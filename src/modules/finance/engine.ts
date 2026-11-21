// The money engine: a PURE function from facts to the ledger transactions that should exist (double-entry, paise).
// Facts: the weekly periods, the rules in force, who takes part when, each day's class (from scoring.classify),
// confirmed payments and approved refunds. Tested directly in test/unit/finance.test.ts.
//
// Sign convention: debit positive, credit negative; every transaction's lines sum to 0.
//   CONTRIBUTION_DUE  RECEIVABLE:p +total | MAIN_POOL -main | FINE_POOL:p:w -fine     (owed, allocated once)
//   PAYMENT           CASH +amount        | RECEIVABLE:p -amount                     (confirmed by Finance Admin)
//   FINE              FINE_POOL:p:w +fine | MAIN_POOL -fine                          (missed eligible day; capped by balance)
//   UNUSED_FINE_POOL  FINE_POOL:p:w +left | REFUND_DUE:p / MAIN_POOL / YEAR_END_POOL -left   (when the week is closed)
//                     CARRY_FORWARD: FINE_POOL:p:w +left | RECEIVABLE:p -left - a credit against the next week the
//                     person takes part in (origin.intoPeriod), so they only pay the top-up; refunded if there is none.
//   REFUND            MAIN_POOL +amount   | REFUND_DUE:p -amount                     (approved by a Super Admin)
//   YEAR_END_TRANSFER YEAR_END_POOL +x    | MAIN_POOL -x                             (approved settlement uses the year-end pool)
//   PRIZE             MAIN_POOL +prize    | PRIZE_DUE:p -prize                       (approved settlement)
//   PAYOUT            PRIZE_DUE:p +prize, REFUND_DUE:p +refund | RECEIVABLE:p -setoff, CASH -paid   (payout recorded)
// The contribution is counted once (when due); fines and unused balances are internal moves of that same money.
import { daysBetween, type Period } from '../../core/dates.js';
import { contributionFor, type ChallengeConfig } from '../challenges/config.js';
import type { DayClass } from '../scoring/engine.js';

export type TxType = 'CONTRIBUTION_DUE' | 'PAYMENT' | 'FINE' | 'UNUSED_FINE_POOL' | 'REFUND' | 'YEAR_END_TRANSFER' | 'PRIZE' | 'PAYOUT';
export interface Line { account: string; amount: number }
export interface DesiredTx { baseKey: string; type: TxType; participantId: number | null; periodNo: number | null; day: string | null; lines: Line[]; origin: Record<string, unknown> }

export interface FinanceInput {
  periods: Period[];
  cfgOn(day: string): ChallengeConfig;
  participants: { participantId: number; joinedOn: string; leftOn: string | null; classes: Record<string, DayClass> }[];
  payments: { paymentId: number; participantId: number; periodNo: number; amount: number; paidOn: string }[];
  refunds: { refundId: number; participantId: number; amount: number }[];
  /** The settlement in force (approved or published), if any. */
  settlement?: { settlementId: number; yearEndUsed: number; prizes: { participantId: number; amount: number }[] } | null;
  payouts?: { payoutId: number; participantId: number; prize: number; refund: number; setoff: number; paid: number; paidOn: string }[];
}

const takesPartIn = (p: { joinedOn: string; leftOn: string | null }, per: Period) =>
  daysBetween(p.joinedOn, per.endsOn) >= 0 && (p.leftOn === null || daysBetween(per.startsOn, p.leftOn) >= 0);

