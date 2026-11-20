import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates.js';
import { normalizeConfig, type ChallengeConfig } from '../../src/modules/challenges/config.js';
import { score, weekendKeyOf, type DayClass, type EngineInput } from '../../src/modules/scoring/engine.js';

const calamari = (): ChallengeConfig => normalizeConfig(JSON.parse(readFileSync(new URL('../../config/challenges/calamari-2026.json', import.meta.url), 'utf8')));
const START = '2026-11-22';
const DAYS = Array.from({ length: 40 }, (_, i) => addDays(START, i));

/** Pattern letters per day from 22 Nov ('.' = not participating; shorter patterns leave the rest undecided). */
function classes(pattern: string): Record<string, DayClass> {
  const out: Record<string, DayClass> = {};
  DAYS.forEach((d, i) => { const ch = pattern[i]; out[d] = ch === undefined ? 'U' : ch === '.' ? 'N' : (ch as DayClass); });
  return out;
}
function run(patterns: Record<number, string>, cfg: ChallengeConfig = calamari(), bonuses: EngineInput['bonuses'] = []) {
  return score({ days: DAYS, cfgOn: () => cfg, versionNoOn: () => 1, participants: Object.entries(patterns).map(([id, p]) => ({ participantId: Number(id), classes: classes(p) })), bonuses });
}
const total = (out: ReturnType<typeof run>, pid: number) => out.events.filter((e) => e.participantId === pid).reduce((a, e) => a + e.points, 0);
const rules = (out: ReturnType<typeof run>, pid: number, rule: string) => out.events.filter((e) => e.participantId === pid && e.rule === rule);

