import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addDays, computePeriods } from '../../src/core/dates.js';
import { normalizeConfig, type ChallengeConfig } from '../../src/modules/challenges/config.js';
import { balances, money, type FinanceInput } from '../../src/modules/finance/engine.js';
import type { DayClass } from '../../src/modules/scoring/engine.js';

const calamariAsIs = (): ChallengeConfig => normalizeConfig(JSON.parse(readFileSync(new URL('../../config/challenges/calamari-2026.json', import.meta.url), 'utf8')));
/** Calamari's amounts with the "refunded at the end" rule (most tests below); carry-over has its own tests. */
const calamari = (): ChallengeConfig => { const c = calamariAsIs(); c.finance.unusedFinePool = 'REFUND'; return c; };
const PERIODS = computePeriods('2026-11-22', '2026-12-31', 'SUNDAY');
const DAYS = Array.from({ length: 40 }, (_, i) => addDays('2026-11-22', i));
const rs = (n: number) => n * 100; // rupees -> paise

/** Pattern letters from 22 Nov; S success, M missed, P rest/excused, U undecided, '.' not taking part. Missing = U. */
const classes = (pattern: string): Record<string, DayClass> =>
  Object.fromEntries(DAYS.map((d, i) => [d, (pattern[i] === undefined ? 'U' : pattern[i] === '.' ? 'N' : pattern[i]) as DayClass]));

function run(people: Record<number, string>, opts: { cfg?: ChallengeConfig; payments?: FinanceInput['payments']; refunds?: FinanceInput['refunds']; joined?: Record<number, string>; left?: Record<number, string> } = {}) {
  const cfg = opts.cfg ?? calamari();
  const txs = money({
    periods: PERIODS, cfgOn: () => cfg,
    participants: Object.entries(people).map(([id, pat]) => ({ participantId: Number(id), joinedOn: opts.joined?.[Number(id)] ?? '2026-11-22', leftOn: opts.left?.[Number(id)] ?? null, classes: classes(pat) })),
    payments: opts.payments ?? [], refunds: opts.refunds ?? [],
  });
  const bal = balances(txs.flatMap((t) => t.lines));
  return { txs, bal: (a: string) => bal.get(a) ?? 0 };
}
const all = (c: string, n = 40) => c.repeat(n);

