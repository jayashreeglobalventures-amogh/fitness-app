// Demo: five people over the first two weeks, scored by the SAME engine the server uses (src/modules/scoring/engine.ts)
// with this challenge's current rules - so the example can never disagree with real points. Tap a day to change it.
import { useMemo, useState } from 'react';
import type { ChallengeConfig } from '../../../src/modules/challenges/config';
import { addDays, weekdayOf } from '../../../src/core/dates';
import { score, weekendKeyOf, type DayClass, type DesiredEvent } from '../../../src/modules/scoring/engine';
import { DEMO_PEOPLE, DEMO_SCRIPT } from '../../../src/modules/scoring/demo';
import { day as fmtDay } from '../ui';
import type { ChallengeView } from './Challenge';

type Cell = 'S' | 'M' | 'R' | 'E';
const PEOPLE: string[] = [...DEMO_PEOPLE];
const SCRIPT: Record<string, string> = DEMO_SCRIPT;
const CELL_LABEL: Record<Cell, string> = { S: 'Target reached', M: 'Missed', R: 'Rest day', E: 'Excused (exemption)' };
const CELL_STATUS: Record<Cell, string> = { S: 'ACHIEVED', M: 'MISSED_DEADLINE', R: 'REST', E: 'EXCUSED' };
const RULE_LABEL: Record<string, string> = {
  DAILY_SUCCESS: 'Daily target', PERSONAL_STREAK: 'Personal streak', TEAM_STREAK: 'Team streak', COMEBACK: 'Comeback', WEEKEND_BONUS: 'Weekend bonus',
  MISSED_DAY: 'Missed day', CONSECUTIVE_MISSES: 'Missed days in a row', TEAM_STREAK_BREAK: 'Team streak break',
};
const pts = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function DemoSection({ v }: { v: ChallengeView }) {
  const cfg: ChallengeConfig = (v.upcoming ?? v.current).config;
  const total = Math.min(14, Math.round((Date.parse(`${v.endsOn}T00:00:00Z`) - Date.parse(`${v.startsOn}T00:00:00Z`)) / 86_400_000) + 1);
  const days = useMemo(() => Array.from({ length: total }, (_, i) => addDays(v.startsOn, i)), [v.startsOn, total]);
  const allowed = useMemo<Cell[]>(() => ['S', 'M', ...(cfg.restDays.enabled ? ['R' as const] : []), ...(cfg.exemptions.enabled ? ['E' as const] : [])], [cfg]);
  const initial = () => Object.fromEntries(PEOPLE.map((p) => [p, days.map((_, i) => {
    const c = (SCRIPT[p]![i] ?? 'S') as Cell;
    return allowed.includes(c) ? c : 'S';
  })])) as Record<string, Cell[]>;
  const [grid, setGrid] = useState<Record<string, Cell[]>>(initial);
  const bonusDay = days.find((d) => weekdayOf(d) === 'SATURDAY') ?? null;
  const bonusOn = cfg.scoring.weekendBonus.enabled && cfg.scoring.weekendBonus.maxPerWeekend > 0 && !!bonusDay;

  const out = useMemo(() => score({
    days, cfgOn: () => cfg, versionNoOn: () => 1,
    participants: PEOPLE.map((p, i) => ({ participantId: i + 1, classes: Object.fromEntries(days.map((d, j) => [d, (grid[p]![j] === 'R' || grid[p]![j] === 'E' ? 'P' : grid[p]![j]) as DayClass])) })),
    bonuses: bonusOn ? [{ participantId: 4, weekendKey: weekendKeyOf(bonusDay!, cfg.scoring.weekendBonus.weekend)!, bonusSubmissionId: 1, approvedOn: bonusDay! }] : [],
  }), [days, cfg, grid, bonusOn, bonusDay]);

  const name = (pid: number | null) => (pid ? PEOPLE[pid - 1]! : 'Team');
  const totals = PEOPLE.map((p, i) => {
    const ev = out.events.filter((e) => e.participantId === i + 1);
    const byRule: Record<string, number> = {};
    for (const e of ev) byRule[e.rule] = (byRule[e.rule] ?? 0) + e.points;
    return { p, total: ev.reduce((a, e) => a + e.points, 0), byRule, state: out.participants[i]! };
  });
  const ranked = [...totals].sort((a, b) => b.total - a.total);
  const cycle = (p: string, j: number) => setGrid((g) => {
    const row = [...g[p]!];
    row[j] = allowed[(allowed.indexOf(row[j]!) + 1) % allowed.length]!;
    return { ...g, [p]: row };
  });
  const s = cfg.scoring;

  return (
    <>
      <div className="card">
        <h3>How points work here: an example</h3>
        <p className="muted small" style={{ margin: 0 }}>Five people, the first {total} days of {v.name}, scored with this challenge's current rules by the same engine that scores the real challenge. <b>Tap any day</b> to change it and see the points recalculate.</p>
      </div>

      <div className="card">
        <h3>This challenge's rules</h3>
        <div className="stats">
          <div className="stat"><span>Target reached</span><b>{pts(s.dailySuccess)}</b></div>
          {s.penalties.missedDay.enabled && <div className="stat"><span>Missed day</span><b>{pts(s.penalties.missedDay.points)}</b></div>}
          {s.personalStreak.milestones.length > 0 && <div className="stat"><span>Streak {s.personalStreak.milestones.slice(0, 3).join('/')}{s.personalStreak.milestones.length > 3 ? '…' : ''} days</span><b>{pts(s.personalStreak.points)}</b></div>}
          {s.teamStreak.enabled && <div className="stat"><span>Every {s.teamStreak.everyDays}th team day</span><b>{pts(s.teamStreak.points)}</b></div>}
          {s.comeback.enabled && <div className="stat"><span>Comeback</span><b>{pts(s.comeback.points)}</b></div>}
          {s.weekendBonus.enabled && <div className="stat"><span>Weekend bonus</span><b>{pts(s.weekendBonus.points)}</b></div>}
          {s.penalties.consecutiveMisses.enabled && <div className="stat"><span>{s.penalties.consecutiveMisses.days} misses in a row</span><b>{pts(s.penalties.consecutiveMisses.points)}</b></div>}
          {s.penalties.teamStreakBreak.enabled && <div className="stat"><span>Breaking team streak</span><b>{pts(s.penalties.teamStreakBreak.points)}</b></div>}
        </div>
      </div>

      <div className="card table-wrap">
        <table className="demo-grid">
          <thead><tr><th>Day</th>{days.map((d, j) => <th key={d} title={fmtDay(d)}>{j + 1}<div className="muted">{weekdayOf(d).slice(0, 2)}</div></th>)}<th>Points</th></tr></thead>
          <tbody>
            {PEOPLE.map((p, i) => (
              <tr key={p}>
                <th>{p}</th>
                {days.map((d, j) => {
                  const c = grid[p]![j]!;
                  const bonus = bonusOn && p === 'Dev' && d === bonusDay;
                  return <td key={d}><button className="demo-cell" data-s={CELL_STATUS[c]} onClick={() => cycle(p, j)} aria-label={`${p}, day ${j + 1}: ${CELL_LABEL[c]}. Tap to change.`}>{c === 'S' ? '✓' : c === 'M' ? '✗' : c === 'R' ? 'R' : 'E'}{bonus ? <sup>★</sup> : null}</button></td>;
                })}
                <td><b>{totals[i]!.total}</b></td>
              </tr>
            ))}
            <tr><th>Team</th>{days.map((d) => {
              const brk = out.team.breaks.find((b) => b.day === d);
              const bonus = out.events.some((e) => e.rule === 'TEAM_STREAK' && e.day === d);
              return <td key={d} title={brk ? 'Team streak broken' : bonus ? 'Team streak bonus' : ''}>{brk ? <span className="team-mark break">✗</span> : bonus ? <span className="team-mark bonus">★</span> : ''}</td>;
            })}<td /></tr>
          </tbody>
        </table>
        <p className="muted small">✓ target reached · ✗ missed · R rest day · E excused (approved exemption) · ★ bonus · team row: ★ team streak bonus, ✗ team streak broken{bonusOn ? ` · Dev also did the weekend bonus activity on ${fmtDay(bonusDay!)}` : ''}</p>
        <button className="btn small ghost" onClick={() => setGrid(initial())}>Reset the example</button>
      </div>

      <div className="card">
        <h3>Result after {total} days</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Name</th><th>Points</th><th>How</th></tr></thead>
          <tbody>{ranked.map((t, i) => (
            <tr key={t.p}><td>{i + 1}</td><td><b>{t.p}</b><div className="muted small">streak {t.state.currentStreak}</div></td><td><b>{t.total}</b></td>
              <td className="small">{Object.entries(t.byRule).filter(([, n]) => n !== 0).map(([r, n]) => `${RULE_LABEL[r] ?? r} ${pts(n)}`).join(' · ')}</td></tr>
          ))}</tbody>
        </table></div>
      </div>

      <div className="card">
        <h3>What happened, day by day</h3>
        <Story days={days} grid={grid} events={out.events} breaks={out.team.breaks} name={name} cfg={cfg} bonusDay={bonusOn ? bonusDay : null} />
      </div>
    </>
  );
}

