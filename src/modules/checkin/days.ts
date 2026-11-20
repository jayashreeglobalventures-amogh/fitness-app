// Participant-day status, derived from rows (submissions, rest days, exemptions), never stored as an editable total.
// Precedence on a day: not participating > approved exemption (EXCUSED) > rest day (REST) > evidence > nothing.
import type { Queryable } from '../../core/db.js';
import { addDays, computePeriods, daysBetween, endOfDay, localDay, zonedInstant, type Period } from '../../core/dates.js';
import { forbidden, notFound } from '../../core/errors.js';
import { getChallenge, versions, versionOn, type ChallengeRow, type ChallengeVersion } from '../challenges/challenges.js';
import type { ChallengeConfig } from '../challenges/config.js';

export type DayStatus =
  | 'NOT_PARTICIPATING' | 'UPCOMING' | 'NOT_SUBMITTED' | 'SUBMITTED' | 'PENDING_VERIFICATION'
  | 'ACHIEVED' | 'TARGET_MISSED' | 'REJECTED' | 'MISSED_DEADLINE' | 'EXCUSED' | 'REST';

/** Statuses that are final for adherence (a pending one may still change). */
export const SUCCESS: ReadonlySet<DayStatus> = new Set(['ACHIEVED']);
export const MISSED: ReadonlySet<DayStatus> = new Set(['TARGET_MISSED', 'REJECTED', 'MISSED_DEADLINE']);
export const EXCLUDED: ReadonlySet<DayStatus> = new Set(['EXCUSED', 'REST']);

export interface ParticipantRow { participantId: number; challengeId: number; userId: number; status: string; joinedOn: string; leftOn: string | null; displayName?: string }

export async function participantOf(db: Queryable, challengeId: number, userId: number): Promise<ParticipantRow | null> {
  const { rows } = await db.query(`SELECT * FROM participants WHERE challenge_id = $1 AND user_id = $2`, [challengeId, userId]);
  return rows[0] ? toParticipant(rows[0]) : null;
}
export async function participantById(db: Queryable, participantId: number): Promise<ParticipantRow> {
  const { rows } = await db.query(`SELECT p.*, u.display_name FROM participants p JOIN users u USING (user_id) WHERE participant_id = $1`, [participantId]);
  if (!rows[0]) throw notFound('Participant not found.');
  return toParticipant(rows[0]);
}
const toParticipant = (r: Record<string, unknown>): ParticipantRow => ({
  participantId: Number(r.participant_id), challengeId: Number(r.challenge_id), userId: Number(r.user_id), status: String(r.status),
  joinedOn: String(r.joined_on), leftOn: r.left_on ? String(r.left_on) : null, displayName: r.display_name ? String(r.display_name) : undefined,
});

/** Takes part on `day`: within [joined_on, left_on]. (Suspension doesn't remove days; see the assessment.) */
export const participatesOn = (p: ParticipantRow, day: string) =>
  daysBetween(p.joinedOn, day) >= 0 && (p.leftOn === null || daysBetween(day, p.leftOn) >= 0);

export interface ChallengeContext { ch: ChallengeRow; all: ChallengeVersion[]; periods: Period[]; today: string; cfgOn(day: string): ChallengeConfig }

export async function challengeContext(db: Queryable, challengeId: number, now: Date): Promise<ChallengeContext> {
  const ch = await getChallenge(db, challengeId);
  const all = await versions(db, challengeId);
  const latest = all[all.length - 1]!.config;
  return {
    ch, all, today: localDay(now, ch.timeZone),
    periods: computePeriods(ch.startsOn, ch.endsOn, latest.periods.weekStartsOn),
    cfgOn: (day) => versionOn(all, day).config,
  };
}
export const periodOf = (periods: Period[], day: string) => periods.find((p) => daysBetween(p.startsOn, day) >= 0 && daysBetween(day, p.endsOn) >= 0) ?? null;

/** The instant after which a rest day can no longer be declared or cancelled by the participant. */
export const restCutoff = (cfg: ChallengeConfig, day: string) => zonedInstant(day, cfg.restDays.declareBefore, cfg.basics.timeZone);

export interface DayInfo {
  day: string; status: DayStatus; periodNo: number | null;
  submission: { submissionId: number; status: string; finalValue: number | null; claimedValue: number | null; receivedAt: string; decisionReason: string | null; appealed: boolean } | null;
  restDay: { restDayId: number; declaredAt: string; source: string } | null;
  exemption: { requestId: number; status: string } | null;
}

