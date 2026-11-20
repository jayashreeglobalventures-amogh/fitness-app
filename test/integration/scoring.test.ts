import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates.js';
import type { ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, asha: Client, ben: Client, cara: Client;
let id: number;
const pid: Record<string, number> = {};
// A reader that sees exactly the expected day and the given total.
let steps = 8000;
const reader: ScreenshotReader = { async read(_i, _m, ctx) { return { readable: true, date: ctx.expectedDay, value: steps, sourceApp: 'Fake', confidence: 0.99, flags: [], notes: '', model: 'fake', provider: 'fake' }; } };
let n = 0;
const noonIst = (day: string) => `${day}T06:30:00Z`;
const walk = async (c: Client, day: string, total = 8000) => {
  h.setNow(noonIst(day)); steps = total;
  const r = await c.upload(`/api/challenges/${id}/submissions`, { clientRef: `walk-${c.username}-${++n}` }, png(`${c.username}-${day}-${n}`));
  expect(r.status).toBe(200);
  await h.settle();
  return r.body.data.submissionId as number;
};
const board = async (c: Client = ca) => (await c.get(`/api/challenges/${id}/leaderboard`)).body.data;
const pointsOf = async (who: string) => (await board()).standings.find((s: { displayName: string }) => s.displayName === who).points;
const ledgerRows = async () => (await h.admin.query(`SELECT count(*)::int AS n FROM scoring_events WHERE challenge_id = $1`, [id])).rows[0].n as number;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  ca = await h.user('chadmin');
  [asha, ben, cara] = [await h.user('asha'), await h.user('ben'), await h.user('cara')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ben, cara]) {
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    pid[c.username] = (await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true })).body.data.participantId;
  }
  setReaderForTests(reader);
}, 120_000);
afterEach(async () => { await h.settle(); });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('points from real check-ins (Calamari)', () => {
  it('day 1: everyone reaches the target -> +10 each; nothing is scored twice', async () => {
    for (const c of [asha, ben, cara]) await walk(c, '2026-11-22');
    const b = await board();
    expect(b.standings.map((s: { points: number }) => s.points)).toEqual([10, 10, 10]);
    expect(b.standings.every((s: { rank: number; tied: boolean }) => s.rank === 1 && s.tied)).toBe(true);
    const rows = await ledgerRows();
    await board(); await board();
    expect(await ledgerRows()).toBe(rows); // idempotent
  });

  it('day 2: Cara misses the deadline -> -15 for her alone, once the day is over; the team streak break is recorded', async () => {
    await walk(asha, '2026-11-23'); await walk(ben, '2026-11-23');
    expect(await pointsOf('cara')).toBe(10); // the 23rd isn't over yet: no penalty
    h.setNow('2026-11-23T18:30:00Z'); // midnight IST
    expect(await pointsOf('cara')).toBe(-5);
    expect(await pointsOf('asha')).toBe(20);
    const b = await board();
    expect(b.team.breaks).toEqual([{ day: '2026-11-23', previousStreak: 1, responsible: [pid.cara], restartOn: '2026-11-24' }]);
  });

  it('an admin overturns a decision -> the ledger gets a reversal, never an edit', async () => {
    await walk(asha, '2026-11-24');
    const sid = await walk(ben, '2026-11-24', 8000);
    expect(await pointsOf('ben')).toBe(30);
    expect((await ca.post(`/api/submissions/${sid}/review`, { outcome: 'BELOW_TARGET', value: 6200, reason: 'Screenshot shows a weekly average' })).status).toBe(200);
    h.setNow('2026-11-24T18:30:00Z');
    expect(await pointsOf('ben')).toBe(20 - 15);
    const { rows } = await h.admin.query(`SELECT rule, kind, points FROM scoring_events WHERE participant_id = $1 AND day = '2026-11-24' ORDER BY event_id`, [pid.ben]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([
      { rule: 'DAILY_SUCCESS', kind: 'AWARD', points: 10 },
      { rule: 'DAILY_SUCCESS', kind: 'REVERSAL', points: -10 },
      { rule: 'MISSED_DAY', kind: 'AWARD', points: -15 },
    ]));
    await expect(h.admin.query(`UPDATE scoring_events SET points = 0`)).rejects.toThrow(/append-only/);
    await expect(h.admin.query(`DELETE FROM scoring_events`)).rejects.toThrow(/append-only/);
  });

  it('an exemption approved afterwards removes the missed-day penalty (reversal) and pauses sequences', async () => {
    h.setNow('2026-11-25T05:00:00Z');
    // Cara: +10 (22nd), -15 (23rd, missed), -15 (24th, missed).
    expect(await pointsOf('cara')).toBe(-20);
    const r = await cara.post(`/api/challenges/${id}/exemptions`, { startDay: '2026-11-23', endDay: '2026-11-23', reason: 'Hospital visit, doctor note' });
    // While the request is pending the 23rd is undecided, so its penalty is reversed for now.
    expect(await pointsOf('cara')).toBe(-5);
    expect((await ca.post(`/api/exemptions/${r.body.data.requestId}/decide`, { approve: true, reason: 'Note seen by admin' })).status).toBe(200);
    expect(await pointsOf('cara')).toBe(-5);
    // The 23rd is excused now, so that team day succeeded; the 24th (Ben below target, Cara missed) is the break.
    expect((await board()).team.breaks.map((b: { day: string; responsible: number[] }) => [b.day, b.responsible])).toEqual([['2026-11-24', [pid.ben, pid.cara]]]);
  });

  it('a rest day costs nothing and the team day still counts', async () => {
    h.setNow('2026-11-25T04:00:00Z'); // 09:30 IST
    expect((await cara.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-25' })).status).toBe(200);
    await walk(asha, '2026-11-25'); await walk(ben, '2026-11-25');
    h.setNow('2026-11-25T18:30:00Z');
    expect(await pointsOf('cara')).toBe(-5); // unchanged by the rest day
  });

  it('weekend bonus: an admin sets the activity, the participant submits that weekend, an admin approves -> +10 (max one)', async () => {
    h.setNow('2026-11-26T06:00:00Z');
    const bad = await ca.post(`/api/challenges/${id}/bonuses`, { day: '2026-11-26', title: 'Thursday thing' });
    expect(bad.status).toBe(400); // not a weekend day
    const a1 = await ca.post(`/api/challenges/${id}/bonuses`, { day: '2026-11-29', title: 'Cycle 10 km', evidence: 'Ride summary screenshot' });
    expect(a1.body.data).toMatchObject({ weekendKey: '2026-11-28', days: ['2026-11-28', '2026-11-29'] });
    const a2 = await ca.post(`/api/challenges/${id}/bonuses`, { day: '2026-11-28', title: 'Swim 30 minutes' });
    expect((await asha.upload(`/api/bonuses/${a1.body.data.activityId}/submissions`, { note: 'Rode 12 km' }, png('ride'))).status).toBe(409); // not the weekend yet
    h.setNow('2026-11-28T06:00:00Z');
    const s1 = await asha.upload(`/api/bonuses/${a1.body.data.activityId}/submissions`, { note: 'Rode 12 km' }, png('ride'));
    const s2 = await asha.post(`/api/bonuses/${a2.body.data.activityId}/submissions`, { note: 'Swam 35 minutes at the club' });
    const before = await pointsOf('asha');
    expect((await asha.post(`/api/bonus-submissions/${s1.body.data.bonusSubmissionId}/decide`, { approve: true })).status).toBe(403);
    await ca.post(`/api/bonus-submissions/${s1.body.data.bonusSubmissionId}/decide`, { approve: true });
    await ca.post(`/api/bonus-submissions/${s2.body.data.bonusSubmissionId}/decide`, { approve: true });
    expect(await pointsOf('asha')).toBe(before + 10); // max one per weekend
    // Cancelling the counted activity: the other approved one takes its place - still +10, never +20.
    await ca.post(`/api/bonuses/${a1.body.data.activityId}/cancel`, { reason: 'Posted by mistake' });
    expect(await pointsOf('asha')).toBe(before + 10);
    await ca.post(`/api/bonuses/${a2.body.data.activityId}/cancel`, { reason: 'Pool was closed' });
    expect(await pointsOf('asha')).toBe(before);
  });

  it('personal streak +20 on the 7th successful day (rest days pause it)', async () => {
    // Asha: 22-25 achieved; walk 26-28 -> 7 successes on the 28th.
    for (const d of ['2026-11-26', '2026-11-27', '2026-11-28']) await walk(asha, d);
    const pts = (await asha.get(`/api/participants/${pid.asha}/points`)).body.data;
    expect(pts.events.filter((e: { rule: string }) => e.rule === 'PERSONAL_STREAK').map((e: { day: string }) => e.day)).toEqual(['2026-11-28']);
    expect(pts.currentStreak).toBe(7);
    expect(pts.byRule.DAILY_SUCCESS).toBe(70);
  });

  it('leaderboard: ranked by points, then the tie-breaks; eligibility needs 80% adherence; participants can\'t see others\' breakdowns', async () => {
    h.setNow(noonIst('2026-11-29'));
    const b = await board(asha);
    expect(b.standings[0]).toMatchObject({ displayName: 'asha', rank: 1, me: true });
    expect(b.standings.find((s: { displayName: string }) => s.displayName === 'ben').eligible).toBe(false); // missed days -> below 80%
    expect(b.standings.find((s: { displayName: string }) => s.displayName === 'asha').eligible).toBe(true);
    expect((await asha.get(`/api/participants/${pid.ben}/points`)).status).toBe(403);
    const outsider = await h.user('outsider');
    expect((await outsider.get(`/api/challenges/${id}/leaderboard`)).status).toBe(403);
    void addDays;
  });

  it('the background job reconciles without anyone opening the leaderboard', async () => {
    const { reconcileAll } = await import('../../src/modules/scoring/ledger.js');
    h.setNow('2026-11-30T18:30:00Z'); // two more days over: misses for everyone who didn't walk
    const before = await ledgerRows();
    const appended = await reconcileAll(h.pool, h.now());
    expect(appended).toBeGreaterThan(0);
    expect(await ledgerRows()).toBe(before + appended);
    expect(await reconcileAll(h.pool, h.now())).toBe(0); // idempotent
  });
});
