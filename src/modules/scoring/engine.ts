// The scoring engine: a PURE function from facts to the points events that should exist.
// Facts: each participant's class on each day, the rules in force on each day, approved weekend bonuses.
// It never reads the clock or the database, so every rule is unit-tested directly (test/unit/scoring.test.ts).
//
// Day classes:  S success (target achieved)   M missed eligible day (no evidence, below target, rejected)
//               P paused (rest day / approved exemption: not eligible, pauses sequences, team day still OK)
//               U undecided (pending review, pending exemption, not over yet)   N not participating
// Sequences (streaks, comebacks, consecutive misses, team streak) run over eligible days in order, skipping P, and
// stop at the first U: nothing after an undecided day is scored until it is decided. Daily points/penalties don't
// depend on order and are scored for every decided day.
import { addDays, weekdayOf } from '../../core/dates.js';
import type { ChallengeConfig } from '../challenges/config.js';

export type DayClass = 'S' | 'M' | 'P' | 'U' | 'N';
export type Rule = 'DAILY_SUCCESS' | 'PERSONAL_STREAK' | 'TEAM_STREAK' | 'COMEBACK' | 'WEEKEND_BONUS' | 'MISSED_DAY' | 'CONSECUTIVE_MISSES' | 'TEAM_STREAK_BREAK' | 'TEAM_STREAK_BROKEN';

export interface DesiredEvent {
  baseKey: string;
  participantId: number | null;
  rule: Rule;
  day: string;
  points: number;
  versionNo: number;
  details: Record<string, unknown>;
}

export interface EngineInput {
  days: string[];                                   // every challenge day, in order
  cfgOn(day: string): ChallengeConfig;
  versionNoOn(day: string): number;
  participants: { participantId: number; classes: Record<string, DayClass> }[];
  bonuses: { participantId: number; weekendKey: string; bonusSubmissionId: number; approvedOn: string }[];
}

export interface ParticipantState {
  participantId: number;
  currentStreak: number;      // consecutive successful eligible days up to the last decided day
  longestStreak: number;
  comebacks: number;
  decidedThrough: string | null; // last day the sequences reached (before the first undecided day)
}

export interface EngineOutput {
  events: DesiredEvent[];
  participants: ParticipantState[];
  team: { currentStreak: number; longestStreak: number; decidedThrough: string | null; breaks: { day: string; previousStreak: number; responsible: number[]; restartOn: string }[] };
}

/** The weekend a day belongs to, identified by its first day; null if the day is not a weekend day. */
export function weekendKeyOf(day: string, mode: 'SAT_NEXT_SUN' | 'SUN_SAT_SAME_WEEK'): string | null {
  const wd = weekdayOf(day);
  if (mode === 'SAT_NEXT_SUN') return wd === 'SATURDAY' ? day : wd === 'SUNDAY' ? addDays(day, -1) : null;
  return wd === 'SUNDAY' ? day : wd === 'SATURDAY' ? addDays(day, -6) : null;
}

