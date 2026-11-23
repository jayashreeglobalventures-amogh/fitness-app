// Connects the pure engine to the database: classify each participant-day from the check-in facts, compute the events
// that should exist, and append only the difference to the ledger (scoring_events). Running it again changes nothing.
// Leaderboard and per-participant breakdowns are read from the ledger.
import type pg from 'pg';
import { lockChallenge, withTx, type Queryable } from '../../core/db.js';
import { stableStringify } from '../../core/json.js';
import { daysBetween, localDay, addDays } from '../../core/dates.js';
import { forbidden } from '../../core/errors.js';
import { versionOn } from '../challenges/challenges.js';
import { accessFor } from '../identity/permissions.js';
import { challengeContext, participantDays, summarize, type ChallengeContext, type DayInfo, type ParticipantRow } from '../checkin/days.js';
import { score, weekendKeyOf, type DayClass, type DesiredEvent, type EngineOutput } from './engine.js';

/** The engine's view of a day. A miss with an exemption still being decided is undecided, not a miss. */
export function classify(d: DayInfo): DayClass {
  switch (d.status) {
    case 'ACHIEVED': return 'S';
    case 'REST': case 'EXCUSED': return 'P';
    case 'NOT_PARTICIPATING': return 'N';
    case 'TARGET_MISSED': case 'REJECTED': case 'MISSED_DEADLINE':
      return d.exemption && d.exemption.status !== 'APPROVED' ? 'U' : 'M';
    default: return 'U';
  }
}

interface Facts { ctx: ChallengeContext; people: (ParticipantRow & { displayName: string; photoFileId: number | null; days: DayInfo[] })[]; out: EngineOutput }

async function facts(db: Queryable, challengeId: number, now: Date): Promise<Facts> {
  const ctx = await challengeContext(db, challengeId, now);
  const { rows } = await db.query(`SELECT p.*, u.display_name, pr.photo_file_id FROM participants p JOIN users u USING (user_id) LEFT JOIN user_profiles pr ON pr.user_id = p.user_id WHERE p.challenge_id = $1 ORDER BY p.participant_id`, [challengeId]);
  const people = [];
  for (const r of rows) {
    const p: ParticipantRow = { participantId: Number(r.participant_id), challengeId, userId: Number(r.user_id), status: r.status, joinedOn: r.joined_on, leftOn: r.left_on };
    people.push({ ...p, displayName: String(r.display_name), photoFileId: r.photo_file_id ? Number(r.photo_file_id) : null, days: await participantDays(db, ctx, p, now) });
  }
  const { rows: b } = await db.query(
    `SELECT s.bonus_submission_id, s.participant_id, a.weekend_key, s.decided_at FROM bonus_submissions s JOIN bonus_activities a USING (activity_id)
      WHERE a.challenge_id = $1 AND s.status = 'APPROVED' AND a.status = 'OPEN'`, [challengeId]);
  const days: string[] = [];
  for (let d = ctx.ch.startsOn; daysBetween(d, ctx.ch.endsOn) >= 0; d = addDays(d, 1)) days.push(d);
  const out = score({
    days, cfgOn: ctx.cfgOn, versionNoOn: (d) => versionOn(ctx.all, d).versionNo,
    participants: people.map((p) => ({ participantId: p.participantId, classes: Object.fromEntries(p.days.map((d) => [d.day, classify(d)])) })),
    bonuses: b.map((x) => ({ participantId: Number(x.participant_id), weekendKey: x.weekend_key, bonusSubmissionId: Number(x.bonus_submission_id), approvedOn: localDay(x.decided_at, ctx.ch.timeZone) })),
  });
  return { ctx, people, out };
}

/**
 * Brings the ledger in line with the facts. For each event key: if what should exist differs from what is active,
 * the active row is reversed and (if needed) a new award appended. Returns the number of rows appended.
 */
