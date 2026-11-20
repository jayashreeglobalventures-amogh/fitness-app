// Optional health profile (PRD 4). Separate from the ordinary profile; nothing is collected without explicit consent.
// Every query here runs as the signed-in person: the database's row-level security only returns THEIR health rows
// (migration 0009). Other people's data is reachable only through health_shared_with(), which applies their sharing.
// Values never go into the audit log, notifications, community posts or the AI - only the fact that something happened.
import { writeAudit } from '../../core/audit.js';
import type { Queryable } from '../../core/db.js';
import { isValidDate, localDay } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { accessFor } from '../identity/permissions.js';

export const CONSENT_VERSION = 1;
export const HEALTH_FIELDS = ['height', 'weight', 'bmi', 'bodyFat', 'waist', 'restingHr', 'fitnessLevel', 'activityLevel', 'goals', 'considerations'] as const;
export type HealthField = (typeof HEALTH_FIELDS)[number];
export const HEALTH_VISIBILITY = ['PRIVATE', 'ADMINS', 'MEMBERS', 'PUBLIC'] as const;
const GOALS = ['FAT_LOSS', 'MUSCLE_GAIN', 'ENDURANCE', 'STRENGTH', 'STEPS', 'CONSISTENCY'];
const FITNESS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];
const ACTIVITY = ['SEDENTARY', 'LIGHT', 'MODERATE', 'ACTIVE', 'VERY_ACTIVE'];

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const bmiOf = (weightKg: number | null, heightCm: number | null) => (weightKg && heightCm ? Math.round((weightKg / (heightCm / 100) ** 2) * 10) / 10 : null);

async function consented(db: Queryable, userId: number): Promise<{ grantedAt: string; version: number } | null> {
  const { rows: [c] } = await db.query(`SELECT granted_at, version FROM user_consents WHERE user_id = $1 AND kind = 'HEALTH_DATA' AND revoked_at IS NULL`, [userId]);
  return c ? { grantedAt: c.granted_at.toISOString(), version: c.version } : null;
}
async function requireConsent(db: Queryable, userId: number): Promise<void> {
  if (!(await consented(db, userId))) throw forbidden('Give consent to the health profile first.');
}

// ---------- consent ----------

export async function giveConsent(db: Queryable, userId: number, input: { agree?: unknown; version?: unknown }, now: Date): Promise<void> {
  if (input.agree !== true || Number(input.version) !== CONSENT_VERSION) throw validation('Please read and accept the health-data consent.');
  if (await consented(db, userId)) return;
  await db.query(`INSERT INTO user_consents (user_id, kind, version, granted_at) VALUES ($1,'HEALTH_DATA',$2,$3)`, [userId, CONSENT_VERSION, now]);
  await writeAudit(db, now, { actorUserId: userId, action: 'HEALTH_CONSENT_GIVEN', entity: 'USER', entityId: userId, after: { version: CONSENT_VERSION } });
}

/**
 * Withdraws consent: from then on nothing is shared with anyone (support access ends too) and nothing new can be
 * recorded. With deleteData the records are erased as well; otherwise they stay, hidden, until the person decides.
 */
export async function withdrawConsent(db: Queryable, userId: number, input: { deleteData?: unknown }, now: Date): Promise<void> {
  await db.query(`UPDATE user_consents SET revoked_at = $2 WHERE user_id = $1 AND kind = 'HEALTH_DATA' AND revoked_at IS NULL`, [userId, now]);
  await db.query(`UPDATE health_support_grants SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, now]);
  await db.query(`UPDATE health_profiles SET visibility = '{}'::jsonb, updated_at = $2 WHERE user_id = $1`, [userId, now]);
  await writeAudit(db, now, { actorUserId: userId, action: 'HEALTH_CONSENT_WITHDRAWN', entity: 'USER', entityId: userId, after: { deleted: input.deleteData === true } });
  if (input.deleteData === true) await eraseAll(db, userId, now);
}

/** Permanently erases every health record and setting of the person (their request; cannot be undone). */
export async function deleteAll(db: Queryable, userId: number, now: Date): Promise<void> {
  await eraseAll(db, userId, now);
}
async function eraseAll(db: Queryable, userId: number, now: Date): Promise<void> {
  const m = await db.query(`DELETE FROM health_measurements WHERE user_id = $1`, [userId]);
  const p = await db.query(`DELETE FROM health_profiles WHERE user_id = $1`, [userId]);
  await db.query(`UPDATE health_support_grants SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, now]);
  await writeAudit(db, now, { actorUserId: userId, action: 'HEALTH_DATA_DELETED', entity: 'USER', entityId: userId, after: { records: m.rowCount ?? 0, profile: (p.rowCount ?? 0) > 0 } });
}

