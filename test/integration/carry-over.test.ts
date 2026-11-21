import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { addDays } from '../../src/core/dates.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

// Calamari's fine pool is carried over (owner, 21 Nov 2026): unused fine money is credited against the next week, so
// participants pay ₹400 + only the top-up back to ₹600.
let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, fa: Client, asha: Client, ben: Client;
let id: number;
const reader: ScreenshotReader = { async read(_i, _m, ctx) { return { readable: true, date: ctx.expectedDay, value: 9000, sourceApp: 'Fake', confidence: 0.99, flags: [], notes: '', model: 'fake', provider: 'fake' }; } };
let n = 0;
const walk = async (c: Client, day: string) => {
  h.setNow(`${day}T06:30:00Z`);
  expect((await c.upload(`/api/challenges/${id}/submissions`, { clientRef: `walk-${c.username}-${++n}` }, png(`${c.username}-${day}`))).status).toBe(200);
  await h.settle();
};
const mine = async (c: Client) => (await c.get(`/api/challenges/${id}/my-money`)).body.data;
const pay = async (c: Client, periodNo: number, amount: number, day: string) => {
  const r = await c.post(`/api/challenges/${id}/payments`, { periodNo, amount, utr: `UTR${c.username.toUpperCase()}${periodNo}${amount}`.padEnd(12, '0'), paidOn: day });
  expect(r.status).toBe(200);
  expect((await fa.post(`/api/payments/${r.body.data.paymentId}/decide`, { confirm: true })).status).toBe(200);
};

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [ca, fa, asha, ben] = [await h.user('chadmin'), await h.user('finadmin'), await h.user('asha'), await h.user('ben')];
  const cfg = calamariConfig();
  expect(cfg.finance.unusedFinePool).toBe('CARRY_FORWARD');
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: cfg })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/roles`, { userId: fa.userId, role: 'FINANCE_ADMIN' });
  await h.ensureAdmins(sa, id); await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ben]) {
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
  }
  setReaderForTests(reader);
  // Week 1 (22-28 Nov): Asha walks every day; Ben misses the 23rd, 24th and 25th (3 x ₹100 fines).
  for (let i = 0; i < 7; i++) {
    const d = addDays('2026-11-22', i);
    await walk(asha, d);
    if (!['2026-11-23', '2026-11-24', '2026-11-25'].includes(d)) await walk(ben, d);
  }
  await pay(asha, 1, 1000, '2026-11-22');
  await pay(ben, 1, 1000, '2026-11-22');
}, 180_000);
afterEach(async () => { await h.settle(); });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('fine-pool carry-over (Calamari)', () => {
  it('after week 1: Asha owes ₹400 for week 2, Ben ₹700 (₹400 + ₹300 top-up); nothing is "owed back"', async () => {
    h.setNow('2026-11-29T03:00:00Z'); // Sunday morning: week 1 decided
    const a = await mine(asha), b = await mine(ben);
    expect(a.weeks[0]).toMatchObject({ unused: 600, unusedTo: 'CARRY_FORWARD', carriedTo: 2 });
    expect(a.weeks[1]).toMatchObject({ fullDue: 1000, carriedIn: 600, due: 400, status: 'DUE' });
    expect(b.weeks[0]).toMatchObject({ fines: 300, unused: 300, carriedTo: 2 });
    expect(b.weeks[1]).toMatchObject({ fullDue: 1000, carriedIn: 300, due: 700 });
    expect([a.refundDue, b.refundDue]).toEqual([0, 0]);
    expect([a.owed, b.owed]).toEqual([400 + 3 * 1000 + 714, 700 + 3 * 1000 + 714]); // week 2 reduced; weeks 3-5 + the short week 6 still in full
  });

  it('the payment alert asks for the reduced amount', async () => {
    const alert = (await ben.get('/api/me/notifications')).body.data.find((x: { id: string }) => x.id === `pay:${id}:2`);
    expect(alert.body).toContain('₹700');
  });

  it('paying more than needed is credit for the next week', async () => {
    await pay(asha, 2, 1000, '2026-11-29'); // she paid the full ₹1,000 out of habit
    const a = await mine(asha);
    expect(a.weeks[1].status).toBe('PAID');
    for (let i = 0; i < 7; i++) await walk(asha, addDays('2026-11-29', i)); // week 2 perfect -> ₹600 carried into week 3
    h.setNow('2026-12-06T03:00:00Z');
    const w3 = (await mine(asha)).weeks[2];
    expect(w3).toMatchObject({ carriedIn: 600, due: 400, creditUsed: 400, paid: 400, status: 'PAID' }); // the extra ₹600 covers it
  });

  it('the books still balance, and the reconciliation checks pass', async () => {
    const f = (await fa.get(`/api/challenges/${id}/finance`)).body.data;
    expect(f.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(f.participants.find((p: { displayName: string }) => p.displayName === 'asha').paid).toBe(2000);
  });
});
