// Today tab: two small rings - my share of the group pot (what I've paid vs everything collected) and this week's fine
// pool (still mine vs moved to the group by misses). Numbers are always written next to the rings.
import { api } from '../api';
import { Collapsible, useLoad } from '../ui';

interface MyMoney {
  weeks: { periodNo: number; startsOn: string; endsOn: string; finePool: number; fines: number; finePoolLeft: number; paid: number; creditUsed: number; status: string }[];
  payments: { amount: number; status: string }[];
  pools: { collected: number };
  prizePool?: { total: number; fromContributions: number; fromFines: number };
  today: string;
}
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** A two-part ring; `part` is drawn in the accent colour, the rest in a quiet neutral, with a thin gap between them. */
function Ring({ part, whole, label }: { part: number; whole: number; label: string }) {
  const r = 34, c = 2 * Math.PI * r;
  const share = whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
  const gap = share > 0 && share < 1 ? 3 : 0;
  return (
    <svg viewBox="0 0 84 84" width="84" height="84" role="img" aria-label={label}>
      <circle cx="42" cy="42" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="10" />
      {share < 1 && <circle cx="42" cy="42" r={r} fill="none" stroke="var(--ring-rest)" strokeWidth="10"
        strokeDasharray={`${Math.max(0, c * (1 - share) - gap)} ${c}`} strokeDashoffset={-(c * share + gap / 2)} transform="rotate(-90 42 42)" />}
      {share > 0 && <circle cx="42" cy="42" r={r} fill="none" stroke="var(--accent)" strokeWidth="10" strokeLinecap="butt"
        strokeDasharray={`${Math.max(0, c * share - gap)} ${c}`} strokeDashoffset={-gap / 2} transform="rotate(-90 42 42)" />}
      <text x="42" y="46" textAnchor="middle" fontSize="15" fontWeight="800" fill="var(--text)">{Math.round(share * 100)}%</text>
    </svg>
  );
}

export function MoneyRings({ challengeId }: { challengeId: number }) {
  const m = useLoad(() => api.get<MyMoney>(`/api/challenges/${challengeId}/my-money`), [challengeId]);
  const d = m.data;
  if (!d) return null;
  const myPaid = d.payments.filter((p) => p.status === 'CONFIRMED').reduce((a, p) => a + p.amount, 0);
  const pot = d.pools.collected;
  const week = d.weeks.find((w) => w.startsOn <= d.today && d.today <= w.endsOn && w.finePool > 0) ?? d.weeks.find((w) => w.finePool > 0);
  return (
    <Collapsible id={`money-${challengeId}`} title="💰 My money" className="money-rings">
      <div className="ring-row">
        <Ring part={myPaid} whole={pot} label={`My payments: ${inr(myPaid)} of ${inr(pot)} collected`} />
        <div className="small">
          <b>My share of the pot</b>
          <div><span className="dot" style={{ background: 'var(--accent)' }} /> Me: {inr(myPaid)}</div>
          <div><span className="dot" style={{ background: 'var(--ring-rest)' }} /> Everyone else: {inr(Math.max(0, pot - myPaid))}</div>
          <div className="muted">Collected so far: {inr(pot)}</div>
        </div>
      </div>
      {week && (
        <div className="ring-row">
          <Ring part={week.finePoolLeft} whole={week.finePool} label={`Week ${week.periodNo} fine pool: ${inr(week.finePoolLeft)} of ${inr(week.finePool)} still mine`} />
          <div className="small">
            <b>Fine pool · week {week.periodNo}</b>
            <div><span className="dot" style={{ background: 'var(--accent)' }} /> Still mine: {inr(week.finePoolLeft)}</div>
            <div><span className="dot" style={{ background: 'var(--ring-rest)' }} /> To the group (misses): {inr(week.fines)}</div>
            <div className="muted">Of {inr(week.finePool)}</div>
          </div>
        </div>
      )}
      {d.prizePool && d.prizePool.total > 0 && (
        <div className="ring-row">
          <Ring part={d.prizePool.fromFines} whole={d.prizePool.total} label={`Prize pool ${inr(d.prizePool.total)}: ${inr(d.prizePool.fromFines)} from fines, ${inr(d.prizePool.fromContributions)} from weekly contributions`} />
          <div className="small">
            <b>Prize pool</b>
            <div><span className="dot" style={{ background: 'var(--ring-rest)' }} /> Weekly ₹ shares: {inr(d.prizePool.fromContributions)}</div>
            <div><span className="dot" style={{ background: 'var(--accent)' }} /> From misses (fines): {inr(d.prizePool.fromFines)}</div>
            <div className="muted">Total: {inr(d.prizePool.total)} (all weeks)</div>
          </div>
        </div>
      )}
    </Collapsible>
  );
}