describe('Calamari money (paise; debit +, credit -)', () => {
  it('every transaction balances to zero', () => {
    const { txs } = run({ 1: all('S'), 2: 'SMMPS' + all('S', 35) }, { payments: [{ paymentId: 1, participantId: 1, periodNo: 1, amount: rs(1000), paidOn: '2026-11-22' }] });
    for (const t of txs) expect(t.lines.reduce((a, l) => a + l.amount, 0)).toBe(0);
  });

  it('a normal week: ₹1,000 owed = ₹400 prize pool + ₹600 fine pool; no misses -> ₹600 refunded to the person', () => {
    const { txs, bal } = run({ 1: all('S', 7) }); // week 1 decided; later weeks undecided
    const due = txs.find((t) => t.baseKey === 'due:1:1')!;
    expect(due.lines).toEqual([{ account: 'RECEIVABLE:1', amount: rs(1000) }, { account: 'MAIN_POOL', amount: -rs(400) }, { account: 'FINE_POOL:1:1', amount: -rs(600) }]);
    expect(bal('FINE_POOL:1:1')).toBe(0);
    expect(bal('REFUND_DUE:1')).toBe(-rs(600));
    expect(bal('MAIN_POOL')).toBe(-rs(400) * 5 - rs(286)); // all six weeks (5 full + the short last one) are owed already
  });

  it('two missed days: ₹200 of fines to the prize pool, ₹400 refunded; rest and excused days cost nothing', () => {
    const { bal } = run({ 1: 'SMPMSSS' });
    expect(bal('REFUND_DUE:1')).toBe(-rs(400));
    expect(bal('MAIN_POOL')).toBe(-(rs(400) * 5 + rs(286)) - rs(200)); // contributions' prize share + the two fines
  });

  it('fines never exceed the fine pool: 7 misses in a normal week = ₹600, not ₹700; nothing left to refund', () => {
    const { txs, bal } = run({ 1: all('M', 7) });
    const fines = txs.filter((t) => t.type === 'FINE' && t.periodNo === 1);
    expect(fines.map((t) => t.lines[0]!.amount)).toEqual([rs(100), rs(100), rs(100), rs(100), rs(100), rs(100)]);
    expect(bal('FINE_POOL:1:1')).toBe(0);
    expect(txs.some((t) => t.baseKey === 'unused:1:1')).toBe(false);
  });

  it('final partial week: ₹714 = ₹286 + ₹428; five misses take only the ₹428 available (100+100+100+100+28)', () => {
    const { txs } = run({ 1: all('S', 35) + all('M', 5) });
    const due6 = txs.find((t) => t.baseKey === 'due:1:6')!;
    expect(due6.lines.map((l) => l.amount)).toEqual([rs(714), -rs(286), -rs(428)]);
    expect(txs.filter((t) => t.type === 'FINE' && t.periodNo === 6).map((t) => t.lines[0]!.amount)).toEqual([rs(100), rs(100), rs(100), rs(100), rs(28)]);
  });

  it('a whole challenge with no misses: owes ₹5,714; ₹2,286 to the prize pool; ₹3,428 refunded - counted once', () => {
    const { bal } = run({ 1: all('S') });
    expect(bal('RECEIVABLE:1')).toBe(rs(5714));
    expect(bal('MAIN_POOL')).toBe(-rs(2286));
    expect(bal('REFUND_DUE:1')).toBe(-rs(3428));
    expect(bal('RECEIVABLE:1') + bal('MAIN_POOL') + bal('REFUND_DUE:1')).toBe(0); // nothing double-counted
  });

  it('payments reduce what is owed; cash equals confirmed payments', () => {
    const { bal } = run({ 1: all('S', 7) }, { payments: [{ paymentId: 9, participantId: 1, periodNo: 1, amount: rs(1000), paidOn: '2026-11-22' }] });
    expect(bal('CASH')).toBe(rs(1000));
    expect(bal('RECEIVABLE:1')).toBe(rs(5714) - rs(1000));
  });

  it('a week with a day still undecided is not closed (no refund yet)', () => {
    const { txs } = run({ 1: 'SSSSSS' }); // the 7th day is undecided
    expect(txs.some((t) => t.baseKey === 'unused:1:1')).toBe(false);
  });

  it('a late joiner owes the weeks they take part in; someone who left owes no later weeks', () => {
    const late = run({ 1: '.........' + all('S', 31) }, { joined: { 1: '2026-12-01' } });
    expect(late.txs.filter((t) => t.type === 'CONTRIBUTION_DUE').map((t) => t.periodNo)).toEqual([2, 3, 4, 5, 6]);
    const gone = run({ 1: all('S', 10) + all('.', 30) }, { left: { 1: '2026-12-01' } });
    expect(gone.txs.filter((t) => t.type === 'CONTRIBUTION_DUE').map((t) => t.periodNo)).toEqual([1, 2]);
  });

  it('Calamari carries unused fine-pool money over: no misses -> next week owes only ₹400', () => {
    expect(calamariAsIs().finance.unusedFinePool).toBe('CARRY_FORWARD');
    const { txs, bal } = run({ 1: all('S', 7) }, { cfg: calamariAsIs() });
    const carry = txs.find((t) => t.baseKey === 'unused:1:1')!;
    expect(carry.lines).toEqual([{ account: 'FINE_POOL:1:1', amount: rs(600) }, { account: 'RECEIVABLE:1', amount: -rs(600) }]);
    expect(carry.origin).toEqual({ to: 'CARRY_FORWARD', intoPeriod: 2 });
    expect(bal('REFUND_DUE:1')).toBe(0);
    expect(bal('FINE_POOL:1:2')).toBe(-rs(600)); // week 2's fine pool is full again
  });

  it('owner\'s example: 3 misses in week 1 -> ₹300 carried, so week 2 owes ₹400 + ₹300 = ₹700', () => {
    const { txs } = run({ 1: 'SMMMSSS' }, { cfg: calamariAsIs() });
    expect(txs.filter((t) => t.type === 'FINE').length).toBe(3);
    expect(txs.find((t) => t.baseKey === 'unused:1:1')!.lines).toEqual([{ account: 'FINE_POOL:1:1', amount: rs(300) }, { account: 'RECEIVABLE:1', amount: -rs(300) }]);
    const owedWeek2 = rs(1000) - rs(300);
    expect(owedWeek2).toBe(rs(700));
  });

  it('carry-over: the last week\'s leftover (or after leaving) is refunded; every entry still balances', () => {
    const { txs, bal } = run({ 1: all('S') }, { cfg: calamariAsIs() });
    for (const t of txs) expect(t.lines.reduce((a, l) => a + l.amount, 0)).toBe(0);
    expect(txs.filter((t) => t.origin.to === 'CARRY_FORWARD').map((t) => t.periodNo)).toEqual([1, 2, 3, 4, 5]);
    expect(bal('REFUND_DUE:1')).toBe(-rs(428)); // the short last week's fine pool (₹428), nothing to carry it into
    const gone = run({ 1: all('S', 10) + all('.', 30) }, { cfg: calamariAsIs(), left: { 1: '2026-12-01' } });
    expect(gone.txs.find((t) => t.baseKey === 'unused:1:2')!.origin).toEqual({ to: 'REFUND' });
  });

  it('unused fine-pool money can go to the prize pool or a separate year-end pool instead (settings)', () => {
    const p = calamari(); p.finance.unusedFinePool = 'PRIZE_POOL';
    expect(run({ 1: 'SMSSSSS' }, { cfg: p }).bal('REFUND_DUE:1')).toBe(0);
    const y = calamari(); y.finance.unusedFinePool = 'YEAR_END_POOL';
    expect(run({ 1: 'SMSSSSS' }, { cfg: y }).bal('YEAR_END_POOL')).toBe(-rs(500));
  });

  it('an approved refund moves money from the prize pool to what is owed back to the person', () => {
    const { bal } = run({ 1: all('S', 7) }, { refunds: [{ refundId: 1, participantId: 1, amount: rs(400) }] });
    expect(bal('REFUND_DUE:1')).toBe(-rs(600) - rs(400));
  });

  it('a challenge without money produces no transactions', () => {
    const c = calamari(); c.finance.enabled = false;
    expect(run({ 1: all('M') }, { cfg: c }).txs).toEqual([]);
  });
});
