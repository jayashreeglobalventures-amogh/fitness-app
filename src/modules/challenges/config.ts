// The configuration of a challenge: every rule the engine applies comes from here, never from constants in code.
// Shape: a TypeBox schema (structure + types, checked by Ajv-compatible validation); meaning: semanticChecks()
// (dates, totals, percentages, consistency). Errors block saving; warnings are shown to the admin but allowed
// (e.g. a rule the owner hasn't decided yet).
//
// Money is integer paise (₹1 = 100). Days are 'YYYY-MM-DD' in basics.timeZone. Times are 'HH:MM' local.
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { stableStringify } from '../../core/json.js';
import { computePeriods, daysBetween, isValidDate, isValidTimeZone, TIME_RE, WEEKDAYS, type Period } from '../../core/dates.js';

const Day = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const Time = Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' });
const Paise = Type.Integer({ minimum: 0, maximum: 100_000_000_00 });
const Pct = Type.Number({ minimum: 0, maximum: 100 });
const Points = Type.Integer({ minimum: -1000, maximum: 1000 });
const Weekday = Type.Union(WEEKDAYS.map((d) => Type.Literal(d)));
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

export const RANKING_KEYS = ['POINTS', 'ADHERENCE', 'SUCCESSFUL_DAYS', 'LONGEST_PERSONAL_STREAK', 'EARLIEST_FINAL_SCORE'] as const;

const ContributionSplit = Type.Object({
  total: Paise,
  mainPool: Paise,
  finePool: Paise,
}, { additionalProperties: false });

