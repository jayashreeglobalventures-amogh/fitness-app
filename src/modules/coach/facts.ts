// The coach's facts: plain numbers worked out from a participant's days and points - no wording, no health data.
// A writer (writer.ts) turns them into messages; the template writer today, an AI writer later, gets only these.
import { addDays, daysBetween } from '../../core/dates.js';
import type { Queryable } from '../../core/db.js';
import type { Period } from '../../core/dates.js';
import { EXCLUDED, MISSED, SUCCESS, type ChallengeContext, type DayInfo } from '../checkin/days.js';
import { classify } from '../scoring/ledger.js';

export interface WeekFacts {
  challengeName: string; periodNo: number; startsOn: string; endsOn: string;
  complete: boolean;            // the week has ended (otherwise: so far)
  daysInWeek: number;           // days the person took part in this week (up to today)
  achieved: number; missed: number; rest: number; excused: number; pending: number;
  previous: { periodNo: number; achieved: number; eligible: number } | null;
  stepsAverage: number | null;  // on days with a counted step total
  bestDay: { day: string; steps: number } | null;
  streak: number;               // successful days in a row up to now (rest days and exemptions pause it)
  bestStreak: number;
  adherencePct: number | null;  // whole challenge so far
  qualificationPct: number;     // the prize line
  daysToQualify: number | null; // successful days in a row needed to get back over the line, if below and still possible
  points: number;               // this week
  pointsTotal: number;
  weakestWeekday: string | null; // a weekday with at least 2 misses and the most misses
  daysLeft: number;
  target: number;
  todayDone?: boolean;          // today is already met (or a rest / excused day)
}

export interface NudgeFacts { challengeName: string; streak: number; hoursLeft: number; target: number; missedYesterday: boolean }

export interface RiskFacts {
  participantId: number; userId: number; displayName: string;
  missesInARow: number; adherencePct: number | null; qualificationPct: number; daysSinceLastSuccess: number | null;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (d: string) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]!;
const PENDING = new Set(['SUBMITTED', 'PENDING_VERIFICATION']);
const decided = (d: DayInfo) => SUCCESS.has(d.status) || MISSED.has(d.status);

/** Days that have happened (today counts once it has a result), oldest first. */
function pastDays(days: DayInfo[], today: string): DayInfo[] {
  return days.filter((d) => d.status !== 'NOT_PARTICIPATING' && (daysBetween(d.day, today) > 0 || (d.day === today && (decided(d) || EXCLUDED.has(d.status)))));
}

/**
 * Streak and misses in a row, counted exactly as the points engine does (scoring/engine.ts), so the coach and the
 * Streak shown on the Today tab always agree: days in order; success +1, miss resets; rest days and approved
 * exemptions are skipped; it stops at the first undecided day (still being checked, or not over yet).
 */
function runs(days: DayInfo[]): { streak: number; best: number; missRun: number } {
  let streak = 0, best = 0, missRun = 0;
  for (const d of days) {
    const c = classify(d);
    if (c === 'N' || c === 'P') continue;
    if (c === 'U') break;
    if (c === 'S') { streak++; best = Math.max(best, streak); missRun = 0; } else { streak = 0; missRun++; }
  }
  return { streak, best, missRun };
}
export function streaks(days: DayInfo[]): { current: number; best: number } {
  const r = runs(days);
  return { current: r.streak, best: r.best };
}
export const missesInARow = (days: DayInfo[]) => runs(days).missRun;

function adherence(days: DayInfo[], today: string): { pct: number | null; achieved: number; eligible: number } {
  const past = pastDays(days, today);
  const achieved = past.filter((d) => SUCCESS.has(d.status)).length;
  const eligible = achieved + past.filter((d) => MISSED.has(d.status)).length;
  return { pct: eligible ? Math.round((achieved / eligible) * 1000) / 10 : null, achieved, eligible };
}

export async function pointsByPeriod(db: Queryable, participantId: number, periods: Period[]): Promise<{ byPeriod: Map<number, number>; total: number }> {
  const { rows } = await db.query(`SELECT day, sum(points)::int AS p FROM scoring_events WHERE participant_id = $1 GROUP BY day`, [participantId]);
  const byPeriod = new Map<number, number>();
  let total = 0;
  for (const r of rows) {
    total += r.p;
    const per = periods.find((p) => daysBetween(p.startsOn, r.day) >= 0 && daysBetween(r.day, p.endsOn) >= 0);
    if (per) byPeriod.set(per.periodNo, (byPeriod.get(per.periodNo) ?? 0) + r.p);
  }
  return { byPeriod, total };
}

