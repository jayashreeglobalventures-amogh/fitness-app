import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, a1: Client, a2: Client, a3: Client, fm: Client, newFm: Client, asha: Client;
let id: number;
const roles = async () => (await a1.get(`/api/challenges/${id}/roles`)).body.data.map((r: { username: string; role: string }) => `${r.username}:${r.role}`).sort();
const ids = async (c: Client) => (await c.get('/api/me/notifications')).body.data.map((n: { id: string }) => n.id.split(':')[0]);

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [a1, a2, a3, fm, newFm, asha] = [await h.user('admin1'), await h.user('admin2'), await h.user('admin3'), await h.user('oldfm'), await h.user('newfm'), await h.user('asha')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: a1.userId, role: 'CHALLENGE_ADMIN' });
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('challenge admins', () => {
  it('an admin can make other users admins - no limit; participants cannot', async () => {
    expect((await asha.post(`/api/challenges/${id}/roles`, { userId: asha.userId, role: 'CHALLENGE_ADMIN' })).status).toBe(403);
    expect(await ids(a1)).toContain('admins'); // "needs at least 2 admins"
    for (const c of [a2, a3]) expect((await a1.post(`/api/challenges/${id}/roles`, { userId: c.userId, role: 'CHALLENGE_ADMIN' })).status).toBe(200);
    expect(await roles()).toEqual(['admin1:CHALLENGE_ADMIN', 'admin2:CHALLENGE_ADMIN', 'admin3:CHALLENGE_ADMIN']);
    expect(await ids(a1)).not.toContain('admins');
  });

  it('a published challenge never drops below 2 admins', async () => {
    await sa.post(`/api/challenges/${id}/publish`);
    expect((await a1.post(`/api/challenges/${id}/roles`, { userId: a3.userId, role: 'CHALLENGE_ADMIN', grant: false })).status).toBe(200);
    const r = await a1.post(`/api/challenges/${id}/roles`, { userId: a2.userId, role: 'CHALLENGE_ADMIN', grant: false });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('at least 2 admins');
  });
});