export const ChallengeConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  basics: Type.Object({
    name: Type.String({ minLength: 2, maxLength: 80 }),
    description: Type.String({ maxLength: 4000 }),
    category: Type.String({ minLength: 2, maxLength: 40 }), // e.g. WALKING, STRENGTH, TRANSFORMATION
    timeZone: Type.String({ minLength: 1, maxLength: 64 }),
    startDate: Day,
    endDate: Day,
    visibility: Type.Union([Type.Literal('INVITED_ONLY'), Type.Literal('ALL_MEMBERS')]),
  }, { additionalProperties: false }),
  registration: Type.Object({
    method: Type.Union([Type.Literal('INVITE_ONLY'), Type.Literal('OPEN'), Type.Literal('APPROVAL')]),
    deadline: Nullable(Day),
    maxParticipants: Nullable(Type.Integer({ minimum: 1, maximum: 10_000 })),
    invitationValidDays: Type.Integer({ minimum: 1, maximum: 90 }),
    lockRosterAtStart: Type.Boolean(),
  }, { additionalProperties: false }),
  activity: Type.Object({
    metric: Type.String({ pattern: '^[a-z][a-z0-9_]{1,31}$' }), // steps, pushups, minutes, km ...
    label: Type.String({ minLength: 1, maxLength: 40 }),
    unit: Type.String({ minLength: 1, maxLength: 20 }),
    dailyTarget: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
  }, { additionalProperties: false }),
  periods: Type.Object({
    weekStartsOn: Weekday,
  }, { additionalProperties: false }),
  submission: Type.Object({
    evidence: Type.Union([Type.Literal('SCREENSHOT')]),
    instructions: Type.String({ maxLength: 1000 }),
    // The deadline of a day is midnight at its end (local). Late evidence never counts for an earlier day.
    deadline: Type.Literal('END_OF_DAY'),
  }, { additionalProperties: false }),
  verification: Type.Object({
    mode: Type.Union([Type.Literal('AI_ASSISTED'), Type.Literal('MANUAL')]),
    autoApproveMinConfidence: Type.Number({ minimum: 0.5, maximum: 1 }),
  }, { additionalProperties: false }),
  restDays: Type.Object({
    enabled: Type.Boolean(),
    perPeriod: Type.Integer({ minimum: 0, maximum: 7 }),
    maxTotal: Type.Integer({ minimum: 0, maximum: 366 }),
    declareBefore: Time, // local time on the rest day itself
  }, { additionalProperties: false }),
  exemptions: Type.Object({
    enabled: Type.Boolean(),
    // null = not decided yet: every request then goes to Admin review (no vote).
    voting: Nullable(Type.Object({
      requesterMayVote: Type.Boolean(),
      minVotes: Type.Integer({ minimum: 1, maximum: 10_000 }),
      approvalThresholdPct: Type.Number({ minimum: 1, maximum: 100 }),
      votingHours: Type.Integer({ minimum: 1, maximum: 24 * 14 }),
      adminOverride: Type.Boolean(),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  scoring: Type.Object({
    dailySuccess: Points,
    personalStreak: Type.Object({
      milestones: Type.Array(Type.Integer({ minimum: 1, maximum: 366 }), { maxItems: 50 }),
      points: Points,
      // true: a new streak after a break earns the milestones again; false: each milestone once per challenge.
      repeatAfterBreak: Type.Boolean(),
    }, { additionalProperties: false }),
    teamStreak: Type.Object({ enabled: Type.Boolean(), everyDays: Type.Integer({ minimum: 1, maximum: 366 }), points: Points }, { additionalProperties: false }),
    comeback: Type.Object({
      enabled: Type.Boolean(),
      missedDays: Type.Integer({ minimum: 1, maximum: 30 }),
      // EXACTLY: only a run of exactly missedDays misses; AT_LEAST: missedDays or more.
      missRun: Type.Union([Type.Literal('EXACTLY'), Type.Literal('AT_LEAST')]),
      recoveryDays: Type.Integer({ minimum: 1, maximum: 30 }),
      points: Points,
      maxAwards: Type.Integer({ minimum: 0, maximum: 100 }),
    }, { additionalProperties: false }),
    weekendBonus: Type.Object({
      enabled: Type.Boolean(),
      points: Points,
      maxPerWeekend: Type.Integer({ minimum: 0, maximum: 2 }),
      // SAT_NEXT_SUN: Saturday + the following Sunday; SUN_SAT_SAME_WEEK: the Sunday and Saturday of one week.
      weekend: Type.Union([Type.Literal('SAT_NEXT_SUN'), Type.Literal('SUN_SAT_SAME_WEEK')]),
    }, { additionalProperties: false }),
    penalties: Type.Object({
      // Every missed eligible day (no evidence, below target, rejected).
      missedDay: Type.Object({ enabled: Type.Boolean(), points: Points }, { additionalProperties: false }),
      consecutiveMisses: Type.Object({
        enabled: Type.Boolean(),
        days: Type.Integer({ minimum: 1, maximum: 30 }),
        // ONCE_PER_RUN: when a run reaches `days`; EVERY_NTH: at days, 2*days, ...; EVERY_MISS_FROM_NTH: every miss from `days` on.
        repeat: Type.Union([Type.Literal('ONCE_PER_RUN'), Type.Literal('EVERY_NTH'), Type.Literal('EVERY_MISS_FROM_NTH')]),
        points: Points,
      }, { additionalProperties: false }),
      teamStreakBreak: Type.Object({
        enabled: Type.Boolean(),
        // RUNNING_STREAK_ONLY: only when a team streak of at least 1 day ends; EVERY_MISS: every miss, even at 0.
        when: Type.Union([Type.Literal('RUNNING_STREAK_ONLY'), Type.Literal('EVERY_MISS')]),
        points: Points,
      }, { additionalProperties: false }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  finance: Type.Object({
    enabled: Type.Boolean(),
    currency: Type.Literal('INR'),
    contribution: ContributionSplit, // per full period (week)
    // Different amounts for specific periods (e.g. a short final week).
    periodOverrides: Type.Array(Type.Composite([Type.Object({ periodNo: Type.Integer({ minimum: 1 }) }), ContributionSplit], { additionalProperties: false }), { maxItems: 60 }),
    finePerMissedDay: Paise,
    // What happens to money left in a person's fine pool when the week closes:
    // REFUND (owed back to them), PRIZE_POOL (the prize pool), YEAR_END_POOL (a separate year-end pool).
    unusedFinePool: Type.Union([Type.Literal('REFUND'), Type.Literal('PRIZE_POOL'), Type.Literal('YEAR_END_POOL')]),
    dueWeekday: Weekday,
    // Days after the due day before an unpaid contribution is shown as overdue. Never affects points.
    graceDays: Type.Integer({ minimum: 0, maximum: 14 }),
    paymentInstructions: Type.String({ maxLength: 1000 }),
  }, { additionalProperties: false }),
  prizes: Type.Object({
    qualificationAdherencePct: Pct,
    // Admin-configurable split of the prize pool; null until decided (needed before settlement, not before start).
    qualificationPoolPct: Nullable(Pct),
    topThreePct: Nullable(Pct),
    topThreeSplitPct: Nullable(Type.Tuple([Pct, Pct, Pct])),
    distribution: Nullable(Type.Union([Type.Literal('EQUAL'), Type.Literal('PROPORTIONAL')])),
    // A top-three place held by someone not eligible: NEXT_ELIGIBLE (the next eligible person moves up) or
    // TO_QUALIFICATION_POOL (that place's money joins the pool shared by all qualifiers).
    topThreeIneligible: Type.Union([Type.Literal('NEXT_ELIGIBLE'), Type.Literal('TO_QUALIFICATION_POOL')]),
    payoutDate: Nullable(Day),
  }, { additionalProperties: false }),
  community: Type.Object({
    enabled: Type.Boolean(),
    participantsCanPost: Type.Boolean(),   // false: only admins post (announcements); everyone can still react and comment
    photos: Type.Boolean(),
  }, { additionalProperties: false }),
  coach: Type.Object({
    weeklySummary: Type.Boolean(),         // a personal summary after each challenge week
    eveningNudge: Type.Boolean(),          // a personal reminder in the evening if today's steps aren't in yet
    nudgeTime: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),   // local time, e.g. "20:00"
    atRiskAlerts: Type.Boolean(),          // tell admins who might need a hand (misses in a row, below the prize line)
  }, { additionalProperties: false }),
  leaderboard: Type.Object({
    ranking: Type.Array(Type.Union(RANKING_KEYS.map((k) => Type.Literal(k))), { minItems: 1, maxItems: RANKING_KEYS.length }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type ChallengeConfig = Static<typeof ChallengeConfigSchema>;

/** Sections that only a Super Admin may change (financial allocations; PRD 12). */
export const FINANCIAL_SECTIONS = ['finance', 'prizes'] as const;

export interface ConfigIssue { path: string; message: string }
export interface ConfigCheck { ok: boolean; errors: ConfigIssue[]; warnings: ConfigIssue[]; periods: Period[] }

/**
 * Settings saved before a field existed get that field's PRD default when read, so older challenges keep working.
 * (Calamari's own settings file states every value explicitly.)
 */
export function normalizeConfig<T>(input: T): T {
  if (!input || typeof input !== 'object') return input;
  const c = structuredClone(input) as Record<string, any>;
  if (c.prizes && typeof c.prizes === 'object' && c.prizes.topThreeIneligible === undefined) c.prizes.topThreeIneligible = 'NEXT_ELIGIBLE';
  if (c.community === undefined && c.schemaVersion !== undefined) c.community = { enabled: true, participantsCanPost: true, photos: true };
  if (c.coach === undefined && c.schemaVersion !== undefined) c.coach = { weeklySummary: true, eveningNudge: true, nudgeTime: '20:00', atRiskAlerts: true };
  const f = c.finance;
  if (f && typeof f === 'object') {
    if (f.unusedFinePool === undefined) f.unusedFinePool = 'REFUND'; // owner default (20 Nov 2026)
    if (f.graceDays === undefined) f.graceDays = 2;
  }
  const s = c.scoring;
  if (s && typeof s === 'object') {
    if (s.personalStreak && s.personalStreak.repeatAfterBreak === undefined) s.personalStreak.repeatAfterBreak = true;
    if (s.comeback && s.comeback.missRun === undefined) s.comeback.missRun = 'EXACTLY';
    if (s.weekendBonus && s.weekendBonus.weekend === undefined) s.weekendBonus.weekend = 'SAT_NEXT_SUN';
    if (s.penalties && typeof s.penalties === 'object') {
      if (s.penalties.missedDay === undefined) s.penalties.missedDay = { enabled: false, points: 0 };
      if (s.penalties.consecutiveMisses && s.penalties.consecutiveMisses.repeat === undefined) s.penalties.consecutiveMisses.repeat = 'ONCE_PER_RUN';
      if (s.penalties.teamStreakBreak && s.penalties.teamStreakBreak.when === undefined) s.penalties.teamStreakBreak.when = 'RUNNING_STREAK_ONLY';
    }
  }
  return c as T;
}

export function validateConfig(raw: unknown): ConfigCheck {
  const input = normalizeConfig(raw);
  const errors: ConfigIssue[] = [];
  for (const e of Value.Errors(ChallengeConfigSchema, input)) {
    errors.push({ path: e.path || '/', message: e.message });
    if (errors.length >= 25) break;
  }
  if (errors.length) return { ok: false, errors, warnings: [], periods: [] };
  return semanticChecks(input as ChallengeConfig);
}

function semanticChecks(c: ChallengeConfig): ConfigCheck {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });
  const b = c.basics;

  if (!isValidTimeZone(b.timeZone)) err('/basics/timeZone', `Unknown time zone "${b.timeZone}".`);
  for (const [k, v] of [['startDate', b.startDate], ['endDate', b.endDate]] as const) if (!isValidDate(v)) err(`/basics/${k}`, 'Not a real calendar date.');
  if (errors.length) return { ok: false, errors, warnings, periods: [] };
  const length = daysBetween(b.startDate, b.endDate) + 1;
  if (length < 1) err('/basics/endDate', 'The end date must be on or after the start date.');
  if (length > 366) err('/basics/endDate', 'A challenge can last at most 366 days.');
  if (errors.length) return { ok: false, errors, warnings, periods: [] };
  const periods = computePeriods(b.startDate, b.endDate, c.periods.weekStartsOn);

  const r = c.registration;
  if (r.deadline !== null && (!isValidDate(r.deadline) || daysBetween(r.deadline, b.endDate) < 0)) err('/registration/deadline', 'The registration deadline must be a real date no later than the end date.');

  if (!TIME_RE.test(c.restDays.declareBefore)) err('/restDays/declareBefore', 'Use HH:MM (24-hour).');
  if (c.restDays.enabled) {
    const possible = c.restDays.perPeriod * periods.length;
    if (c.restDays.maxTotal > possible) warn('/restDays/maxTotal', `At most ${possible} rest days can actually be taken (${c.restDays.perPeriod} × ${periods.length} periods).`);
  }

  if (c.exemptions.enabled && c.exemptions.voting === null) warn('/exemptions/voting', 'Exemption voting is not configured yet: every exemption request will go to Admin review.');

  const s = c.scoring;
  const ms = s.personalStreak.milestones;
  if (ms.some((m, i) => i > 0 && m <= ms[i - 1]!)) err('/scoring/personalStreak/milestones', 'Milestones must be in increasing order without repeats.');
  if (ms.some((m) => m > length)) warn('/scoring/personalStreak/milestones', `Some milestones are longer than the challenge (${length} days) and can never be reached.`);
  for (const [path, v] of [['/scoring/dailySuccess', s.dailySuccess], ['/scoring/personalStreak/points', s.personalStreak.points], ['/scoring/teamStreak/points', s.teamStreak.points], ['/scoring/comeback/points', s.comeback.points], ['/scoring/weekendBonus/points', s.weekendBonus.points]] as const) {
    if (v < 0) err(path, 'Rewards must not be negative (use penalties for deductions).');
  }
  for (const [path, v] of [['/scoring/penalties/missedDay/points', s.penalties.missedDay.points], ['/scoring/penalties/consecutiveMisses/points', s.penalties.consecutiveMisses.points], ['/scoring/penalties/teamStreakBreak/points', s.penalties.teamStreakBreak.points]] as const) {
    if (v > 0) err(path, 'A penalty must be zero or negative.');
  }

  const stacking = [s.penalties.missedDay.enabled, s.penalties.consecutiveMisses.enabled, s.penalties.teamStreakBreak.enabled].filter(Boolean).length;
  if (stacking > 1) warn('/scoring/penalties', 'More than one penalty is on: they add up on the same missed day.');

  const f = c.finance;
  const split = (path: string, x: { total: number; mainPool: number; finePool: number }) => {
    if (x.mainPool + x.finePool !== x.total) err(path, `Main pool + fine pool (${rupees(x.mainPool + x.finePool)}) must equal the contribution (${rupees(x.total)}).`);
  };
  if (f.enabled) {
    split('/finance/contribution', f.contribution);
    const seen = new Set<number>();
    f.periodOverrides.forEach((o, i) => {
      split(`/finance/periodOverrides/${i}`, o);
      if (o.periodNo > periods.length) err(`/finance/periodOverrides/${i}/periodNo`, `There are only ${periods.length} periods.`);
      if (seen.has(o.periodNo)) err(`/finance/periodOverrides/${i}/periodNo`, `Period ${o.periodNo} has more than one override.`);
      seen.add(o.periodNo);
    });
    for (const p of periods) {
      if (p.days < 7 && !seen.has(p.periodNo)) warn('/finance/periodOverrides', `Period ${p.periodNo} (${p.startsOn} – ${p.endsOn}) has only ${p.days} days but uses the full-week contribution.`);
    }
    if (f.finePerMissedDay === 0) warn('/finance/finePerMissedDay', 'Missed days cost nothing.');
  }

  const p = c.prizes;
  if (p.qualificationPoolPct !== null && p.topThreePct !== null && Math.abs(p.qualificationPoolPct + p.topThreePct - 100) > 1e-9) {
    err('/prizes', `Qualification pool (${p.qualificationPoolPct}%) + top-three bonus (${p.topThreePct}%) must total 100%.`);
  }
  if (p.topThreeSplitPct !== null && Math.abs(p.topThreeSplitPct.reduce((a, x) => a + x, 0) - 100) > 1e-9) err('/prizes/topThreeSplitPct', '1st + 2nd + 3rd must total 100%.');
  if (p.payoutDate !== null && (!isValidDate(p.payoutDate) || daysBetween(b.endDate, p.payoutDate) < 0)) err('/prizes/payoutDate', 'The payout date must be on or after the end date.');
  if (p.qualificationPoolPct === null || p.topThreePct === null || p.topThreeSplitPct === null || p.distribution === null) {
    warn('/prizes', 'The prize split is not fully configured yet (needed before final settlement).');
  }

  const rk = c.leaderboard.ranking;
  if (new Set(rk).size !== rk.length) err('/leaderboard/ranking', 'Each ranking criterion may appear only once.');

  return { ok: errors.length === 0, errors, warnings, periods };
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

/** The contribution due for a period: its override, else the full-period amount. */
export function contributionFor(c: ChallengeConfig, periodNo: number): { total: number; mainPool: number; finePool: number } {
  const o = c.finance.periodOverrides.find((x) => x.periodNo === periodNo);
  return o ? { total: o.total, mainPool: o.mainPool, finePool: o.finePool } : c.finance.contribution;
}

/** Top-level sections whose content differs between two configurations. */
export function changedSections(a: ChallengeConfig, b: ChallengeConfig): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ChallengeConfig>;
  return [...keys].filter((k) => stableStringify(a[k]) !== stableStringify(b[k]));
}
