import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addDays, weekdayOf } from '../../src/core/dates.js';
import { normalizeConfig, type ChallengeConfig } from '../../src/modules/challenges/config.js';
import { DEMO_PEOPLE, DEMO_SCRIPT } from '../../src/modules/scoring/demo.js';
import { score, weekendKeyOf, type DayClass } from '../../src/modules/scoring/engine.js';

describe('the Demo tab example (Calamari rules)', () => {
  const cfg: ChallengeConfig = normalizeConfig(JSON.parse(readFileSync(new URL('../../config/challenges/calamari-2026.json', import.meta.url), 'utf8')));
  const days = Array.from({ length: 14 }, (_, i) => addDays('2026-11-22', i));
  const sat = days.find((d) => weekdayOf(d) === 'SATURDAY')!;
  const out = score({
    days, cfgOn: () => cfg, versionNoOn: () => 1,
    participants: DEMO_PEOPLE.map((p, i) => ({ participantId: i + 1, classes: Object.fromEntries(days.map((d, j) => { const c = DEMO_SCRIPT[p][j]!; return [d, (c === 'R' || c === 'E' ? 'P' : c) as DayClass]; })) })),
    bonuses: [{ participantId: 4, weekendKey: weekendKeyOf(sat, 'SAT_NEXT_SUN')!, bonusSubmissionId: 1, approvedOn: sat }],
  });
  const of = (pid: number) => out.events.filter((e) => e.participantId === pid).reduce((a, e) => a + e.points, 0);

  it('shows every Calamari rule at least once', () => {
    const rules = new Set(out.events.map((e) => e.rule));
    for (const r of ['DAILY_SUCCESS', 'MISSED_DAY', 'PERSONAL_STREAK', 'TEAM_STREAK', 'TEAM_STREAK_BROKEN', 'COMEBACK', 'WEEKEND_BONUS']) expect(rules).toContain(r);
  });

  it('adds up as the story says', () => {
    // Asha 14 days + streaks at 7 and 14 + team bonus on day 8 = 140 + 40 + 10.
    expect(of(1)).toBe(190);
    // Esha: 12 successes, 2 misses (-30), 7-day streak before the misses (+20), team bonus on day 8, comeback.
    expect(of(5)).toBe(120 - 30 + 20 + 10 + 10);
    // Dev: 13 successes, 1 miss, team bonus, weekend bonus, streak milestone at 7 (and none after the miss).
    expect(of(4)).toBe(130 - 15 + 10 + 10 + 20);
    expect(out.team.breaks.map((b) => [b.day, b.responsible])).toEqual([['2026-11-30', [5]], ['2026-12-03', [4]]]);
  });
});
