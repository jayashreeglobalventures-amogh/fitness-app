// Steps straight from the iPhone Health app, sent by an Apple Shortcut (owner, 23 Nov 2026; screenshots still work).
// Each person creates a personal sync key in Profile (shown once; only its SHA-256 is kept). The Shortcut sends
// today's step count with the key; it is saved for every live challenge the person takes part in that day (one number
// per day, raised by a newer sync, never lowered). A count that reaches the target meets the day; below it, the day is "in
// progress" until midnight. An admin can doubt a synced number: it then stops counting and the person is asked for a
// screenshot (an admin records it with Correct).
import { createHash, randomBytes } from 'node:crypto';
import { writeAudit } from '../../core/audit.js';
import type { Queryable } from '../../core/db.js';
import { daysBetween, localDay } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { addNotice } from '../notifications/prefs.js';
import { challengeContext, participantById, participatesOn, type ParticipantRow } from './days.js';

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const fmt = (n: number) => n.toLocaleString('en-IN');
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' });

/** My sync key (without the key itself) and my latest syncs. */
export async function syncStatus(db: Queryable, userId: number): Promise<unknown> {
  const { rows: [k] } = await db.query(`SELECT hint, created_at, last_used_at FROM sync_keys WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  const { rows } = await db.query(
    `SELECT h.day, h.steps, h.synced_at, h.doubted_at, c.name FROM health_syncs h JOIN participants p USING (participant_id) JOIN challenges c ON c.challenge_id = h.challenge_id
      WHERE p.user_id = $1 ORDER BY h.synced_at DESC LIMIT 5`, [userId]);
  return {
    key: k ? { hint: k.hint, createdAt: k.created_at.toISOString(), lastUsedAt: k.last_used_at?.toISOString() ?? null } : null,
    recent: rows.map((r) => ({ challenge: r.name, day: r.day, steps: r.steps, syncedAt: r.synced_at.toISOString(), doubted: !!r.doubted_at })),
  };
}

/** A new personal sync key (any older one stops working). Returned once - only its fingerprint is stored. */
export async function createKey(db: Queryable, userId: number, now: Date): Promise<{ key: string; hint: string }> {
  await db.query(`UPDATE sync_keys SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, now]);
  const key = `fit_${randomBytes(24).toString('base64url')}`;
  const hint = key.slice(-4);
  const { rows: [r] } = await db.query(`INSERT INTO sync_keys (user_id, key_hash, hint, created_at) VALUES ($1,$2,$3,$4) RETURNING key_id`, [userId, hash(key), hint, now]);
  await writeAudit(db, now, { actorUserId: userId, action: 'SYNC_KEY_CREATED', entity: 'SYNC_KEY', entityId: Number(r.key_id), after: { hint } });
  return { key, hint };
}

export async function revokeKey(db: Queryable, userId: number, now: Date): Promise<void> {
  const { rows } = await db.query(`UPDATE sync_keys SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL RETURNING key_id`, [userId, now]);
  for (const r of rows) await writeAudit(db, now, { actorUserId: userId, action: 'SYNC_KEY_REVOKED', entity: 'SYNC_KEY', entityId: Number(r.key_id) });
}

/** Reads "8214", "8,214", "8214.0" or 8214. */
function parseSteps(v: unknown): number | null {
  // Also "8,214 steps" / "8214 count" (how a Health quantity can be written as text).
  const m = /^\s*([\d,]+(?:\.\d+)?)\s*(?:steps?|count)?\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const n = Math.round(Number(m[1]!.replace(/,/g, '')));
  return n >= 0 && n <= 200_000 ? n : null;
}

/**
 * The calendar day of the Health sample, as the Shortcut writes it - e.g. "2026-11-23T00:00:00+05:30",
 * "23 Nov 2026 at 12:00 AM" or "Nov 23, 2026 at 00:00". null if it can't be read (then it isn't checked).
 */
export function sampleDay(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const t = Date.parse(s.replace(/\s+at\s+/i, ' ').replace(/ /g, ' '));
  if (Number.isNaN(t)) return null;
  const d = new Date(t); // written without a time zone: read back the same calendar date
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(/\r?\n/)).map((s) => s.trim()).filter((s, i, a) => s !== '' || i < a.length - 1);

