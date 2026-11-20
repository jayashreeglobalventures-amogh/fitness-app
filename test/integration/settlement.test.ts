import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/core/dates.js';
import type { ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

// A one-week challenge with Calamari's rules and money (₹1,000 = ₹400 prize pool + ₹600 fine pool).
let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, fa: Client, asha: Client, ben: Client, chitra: Client, dev: Client;
let id: number;
const pid: Record<string, number> = {};
const reader: ScreenshotReader = { async read(_i, _m, ctx) { return { readable: true, date: ctx.expectedDay, value: 9000, sourceApp: 'Fake', confidence: 0.99, flags: [], notes: '', model: 'fake', provider: 'fake' }; } };
let n = 0;
const DAYS = Array.from({ length: 7 }, (_, i) => addDays('2026-11-22', i));
const results = async (c: Client) => (await c.get(`/api/challenges/${id}/results`)).body.data;
const rs = (x: number) => Math.round(x * 100);

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [ca, fa, asha, ben, chitra, dev] = [await h.user('chadmin'), await h.user('finadmin'), await h.user('asha'), await h.user('ben'), await h.user('chitra'), await h.user('dev')];
  const cfg = calamariConfig();
  cfg.basics.endDate = '2026-11-28';
  cfg.finance.periodOverrides = [];
  cfg.prizes.payoutDate = '2026-11-30';
  id = (await sa.post('/api/challenges', { slug: 'one-week', config: cfg })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/roles`, { userId: fa.userId, role: 'FINANCE_ADMIN' });
  await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ben, chitra, dev]) {
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    pid[c.username] = (await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true })).body.data.participantId;
  }
  setReaderForTests(reader);
  // Who walks which day: Asha every day; Ben misses day 3; Chitra misses day 5 (Ben and Chitra end up tied on every
  // ranking rule); Dev walks 4 of 7 days (57 %: not eligible).
  const plan: Record<string, number[]> = { asha: [0, 1, 2, 3, 4, 5, 6], ben: [0, 1, 3, 4, 5, 6], chitra: [0, 1, 2, 3, 5, 6], dev: [0, 1, 2, 3] };
  for (let d = 0; d < 7; d++) {
    h.setNow(`${DAYS[d]}T06:30:00Z`);
    for (const c of [asha, ben, chitra, dev]) if (plan[c.username]!.includes(d)) {
      await c.upload(`/api/challenges/${id}/submissions`, { clientRef: `walk-${c.username}-${++n}` }, png(`${c.username}-${d}`));
      await h.settle();
    }
  }
  // Asha, Ben and Chitra pay; Dev doesn't.
  for (const c of [asha, ben, chitra]) {
    const p = await c.post(`/api/challenges/${id}/payments`, { periodNo: 1, amount: 1000, utr: `UTR${c.username.toUpperCase()}0001`, paidOn: '2026-11-22' });
    await fa.post(`/api/payments/${p.body.data.paymentId}/decide`, { confirm: true });
  }
}, 180_000);
afterEach(async () => { await h.settle(); });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('final settlement', () => {
  it('not before the challenge is over', async () => {
    h.setNow('2026-11-28T12:00:00Z'); // 17:30 IST on the last day
    const r = await results(sa);
    expect(r.checks.find((c: { key: string }) => c.key === 'ended').ok).toBe(false);
    const prep = await sa.post(`/api/challenges/${id}/settlements`, {});
    expect((await sa.post(`/api/settlements/${prep.body.data.settlementId}/approve`, {})).status).toBe(409);
  });

  it('after the end: everything decided; recommendation with the pool, prizes, refunds and what Dev still owes', async () => {
    h.setNow('2026-11-29T03:00:00Z');
    const r0 = await results(sa);
    expect(r0.checks.filter((c: { ok: boolean; blocking: boolean }) => c.blocking && !c.ok)).toEqual([]);
    expect(r0.checks.find((c: { key: string }) => c.key === 'owed')).toMatchObject({ ok: false, blocking: false }); // Dev hasn't paid: noted, not blocking
    await sa.post(`/api/challenges/${id}/settlements`, {});
    const s = (await results(sa)).settlements.find((x: { status: string }) => x.status === 'DRAFT').snapshot;
    // Pool: 4 × ₹400 + fines (Ben ₹100, Chitra ₹100, Dev ₹300) = ₹2,100.
    expect(s.pools.prizePool).toBe(rs(2100));
    expect(s.standings.map((x: { displayName: string; eligible: boolean }) => [x.displayName, x.eligible])).toEqual([['asha', true], ['ben', true], ['chitra', true], ['dev', false]]);
    // Ben and Chitra are identical on every rule -> a decision is needed, and their places' money is held back.
    expect(s.prizes.issues.map((i: { kind: string }) => i.kind)).toEqual(['TIE_NEEDS_DECISION']);
    expect(s.prizes.issues[0].places).toEqual([2, 3]);
    const devS = s.statements.find((x: { displayName: string }) => x.displayName === 'dev');
    expect(devS).toMatchObject({ prize: 0, refund: rs(300), owed: rs(1000), setoff: rs(300), net: 0, stillOwesAfter: rs(700) });
  });

  it('only a Super Admin approves, and not while a prize tie is undecided', async () => {
    const draft = (await results(sa)).settlements.find((x: { status: string }) => x.status === 'DRAFT');
    expect((await fa.post(`/api/settlements/${draft.settlementId}/approve`, {})).status).toBe(403);
    expect((await ca.post(`/api/settlements/${draft.settlementId}/approve`, {})).status).toBe(403);
    expect((await sa.post(`/api/settlements/${draft.settlementId}/approve`, {})).status).toBe(409);
  });

  it('the Finance Admin records the tie decision (split equally) with a reason; the Super Admin approves; prizes are booked', async () => {
    const key = (await results(fa)).settlements.find((x: { status: string }) => x.status === 'DRAFT').snapshot.prizes.issues[0].groupKey;
    expect((await fa.post(`/api/challenges/${id}/settlements`, { tieDecisions: [{ groupKey: key, resolution: 'SPLIT_EQUALLY', reason: '' }] })).status).toBe(400);
    expect((await fa.post(`/api/challenges/${id}/settlements`, { tieDecisions: [{ groupKey: key, resolution: 'SPLIT_EQUALLY', reason: 'Identical on every rule; equal treatment' }] })).status).toBe(200);
    const draft = (await results(sa)).settlements.find((x: { status: string }) => x.status === 'DRAFT');
    const a = (name: string) => draft.snapshot.prizes.allocations.find((x: { displayName: string }) => x.displayName === name);
    // Top three: 30 % of ₹2,100 = ₹630 -> 1st ₹315; 2nd+3rd (₹189 + ₹126) shared: ₹157.50 each. 70 % = ₹1,470 / 3 = ₹490.
    expect(a('asha')).toMatchObject({ place: 1, topThree: rs(315), qualification: rs(490), total: rs(805) });
    expect(a('ben').topThree).toBe(rs(157.5));
    expect(a('chitra').topThree).toBe(rs(157.5));
    expect(a('dev').total).toBe(0);
    expect(draft.snapshot.prizes.allocations.reduce((s: number, x: { total: number }) => s + x.total, 0)).toBe(rs(2100));
    expect((await sa.post(`/api/settlements/${draft.settlementId}/approve`, {})).status).toBe(200);
    const { rows } = await h.admin.query(`SELECT l.account, sum(l.amount_paise)::bigint AS amt FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id) WHERE t.challenge_id = $1 AND l.account LIKE 'PRIZE_DUE:%' GROUP BY l.account`, [id]);
    expect(rows.reduce((s, r) => s + Number(r.amt), 0)).toBe(-rs(2100));
    // Approved results are frozen.
    await expect(h.admin.query(`UPDATE settlements SET snapshot = '{}'::jsonb WHERE settlement_id = $1`, [draft.settlementId])).rejects.toThrow(/can no longer change/);
  });

  it('participants see nothing until published; then the final standings and their own statement', async () => {
    expect((await results(asha)).published).toBeNull();
    const approved = (await results(sa)).settlements.find((x: { status: string }) => x.status === 'APPROVED');
    expect((await fa.post(`/api/settlements/${approved.settlementId}/publish`)).status).toBe(403);
    expect((await sa.post(`/api/settlements/${approved.settlementId}/publish`)).status).toBe(200);
    const r = (await results(asha)).published;
    expect(r.standings[0]).toMatchObject({ displayName: 'asha', rank: 1, prize: rs(805), me: true });
    expect(r.mine).toMatchObject({ prize: rs(805), refund: rs(600), owed: 0, net: rs(1405) });
    expect(JSON.stringify(r)).not.toContain('"owed":100000'); // nobody else's statement
  });

  it('payouts: prize + refund paid once with a reference; what Dev owes is set off; nobody pays themselves', async () => {
    const st = (await results(sa)).settlements.find((x: { status: string }) => x.status === 'PUBLISHED');
    const pay = (who: string, c: Client = fa, body: Record<string, unknown> = { method: 'UPI', reference: `PAYOUT${who}`, paidOn: '2026-11-30' }) =>
      c.post(`/api/settlements/${st.settlementId}/payouts/${pid[who]}`, body);
    expect((await pay('asha', ca)).status).toBe(403);
    expect((await pay('asha', fa, { method: 'UPI', paidOn: '2026-11-30' })).status).toBe(400); // UTR needed
    h.setNow('2026-11-30T06:00:00Z');
    const a = await pay('asha');
    expect(a.body.data.paid).toBe(rs(1405));
    expect((await pay('asha')).status).toBe(409); // not twice
    const d = await pay('dev', fa, { paidOn: '2026-11-30' });
    expect(d.body.data.paid).toBe(0); // his ₹300 refund went against the ₹1,000 he owed
    const money = (await dev.get(`/api/challenges/${id}/my-money`)).body.data;
    expect(money.owed).toBe(700);
    expect(money.refundDue).toBe(0);
    const f = (await fa.get(`/api/challenges/${id}/finance`)).body.data;
    expect(f.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it('a later correction is a new version (with a reason) that replaces the approved one; already-paid money is not paid twice', async () => {
    expect((await sa.post(`/api/challenges/${id}/settlements`, {})).status).toBe(400); // reason needed
    const key = (await results(sa)).settlements.find((x: { status: string }) => x.status === 'PUBLISHED').snapshot.prizes.issues;
    void key;
    const tie = (await results(sa)).settlements.find((x: { status: string }) => x.status === 'PUBLISHED').snapshot.tieDecisions;
    const prep = await sa.post(`/api/challenges/${id}/settlements`, { reason: 'Re-check after a late appeal', tieDecisions: tie.map((t: { groupKey: string; reason: string; decision: { resolution: string } }) => ({ groupKey: t.groupKey, reason: t.reason, resolution: t.decision.resolution })) });
    expect(prep.status).toBe(200);
    const draft = (await results(sa)).settlements.find((x: { status: string }) => x.status === 'DRAFT');
    expect(draft.snapshot.statements.find((s: { displayName: string }) => s.displayName === 'asha')).toMatchObject({ prize: rs(805), prizeAlreadyPaid: rs(805), net: 0 });
    expect((await sa.post(`/api/settlements/${draft.settlementId}/approve`, {})).status).toBe(200);
    const list = (await results(sa)).settlements.map((x: { versionNo: number; status: string }) => [x.versionNo, x.status]);
    expect(list).toEqual([[2, 'APPROVED']]);
    expect((await fa.post(`/api/settlements/${draft.settlementId}/payouts/${pid.asha}`, { method: 'UPI', reference: 'AGAIN', paidOn: '2026-11-30' })).status).toBe(409); // nothing owed
    const { rows } = await h.admin.query(`SELECT action FROM audit_log WHERE challenge_id = $1 AND entity IN ('SETTLEMENT','PAYOUT') ORDER BY audit_id`, [id]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['SETTLEMENT_PREPARED', 'SETTLEMENT_APPROVED', 'RESULTS_PUBLISHED', 'PAYOUT_RECORDED', 'SETTLEMENT_CORRECTION_APPROVED']));
  });
});
