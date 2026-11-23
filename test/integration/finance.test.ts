import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, sa2: Client, ca: Client, fa: Client, asha: Client, ben: Client;
let id: number;
const pid: Record<string, number> = {};
const reader: ScreenshotReader = { async read(_i, _m, ctx) { return { readable: true, date: ctx.expectedDay, value: 9000, sourceApp: 'Fake', confidence: 0.99, flags: [], notes: '', model: 'fake', provider: 'fake' }; } };
let n = 0;
const walk = async (c: Client, day: string) => {
  h.setNow(`${day}T06:30:00Z`);
  const up = await c.upload(`/api/challenges/${id}/submissions`, { clientRef: `walk-${c.username}-${++n}` }, png(`${c.username}-${day}`));
  expect(up.status).toBe(200);
  await h.settle();
};
const mine = async (c: Client) => (await c.get(`/api/challenges/${id}/my-money`)).body.data;
const fin = async (c: Client = fa) => (await c.get(`/api/challenges/${id}/finance`)).body.data;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  sa2 = await h.user('super2', { superAdmin: true });
  [ca, fa, asha, ben] = [await h.user('chadmin'), await h.user('finadmin'), await h.user('asha'), await h.user('ben')];
  // This file tests the "refunded at the end" rule; carry-over (Calamari's setting) is tested in carry-over.test.ts.
  const cfg = calamariConfig(); cfg.finance.unusedFinePool = 'REFUND';
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: cfg })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/roles`, { userId: fa.userId, role: 'FINANCE_ADMIN' });
  await h.ensureAdmins(sa, id); await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ben]) {
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    pid[c.username] = (await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true })).body.data.participantId;
  }
  setReaderForTests(reader);
}, 120_000);
afterEach(async () => { await h.settle(); });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('payment details (UPI ID / QR)', () => {
  it('only the Finance Admin (or Super Admin) sets them; participants can see them and the QR image', async () => {
    expect((await ca.post(`/api/challenges/${id}/payment-settings`, { upiId: 'calamari@okbank', payeeName: 'Calamari Fund' })).status).toBe(403);
    expect((await fa.post(`/api/challenges/${id}/payment-settings`, { upiId: 'not a upi' })).status).toBe(400);
    expect((await fa.upload(`/api/challenges/${id}/payment-settings`, { upiId: 'calamari@okbank', payeeName: 'Calamari Fund' }, png('qr'))).status).toBe(200);
    const s = (await asha.get(`/api/challenges/${id}/payment-settings`)).body.data;
    expect(s).toMatchObject({ upiId: 'calamari@okbank', payeeName: 'Calamari Fund', canEdit: false });
    expect((await asha.raw(`/api/files/${s.qrFileId}`)).status).toBe(200);
    const outsider = await h.user('outsider');
    expect((await outsider.raw(`/api/files/${s.qrFileId}`)).status).toBe(404);
  });
});

describe('contributions, payments and fines (Calamari)', () => {
  it('week 1 is due on the start day: ₹1,000, shown as due; paid before the app was live -> reported later with the original UTR and date', async () => {
    h.setNow('2026-11-22T06:00:00Z');
    const m = await mine(asha);
    expect(m.weeks[0]).toMatchObject({ periodNo: 1, due: 1000, paid: 0, status: 'DUE', dueOn: '2026-11-22', finePool: 600 });
    expect(m.weeks[5]).toMatchObject({ periodNo: 6, due: 714, finePool: 428 });
    expect(m.owed).toBe(5714);
    const r = await asha.post(`/api/challenges/${id}/payments`, { periodNo: 1, amount: '1,000', utr: '4321 9876 5432', paidOn: '2026-11-21', note: 'Paid on WhatsApp day' });
    expect(r.status).toBe(200);
    expect((await mine(asha)).weeks[0]).toMatchObject({ status: 'CHECKING', pending: 1000 });
    expect((await ben.post(`/api/challenges/${id}/payments`, { periodNo: 1, amount: 1000, utr: '432198765432', paidOn: '2026-11-22' })).status).toBe(409); // same UTR
    expect((await asha.post(`/api/challenges/${id}/payments`, { periodNo: 1, amount: 1000, paidOn: '2026-11-22' })).status).toBe(400); // UTR required
  });

  it('the Finance Admin confirms; a Challenge Admin cannot; nobody confirms their own', async () => {
    const pay = (await fin()).payments.find((p: { displayName: string }) => p.displayName === 'asha');
    expect(pay).toMatchObject({ status: 'SUBMITTED', utr: '432198765432', amount: 1000 });
    expect((await ca.post(`/api/payments/${pay.paymentId}/decide`, { confirm: true })).status).toBe(403);
    expect((await asha.post(`/api/payments/${pay.paymentId}/decide`, { confirm: true })).status).toBe(403);
    expect((await fa.post(`/api/payments/${pay.paymentId}/decide`, { confirm: true })).status).toBe(200);
    const m = await mine(asha);
    expect(m.weeks[0]).toMatchObject({ status: 'PAID', paid: 1000 });
    expect(m.owed).toBe(4714);
    expect(m.pools.collected).toBe(1000);
  });

  it('rejecting needs a reason; the UTR can then be used again', async () => {
    const r = await ben.post(`/api/challenges/${id}/payments`, { periodNo: 1, amount: 1000, utr: 'AXIS00001111', paidOn: '2026-11-22' });
    expect((await fa.post(`/api/payments/${r.body.data.paymentId}/decide`, { confirm: false })).status).toBe(400);
    expect((await fa.post(`/api/payments/${r.body.data.paymentId}/decide`, { confirm: false, reason: 'No such credit in the account' })).status).toBe(200);
    expect((await ben.post(`/api/challenges/${id}/payments`, { periodNo: 1, amount: 1000, utr: 'AXIS00001111', paidOn: '2026-11-22' })).status).toBe(200);
  });

  it('a missed day takes ₹100 from the fine pool to the prize pool; a rest day costs nothing', async () => {
    await walk(asha, '2026-11-22'); await walk(ben, '2026-11-22');
    await walk(asha, '2026-11-23');                     // Ben misses the 23rd
    h.setNow('2026-11-24T03:00:00Z');                   // 08:30 IST: the 23rd is over
    expect((await ben.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-24' })).status).toBe(200);
    const b = await mine(ben);
    expect(b.weeks[0]).toMatchObject({ fines: 100, finePoolLeft: 500 });
    expect(b.pools.prizePool).toBe(2 * 2286 + 100); // both owe all weeks' prize share + Ben's fine
    await walk(asha, '2026-11-24');
  });

  it('after the 2-day grace an unpaid week shows as overdue (and only money, never points)', async () => {
    h.setNow('2026-11-25T06:00:00Z'); // 25th: grace (23rd, 24th) has passed
    const ben1 = (await mine(ben)).weeks[0];
    expect(ben1.status).toBe('CHECKING'); // he reported it again; waiting for a decision
    const notices = (await ben.get('/api/me/notifications')).body.data.map((x: { id: string }) => x.id);
    expect(notices.some((x: string) => x.startsWith('pay:'))).toBe(false);
    const p = (await fin()).payments.find((x: { displayName: string; status: string }) => x.displayName === 'ben' && x.status === 'SUBMITTED');
    await fa.post(`/api/payments/${p.paymentId}/decide`, { confirm: false, reason: 'Amount never arrived' });
    expect((await mine(ben)).weeks[0].status).toBe('OVERDUE');
    expect((await ben.get('/api/me/notifications')).body.data.find((x: { id: string }) => x.id.startsWith('pay:'))).toMatchObject({ kind: 'warning' });
    expect((await fin()).participants.find((x: { displayName: string }) => x.displayName === 'ben').overdueWeeks).toEqual([1]);
    expect((await fa.get('/api/me/notifications')).body.data.map((x: { id: string }) => x.id.split(':')[0])).not.toContain('payments');
  });

  it('when the week is over and decided, what is left in the fine pool is owed back (Calamari: refund)', async () => {
    for (const d of ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28']) { await walk(asha, d); await walk(ben, d); }
    h.setNow('2026-11-28T18:30:00Z'); // midnight: week 1 is over
    expect((await mine(asha)).refundDue).toBe(600);
    expect((await mine(ben)).refundDue).toBe(500); // ₹600 - one ₹100 fine
  });

  it('the finance manager records a payment for someone else: it counts straight away; UTR and "where" are optional', async () => {
    const r = await fa.post(`/api/participants/${pid.ben}/payments`, { periodNo: 1, amount: 1000, method: 'UPI', paidOn: '2026-11-28' });
    expect(r.status).toBe(200);
    expect(r.body.data.confirmed).toBe(true);
    expect((await mine(ben)).weeks[0].status).toBe('PAID');
    const { rows } = await h.admin.query(`SELECT action FROM audit_log WHERE action = 'PAYMENT_RECORDED_AND_CONFIRMED'`);
    expect(rows).toHaveLength(1);
    expect((await ca.post(`/api/participants/${pid.ben}/payments`, { periodNo: 1, amount: 1000, method: 'CASH', paidOn: '2026-11-28' })).status).toBe(403); // only those who confirm payments
  });

  it('withdrawal refund: Finance Admin proposes, a different Super Admin approves, then it is owed', async () => {
    const r = await fa.post(`/api/participants/${pid.ben}/refunds`, { amount: 300, reason: 'Withdrawal on medical grounds: admin decision' });
    expect(r.status).toBe(200);
    expect((await fa.post(`/api/refunds/${r.body.data.refundId}/decide`, { approve: true })).status).toBe(403); // not a Super Admin
    expect((await sa.post(`/api/refunds/${r.body.data.refundId}/decide`, { approve: true })).status).toBe(200);
    expect((await mine(ben)).refundDue).toBe(800);
    const r2 = await sa.post(`/api/participants/${pid.asha}/refunds`, { amount: 100, reason: 'Testing proposer rule' });
    expect((await sa.post(`/api/refunds/${r2.body.data.refundId}/decide`, { approve: true })).status).toBe(403); // can't approve your own proposal
    expect((await sa2.post(`/api/refunds/${r2.body.data.refundId}/decide`, { approve: false, reason: 'Not agreed' })).status).toBe(200);
  });

  it('the ledger reconciles, can\'t be edited, refuses unbalanced entries, and recalculating twice changes nothing', async () => {
    const f = await fin();
    expect(f.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    const count = async () => (await h.admin.query(`SELECT count(*)::int AS n FROM ledger_transactions`)).rows[0].n;
    const before = await count();
    await fin(); await mine(asha);
    expect(await count()).toBe(before);
    await expect(h.admin.query(`UPDATE ledger_lines SET amount_paise = 1`)).rejects.toThrow(/append-only/);
    await expect(h.admin.query(`DELETE FROM ledger_transactions`)).rejects.toThrow(/append-only/);
    const c = await h.admin.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query(`INSERT INTO ledger_transactions (challenge_id, base_key, idem_key, type, kind, created_at) VALUES ($1,'x','x#1','CORRECTION','ENTRY',now()) RETURNING transaction_id`, [id]);
      await c.query(`INSERT INTO ledger_lines (transaction_id, account, amount_paise) VALUES ($1,'CASH',100),($1,'MAIN_POOL',-99)`, [rows[0].transaction_id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it('participants see only their own money (plus pool totals); a Challenge Admin sees the finance view (to approve requests) but can\'t confirm reported payments', async () => {
    expect((await asha.get(`/api/challenges/${id}/finance`)).status).toBe(403);
    const caView = await ca.get(`/api/challenges/${id}/finance`);
    expect(caView.status).toBe(200);
    expect(caView.body.data).toMatchObject({ canConfirm: false, canApproveRefund: true });
    const rep = await asha.post(`/api/challenges/${id}/payments`, { periodNo: 2, amount: 1000, utr: 'ASHAWEEK2001', paidOn: '2026-11-29' });
    expect((await ca.post(`/api/payments/${rep.body.data.paymentId}/decide`, { confirm: true })).status).toBe(403);
    const m = await mine(asha);
    expect(Object.keys(m)).toEqual(expect.arrayContaining(['weeks', 'owed', 'refundDue', 'payments', 'pools']));
    expect(JSON.stringify(m)).not.toContain('ben');
  });
});

describe('Settings -> Money: UTR mandatory for participants', () => {
  it('on (default): a participant must give a UTR; off: it is optional', async () => {
    h.setNow('2026-11-29T06:00:00Z');
    const r = await asha.post(`/api/challenges/${id}/payments`, { periodNo: 2, amount: 1000, paidOn: '2026-11-29' });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('UTR');
    const cfg = calamariConfig(); cfg.finance.unusedFinePool = 'REFUND'; cfg.finance.utrRequired = false;
    expect((await sa.put(`/api/challenges/${id}/config`, { config: cfg, reason: 'UTR optional for participants', effectiveFrom: '2026-11-30' })).status).toBe(200);
    h.setNow('2026-11-30T06:00:00Z');
    expect((await asha.post(`/api/challenges/${id}/payments`, { periodNo: 2, amount: 1000, paidOn: '2026-11-30' })).status).toBe(200);
  });
});