function Story({ days, grid, events, breaks, name, cfg, bonusDay }: {
  days: string[]; grid: Record<string, Cell[]>; events: DesiredEvent[]; breaks: { day: string; previousStreak: number; responsible: number[]; restartOn: string }[];
  name: (pid: number | null) => string; cfg: ChallengeConfig; bonusDay: string | null;
}) {
  const lines: { day: string; text: string }[] = [];
  days.forEach((d, j) => {
    const list = (c: Cell) => PEOPLE.filter((p) => grid[p]![j] === c);
    const rest = list('R'), exc = list('E'), miss = list('M');
    if (j === 0) lines.push({ day: d, text: `Everyone who reaches the target gets ${pts(cfg.scoring.dailySuccess)}. That happens every day and isn't repeated below.` });
    if (rest.length) lines.push({ day: d, text: `${rest.join(', ')}: rest day. No evidence, no points either way; their streak pauses, and it still counts as a good team day.` });
    if (exc.length) lines.push({ day: d, text: `${exc.join(', ')}: approved exemption (e.g. sick). No fine, no points either way; not counted in adherence; streak pauses; doesn't use a rest day.` });
    for (const p of miss) {
      const pen = events.filter((e) => e.day === d && name(e.participantId) === p && e.points < 0).reduce((a, e) => a + e.points, 0);
      lines.push({ day: d, text: `${p} missed the target: ${pen ? pts(pen) : 'no penalty'}. Their personal streak restarts at 0.` });
    }
    const b = breaks.find((x) => x.day === d);
    if (b) lines.push({ day: d, text: `Team streak of ${b.previousStreak} day${b.previousStreak === 1 ? '' : 's'} ends because ${b.responsible.map(name).join(' and ')} missed. Only they lose points; it restarts tomorrow.` });
    const team = events.filter((e) => e.day === d && e.rule === 'TEAM_STREAK');
    if (team.length) lines.push({ day: d, text: `Team day ${team[0]!.details.teamStreak} in a row: ${pts(team[0]!.points)} for everyone taking part (${team.map((e) => name(e.participantId)).join(', ')}).` });
    // Same milestone on the same day: one line for everyone who reached it.
    const streaks = new Map<number, string[]>();
    for (const e of events.filter((x) => x.day === d && x.rule === 'PERSONAL_STREAK')) streaks.set(e.details.streak as number, [...(streaks.get(e.details.streak as number) ?? []), name(e.participantId)]);
    for (const [n, who] of streaks) lines.push({ day: d, text: `${joinNames(who)} reached a ${n}-day personal streak: ${pts(cfg.scoring.personalStreak.points)}${who.length > 1 ? ' each' : ''}.` });
    for (const e of events.filter((x) => x.day === d && x.rule === 'COMEBACK')) lines.push({ day: d, text: `${name(e.participantId)} made a comeback (${e.details.missedRun} misses, then ${e.details.recoveryDays} good days in a row): ${pts(e.points)}.` });
    if (bonusDay === d) {
      const e = events.find((x) => x.rule === 'WEEKEND_BONUS');
      if (e) lines.push({ day: d, text: `Dev did the optional weekend activity and an admin approved it: ${pts(e.points)}. It doesn't replace the daily target.` });
    }
  });
  return (
    <ol className="story">
      {lines.map((l, i) => <li key={i}><span className="muted small">Day {days.indexOf(l.day) + 1} · {fmtDay(l.day)}</span><br />{l.text}</li>)}
    </ol>
  );
}

const joinNames = (n: string[]) => (n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);