// ---------- the person's own profile ----------

export async function mine(db: Queryable, userId: number, now: Date): Promise<unknown> {
  const consent = await consented(db, userId);
  const { rows: [p] } = await db.query(`SELECT * FROM health_profiles WHERE user_id = $1`, [userId]);
  const { rows } = await db.query(`SELECT * FROM health_measurements WHERE user_id = $1 ORDER BY measured_on, measurement_id`, [userId]);
  // BMI per entry uses the height of that entry, or the latest height recorded on or before it (or the first one).
  let height: number | null = rows.find((r) => r.height_cm !== null)?.height_cm ?? null;
  const records = rows.map((r) => {
    if (r.height_cm !== null) height = Number(r.height_cm);
    const weight = r.weight_kg === null ? null : Number(r.weight_kg);
    return { id: Number(r.measurement_id), on: r.measured_on, heightCm: r.height_cm === null ? null : Number(r.height_cm), weightKg: weight,
      bodyFatPct: r.body_fat_pct === null ? null : Number(r.body_fat_pct), waistCm: r.waist_cm === null ? null : Number(r.waist_cm),
      restingHr: r.resting_hr, note: r.note, bmi: bmiOf(weight, height !== null ? Number(height) : null) };
  });
  const vis = (p?.visibility ?? {}) as Record<string, string>;
  const { rows: grants } = await db.query(
    `SELECT g.grant_id, g.expires_at, g.reason, g.granted_at, u.display_name FROM health_support_grants g JOIN users u ON u.user_id = g.grantee_user_id
      WHERE g.user_id = $1 AND g.revoked_at IS NULL AND g.expires_at > $2 ORDER BY g.granted_at DESC`, [userId, now]);
  return {
    consent, consentVersion: CONSENT_VERSION,
    profile: {
      units: p?.units ?? 'METRIC', fitnessLevel: p?.fitness_level ?? null, activityLevel: p?.activity_level ?? null, goals: p?.goals ?? [],
      targetWeightKg: p?.target_weight_kg === null || p?.target_weight_kg === undefined ? null : Number(p.target_weight_kg),
      targetDailySteps: p?.target_daily_steps ?? null, considerations: p?.considerations ?? null,
      visibility: Object.fromEntries(HEALTH_FIELDS.map((f) => [f, (HEALTH_VISIBILITY as readonly string[]).includes(vis[f] ?? '') ? vis[f] : 'PRIVATE'])),
    },
    records,
    supportGrants: grants.map((g) => ({ grantId: Number(g.grant_id), to: g.display_name, reason: g.reason, since: g.granted_at.toISOString(), until: g.expires_at.toISOString() })),
  };
}

export async function updateProfile(db: Queryable, userId: number, input: Record<string, unknown>, now: Date): Promise<unknown> {
  await requireConsent(db, userId);
  const cur = (await mine(db, userId, now)) as { profile: Record<string, unknown> & { visibility: Record<string, string> } };
  const next = { ...cur.profile, ...Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'visibility')) } as Record<string, unknown>;
  if (!['METRIC', 'IMPERIAL'].includes(String(next.units))) throw validation('Units must be metric or imperial.');
  if (next.fitnessLevel !== null && !FITNESS.includes(String(next.fitnessLevel))) throw validation('Unknown fitness level.');
  if (next.activityLevel !== null && !ACTIVITY.includes(String(next.activityLevel))) throw validation('Unknown activity level.');
  const goals = Array.isArray(next.goals) ? [...new Set(next.goals.map(String))] : [];
  if (goals.some((g) => !GOALS.includes(g))) throw validation('Unknown goal.');
  const tw = num(next.targetWeightKg), ts = num(next.targetDailySteps);
  if (tw !== null && !(tw >= 20 && tw <= 350)) throw validation('Target weight must be between 20 and 350 kg.');
  if (ts !== null && !(Number.isInteger(ts) && ts >= 1000 && ts <= 100000)) throw validation('Target daily steps must be between 1,000 and 100,000.');
  const considerations = next.considerations == null ? null : String(next.considerations).trim().slice(0, 1000) || null;

  const vis = { ...cur.profile.visibility };
  for (const [k, v] of Object.entries((input.visibility ?? {}) as Record<string, unknown>)) {
    if (!(HEALTH_FIELDS as readonly string[]).includes(k)) throw validation(`Unknown health field "${k}".`);
    if (!(HEALTH_VISIBILITY as readonly string[]).includes(String(v))) throw validation('Visibility must be PRIVATE, ADMINS, MEMBERS or PUBLIC.');
    if (k === 'considerations' && (v === 'MEMBERS' || v === 'PUBLIC')) throw validation('Health considerations can be shared at most with your challenge admins.');
    vis[k] = String(v);
  }
  await db.query(
    `INSERT INTO health_profiles (user_id, units, fitness_level, activity_level, goals, target_weight_kg, target_daily_steps, considerations, visibility, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id) DO UPDATE SET units = EXCLUDED.units, fitness_level = EXCLUDED.fitness_level, activity_level = EXCLUDED.activity_level,
       goals = EXCLUDED.goals, target_weight_kg = EXCLUDED.target_weight_kg, target_daily_steps = EXCLUDED.target_daily_steps,
       considerations = EXCLUDED.considerations, visibility = EXCLUDED.visibility, updated_at = EXCLUDED.updated_at`,
    [userId, next.units, next.fitnessLevel, next.activityLevel, goals, tw, ts, considerations, JSON.stringify(vis), now]);
  const sharingChanged = HEALTH_FIELDS.filter((f) => vis[f] !== cur.profile.visibility[f]);
  if (sharingChanged.length) {
    // Which fields and to what level - never values.
    await writeAudit(db, now, { actorUserId: userId, action: 'HEALTH_SHARING_CHANGED', entity: 'USER', entityId: userId,
      before: Object.fromEntries(sharingChanged.map((f) => [f, cur.profile.visibility[f]])), after: Object.fromEntries(sharingChanged.map((f) => [f, vis[f]])) });
  }
  return mine(db, userId, now);
}