/**
 * Today's total from the latest step readings (one per line: value, start date, device). Readings from other days are
 * left out. If more than one device recorded steps (e.g. phone and watch, which overlap), the device with the most
 * counts - close to what the Health app shows, never double.
 */
export function sumReadings(b: Record<string, unknown>, day: string): { total: number; counted: number } | { error: string } {
  const values = lines(b.readings);
  const dates = lines(b.dates);
  const sources = lines(b.sources);
  if (!values.length || values.length !== dates.length) return { error: `couldn't read the steps from Health (${values.length} readings, ${dates.length} dates). Please tell an admin.` };
  const bySource = new Map<string, number>();
  let counted = 0, unreadable = 0;
  values.forEach((v, i) => {
    const n = parseSteps(v);
    const d = sampleDay(dates[i]);
    if (n === null || d === null) { unreadable++; return; }
    if (d !== day) return;
    const src = sources.length === values.length ? sources[i]! : 'Health';
    bySource.set(src, (bySource.get(src) ?? 0) + n);
    counted++;
  });
  if (unreadable === values.length) return { error: `couldn't read the dates from Health (e.g. "${dates[0]!.slice(0, 40)}"). Please tell an admin.` };
  return { total: Math.min(200_000, Math.max(0, ...bySource.values())), counted };
}

/**
 * The Shortcut sends today's steps. Returns a short message the Shortcut shows as a notification.
 * Throws for a bad key (401) or bad number (400).
 */
export async function receiveSteps(db: Queryable, keyRaw: string | undefined, body: unknown, device: string, now: Date): Promise<string> {
  const key = String(keyRaw ?? '').trim();
  if (!/^fit_[A-Za-z0-9_-]{20,64}$/.test(key)) throw Object.assign(new Error('bad key'), { syncStatus: 401 });
  const { rows: [k] } = await db.query(`SELECT k.key_id, k.user_id FROM sync_keys k JOIN users u USING (user_id) WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND u.status = 'ACTIVE'`, [hash(key)]);
  if (!k) throw Object.assign(new Error('bad key'), { syncStatus: 401 });
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  // Either one total ({"steps": 8214}) or the latest readings, one per line ({"readings", "dates", "sources"}).
  const byReadings = b.readings !== undefined;
  const steps = byReadings ? 0 : parseSteps(b.steps ?? b.Steps ?? b.value);
  if (steps === null) throw validation('Send the number of steps, e.g. {"steps": 8214}.');
  await db.query(`UPDATE sync_keys SET last_used_at = $2 WHERE key_id = $1`, [k.key_id, now]);

  const { rows: parts } = await db.query(
    `SELECT p.participant_id, p.status, p.joined_on, p.left_on, p.user_id, c.challenge_id, c.time_zone FROM participants p JOIN challenges c USING (challenge_id)
      WHERE p.user_id = $1 AND p.status = 'ACTIVE' AND c.status = 'PUBLISHED'`, [k.user_id]);
  const out: string[] = [];
  for (const r of parts) {
    const cid = Number(r.challenge_id);
    const day = localDay(now, r.time_zone);
    const ctx = await challengeContext(db, cid, now);
    if (daysBetween(ctx.ch.startsOn, day) < 0 || daysBetween(day, ctx.ch.endsOn) < 0) continue;
    let daySteps = steps;
    if (byReadings) {
      const r = sumReadings(b, day);
      if ('error' in r) { out.push(`${ctx.ch.name}: ${r.error}`); continue; }
      if (r.counted === 0) { out.push(`${ctx.ch.name}: no steps in your Health app for today yet - nothing saved.`); continue; }
      daySteps = r.total;
    } else {
      // A single total sent with its day: if that isn't today, there are no steps today yet.
      const from = sampleDay(b.date);
      if (from && from !== day) { out.push(`${ctx.ch.name}: no steps in your Health app for today yet (the latest are from ${dayLabel(from)}) - nothing saved.`); continue; }
    }
    const p: ParticipantRow = { participantId: Number(r.participant_id), challengeId: cid, userId: Number(r.user_id), status: r.status, joinedOn: r.joined_on, leftOn: r.left_on };
    if (!participatesOn(p, day)) continue;
    const cfg = ctx.cfgOn(day);
    if (!cfg.submission.healthSync.enabled) { out.push(`${ctx.ch.name}: steps from Apple Health aren't used in this challenge - please upload a screenshot.`); continue; }
    const { rows: [rest] } = await db.query(`SELECT 1 FROM rest_days WHERE participant_id = $1 AND day = $2 AND cancelled_at IS NULL`, [p.participantId, day]);
    if (rest) { out.push(`${ctx.ch.name}: today is your rest day 😴 - nothing needed.`); continue; }
    const { rows: [prev] } = await db.query(`SELECT doubted_at FROM health_syncs WHERE participant_id = $1 AND day = $2`, [p.participantId, day]);
    if (prev?.doubted_at) { out.push(`${ctx.ch.name}: an admin asked for a screenshot for today - please upload one.`); continue; }
    // Steps only go up during a day: a lower count (e.g. a single late reading) never replaces a higher one.
    const { rows: [kept] } = await db.query(
      `INSERT INTO health_syncs (challenge_id, participant_id, day, steps, source, device, first_synced_at, synced_at) VALUES ($1,$2,$3,$4,'APPLE_HEALTH',$5,$6,$6)
       ON CONFLICT (participant_id, day) DO UPDATE SET steps = GREATEST(health_syncs.steps, EXCLUDED.steps), device = EXCLUDED.device, synced_at = EXCLUDED.synced_at, times = health_syncs.times + 1
       RETURNING steps`,
      [cid, p.participantId, day, daySteps, device.slice(0, 300) || null, now]);
    const total = Number(kept.steps);
    const target = cfg.activity.dailyTarget;
    out.push(total >= target
      ? `${ctx.ch.name}: ${fmt(total)} ${cfg.activity.unit} saved for ${dayLabel(day)} - target met ✅`
      : `${ctx.ch.name}: ${fmt(total)} of ${fmt(target)} ${cfg.activity.unit} so far today - ${fmt(target - total)} to go 💪`);
  }
  return out.length ? out.join('\n') : 'No challenge is running for you today, so nothing was saved.';
}

