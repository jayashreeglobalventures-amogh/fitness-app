// The incoming finance manager accepts a handover: confirms the amount received and that the accounts are settled.
import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { ErrorBox, Field, Loading, useLoad } from '../ui';

interface H { handoverId: number; challengeId: number; challengeName: string; status: string; fromName: string | null; cashHeld: number; pendingPayments: number; pendingRefunds: number; adminNote: string | null; forMe: boolean }
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function HandoverPage({ id }: { id: number }) {
  const h = useLoad(() => api.get<H>(`/api/finance-handovers/${id}`), [id]);
  const [amount, setAmount] = useState('');
  const [settled, setSettled] = useState(false);
  const [statement, setStatement] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  if (h.loading && !h.data) return <Loading />;
  if (!h.data) return <ErrorBox error={h.error} />;
  const d = h.data;
  const accept = async () => {
    setError(null);
    try { await api.post(`/api/finance-handovers/${id}/accept`, { receivedAmount: amount, accountsSettled: settled, statement }); setDone(true); } catch (e) { setError(e); }
  };
  if (done) return (
    <div className="card">
      <h1>You're the finance manager of {d.challengeName}</h1>
      <p>Next: enter your UPI ID and QR code so participants can pay you. The previous details are hidden from participants until you do.</p>
      <button className="btn primary" onClick={() => navigate(`/challenges/${d.challengeId}/money`)}>Add my payment details</button>
    </div>
  );
  return (
    <>
      <h1>Finance manager handover</h1>
      <div className="card">
        <h3>{d.challengeName}</h3>
        <dl className="kv">
          <dt>From</dt><dd>{d.fromName ?? 'Nobody (first finance manager)'}</dd>
          <dt>Money to hand over</dt><dd><b>{inr(d.cashHeld)}</b></dd>
          <dt>Payment reports to check</dt><dd>{d.pendingPayments}</dd>
          <dt>Refunds waiting</dt><dd>{d.pendingRefunds}</dd>
          {d.adminNote && <><dt>Admin's note</dt><dd>{d.adminNote}</dd></>}
        </dl>
      </div>
      {d.status !== 'PENDING' ? <div className="alert">This handover is {d.status.toLowerCase()}.</div> : !d.forMe ? <div className="alert">Waiting for the new finance manager to accept.</div> : (
        <div className="card">
          <p className="small">Only accept once you have actually received the money and the records. If the amount isn't right, don't accept: talk to the admin.</p>
          <ErrorBox error={error} />
          <Field label="Amount you received (₹)"><input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(d.cashHeld)} /></Field>
          <label className="check"><input type="checkbox" checked={settled} onChange={(e) => setSettled(e.target.checked)} /><span>I confirm the accounts have been settled with me (money, payment records and pending items).</span></label>
          <Field label="Note (optional)"><input type="text" value={statement} onChange={(e) => setStatement(e.target.value)} placeholder="e.g. received by bank transfer, statement checked" /></Field>
          <button className="btn primary" disabled={!amount || !settled} onClick={accept}>Accept and become finance manager</button>
        </div>
      )}
    </>
  );
}
