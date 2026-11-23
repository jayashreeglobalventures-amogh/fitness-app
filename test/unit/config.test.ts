import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { changedSections, contributionFor, validateConfig, type ChallengeConfig } from '../../src/modules/challenges/config.js';

const calamari = (): ChallengeConfig => JSON.parse(readFileSync(new URL('../../config/challenges/calamari-2026.json', import.meta.url), 'utf8'));
const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

describe('challenge configuration', () => {
  it('Calamari is valid; its open decisions are warnings, not errors', () => {
    const r = validateConfig(calamari());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.periods).toHaveLength(6);
    expect(paths(r.warnings)).toEqual(['/exemptions/voting']);
  });

  it('Calamari money: ₹1,000 weekly (₹400 + ₹600), ₹714 final week (₹286 + ₹428), ₹100 per missed day', () => {
    const c = calamari();
    expect(contributionFor(c, 1)).toEqual({ total: 100000, mainPool: 40000, finePool: 60000 });
    expect(contributionFor(c, 5)).toEqual({ total: 100000, mainPool: 40000, finePool: 60000 });
    expect(contributionFor(c, 6)).toEqual({ total: 71400, mainPool: 28600, finePool: 42800 });
    expect(c.finance.finePerMissedDay).toBe(10000);
  });

  it('rejects unknown fields and wrong types (shape)', () => {
    const c = calamari() as unknown as Record<string, unknown>;
    expect(validateConfig({ ...c, surprise: 1 }).ok).toBe(false);
    const bad = calamari();
    (bad.activity as unknown as { dailyTarget: unknown }).dailyTarget = '7000';
    expect(paths(validateConfig(bad).errors)).toContain('/activity/dailyTarget');
  });

  it('rejects impossible dates, end before start and unknown time zones', () => {
    const a = calamari(); a.basics.startDate = '2026-02-30';
    expect(paths(validateConfig(a).errors)).toContain('/basics/startDate');
    const b = calamari(); b.basics.endDate = '2026-11-21';
    expect(paths(validateConfig(b).errors)).toContain('/basics/endDate');
    const c = calamari(); c.basics.timeZone = 'Mars/Olympus';
    expect(paths(validateConfig(c).errors)).toContain('/basics/timeZone');
  });

  it('contribution split must add up, overrides must point at real periods once', () => {
    const a = calamari(); a.finance.contribution.finePool = 50000;
    expect(paths(validateConfig(a).errors)).toContain('/finance/contribution');
    const b = calamari(); b.finance.periodOverrides[0]!.periodNo = 7;
    expect(paths(validateConfig(b).errors)).toContain('/finance/periodOverrides/0/periodNo');
    const c = calamari(); c.finance.periodOverrides.push({ ...c.finance.periodOverrides[0]! });
    expect(paths(validateConfig(c).errors)).toContain('/finance/periodOverrides/1/periodNo');
  });

  it('warns when a short period uses the full-week amount', () => {
    const a = calamari(); a.finance.periodOverrides = [];
    expect(validateConfig(a).warnings.some((w) => w.message.includes('Period 6'))).toBe(true);
  });

  it('prize percentages must total 100 and payout cannot precede the end', () => {
    const a = calamari(); a.prizes.qualificationPoolPct = 60; a.prizes.topThreePct = 30;
    expect(paths(validateConfig(a).errors)).toContain('/prizes');
    const b = calamari(); b.prizes.topThreeSplitPct = [50, 30, 10];
    expect(paths(validateConfig(b).errors)).toContain('/prizes/topThreeSplitPct');
    const c = calamari(); Object.assign(c.prizes, { qualificationPoolPct: 70, topThreePct: 30, topThreeSplitPct: [50, 30, 20], distribution: 'EQUAL' });
    expect(validateConfig(c).ok).toBe(true);
    expect(paths(validateConfig(c).warnings)).not.toContain('/prizes');
    const d = calamari(); d.prizes.payoutDate = '2026-12-30';
    expect(paths(validateConfig(d).errors)).toContain('/prizes/payoutDate');
  });

  it('milestones increasing; rewards non-negative; penalties non-positive; ranking unique', () => {
    const a = calamari(); a.scoring.personalStreak.milestones = [7, 7, 14];
    expect(paths(validateConfig(a).errors)).toContain('/scoring/personalStreak/milestones');
    const b = calamari(); b.scoring.penalties.teamStreakBreak.points = 15;
    expect(paths(validateConfig(b).errors)).toContain('/scoring/penalties/teamStreakBreak/points');
    const c = calamari(); c.scoring.dailySuccess = -10;
    expect(paths(validateConfig(c).errors)).toContain('/scoring/dailySuccess');
    const d = calamari(); d.leaderboard.ranking = ['POINTS', 'POINTS'];
    expect(paths(validateConfig(d).errors)).toContain('/leaderboard/ranking');
  });

  it('a different kind of challenge validates with the same engine (push-ups, Monday weeks, no money)', () => {
    const p = calamari();
    p.basics = { ...p.basics, name: '1,000 Push-ups', category: 'STRENGTH', startDate: '2027-01-04', endDate: '2027-02-02' };
    p.activity = { metric: 'pushups', label: 'Push-ups', unit: 'reps', dailyTarget: 50 };
    p.periods.weekStartsOn = 'MONDAY';
    p.finance.enabled = false;
    p.prizes.payoutDate = null;
    const r = validateConfig(p);
    expect(r.errors).toEqual([]);
    expect(r.periods[0]).toMatchObject({ startsOn: '2027-01-04', endsOn: '2027-01-10' });
  });

  it('changedSections ignores key order', () => {
    const a = calamari();
    const b = JSON.parse(JSON.stringify({ ...calamari(), basics: Object.fromEntries(Object.entries(calamari().basics).reverse()) }));
    expect(changedSections(a, b)).toEqual([]);
    b.finance.finePerMissedDay = 5000;
    expect(changedSections(a, b)).toEqual(['finance']);
  });
});

describe('notification settings', () => {
  it('reminder times must be distinct; times inside quiet hours are flagged; older settings get the old behaviour', () => {
    const c = calamari();
    c.notifications.stepReminders.times = ['12:00', '12:00'];
    expect(validateConfig(c).errors.map((e) => e.path)).toContain('/notifications/stepReminders/times');
    c.notifications.stepReminders.times = ['06:30', '20:00'];
    const r = validateConfig(c);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.path)).toContain('/notifications/stepReminders/times');
    const old = calamari() as Partial<ChallengeConfig>;
    delete old.notifications;
    old.coach = { weeklySummary: true, eveningNudge: true, nudgeTime: '19:30', atRiskAlerts: true };
    const v = validateConfig(old);
    expect(v.ok).toBe(true);
  });
});