export function money(input: FinanceInput): DesiredTx[] {
  const out: DesiredTx[] = [];
  for (const p of input.participants) {
    const pid = p.participantId;
    for (const per of input.periods) {
      const cfg = input.cfgOn(per.startsOn);
      if (!cfg.finance.enabled || !takesPartIn(p, per)) continue;
      const c = contributionFor(cfg, per.periodNo);
      const pool = `FINE_POOL:${pid}:${per.periodNo}`;
      // 1. Owed for this week (once), split into the prize pool and the person's fine pool.
      if (c.total > 0) {
        const lines: Line[] = [{ account: `RECEIVABLE:${pid}`, amount: c.total }];
        if (c.mainPool) lines.push({ account: 'MAIN_POOL', amount: -c.mainPool });
        if (c.finePool) lines.push({ account: pool, amount: -c.finePool });
        out.push({ baseKey: `due:${pid}:${per.periodNo}`, type: 'CONTRIBUTION_DUE', participantId: pid, periodNo: per.periodNo, day: per.startsOn, lines, origin: { ...c } });
      }
      // 2. Fines: each missed eligible day, never more than what is left in the week's fine pool.
      let left = c.finePool;
      let undecided = false;
      for (let i = 0; i < per.days; i++) {
        const d = addDay(per.startsOn, i);
        const cls = p.classes[d] ?? 'N';
        if (cls === 'U') undecided = true;
        if (cls !== 'M') continue;
        const fine = Math.min(input.cfgOn(d).finance.finePerMissedDay, left);
        if (fine <= 0) continue;
        left -= fine;
        out.push({ baseKey: `fine:${pid}:${d}`, type: 'FINE', participantId: pid, periodNo: per.periodNo, day: d,
          lines: [{ account: pool, amount: fine }, { account: 'MAIN_POOL', amount: -fine }], origin: { missedDay: d } });
      }
      // 3. Close the week: once every day of it is decided, what's left goes where the settings say.
      if (!undecided && left > 0 && per.days > 0 && lastDayDecided(p, per)) {
        const rule = cfg.finance.unusedFinePool;
        // Carry forward: the next week this person takes part in (with money on); none left -> refunded at the end.
        const next = rule === 'CARRY_FORWARD'
          ? input.periods.find((x) => x.periodNo > per.periodNo && takesPartIn(p, x) && input.cfgOn(x.startsOn).finance.enabled && contributionFor(input.cfgOn(x.startsOn), x.periodNo).total >= left)
          : undefined;
        if (next) {
          out.push({ baseKey: `unused:${pid}:${per.periodNo}`, type: 'UNUSED_FINE_POOL', participantId: pid, periodNo: per.periodNo, day: per.endsOn,
            lines: [{ account: pool, amount: left }, { account: `RECEIVABLE:${pid}`, amount: -left }], origin: { to: 'CARRY_FORWARD', intoPeriod: next.periodNo } });
        } else {
          const to = rule === 'REFUND' || rule === 'CARRY_FORWARD' ? `REFUND_DUE:${pid}` : rule === 'YEAR_END_POOL' ? 'YEAR_END_POOL' : 'MAIN_POOL';
          out.push({ baseKey: `unused:${pid}:${per.periodNo}`, type: 'UNUSED_FINE_POOL', participantId: pid, periodNo: per.periodNo, day: per.endsOn,
            lines: [{ account: pool, amount: left }, { account: to, amount: -left }], origin: { to: rule === 'CARRY_FORWARD' ? 'REFUND' : rule } });
        }
      }
    }
  }
  for (const pay of input.payments) {
    out.push({ baseKey: `pay:${pay.paymentId}`, type: 'PAYMENT', participantId: pay.participantId, periodNo: pay.periodNo, day: pay.paidOn,
      lines: [{ account: 'CASH', amount: pay.amount }, { account: `RECEIVABLE:${pay.participantId}`, amount: -pay.amount }], origin: { paymentId: pay.paymentId } });
  }
  for (const r of input.refunds) {
    out.push({ baseKey: `refund:${r.refundId}`, type: 'REFUND', participantId: r.participantId, periodNo: null, day: null,
      lines: [{ account: 'MAIN_POOL', amount: r.amount }, { account: `REFUND_DUE:${r.participantId}`, amount: -r.amount }], origin: { refundId: r.refundId } });
  }
  const s = input.settlement;
  if (s) {
    if (s.yearEndUsed > 0) out.push({ baseKey: `yearend:${s.settlementId}`, type: 'YEAR_END_TRANSFER', participantId: null, periodNo: null, day: null,
      lines: [{ account: 'YEAR_END_POOL', amount: s.yearEndUsed }, { account: 'MAIN_POOL', amount: -s.yearEndUsed }], origin: { settlementId: s.settlementId } });
    for (const p of s.prizes) if (p.amount > 0) out.push({ baseKey: `prize:${s.settlementId}:${p.participantId}`, type: 'PRIZE', participantId: p.participantId, periodNo: null, day: null,
      lines: [{ account: 'MAIN_POOL', amount: p.amount }, { account: `PRIZE_DUE:${p.participantId}`, amount: -p.amount }], origin: { settlementId: s.settlementId } });
  }
  for (const p of input.payouts ?? []) {
    const lines: Line[] = [];
    if (p.prize) lines.push({ account: `PRIZE_DUE:${p.participantId}`, amount: p.prize });
    if (p.refund) lines.push({ account: `REFUND_DUE:${p.participantId}`, amount: p.refund });
    if (p.setoff) lines.push({ account: `RECEIVABLE:${p.participantId}`, amount: -p.setoff });
    if (p.paid) lines.push({ account: 'CASH', amount: -p.paid });
    if (lines.length >= 2) out.push({ baseKey: `payout:${p.payoutId}`, type: 'PAYOUT', participantId: p.participantId, periodNo: null, day: p.paidOn, lines, origin: { payoutId: p.payoutId } });
  }
  return out;
}

/** The week is closed for a participant when its last day they take part on is over and decided. */
function lastDayDecided(p: FinanceInput['participants'][number], per: Period): boolean {
  for (let i = per.days - 1; i >= 0; i--) {
    const c = p.classes[addDay(per.startsOn, i)] ?? 'N';
    if (c === 'N') continue;
    return c !== 'U';
  }
  return true; // took part on no day of it (left at its start): nothing pending
}

const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Balances by account from ledger lines (sum of amounts). */
export function balances(lines: Line[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.account, (m.get(l.account) ?? 0) + l.amount);
  return m;
}