/** Every challenge day for one participant. */
export async function participantDays(db: Queryable, ctx: ChallengeContext, p: ParticipantRow, now: Date): Promise<DayInfo[]> {
  const [subs, rests, exs] = await Promise.all([
    db.query(`SELECT * FROM submissions WHERE participant_id = $1 AND status <> 'SUPERSEDED'`, [p.participantId]),
    db.query(`SELECT * FROM rest_days WHERE participant_id = $1 AND cancelled_at IS NULL`, [p.participantId]),
    db.query(`SELECT * FROM exemption_requests WHERE participant_id = $1 AND status IN ('VOTING','ADMIN_REVIEW','APPROVED') ORDER BY request_id`, [p.participantId]),
  ]);
  const subOf = new Map(subs.rows.map((r) => [String(r.day), r]));
  const restOf = new Map(rests.rows.map((r) => [String(r.day), r]));
  const out: DayInfo[] = [];
  for (let d = ctx.ch.startsOn; daysBetween(d, ctx.ch.endsOn) >= 0; d = addDays(d, 1)) {
    const s = subOf.get(d);
    const r = restOf.get(d);
    const ex = exs.rows.filter((e) => daysBetween(e.start_day, d) >= 0 && daysBetween(d, e.end_day) >= 0);
    const approved = ex.find((e) => e.status === 'APPROVED');
    const pending = ex.find((e) => e.status !== 'APPROVED');
    let status: DayStatus;
    if (!participatesOn(p, d)) status = 'NOT_PARTICIPATING';
    else if (approved) status = 'EXCUSED';
    else if (r) status = 'REST';
    else if (s) status = ({ PENDING_AI: 'SUBMITTED', PENDING_REVIEW: 'PENDING_VERIFICATION', ACHIEVED: 'ACHIEVED', BELOW_TARGET: 'TARGET_MISSED', REJECTED: 'REJECTED' } as const)[s.status as 'ACHIEVED'];
    else if (daysBetween(ctx.today, d) > 0) status = 'UPCOMING';
    else status = now < endOfDay(d, ctx.ch.timeZone) ? 'NOT_SUBMITTED' : 'MISSED_DEADLINE';
    out.push({
      day: d, status, periodNo: periodOf(ctx.periods, d)?.periodNo ?? null,
      submission: s ? { submissionId: Number(s.submission_id), status: s.status, finalValue: s.final_value, claimedValue: s.claimed_value, receivedAt: s.received_at.toISOString(),
        decisionReason: s.decision_reason, appealed: !!s.appealed_at } : null,
      restDay: r ? { restDayId: Number(r.rest_day_id), declaredAt: r.declared_at.toISOString(), source: r.source } : null,
      exemption: approved ? { requestId: Number(approved.request_id), status: 'APPROVED' } : pending ? { requestId: Number(pending.request_id), status: pending.status } : null,
    });
  }
  return out;
}

export interface Summary {
  achieved: number; missed: number; rest: number; excused: number; pending: number; eligibleDecided: number;
  adherencePct: number | null; restDaysUsed: number; restDaysThisPeriod: number; daysLeft: number;
}

/**
 * Counts over days that have happened. Adherence = successful eligible days / eligible days, where rest and approved
 * exemption days are not eligible (PRD 10). Provisional while anything is pending.
 */
export function summarize(days: DayInfo[], ctx: ChallengeContext): Summary {
  const past = days.filter((d) => daysBetween(d.day, ctx.today) >= 0 && d.status !== 'NOT_PARTICIPATING');
  const count = (set: ReadonlySet<DayStatus>) => past.filter((d) => set.has(d.status)).length;
  const achieved = count(SUCCESS), missed = count(MISSED);
  const pending = past.filter((d) => d.status === 'SUBMITTED' || d.status === 'PENDING_VERIFICATION').length;
  const eligibleDecided = achieved + missed;
  const period = periodOf(ctx.periods, ctx.today);
  return {
    achieved, missed, pending, eligibleDecided,
    rest: past.filter((d) => d.status === 'REST').length,
    excused: past.filter((d) => d.status === 'EXCUSED').length,
    adherencePct: eligibleDecided ? Math.round((achieved / eligibleDecided) * 10000) / 100 : null,
    restDaysUsed: days.filter((d) => d.restDay).length,
    restDaysThisPeriod: period ? days.filter((d) => d.restDay && d.periodNo === period.periodNo).length : 0,
    daysLeft: Math.max(0, daysBetween(ctx.today, ctx.ch.endsOn) + (daysBetween(ctx.ch.startsOn, ctx.today) >= 0 ? 1 : 0)),
  };
}

/** The participant's own dashboard for a challenge. */
export async function myDashboard(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const ctx = await challengeContext(db, challengeId, now);
  const p = await participantOf(db, challengeId, userId);
  if (!p) throw forbidden('You are not taking part in this challenge.');
  const days = await participantDays(db, ctx, p, now);
  const inChallenge = daysBetween(ctx.ch.startsOn, ctx.today) >= 0 && daysBetween(ctx.today, ctx.ch.endsOn) >= 0;
  const todayCfg = ctx.cfgOn(inChallenge ? ctx.today : ctx.ch.startsOn);
  const today = days.find((d) => d.day === ctx.today) ?? null;
  return {
    participant: { participantId: p.participantId, status: p.status, joinedOn: p.joinedOn, leftOn: p.leftOn },
    today: today && {
      ...today,
      target: todayCfg.activity.dailyTarget, unit: todayCfg.activity.unit, label: todayCfg.activity.label,
      deadline: endOfDay(ctx.today, ctx.ch.timeZone).toISOString(),
      restCutoff: restCutoff(todayCfg, ctx.today).toISOString(),
    },
    days, summary: summarize(days, ctx), periods: ctx.periods,
    rules: { restDays: todayCfg.restDays, exemptions: { enabled: todayCfg.exemptions.enabled }, instructions: todayCfg.submission.instructions },
    serverNow: now.toISOString(), timeZone: ctx.ch.timeZone,
  };
}