export function score(input: EngineInput): EngineOutput {
  const events: DesiredEvent[] = [];
  const emit = (e: Omit<DesiredEvent, 'versionNo'>) => events.push({ ...e, versionNo: input.versionNoOn(e.day) });
  const states: ParticipantState[] = [];

  for (const p of input.participants) {
    const pid = p.participantId;
    // 1. Day-by-day points (order-independent).
    for (const d of input.days) {
      const c = p.classes[d] ?? 'N';
      const sc = input.cfgOn(d).scoring;
      if (c === 'S' && sc.dailySuccess !== 0) emit({ baseKey: `daily:${pid}:${d}`, participantId: pid, rule: 'DAILY_SUCCESS', day: d, points: sc.dailySuccess, details: {} });
      if (c === 'M' && sc.penalties.missedDay.enabled && sc.penalties.missedDay.points !== 0) {
        emit({ baseKey: `miss:${pid}:${d}`, participantId: pid, rule: 'MISSED_DAY', day: d, points: sc.penalties.missedDay.points, details: {} });
      }
    }

    // 2. Sequences over eligible days.
    let streak = 0, streakStart: string | null = null, longest = 0;
    const milestonesOnce = new Set<number>();
    let missRun = 0, missRunStart: string | null = null;
    let comebackArmed = false, recovery = 0, comebacks = 0, armedRun = 0;
    let decidedThrough: string | null = null;
    for (const d of input.days) {
      const c = p.classes[d] ?? 'N';
      if (c === 'N' || c === 'P') { if (c === 'P') decidedThrough = d; continue; }
      if (c === 'U') break;
      decidedThrough = d;
      const sc = input.cfgOn(d).scoring;
      if (c === 'S') {
        // Comeback: the first success after a run of misses arms it (if the run qualifies); then count successes.
        if (missRun > 0) {
          const cb = sc.comeback;
          comebackArmed = cb.enabled && (cb.missRun === 'EXACTLY' ? missRun === cb.missedDays : missRun >= cb.missedDays);
          armedRun = missRun;
          recovery = 0;
        }
        if (comebackArmed) {
          recovery++;
          if (recovery === sc.comeback.recoveryDays) {
            comebackArmed = false;
            if (comebacks < sc.comeback.maxAwards && sc.comeback.points !== 0) {
              comebacks++;
              emit({ baseKey: `comeback:${pid}:${d}`, participantId: pid, rule: 'COMEBACK', day: d, points: sc.comeback.points, details: { missedRun: armedRun, recoveryDays: recovery, award: comebacks } });
            }
          }
        }
        missRun = 0; missRunStart = null;
        if (streak === 0) streakStart = d;
        streak++;
        longest = Math.max(longest, streak);
        const ps = sc.personalStreak;
        if (ps.milestones.includes(streak) && ps.points !== 0) {
          if (ps.repeatAfterBreak) emit({ baseKey: `pstreak:${pid}:${streakStart}:${streak}`, participantId: pid, rule: 'PERSONAL_STREAK', day: d, points: ps.points, details: { streak, since: streakStart } });
          else if (!milestonesOnce.has(streak)) {
            milestonesOnce.add(streak);
            emit({ baseKey: `pstreak:${pid}:${streak}`, participantId: pid, rule: 'PERSONAL_STREAK', day: d, points: ps.points, details: { streak, since: streakStart } });
          }
        }
      } else { // M
        streak = 0; streakStart = null;
        comebackArmed = false; recovery = 0; // a miss during recovery resets it
        if (missRun === 0) missRunStart = d;
        missRun++;
        const cm = input.cfgOn(d).scoring.penalties.consecutiveMisses;
        if (cm.enabled && cm.points !== 0) {
          const hit = cm.repeat === 'ONCE_PER_RUN' ? missRun === cm.days : cm.repeat === 'EVERY_NTH' ? missRun % cm.days === 0 : missRun >= cm.days;
          if (hit) emit({ baseKey: `cmiss:${pid}:${missRunStart}:${missRun}`, participantId: pid, rule: 'CONSECUTIVE_MISSES', day: d, points: cm.points, details: { missRun, since: missRunStart } });
        }
      }
    }
    states.push({ participantId: pid, currentStreak: streak, longestStreak: longest, comebacks, decidedThrough });
  }

  // 3. Team streak: a team day succeeds when every participant taking part that day succeeded or was paused.
  let tStreak = 0, tLongest = 0, tThrough: string | null = null;
  const breaks: EngineOutput['team']['breaks'] = [];
  for (const d of input.days) {
    const on = input.participants.filter((p) => (p.classes[d] ?? 'N') !== 'N');
    if (!on.length) continue;
    if (on.some((p) => p.classes[d] === 'U')) break;
    tThrough = d;
    const sc = input.cfgOn(d).scoring;
    const missed = on.filter((p) => p.classes[d] === 'M').map((p) => p.participantId);
    if (!missed.length) {
      tStreak++;
      tLongest = Math.max(tLongest, tStreak);
      if (sc.teamStreak.enabled && sc.teamStreak.points !== 0 && tStreak % sc.teamStreak.everyDays === 0) {
        for (const p of on) emit({ baseKey: `tstreak:${p.participantId}:${d}`, participantId: p.participantId, rule: 'TEAM_STREAK', day: d, points: sc.teamStreak.points, details: { teamStreak: tStreak } });
      }
      continue;
    }
    const pen = sc.penalties.teamStreakBreak;
    if (pen.enabled && pen.points !== 0 && (pen.when === 'EVERY_MISS' || tStreak > 0)) {
      for (const pid of missed) emit({ baseKey: `tbreakpen:${pid}:${d}`, participantId: pid, rule: 'TEAM_STREAK_BREAK', day: d, points: pen.points, details: { previousStreak: tStreak } });
    }
    if (tStreak > 0) {
      const b = { day: d, previousStreak: tStreak, responsible: missed, restartOn: addDays(d, 1) };
      breaks.push(b);
      emit({ baseKey: `tbreak:${d}`, participantId: null, rule: 'TEAM_STREAK_BROKEN', day: d, points: 0, details: { ...b, penaltyEach: pen.enabled ? pen.points : 0 } });
    }
    tStreak = 0;
  }

  // 4. Weekend bonuses: approved activities, at most maxPerWeekend per participant per weekend.
  const byWeekend = new Map<string, EngineInput['bonuses']>();
  for (const b of [...input.bonuses].sort((a, b) => a.bonusSubmissionId - b.bonusSubmissionId)) {
    const k = `${b.participantId}:${b.weekendKey}`;
    byWeekend.set(k, [...(byWeekend.get(k) ?? []), b]);
  }
  for (const list of byWeekend.values()) {
    const first = list[0]!;
    const day = input.days.find((d) => d >= first.weekendKey) ?? input.days[0]!;
    const wb = input.cfgOn(day).scoring.weekendBonus;
    if (!wb.enabled || wb.points === 0) continue;
    list.slice(0, wb.maxPerWeekend).forEach((b, i) => {
      emit({ baseKey: `bonus:${b.participantId}:${b.weekendKey}:${i + 1}`, participantId: b.participantId, rule: 'WEEKEND_BONUS', day, points: wb.points, details: { weekend: b.weekendKey, bonusSubmissionId: b.bonusSubmissionId } });
    });
  }

  return { events, participants: states, team: { currentStreak: tStreak, longestStreak: tLongest, decidedThrough: tThrough, breaks } };
}