describe('Calamari scoring (owner rulings of 20 Nov 2026)', () => {
  it('+10 per successful day', () => {
    const o = run({ 1: 'SSS' });
    expect(rules(o, 1, 'DAILY_SUCCESS').map((e) => e.day)).toEqual(['2026-11-22', '2026-11-23', '2026-11-24']);
    expect(total(o, 1)).toBe(30);
  });

  it('every missed eligible day costs -15 in total - penalties never stack (Mon, Tue, Wed missed = -45)', () => {
    const o = run({ 1: 'MMM', 2: 'SSS' });
    expect(total(o, 1)).toBe(-45);
    expect(rules(o, 1, 'MISSED_DAY')).toHaveLength(3);
    expect(rules(o, 1, 'CONSECUTIVE_MISSES')).toHaveLength(0);
    expect(rules(o, 1, 'TEAM_STREAK_BREAK')).toHaveLength(0);
  });

  it('personal streak +20 at 7, 14, 21, 28, 35 successful days; rest days pause, not reset', () => {
    const o = run({ 1: 'SSSSSSPSSSSSSSP' + 'S'.repeat(25) }); // 38 successes, 2 rest days
    const ms = rules(o, 1, 'PERSONAL_STREAK').map((e) => e.details.streak);
    expect(ms).toEqual([7, 14, 21, 28, 35]);
    expect(rules(o, 1, 'PERSONAL_STREAK')[0]!.day).toBe('2026-11-29'); // 7th success is on day 8 (rest on day 7)
    expect(o.participants[0]).toMatchObject({ currentStreak: 38, longestStreak: 38 });
  });

  it('a new streak after a break earns the milestones again (repeatAfterBreak)', () => {
    const o = run({ 1: 'SSSSSSS' + 'M' + 'SSSSSSS' });
    expect(rules(o, 1, 'PERSONAL_STREAK').map((e) => e.day)).toEqual(['2026-11-28', '2026-12-06']);
    const cfg = calamari(); cfg.scoring.personalStreak.repeatAfterBreak = false;
    expect(rules(run({ 1: 'SSSSSSS' + 'M' + 'SSSSSSS' }, cfg), 1, 'PERSONAL_STREAK')).toHaveLength(1);
  });

  it('comeback +10: two or more misses, then three successes; awarded on the third', () => {
    const two = run({ 1: 'SMMSSS' });
    expect(rules(two, 1, 'COMEBACK').map((e) => e.day)).toEqual(['2026-11-27']);
    const four = run({ 1: 'MMMMSSS' });
    expect(rules(four, 1, 'COMEBACK')).toHaveLength(1); // owner: "two or more"
    const one = run({ 1: 'MSSS' });
    expect(rules(one, 1, 'COMEBACK')).toHaveLength(0);
  });

  it('comeback: a miss during recovery resets it; rest days pause it; at most 3 per challenge', () => {
    expect(rules(run({ 1: 'MMSSMSS' }), 1, 'COMEBACK')).toHaveLength(0);
    expect(rules(run({ 1: 'MMSPSPS' }), 1, 'COMEBACK').map((e) => e.day)).toEqual(['2026-11-28']);
    expect(rules(run({ 1: 'MMPMSSS' }), 1, 'COMEBACK')).toHaveLength(1); // rest between misses: still one run of 2
    const many = run({ 1: 'MMSSS'.repeat(5) });
    expect(rules(many, 1, 'COMEBACK')).toHaveLength(3);
  });

  it('"exactly two" variant for other challenges', () => {
    const cfg = calamari(); cfg.scoring.comeback.missRun = 'EXACTLY';
    expect(rules(run({ 1: 'MMMSSS' }, cfg), 1, 'COMEBACK')).toHaveLength(0);
    expect(rules(run({ 1: 'MMSSS' }, cfg), 1, 'COMEBACK')).toHaveLength(1);
  });

  it('team streak: +10 to everyone taking part on every 8th successful team day; rest days count as success', () => {
    const o = run({ 1: 'SSSSSSSS', 2: 'SSSPSSSS' });
    expect(rules(o, 1, 'TEAM_STREAK').map((e) => e.day)).toEqual(['2026-11-29']);
    expect(rules(o, 2, 'TEAM_STREAK')).toHaveLength(1); // including the one who rested that week
    expect(o.team).toMatchObject({ currentStreak: 8, longestStreak: 8 });
  });

  it('team streak break: recorded with who missed, previous streak and restart day; only they lose points', () => {
    const o = run({ 1: 'SSSM', 2: 'SSSS', 3: 'SSSM' });
    expect(o.team.breaks).toEqual([{ day: '2026-11-25', previousStreak: 3, responsible: [1, 3], restartOn: '2026-11-26' }]);
    expect(total(o, 2)).toBe(40);
    expect(total(o, 1)).toBe(30 - 15);
  });

  it('team-break penalty variants for other challenges: running streak only vs every miss', () => {
    const cfg = calamari();
    cfg.scoring.penalties.missedDay.enabled = false;
    cfg.scoring.penalties.teamStreakBreak = { enabled: true, when: 'RUNNING_STREAK_ONLY', points: -15 };
    const o = run({ 1: 'SMM', 2: 'SSS' }, cfg);
    expect(rules(o, 1, 'TEAM_STREAK_BREAK').map((e) => e.day)).toEqual(['2026-11-23']); // the 24th: streak already 0
    cfg.scoring.penalties.teamStreakBreak.when = 'EVERY_MISS';
    expect(rules(run({ 1: 'SMM', 2: 'SSS' }, cfg), 1, 'TEAM_STREAK_BREAK')).toHaveLength(2);
  });

  it('consecutive-miss penalty variants for other challenges', () => {
    const cfg = calamari();
    cfg.scoring.penalties.missedDay.enabled = false;
    cfg.scoring.penalties.consecutiveMisses = { enabled: true, days: 2, repeat: 'ONCE_PER_RUN', points: -15 };
    const count = () => rules(run({ 1: 'MMMMM' }, cfg), 1, 'CONSECUTIVE_MISSES').length;
    expect(count()).toBe(1);
    cfg.scoring.penalties.consecutiveMisses.repeat = 'EVERY_NTH';
    expect(count()).toBe(2);
    cfg.scoring.penalties.consecutiveMisses.repeat = 'EVERY_MISS_FROM_NTH';
    expect(count()).toBe(4);
    // a rest day between two misses: still consecutive eligible misses (PRD edge case 1)
    cfg.scoring.penalties.consecutiveMisses.repeat = 'ONCE_PER_RUN';
    expect(rules(run({ 1: 'MPM' }, cfg), 1, 'CONSECUTIVE_MISSES')).toHaveLength(1);
  });

  it('weekend bonus: +10, at most one per weekend (Saturday + next Sunday)', () => {
    expect(weekendKeyOf('2026-11-28', 'SAT_NEXT_SUN')).toBe('2026-11-28');
    expect(weekendKeyOf('2026-11-29', 'SAT_NEXT_SUN')).toBe('2026-11-28');
    expect(weekendKeyOf('2026-11-22', 'SAT_NEXT_SUN')).toBe('2026-11-21'); // the lone first Sunday
    expect(weekendKeyOf('2026-11-25', 'SAT_NEXT_SUN')).toBeNull();
    const o = run({ 1: 'SSSSSSSS' }, calamari(), [
      { participantId: 1, weekendKey: '2026-11-28', bonusSubmissionId: 1, approvedOn: '2026-11-29' },
      { participantId: 1, weekendKey: '2026-11-28', bonusSubmissionId: 2, approvedOn: '2026-11-29' },
    ]);
    expect(rules(o, 1, 'WEEKEND_BONUS')).toHaveLength(1);
  });

  it('nothing after an undecided day is scored in sequences; daily points still are', () => {
    const o = run({ 1: 'SSSSSSUS' });
    expect(rules(o, 1, 'PERSONAL_STREAK')).toHaveLength(0); // the 7th success comes after the pending day
    expect(rules(o, 1, 'DAILY_SUCCESS')).toHaveLength(7);
    expect(o.participants[0]!.decidedThrough).toBe('2026-11-27');
    // team sequences stop at a day where anyone is undecided
    expect(run({ 1: 'SSU', 2: 'SSS' }).team.decidedThrough).toBe('2026-11-23');
  });

  it('late joiner: no points or penalties before their first day; they count for team days from then', () => {
    const o = run({ 1: 'SSSSSSSS', 2: '...SSSSS' });
    expect(rules(o, 2, 'DAILY_SUCCESS')).toHaveLength(5);
    expect(rules(o, 2, 'MISSED_DAY')).toHaveLength(0);
    expect(rules(o, 2, 'TEAM_STREAK')).toHaveLength(1); // on the 8th team day they were taking part
  });

  it('withdrawn participant stops affecting team days after leaving', () => {
    const o = run({ 1: 'SSSSSSSS', 2: 'SSS.....' });
    expect(o.team.breaks).toHaveLength(0);
    expect(rules(o, 1, 'TEAM_STREAK')).toHaveLength(1);
  });

  it('every event key is unique and stable (re-running gives the same events)', () => {
    const a = run({ 1: 'SMMSSSPSSSSSSSS', 2: 'SSSSMSSSS' });
    const b = run({ 1: 'SMMSSSPSSSSSSSS', 2: 'SSSSMSSSS' });
    expect(new Set(a.events.map((e) => e.baseKey)).size).toBe(a.events.length);
    expect(b.events).toEqual(a.events);
  });

  it('a full Calamari example adds up', () => {
    // 40 days: 34 successes, 4 misses (two runs of 2, each followed by 3+ successes), 2 rest days.
    const p = 'SSSSSPS' + 'MMSSSSS' + 'SSSSSPS' + 'SSMMSSS' + 'SSSSSSS' + 'SSSSS';
    const o = run({ 1: p });
    const s = (r: string) => rules(o, 1, r).reduce((a, e) => a + e.points, 0);
    expect(rules(o, 1, 'DAILY_SUCCESS')).toHaveLength(34);
    expect(s('MISSED_DAY')).toBe(-60);
    expect(s('COMEBACK')).toBe(20);
    // Streak runs: 6 (then misses), 13 (then misses), 15 -> milestones 7 | 7, 14.
    expect(rules(o, 1, 'PERSONAL_STREAK').map((e) => e.details.streak)).toEqual([7, 7, 14]);
    // Alone, every successful day is also a team day: team runs of 7, 14 and 15 days -> +10 twice.
    expect(rules(o, 1, 'TEAM_STREAK').map((e) => e.day)).toEqual(['2026-12-08', '2026-12-24']);
    expect(total(o, 1)).toBe(340 - 60 + 20 + 60 + 20);
  });
});