/** An admin doubts a synced number (it stops counting; the person is asked for a screenshot), or accepts it again. */
export async function doubtSync(db: Queryable, actorUserId: number, participantId: number, input: { day?: unknown; doubt?: unknown; reason?: unknown }, now: Date): Promise<void> {
  const p = await participantById(db, participantId);
  requirePermission(await accessFor(db, actorUserId, p.challengeId), 'submissions.review');
  if (p.userId === actorUserId) throw forbidden('You can\'t decide on your own steps; another admin must do it.');
  const day = String(input.day ?? '');
  const { rows: [s] } = await db.query(`SELECT * FROM health_syncs WHERE participant_id = $1 AND day = $2`, [participantId, day]);
  if (!s) throw notFound('No synced steps for that day.');
  const doubt = input.doubt !== false;
  if (doubt === !!s.doubted_at) throw conflict(doubt ? 'Already doubted.' : 'It already counts.');
  const reason = String(input.reason ?? '').trim().slice(0, 300) || null;
  await db.query(`UPDATE health_syncs SET doubted_at = $2, doubted_by = $3, doubt_reason = $4 WHERE sync_id = $1`,
    [s.sync_id, doubt ? now : null, doubt ? actorUserId : null, doubt ? reason : null]);
  await writeAudit(db, now, { actorUserId, challengeId: p.challengeId, action: doubt ? 'SYNCED_STEPS_DOUBTED' : 'SYNCED_STEPS_ACCEPTED', entity: 'HEALTH_SYNC', entityId: Number(s.sync_id), reason,
    after: { participantId, day, steps: s.steps } });
  const ctx = await challengeContext(db, p.challengeId, now);
  await addNotice(db, { userId: p.userId, challengeId: p.challengeId, key: `syncdoubt:${s.sync_id}:${doubt ? 'd' : 'a'}:${now.getTime()}`, category: 'essential',
    kind: doubt ? 'warning' : 'info',
    title: doubt ? `${ctx.ch.name}: please send a screenshot for ${dayLabel(day)}` : `${ctx.ch.name}: your synced steps for ${dayLabel(day)} count again ✅`,
    body: doubt ? `An admin would like to see a screenshot of your ${fmt(s.steps)} steps${reason ? ` (${reason})` : ''}. ${day === ctx.today ? 'Upload it in the app today.' : 'Send it to an admin, who will record it.'}` : `${fmt(s.steps)} steps.`,
    link: `/challenges/${p.challengeId}/today` }, now);
}