describe('the finance manager: exactly one, changed only through a handover', () => {
  it('the first one is appointed directly; a second can\'t be added, and the role can\'t simply be removed', async () => {
    expect(await ids(a1)).toContain('nofm');
    expect((await a1.post(`/api/challenges/${id}/roles`, { userId: fm.userId, role: 'FINANCE_ADMIN' })).status).toBe(200);
    expect((await a1.post(`/api/challenges/${id}/roles`, { userId: newFm.userId, role: 'FINANCE_ADMIN' })).status).toBe(409);
    expect((await a1.post(`/api/challenges/${id}/roles`, { userId: fm.userId, role: 'FINANCE_ADMIN', grant: false })).status).toBe(409);
    await fm.upload(`/api/challenges/${id}/payment-settings`, { upiId: 'oldfm@okbank', payeeName: 'Old FM' }, png('old-qr'));
    // Money held: Asha joins and pays ₹1,000, confirmed by the finance manager.
    const inv = await a1.post(`/api/challenges/${id}/invitations`, { userIds: [asha.userId] });
    await asha.post(`/api/invitations/${inv.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
    const p = await asha.post(`/api/challenges/${id}/payments`, { periodNo: 1, amount: 1000, utr: 'ASHA00000001', paidOn: '2026-11-20' });
    await fm.post(`/api/payments/${p.body.data.paymentId}/decide`, { confirm: true });
  });

  it('an admin starts a handover after seeing the checks; they can\'t appoint themselves; one at a time', async () => {
    const v = (await a1.get(`/api/challenges/${id}/finance-manager`)).body.data;
    expect(v).toMatchObject({ current: { username: 'oldfm' }, checks: { cashHeld: 1000, pendingPayments: 0, pendingRefunds: 0 }, pending: null, canChange: true });
    expect((await fm.post(`/api/challenges/${id}/finance-handovers`, { toUserId: newFm.userId, confirmHandedOver: true })).status).toBe(403); // not an admin
    expect((await a1.post(`/api/challenges/${id}/finance-handovers`, { toUserId: a1.userId, confirmHandedOver: true })).status).toBe(403);
    expect((await a1.post(`/api/challenges/${id}/finance-handovers`, { toUserId: newFm.userId })).status).toBe(400); // must confirm the hand-over
    expect((await a1.post(`/api/challenges/${id}/finance-handovers`, { toUserId: newFm.userId, confirmHandedOver: true, note: 'Old FM travelling' })).status).toBe(200);
    expect((await a2.post(`/api/challenges/${id}/finance-handovers`, { toUserId: asha.userId, confirmHandedOver: true })).status).toBe(409);
    expect(await ids(newFm)).toContain('handover');
  });

  it('the new manager must confirm the exact amount received and that the accounts are settled', async () => {
    const hid = (await a1.get(`/api/challenges/${id}/finance-manager`)).body.data.pending.handoverId;
    expect((await asha.get(`/api/finance-handovers/${hid}`)).status).toBe(404);
    expect((await newFm.get(`/api/finance-handovers/${hid}`)).body.data).toMatchObject({ forMe: true, cashHeld: 1000, challengeName: 'Calamari' });
    expect((await newFm.post(`/api/finance-handovers/${hid}/accept`, { receivedAmount: 900, accountsSettled: true })).status).toBe(400);
    expect((await newFm.post(`/api/finance-handovers/${hid}/accept`, { receivedAmount: 1000 })).status).toBe(400);
    expect((await asha.post(`/api/finance-handovers/${hid}/accept`, { receivedAmount: 1000, accountsSettled: true })).status).toBe(404);
    expect((await newFm.post(`/api/finance-handovers/${hid}/accept`, { receivedAmount: '1,000', accountsSettled: true, statement: 'Cash and the UPI statement received' })).status).toBe(200);
    expect(await roles()).toEqual(['admin1:CHALLENGE_ADMIN', 'admin2:CHALLENGE_ADMIN', 'newfm:FINANCE_ADMIN']);
    expect((await fm.get(`/api/challenges/${id}/finance`)).status).toBe(403); // the old manager no longer has access
  });

  it('the old UPI details are hidden from participants until the new manager adds theirs', async () => {
    const s = (await asha.get(`/api/challenges/${id}/payment-settings`)).body.data;
    expect(s).toMatchObject({ upiId: null, qrFileId: null, needsUpdate: true });
    expect(await ids(newFm)).toContain('paydetails');
    await newFm.post(`/api/challenges/${id}/payment-settings`, { upiId: 'newfm@okbank', payeeName: 'New FM' });
    expect((await asha.get(`/api/challenges/${id}/payment-settings`)).body.data).toMatchObject({ upiId: 'newfm@okbank', needsUpdate: false });
    expect(await ids(newFm)).not.toContain('paydetails');
  });

  it('a handover can be cancelled by an admin with a reason; everything is audited', async () => {
    const r = await a2.post(`/api/challenges/${id}/finance-handovers`, { toUserId: fm.userId, confirmHandedOver: true });
    expect((await a2.post(`/api/finance-handovers/${r.body.data.handoverId}/cancel`, { reason: '' })).status).toBe(400);
    expect((await a2.post(`/api/finance-handovers/${r.body.data.handoverId}/cancel`, { reason: 'Changed our mind' })).status).toBe(200);
    const { rows } = await h.admin.query(`SELECT action FROM audit_log WHERE challenge_id = $1 AND entity = 'FINANCE_HANDOVER' ORDER BY audit_id`, [id]);
    expect(rows.map((x) => x.action)).toEqual(['FINANCE_HANDOVER_STARTED', 'FINANCE_HANDOVER_ACCEPTED', 'FINANCE_HANDOVER_STARTED', 'FINANCE_HANDOVER_CANCELLED']);
  });
});