export async function reconcile(db: Queryable, challengeId: number, now: Date): Promise<{ appended: number; facts: Facts }> {
  await lockChallenge(db, challengeId);
  const f = await facts(db, challengeId, now);
  const want = new Map<string, DesiredEvent>(f.out.events.map((e) => [e.baseKey, e]));
  const { rows } = await db.query(`SELECT * FROM scoring_events WHERE challenge_id = $1 ORDER BY event_id`, [challengeId]);
  const byKey = new Map<string, Record<string, any>[]>();
  for (const r of rows) byKey.set(r.base_key, [...(byKey.get(r.base_key) ?? []), r]);
  const same = (a: Record<string, any>, e: DesiredEvent) => a.points === e.points && a.day === e.day && (e.points !== 0 || stableStringify(a.details) === stableStringify(e.details));
  let appended = 0;
  const insert = async (e: { baseKey: string; participantId: number | null; rule: string; day: string; points: number; versionNo: number; details: unknown }, kind: 'AWARD' | 'REVERSAL', reverses: number | null, seq: number) => {
    await db.query(
      `INSERT INTO scoring_events (challenge_id, participant_id, base_key, idem_key, rule, kind, reverses_event_id, day, points, rules_version_no, details, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (idem_key) DO NOTHING`,
      [challengeId, e.participantId, e.baseKey, `${e.baseKey}#${seq}`, e.rule, kind, reverses, e.day, e.points, e.versionNo, JSON.stringify(e.details), now]);
    appended++;
  };
  for (const key of new Set([...want.keys(), ...byKey.keys()])) {
    const hist = byKey.get(key) ?? [];
    const reversed = new Set(hist.filter((h) => h.kind === 'REVERSAL').map((h) => Number(h.reverses_event_id)));
    const active = hist.filter((h) => h.kind === 'AWARD' && !reversed.has(Number(h.event_id))).at(-1) ?? null;
    const e = want.get(key);
    if (active && e && same(active, e)) continue;
    let seq = hist.length;
    if (active) {
      await insert({ baseKey: key, participantId: active.participant_id === null ? null : Number(active.participant_id), rule: active.rule, day: active.day,
        points: -active.points, versionNo: active.rules_version_no, details: { reason: e ? 'recalculated' : 'no longer applies' } }, 'REVERSAL', Number(active.event_id), ++seq);
    }
    if (e) await insert(e, 'AWARD', null, ++seq);
  }
  return { appended, facts: f };
}

/** Reconciles every published challenge that has started (scheduler). */
export async function reconcileAll(pool: pg.Pool, now: Date): Promise<number> {
  const { rows } = await pool.query(`SELECT challenge_id FROM challenges WHERE status = 'PUBLISHED' AND starts_on <= ($1::timestamptz AT TIME ZONE time_zone)::date + 1`, [now]);
  let n = 0;
  for (const r of rows) n += (await withTx(pool, (tx) => reconcile(tx, Number(r.challenge_id), now))).appended;
  return n;
}

const RULE_LABEL: Record<string, string> = {
  DAILY_SUCCESS: 'Daily target', PERSONAL_STREAK: 'Personal streak', TEAM_STREAK: 'Team streak', COMEBACK: 'Comeback', WEEKEND_BONUS: 'Weekend bonus',
  MISSED_DAY: 'Missed day', CONSECUTIVE_MISSES: 'Missed days in a row', TEAM_STREAK_BREAK: 'Team streak broken', TEAM_STREAK_BROKEN: 'Team streak broken',
};

export interface Standing {
  rank: number; tied: boolean; participantId: number; displayName: string; status: string; points: number; adherencePct: number | null;
  successfulDays: number; longestStreak: number; currentStreak: number; finalScoreOn: string | null; eligible: boolean; me?: boolean;
  photoFileId?: number | null; // shown only if the viewer may see it (checked when the image is requested)
  userId?: number;
}

/** Ranking per the challenge's leaderboard settings; identical rows share a rank and are flagged as tied. */
export function rank(rows: Omit<Standing, 'rank' | 'tied'>[], order: string[]): Standing[] {
  const cmp = (a: Omit<Standing, 'rank' | 'tied'>, b: Omit<Standing, 'rank' | 'tied'>) => {
    for (const k of order) {
      const d = k === 'POINTS' ? b.points - a.points
        : k === 'ADHERENCE' ? (b.adherencePct ?? -1) - (a.adherencePct ?? -1)
        : k === 'SUCCESSFUL_DAYS' ? b.successfulDays - a.successfulDays
        : k === 'LONGEST_PERSONAL_STREAK' ? b.longestStreak - a.longestStreak
        : k === 'EARLIEST_FINAL_SCORE' ? (a.finalScoreOn ?? '9999').localeCompare(b.finalScoreOn ?? '9999') : 0;
      if (d !== 0) return d;
    }
    return 0;
  };
  const sorted = [...rows].sort((a, b) => cmp(a, b) || a.displayName.localeCompare(b.displayName));
  return sorted.map((r, i) => {
    let first = i;
    while (first > 0 && cmp(sorted[first - 1]!, r) === 0) first--;
    const tied = (i > 0 && cmp(sorted[i - 1]!, r) === 0) || (i < sorted.length - 1 && cmp(sorted[i + 1]!, r) === 0);
    return { ...r, rank: first + 1, tied };
  });
}