interface MeasurementIn { measuredOn?: unknown; heightCm?: unknown; weightKg?: unknown; bodyFatPct?: unknown; waistCm?: unknown; restingHr?: unknown; note?: unknown }

function cleanMeasurement(m: MeasurementIn, today: string) {
  const on = String(m.measuredOn ?? '');
  if (!isValidDate(on)) throw validation('Choose the date of the measurement.');
  if (on > today) throw validation('The date can\'t be in the future.');
  if (on < '1900-01-01') throw validation('That date is too far in the past.');
  const r1 = (v: unknown) => { const n = num(v); return n === null ? null : Math.round(n * 10) / 10; };
  const out = { on, heightCm: r1(m.heightCm), weightKg: r1(m.weightKg), bodyFatPct: r1(m.bodyFatPct), waistCm: r1(m.waistCm), restingHr: num(m.restingHr),
    note: m.note == null ? null : String(m.note).trim().slice(0, 200) || null };
  const check = (v: number | null, lo: number, hi: number, what: string) => { if (v !== null && !(Number.isFinite(v) && v >= lo && v <= hi)) throw validation(`${what} must be between ${lo} and ${hi}.`); };
  check(out.heightCm, 50, 250, 'Height (cm)');
  check(out.weightKg, 20, 350, 'Weight (kg)');
  check(out.bodyFatPct, 2, 75, 'Body fat (%)');
  check(out.waistCm, 30, 250, 'Waist (cm)');
  check(out.restingHr, 25, 220, 'Resting heart rate (beats per minute)');
  if (out.restingHr !== null && !Number.isInteger(out.restingHr)) throw validation('Resting heart rate must be a whole number.');
  if ([out.heightCm, out.weightKg, out.bodyFatPct, out.waistCm, out.restingHr].every((v) => v === null)) throw validation('Enter at least one measurement.');
  return out;
}

