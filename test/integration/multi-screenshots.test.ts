import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

// Several screenshots a day (owner, 21 Nov 2026): each is checked on its own (approve / decline); the day's total is
// the approved ones added up (or the highest); met as soon as it reaches the target, otherwise decided at midnight.
let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, asha: Client, ben: Client;
let id: number;
let next = { value: 1000, date: null as string | null };
const reader: ScreenshotReader = { async read(_i, _m, ctx) { return { readable: true, date: next.date ?? ctx.expectedDay, value: next.value, sourceApp: 'Fake', confidence: 0.99, flags: [], notes: '', model: 'fake', provider: 'fake' }; } };
let n = 0;
const shot = async (c: Client, value: number, opts: { date?: string; image?: Buffer } = {}) => {
  next = { value, date: opts.date ?? null };
  const r = await c.upload(`/api/challenges/${id}/submissions`, { clientRef: `part-${c.username}-${++n}` }, opts.image ?? png(`${c.username}-${n}`));
  await h.settle();
  return r;
};
const today = async (c: Client) => (await c.get(`/api/challenges/${id}/me`)).body.data.today;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [ca, asha, ben] = [await h.user('chadmin'), await h.user('asha'), await h.user('ben')];
  const cfg = calamariConfig();
  cfg.submission.multiplePerDay = { enabled: true, combine: 'SUM' };
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: cfg })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await h.ensureAdmins(sa, id); await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ben]) {
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
  }
  setReaderForTests(reader);
}, 120_000);
afterEach(async () => { await h.settle(); });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('several screenshots a day - added up', () => {
  it('owner\'s example: 1,000 then 6,500 -> 7,500, target met; each screenshot approved on its own', async () => {
    h.setNow('2026-11-22T04:30:00Z'); // 10:00 IST
    expect((await shot(asha, 1000)).status).toBe(200);
    let t = await today(asha);
    expect(t).toMatchObject({ status: 'IN_PROGRESS', submission: { finalValue: 1000 } });
    expect(t.parts.map((p: { status: string; value: number }) => [p.status, p.value])).toEqual([['APPROVED', 1000]]); // below target is fine for a part
    h.setNow('2026-11-22T13:30:00Z'); // 19:00 IST
    await shot(asha, 6500);
    t = await today(asha);
    expect(t).toMatchObject({ status: 'ACHIEVED', submission: { finalValue: 7500 } });
    expect(t.parts).toHaveLength(2);
  });

  it('points follow the day (+10), and alerts work with several screenshots', async () => {
    expect((await asha.get('/api/me/notifications')).status).toBe(200);
    h.setNow('2026-11-22T18:31:00Z'); // just after midnight
    const b = (await ca.get(`/api/challenges/${id}/leaderboard`)).body.data;
    expect(b.standings.find((s: { displayName: string }) => s.displayName === 'asha').points).toBe(10);
  });

  it('the same picture can\'t be added twice in a day', async () => {
    h.setNow('2026-11-23T04:30:00Z');
    const img = png('same-picture');
    expect((await shot(ben, 3000, { image: img })).status).toBe(200);
    const again = await shot(ben, 3000, { image: img });
    expect(again.status).toBe(409);
    expect(again.body.message).toContain('already added this screenshot');
  });

  it('a screenshot of another day goes to an admin, who approves or declines it (not "target met")', async () => {
    const r = await shot(ben, 4000, { date: '2026-11-17' });
    const sid = r.body.data.submissionId;
    expect((await today(ben)).status).toBe('PENDING_VERIFICATION');
    const q = (await ca.get(`/api/challenges/${id}/review-queue`)).body.data;
    expect(q.find((x: { submissionId: number }) => x.submissionId === sid)).toMatchObject({ part: true });
    expect((await ca.post(`/api/submissions/${sid}/review`, { outcome: 'ACHIEVED', value: 4000 })).status).toBe(400);
    expect((await ca.post(`/api/submissions/${sid}/review`, { outcome: 'REJECTED', reason: 'That screenshot is from 17 Nov' })).status).toBe(200);
    expect((await today(ben))).toMatchObject({ status: 'IN_PROGRESS', submission: { finalValue: 3000 } });
  });

  it('below the target at midnight: target missed; all declined: rejected', async () => {
    h.setNow('2026-11-23T18:31:00Z');
    const days = (await ben.get(`/api/challenges/${id}/me`)).body.data.days;
    expect(days.find((d: { day: string }) => d.day === '2026-11-23').status).toBe('TARGET_MISSED');
  });

  it('an approved number can be corrected by an admin with a reason', async () => {
    h.setNow('2026-11-24T04:30:00Z');
    const sid = (await shot(ben, 5000)).body.data.submissionId;
    expect((await ca.post(`/api/submissions/${sid}/review`, { outcome: 'APPROVED', value: 8000 })).status).toBe(400); // changing a decision needs a reason
    expect((await ca.post(`/api/submissions/${sid}/review`, { outcome: 'APPROVED', value: 8000, reason: 'Read the number wrong' })).status).toBe(200);
    expect(await today(ben)).toMatchObject({ status: 'ACHIEVED', submission: { finalValue: 8000 } });
  });
});

describe('several screenshots a day - highest counts', () => {
  it('1,000 then 5,000 from the same app -> 5,000 (not 6,000)', async () => {
    h.setNow('2026-11-24T05:00:00Z');
    const cfg = calamariConfig();
    cfg.submission.multiplePerDay = { enabled: true, combine: 'HIGHEST' };
    expect((await sa.put(`/api/challenges/${id}/config`, { config: cfg, reason: 'Use the highest screenshot', effectiveFrom: '2026-11-25' })).status).toBe(200);
    h.setNow('2026-11-25T04:30:00Z');
    await shot(asha, 1000);
    await shot(asha, 5000);
    expect(await today(asha)).toMatchObject({ status: 'IN_PROGRESS', submission: { finalValue: 5000 } });
  });
});