/** The (provisional) leaderboard. Reconciles first, so it always reflects the latest decisions. */
export async function leaderboard(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const access = await accessFor(db, userId, challengeId);
  const me = await db.query(`SELECT participant_id FROM participants WHERE challenge_id = $1 AND user_id = $2`, [challengeId, userId]);
  if (!access.permissions.has('challenge.view_admin') && !me.rows[0]) throw forbidden();
  return standingsOf(db, challengeId, now, me.rows[0] ? Number(me.rows[0].participant_id) : null);
}

/** The ranked standings (no access check: callers check, or it is the scheduler). */
export async function standingsOf(db: Queryable, challengeId: number, now: Date, meParticipantId: number | null = null) {
  const { facts: f } = await reconcile(db, challengeId, now);
  const totals = await db.query(
    `SELECT participant_id, sum(points)::int AS points, max(day) FILTER (WHERE points <> 0) AS last_change FROM scoring_events WHERE challenge_id = $1 AND participant_id IS NOT NULL GROUP BY participant_id`, [challengeId]);
  const tmap = new Map(totals.rows.map((r) => [Number(r.participant_id), r]));
  const cfg = f.ctx.cfgOn(daysBetween(f.ctx.ch.startsOn, f.ctx.today) >= 0 ? (daysBetween(f.ctx.today, f.ctx.ch.endsOn) >= 0 ? f.ctx.today : f.ctx.ch.endsOn) : f.ctx.ch.startsOn);
  const rows = f.people.map((p) => {
    const s = summarize(p.days, f.ctx);
    const st = f.out.participants.find((x) => x.participantId === p.participantId)!;
    const t = tmap.get(p.participantId);
    const eligible = !['DISQUALIFIED', 'REMOVED', 'WITHDRAWN'].includes(p.status) && s.adherencePct !== null && s.adherencePct >= cfg.prizes.qualificationAdherencePct;
    return { participantId: p.participantId, displayName: p.displayName, status: p.status, points: t ? Number(t.points) : 0, adherencePct: s.adherencePct,
      successfulDays: s.achieved, longestStreak: st.longestStreak, currentStreak: st.currentStreak, finalScoreOn: t?.last_change ?? null, eligible,
      me: meParticipantId === p.participantId, photoFileId: p.photoFileId, userId: p.userId };
  });
  return {
    standings: rank(rows, cfg.leaderboard.ranking), ranking: cfg.leaderboard.ranking, qualificationAdherencePct: cfg.prizes.qualificationAdherencePct,
    team: f.out.team, provisional: true, asOf: now.toISOString(),
  };
}

/** One participant's points, event by event (corrections shown as reversals). Own, or admins. */
export async function breakdown(db: Queryable, userId: number, participantId: number, now: Date): Promise<unknown> {
  const { rows: [p] } = await db.query(`SELECT challenge_id, user_id FROM participants WHERE participant_id = $1`, [participantId]);
  if (!p) throw forbidden();
  if (Number(p.user_id) !== userId && !(await accessFor(db, userId, Number(p.challenge_id))).permissions.has('challenge.view_admin')) throw forbidden();
  const { facts: f } = await reconcile(db, Number(p.challenge_id), now);
  const { rows } = await db.query(`SELECT event_id, rule, kind, day, points, details, created_at FROM scoring_events WHERE participant_id = $1 ORDER BY day, event_id`, [participantId]);
  const st = f.out.participants.find((x) => x.participantId === participantId);
  const byRule: Record<string, number> = {};
  for (const r of rows) byRule[r.rule] = (byRule[r.rule] ?? 0) + r.points;
  return {
    total: rows.reduce((a, r) => a + r.points, 0), byRule, labels: RULE_LABEL,
    currentStreak: st?.currentStreak ?? 0, longestStreak: st?.longestStreak ?? 0, comebacks: st?.comebacks ?? 0, teamStreak: f.out.team.currentStreak,
    events: rows.map((r) => ({ eventId: Number(r.event_id), rule: r.rule, label: RULE_LABEL[r.rule] ?? r.rule, kind: r.kind, day: r.day, points: r.points, details: r.details })),
  };
}

export { weekendKeyOf };