/** The facts for one challenge week (complete, or so far if it's the current week). */
export function weekFacts(ctx: ChallengeContext, days: DayInfo[], period: Period, points: { byPeriod: Map<number, number>; total: number }): WeekFacts {
  const today = ctx.today;
  const cfg = ctx.cfgOn(daysBetween(period.endsOn, today) >= 0 ? period.endsOn : today);
  const upTo = daysBetween(period.endsOn, today) > 0 ? period.endsOn : today;
  const inWeek = days.filter((d) => d.periodNo === period.periodNo && d.status !== 'NOT_PARTICIPATING');
  const happened = pastDays(inWeek, today);
  const count = (pred: (d: DayInfo) => boolean) => happened.filter(pred).length;
  const prevPeriod = ctx.periods.find((p) => p.periodNo === period.periodNo - 1);
  let previous: WeekFacts['previous'] = null;
  if (prevPeriod) {
    const prev = pastDays(days.filter((d) => d.periodNo === prevPeriod.periodNo && d.status !== 'NOT_PARTICIPATING'), today);
    const a = prev.filter((d) => SUCCESS.has(d.status)).length;
    if (prev.length) previous = { periodNo: prevPeriod.periodNo, achieved: a, eligible: a + prev.filter((d) => MISSED.has(d.status)).length };
  }
  // The day's count: a screenshot's number or steps synced from Apple Health (not doubted), whichever is higher.
  const stepsOf = (d: DayInfo) => Math.max(d.submission?.finalValue ?? -1, d.sync && !d.sync.doubted ? d.sync.steps : -1);
  const withSteps = happened.filter((d) => SUCCESS.has(d.status) && stepsOf(d) >= 0);
  const best = withSteps.reduce<DayInfo | null>((b, d) => (!b || stepsOf(d) > stepsOf(b) ? d : b), null);
  // Weakest weekday over the whole challenge so far.
  const missByDay = new Map<string, number>();
  for (const d of pastDays(days, today)) if (MISSED.has(d.status)) missByDay.set(weekday(d.day), (missByDay.get(weekday(d.day)) ?? 0) + 1);
  const worst = [...missByDay.entries()].sort((a, b) => b[1] - a[1])[0];
  const st = streaks(days.filter((d) => daysBetween(d.day, upTo) >= 0));
  const adh = adherence(days.filter((d) => daysBetween(d.day, upTo) >= 0), today);
  const q = cfg.prizes.qualificationAdherencePct / 100;
  const daysLeft = Math.max(0, daysBetween(today, ctx.ch.endsOn));
  let daysToQualify: number | null = null;
  if (adh.pct !== null && adh.pct < cfg.prizes.qualificationAdherencePct && q < 1) {
    const k = Math.ceil((q * adh.eligible - adh.achieved) / (1 - q));
    if (k <= daysLeft) daysToQualify = Math.max(1, k);
  }
  return {
    challengeName: ctx.ch.name, periodNo: period.periodNo, startsOn: period.startsOn, endsOn: period.endsOn,
    complete: daysBetween(period.endsOn, today) > 0, daysInWeek: happened.length,
    achieved: count((d) => SUCCESS.has(d.status)), missed: count((d) => MISSED.has(d.status)),
    rest: count((d) => d.status === 'REST'), excused: count((d) => d.status === 'EXCUSED'), pending: inWeek.filter((d) => PENDING.has(d.status)).length,
    previous,
    stepsAverage: withSteps.length ? Math.round(withSteps.reduce((s, d) => s + stepsOf(d), 0) / withSteps.length) : null,
    bestDay: best ? { day: best.day, steps: stepsOf(best) } : null,
    todayDone: ['ACHIEVED', 'REST', 'EXCUSED'].includes(days.find((d) => d.day === today)?.status ?? ''),
    streak: st.current, bestStreak: st.best,
    adherencePct: adh.pct, qualificationPct: cfg.prizes.qualificationAdherencePct, daysToQualify,
    points: points.byPeriod.get(period.periodNo) ?? 0, pointsTotal: points.total,
    weakestWeekday: worst && worst[1] >= 2 ? worst[0] : null,
    daysLeft, target: cfg.activity.dailyTarget,
  };
}

export function nudgeFacts(ctx: ChallengeContext, days: DayInfo[], now: Date, endOfToday: Date): NudgeFacts {
  const y = days.find((d) => d.day === addDays(ctx.today, -1));
  return {
    challengeName: ctx.ch.name, streak: streaks(days).current,
    hoursLeft: Math.max(0, Math.round((endOfToday.getTime() - now.getTime()) / 3_600_000)),
    target: ctx.cfgOn(ctx.today).activity.dailyTarget, missedYesterday: !!y && MISSED.has(y.status),
  };
}

/** Whether someone might need a hand: 2+ misses in a row, or below the prize line with enough days decided. */
export function riskFacts(ctx: ChallengeContext, days: DayInfo[], p: { participantId: number; userId: number; displayName: string }): RiskFacts | null {
  const today = ctx.today;
  const cfg = ctx.cfgOn(daysBetween(today, ctx.ch.endsOn) >= 0 ? today : ctx.ch.endsOn);
  const misses = missesInARow(days);
  const adh = adherence(days, today);
  const below = adh.pct !== null && adh.eligible >= 5 && adh.pct < cfg.prizes.qualificationAdherencePct;
  if (misses < 2 && !below) return null;
  const lastSuccess = pastDays(days, today).filter((d) => SUCCESS.has(d.status)).at(-1);
  return { ...p, missesInARow: misses, adherencePct: adh.pct, qualificationPct: cfg.prizes.qualificationAdherencePct,
    daysSinceLastSuccess: lastSuccess ? daysBetween(lastSuccess.day, today) : null };
}