/** A new dated entry; earlier entries are never overwritten. */
export async function addMeasurement(db: Queryable, userId: number, m: MeasurementIn, now: Date): Promise<unknown> {
  await requireConsent(db, userId);
  const v = cleanMeasurement(m, localDay(now, 'Asia/Kolkata'));
  const { rows: [{ n }] } = await db.query(`SELECT count(*)::int AS n FROM health_measurements WHERE user_id = $1`, [userId]);
  if (n >= 5000) throw conflict('You have reached the maximum number of health records.');
  await db.query(
    `INSERT INTO health_measurements (user_id, measured_on, height_cm, weight_kg, body_fat_pct, waist_cm, resting_hr, note, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, [userId, v.on, v.heightCm, v.weightKg, v.bodyFatPct, v.waistCm, v.restingHr, v.note, now]);
  return mine(db, userId, now);
}

/** Corrects a mistaken entry (the person's own; row-level security makes anyone else's invisible). */
export async function updateMeasurement(db: Queryable, userId: number, id: number, m: MeasurementIn, now: Date): Promise<unknown> {
  await requireConsent(db, userId);
  const v = cleanMeasurement(m, localDay(now, 'Asia/Kolkata'));
  const r = await db.query(
    `UPDATE health_measurements SET measured_on = $3, height_cm = $4, weight_kg = $5, body_fat_pct = $6, waist_cm = $7, resting_hr = $8, note = $9, updated_at = $10
      WHERE measurement_id = $1 AND user_id = $2`, [id, userId, v.on, v.heightCm, v.weightKg, v.bodyFatPct, v.waistCm, v.restingHr, v.note, now]);
  if (!r.rowCount) throw notFound('Record not found.');
  return mine(db, userId, now);
}

export async function deleteMeasurement(db: Queryable, userId: number, id: number, now: Date): Promise<unknown> {
  const r = await db.query(`DELETE FROM health_measurements WHERE measurement_id = $1 AND user_id = $2`, [id, userId]);
  if (!r.rowCount) throw notFound('Record not found.');
  await writeAudit(db, now, { actorUserId: userId, action: 'HEALTH_RECORD_DELETED', entity: 'USER', entityId: userId });
  return mine(db, userId, now);
}

// ---------- exceptional support access ----------

/** The person lets one Super Admin see their health profile for a limited time (max 72 hours) to help them. */
export async function grantSupport(db: Queryable, userId: number, input: { granteeUserId?: unknown; hours?: unknown; reason?: unknown }, now: Date): Promise<unknown> {
  await requireConsent(db, userId);
  const grantee = Number(input.granteeUserId);
  if (grantee === userId) throw validation('Choose someone else.');
  if (!(await accessFor(db, grantee, null)).platformRoles.includes('SUPER_ADMIN')) throw validation('Support access can only be given to a Super Admin.');
  const hours = Number(input.hours);
  if (![1, 4, 24, 72].includes(hours)) throw validation('Choose 1, 4, 24 or 72 hours.');
  const reason = String(input.reason ?? '').trim().slice(0, 300) || null;
  const expires = new Date(now.getTime() + hours * 3_600_000);
  const { rows: [g] } = await db.query(
    `INSERT INTO health_support_grants (user_id, grantee_user_id, reason, granted_at, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING grant_id`, [userId, grantee, reason, now, expires]);
  await writeAudit(db, now, { actorUserId: userId, action: 'HEALTH_SUPPORT_GRANTED', entity: 'USER', entityId: grantee, reason, after: { hours, until: expires.toISOString(), grantId: Number(g.grant_id) } });
  return mine(db, userId, now);
}

export async function revokeSupport(db: Queryable, userId: number, grantId: number, now: Date): Promise<unknown> {
  const r = await db.query(`UPDATE health_support_grants SET revoked_at = $3 WHERE grant_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING grantee_user_id`, [grantId, userId, now]);
  if (!r.rowCount) throw notFound('Grant not found.');
  await writeAudit(db, now, { actorUserId: userId, action: 'HEALTH_SUPPORT_REVOKED', entity: 'USER', entityId: Number(r.rows[0].grantee_user_id), after: { grantId } });
  return mine(db, userId, now);
}

/** Support access granted to the viewer that is still running (for a Super Admin's list). */
export async function supportGrantsToMe(db: Queryable, viewerId: number, now: Date): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT g.grant_id, g.user_id, g.reason, g.expires_at, u.display_name FROM health_support_grants g JOIN users u ON u.user_id = g.user_id
      WHERE g.grantee_user_id = $1 AND g.revoked_at IS NULL AND g.expires_at > $2 ORDER BY g.expires_at`, [viewerId, now]);
  return rows.map((r) => ({ grantId: Number(r.grant_id), userId: Number(r.user_id), name: r.display_name, reason: r.reason, until: r.expires_at.toISOString() }));
}

// ---------- someone else's health profile ----------

/** What the viewer may see of another person's health profile (null = nothing). Support views are audit-logged. */
export async function sharedView(db: Queryable, viewerId: number, ownerId: number, now: Date): Promise<unknown> {
  if (viewerId === ownerId) return null;
  const { rows: [r] } = await db.query(`SELECT health_shared_with($1, $2, $3) AS v`, [viewerId, ownerId, now]);
  const v = r?.v as { values: Record<string, unknown>; support: boolean; history: unknown[] | null } | null;
  if (v?.support) await writeAudit(db, now, { actorUserId: viewerId, action: 'HEALTH_SUPPORT_VIEWED', entity: 'USER', entityId: ownerId });
  return v;
}
