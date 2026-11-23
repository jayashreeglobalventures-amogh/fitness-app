// Money tab. Participants: where and how much to pay (UPI ID / QR / "pay with a UPI app"), week-by-week status,
// report a payment's UTR. Finance: pools + reconciliation, payments to confirm, everyone's position, refunds,
// payment details. Money never affects points.
import { useState } from 'react';
import { api } from '../api';
import { day, ErrorBox, Field, Loading, upload, useLoad, ViewPhoto } from '../ui';
import type { ChallengeView } from './Challenge';

interface Week {
  periodNo: number; startsOn: string; endsOn: string; dueOn: string; overdueFrom: string; due: number; paid: number; pending: number; status: string; finePool: number; fines: number;
  unused: number; unusedTo: string; finePoolLeft: number; carriedTo: number | null; carriedIn: number; fullDue: number; creditUsed: number;
}
interface Payment { paymentId: number; periodNo: number; amount: number; method: string; utr: string | null; paidOn: string; status: string; decisionReason: string | null; proofFileId: number | null }
interface Pools { prizePool: number; yearEndPool: number; collected: number; stillOwed: number; refundsDue: number; inFinePools: number; prizesDue: number }
interface MyMoney { weeks: Week[]; owed: number; refundDue: number; payments: Payment[]; pools: Pools; today: string }
interface Settings { upiId: string | null; payeeName: string | null; qrFileId: number | null; canEdit: boolean; needsUpdate: boolean }

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const STATUS: Record<string, { label: string; tone: string }> = {
  PAID: { label: 'Paid', tone: 'ok' }, CHECKING: { label: 'Being checked', tone: 'info' }, DUE: { label: 'Due', tone: 'warn' },
  OVERDUE: { label: 'Overdue', tone: 'danger' }, UPCOMING: { label: 'Upcoming', tone: '' }, NOT_DUE: { label: 'Not taking part', tone: '' },
  SUBMITTED: { label: 'Being checked', tone: 'info' }, CONFIRMED: { label: 'Confirmed', tone: 'ok' }, REJECTED: { label: 'Not accepted', tone: 'danger' }, WITHDRAWN: { label: 'Withdrawn', tone: '' },
};
const Badge = ({ s }: { s: string }) => <span className={`badge ${STATUS[s]?.tone ?? ''}`}>{STATUS[s]?.label ?? s}</span>;

export function MoneySection({ v }: { v: ChallengeView }) {
  const can = (p: string) => v.myPermissions.includes(p);
  const isParticipant = !!v.participantStatus;
  const isFinance = can('finance.view') || can('refunds.approve');
  const [view, setView] = useState<'mine' | 'finance'>(isFinance ? 'finance' : 'mine');
  return (
    <>
      {isParticipant && isFinance && (
        <div className="subnav inline" style={{ margin: '0 0 12px' }}>
          <button aria-current={view === 'finance'} onClick={() => setView('finance')}>Finance</button>
          <button aria-current={view === 'mine'} onClick={() => setView('mine')}>My money</button>
        </div>
      )}
      {view === 'finance' && isFinance ? <FinanceView v={v} /> : isParticipant ? <MyMoneyView v={v} /> : <PaymentDetails v={v} />}
    </>
  );
}

// ---------------- participant ----------------

function MyMoneyView({ v }: { v: ChallengeView }) {
  const m = useLoad(() => api.get<MyMoney>(`/api/challenges/${v.challengeId}/my-money`), [v.challengeId]);
  const [open, setOpen] = useState<number | null>(null);
  if (m.loading && !m.data) return <Loading />;
  if (!m.data) return <ErrorBox error={m.error} />;
  const d = m.data;
  // The week to pay now: anything overdue or due, else the next upcoming one (people often pay ahead).
  const next = d.weeks.find((w) => w.status === 'OVERDUE' || w.status === 'DUE') ?? d.weeks.find((w) => w.status === 'UPCOMING');
  return (
    <>
      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat"><span>Still to pay (all weeks)</span><b>{inr(d.owed)}</b></div>
        <div className="stat"><span>Owed back to you</span><b>{inr(d.refundDue)}</b></div>
        <div className="stat"><span>Prize pool</span><b>{inr(d.pools.prizePool)}</b></div>
      </div>
      {next && <PayNow v={v} week={next} onReported={m.reload} />}
      <h2>Week by week</h2>
      {d.weeks.filter((w) => w.status !== 'NOT_DUE').map((w) => (
        <div key={w.periodNo} className="card">
          <div className="spread">
            <div><b>Week {w.periodNo}</b> <span className="muted small">{day(w.startsOn)} – {day(w.endsOn)}</span></div>
            <Badge s={w.status} />
          </div>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Contribution</dt><dd>{inr(w.due)} · due {day(w.dueOn)}{w.status === 'DUE' ? ` (overdue from ${day(w.overdueFrom)})` : ''}</dd>
            {w.carriedIn > 0 && <><dt>Carried over</dt><dd className="small">{inr(w.fullDue)} − {inr(w.carriedIn)} unused fine-pool money from last week = {inr(w.due)}</dd></>}
            {w.paid > 0 && <><dt>Paid</dt><dd>{inr(w.paid)}{w.creditUsed > 0 && <span className="muted small"> (incl. {inr(w.creditUsed)} paid earlier)</span>}</dd></>}
            {w.pending > 0 && <><dt>Being checked</dt><dd>{inr(w.pending)}</dd></>}
            <dt>Fine pool</dt><dd>{inr(w.finePool)}{w.fines ? ` − fines ${inr(w.fines)}` : ''}{w.unused ? ` → ${inr(w.unused)} ${w.unusedTo === 'CARRY_FORWARD' ? `carried to week ${w.carriedTo}` : w.unusedTo === 'REFUND' ? 'owed back to you' : w.unusedTo === 'PRIZE_POOL' ? 'to the prize pool' : 'to the year-end pool'}` : w.fines < w.finePool ? ` (${inr(w.finePoolLeft)} left)` : ''}</dd>
          </dl>
          {(w.status === 'DUE' || w.status === 'OVERDUE' || w.status === 'UPCOMING') && open !== w.periodNo && <button className="btn small" style={{ marginTop: 8 }} onClick={() => setOpen(w.periodNo)}>I've paid this week</button>}
          {open === w.periodNo && <ReportPayment v={v} week={w} onDone={() => { setOpen(null); m.reload(); }} />}
        </div>
      ))}
      {d.payments.length > 0 && (
        <details className="card"><summary>My payment reports ({d.payments.length})</summary>
          {d.payments.map((p) => (
            <div key={p.paymentId} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span className="small">Week {p.periodNo} · {inr(p.amount)} · {p.utr ?? p.method.toLowerCase()} · paid {day(p.paidOn)}{p.decisionReason ? ` · ${p.decisionReason}` : ''}</span>
              <span className="row" style={{ gap: 6 }}><Badge s={p.status} />
                {p.status === 'SUBMITTED' && <button className="btn small ghost" onClick={() => api.post(`/api/payments/${p.paymentId}/withdraw`).then(m.reload)}>Withdraw</button>}</span>
            </div>
          ))}
        </details>
      )}
      <p className="muted small">Payments are made outside the app (UPI) and confirmed by a Finance Admin. They never affect your points.</p>
    </>
  );
}

function PayNow({ v, week, onReported }: { v: ChallengeView; week: Week; onReported: () => void }) {
  const s = useLoad(() => api.get<Settings>(`/api/challenges/${v.challengeId}/payment-settings`), [v.challengeId]);
  const [reporting, setReporting] = useState(false);
  const amount = Math.max(0, week.due - week.paid - week.pending);
  if (!s.data) return null;
  const upi = s.data.upiId;
  const link = upi ? `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(s.data.payeeName ?? v.name)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(`${v.name} week ${week.periodNo}`)}` : null;
  return (
    <div className="card today">
      <div className="spread"><h3>Week {week.periodNo}: {inr(amount)} {week.status === 'OVERDUE' ? 'overdue' : week.status === 'UPCOMING' ? `due ${day(week.dueOn)}` : 'due'}</h3><Badge s={week.status} /></div>
      {!upi && !s.data.qrFileId ? <p className="muted">{s.data.needsUpdate ? 'A new finance manager is taking over: their payment details will appear here soon. Please don\'t pay the previous details.' : 'The Finance Admin hasn\'t added payment details yet.'}</p> : (
        <div className="grid2" style={{ alignItems: 'center' }}>
          {s.data.qrFileId && <img src={`/api/files/${s.data.qrFileId}`} alt="UPI QR code" style={{ width: '100%', maxWidth: 240, borderRadius: 12, background: '#fff', padding: 8 }} />}
          <div className="stack">
            {upi && <div><span className="muted small">UPI ID</span><div className="row"><b style={{ userSelect: 'all' }}>{upi}</b>
              <button className="btn small ghost" onClick={() => navigator.clipboard?.writeText(upi)}>Copy</button></div>{s.data.payeeName && <div className="muted small">{s.data.payeeName}</div>}</div>}
            {link && <a className="btn primary" href={link}>Pay {inr(amount)} with a UPI app</a>}
            <p className="muted small">After paying, enter the UTR (UPI reference number) from your payment app.</p>
            {!reporting && <button className="btn" onClick={() => setReporting(true)}>I've paid: enter the UTR</button>}
          </div>
        </div>
      )}
      {reporting && <ReportPayment v={v} week={week} onDone={() => { setReporting(false); onReported(); }} />}
    </div>
  );
}

function ReportPayment({ v, week, onDone }: { v: ChallengeView; week: Week; onDone: () => void }) {
  const [f, setF] = useState({ amount: String(Math.max(0, week.due - week.paid - week.pending) || week.due), utr: '', paidOn: v.today, note: '' });
  const utrRequired = (v.upcoming ?? v.current).config.finance.utrRequired !== false;
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setError(null);
    try { await upload(`/api/challenges/${v.challengeId}/payments`, { periodNo: String(week.periodNo), ...f }, file); onDone(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="section">
      <ErrorBox error={error} />
      <div className="grid2">
        <Field label="Amount (₹)"><input type="number" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label={utrRequired ? 'UTR / UPI reference' : 'UTR / UPI reference (optional)'} hint="Usually 12 digits, in your payment app's receipt"><input type="text" inputMode="numeric" autoCapitalize="characters" value={f.utr} onChange={(e) => setF({ ...f, utr: e.target.value })} /></Field>
        <Field label="Paid on" hint="Paid before the app was live? Use the real date."><input type="date" value={f.paidOn} max={v.today} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
        <Field label="Screenshot (optional)"><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      </div>
      <button className="btn primary" disabled={busy || (utrRequired ? f.utr.trim().length < 6 : f.utr.trim().length > 0 && f.utr.trim().length < 6)} onClick={send}>{busy ? 'Sending…' : 'Send for checking'}</button>
    </div>
  );
}

// ---------------- payment details (UPI ID / QR) ----------------

function PaymentDetails({ v, onSaved }: { v: ChallengeView; onSaved?: () => void }) {
  const s = useLoad(() => api.get<Settings>(`/api/challenges/${v.challengeId}/payment-settings`), [v.challengeId]);
  const [f, setF] = useState<{ upiId: string; payeeName: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  if (!s.data) return <ErrorBox error={s.error} />;
  const cur = f ?? { upiId: s.data.upiId ?? '', payeeName: s.data.payeeName ?? '' };
  const save = async () => {
    setError(null); setSaved(false);
    try { await upload(`/api/challenges/${v.challengeId}/payment-settings`, cur, file); setSaved(true); setFile(null); s.reload(); onSaved?.(); } catch (e) { setError(e); }
  };
  return (
    <details className="card" open={(!s.data.upiId && !s.data.qrFileId) || (s.data.needsUpdate && s.data.canEdit)}>
      <summary>Payment details (UPI ID and QR)</summary>
      {s.data.needsUpdate && <div className="alert warn">{s.data.canEdit ? 'You are the new finance manager: enter your own UPI ID and QR. Until you save, participants see no payment details.' : 'Hidden from participants until the new finance manager enters theirs.'}</div>}
      {s.data.qrFileId && <img src={`/api/files/${s.data.qrFileId}`} alt="Current UPI QR code" style={{ width: 160, borderRadius: 12, background: '#fff', padding: 6, marginBottom: 10 }} />}
      {s.data.canEdit ? (<>
        <ErrorBox error={error} />
        {saved && <div className="alert ok">Saved. Participants see the new details right away.</div>}
        <div className="grid2">
          <Field label="UPI ID"><input type="text" autoCapitalize="none" value={cur.upiId} placeholder="name@bank" onChange={(e) => setF({ ...cur, upiId: e.target.value })} /></Field>
          <Field label="Payee name"><input type="text" value={cur.payeeName} onChange={(e) => setF({ ...cur, payeeName: e.target.value })} /></Field>
        </div>
        <Field label={s.data.qrFileId ? 'Replace the QR code (image)' : 'QR code (image)'}><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <button className="btn primary" onClick={save}>Save payment details</button>
      </>) : <p className="muted small">UPI ID: {s.data.upiId ?? 'not set'}{s.data.payeeName ? ` · ${s.data.payeeName}` : ''}</p>}
    </details>
  );
}

// ---------------- finance ----------------

interface Overview {
  pools: Pools; checks: { name: string; ok: boolean }[]; today: string; periods: { periodNo: number; startsOn: string; endsOn: string }[];
  participants: { participantId: number; displayName: string; status: string; isMe?: boolean; owed: number; refundDue: number; paid: number; fines: number; overdueWeeks: number[]; checking: number[] }[];
  payments: (Payment & { participantId: number; displayName: string; mine: boolean; note: string | null; recordedByAdmin: boolean; recordedByMe: boolean; byAdminForSelf: boolean })[];
  refunds: { refundId: number; participantId: number; displayName: string; amount: number; reason: string; status: string; proposedBy: number; decisionReason: string | null }[];
  canConfirm: boolean; canCountersign: boolean; canProposeRefund: boolean; canApproveRefund: boolean;
}

function FinanceView({ v }: { v: ChallengeView }) {
  const o = useLoad(() => api.get<Overview>(`/api/challenges/${v.challengeId}/finance`), [v.challengeId]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [act, setAct] = useState<{ kind: 'record' | 'refund'; participantId: number } | null>(null);
  if (o.loading && !o.data) return <Loading />;
  if (!o.data) return <ErrorBox error={o.error} />;
  const d = o.data;
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); o.reload(); } catch (e) { setError(e); } };
  const toCheck = d.payments.filter((p) => p.status === 'SUBMITTED');
  const allOk = d.checks.every((c) => c.ok);
  return (
    <>
      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat"><span>Prize pool</span><b>{inr(d.pools.prizePool)}</b></div>
        {d.pools.yearEndPool > 0 && <div className="stat"><span>Year-end pool</span><b>{inr(d.pools.yearEndPool)}</b></div>}
        <div className="stat"><span>Held (received − paid out)</span><b>{inr(d.pools.collected)}</b></div>
        <div className="stat"><span>Still owed to us</span><b>{inr(d.pools.stillOwed)}</b></div>
        <div className="stat"><span>Refunds owed</span><b>{inr(d.pools.refundsDue)}</b></div>
        {d.pools.prizesDue > 0 && <div className="stat"><span>Prizes owed</span><b>{inr(d.pools.prizesDue)}</b></div>}
        <div className="stat"><span>In fine pools</span><b>{inr(d.pools.inFinePools)}</b></div>
      </div>
      <details className="card"><summary>Reconciliation: {allOk ? '✅ all checks pass' : '⚠️ needs attention'}</summary>
        <ul>{d.checks.map((c) => <li key={c.name} className="small">{c.ok ? '✅' : '❌'} {c.name}</li>)}</ul>
        <p className="muted small">"Still owed" counts every week of the challenge, including weeks not due yet.</p>
      </details>
      <ErrorBox error={error} />

      <h2>Payments to check ({toCheck.length})</h2>
      {toCheck.length === 0 && <div className="card empty">Nothing waiting. ✅</div>}
      {toCheck.length > 0 && <Field label="Reason (needed to reject)"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. no such credit in the account" /></Field>}
      {toCheck.map((p) => (
        <div key={p.paymentId} className="card">
          <div className="spread"><b>{p.displayName} · week {p.periodNo} · {inr(p.amount)}</b><Badge s={p.status} /></div>
          <p className="small" style={{ margin: '6px 0' }}>{p.method === 'UPI' ? <>UTR <b style={{ userSelect: 'all' }}>{p.utr}</b></> : p.method.toLowerCase()} · paid {day(p.paidOn)}{p.note ? ` · ${p.note}` : ''}
            {p.proofFileId && <> · <ViewPhoto fileId={p.proofFileId} alt="Payment screenshot">screenshot</ViewPhoto></>}</p>
          {p.byAdminForSelf && <p className="small"><span className="badge info">an admin's own payment</span> needs another admin to confirm</p>}
          {p.mine ? <p className="muted small">Your own payment: another admin must confirm it.</p> : p.recordedByMe ? <p className="muted small">You recorded this: another admin must confirm it.</p> : (p.byAdminForSelf || p.recordedByAdmin ? d.canCountersign : d.canConfirm) && (
            <div className="row">
              <button className="btn small primary" onClick={() => run(() => api.post(`/api/payments/${p.paymentId}/decide`, { confirm: true }))}>Confirm received</button>
              <button className="btn small danger" disabled={reason.trim().length < 5} onClick={() => run(() => api.post(`/api/payments/${p.paymentId}/decide`, { confirm: false, reason }))}>Not received</button>
            </div>
          )}
        </div>
      ))}

      <h2>Everyone</h2>
      <div className="card table-wrap"><table>
        <thead><tr><th>Name</th><th>Paid</th><th>Fines</th><th>Owed back</th><th /></tr></thead>
        <tbody>{d.participants.map((p) => (
          <tr key={p.participantId}>
            <td><b>{p.displayName}</b>{p.overdueWeeks.length > 0 && <div><span className="badge danger">overdue: week {p.overdueWeeks.join(', ')}</span></div>}
              {p.checking.length > 0 && <div><span className="badge info">checking: week {p.checking.join(', ')}</span></div>}
              {p.status !== 'ACTIVE' && <div><span className="badge warn">{p.status.toLowerCase()}</span></div>}</td>
            <td>{inr(p.paid)}</td><td>{inr(p.fines)}</td><td>{inr(p.refundDue)}</td>
            <td><div className="row" style={{ gap: 4 }}>
              {d.canConfirm && <button className="btn small ghost" onClick={() => setAct({ kind: 'record', participantId: p.participantId })}>Record payment</button>}
              {d.canProposeRefund && <button className="btn small ghost" onClick={() => setAct({ kind: 'refund', participantId: p.participantId })}>Refund</button>}
            </div></td>
          </tr>))}
        </tbody></table></div>
      {act && <AdminAction d={d} act={act} onDone={() => { setAct(null); o.reload(); }} onCancel={() => setAct(null)} />}

      {d.refunds.length > 0 && (<>
        <h2>Refunds</h2>
        {d.refunds.map((r) => (
          <div key={r.refundId} className="card">
            <div className="spread"><b>{r.displayName} · {inr(r.amount)}</b><span className={`badge ${r.status === 'APPROVED' ? 'ok' : r.status === 'REJECTED' ? 'danger' : 'warn'}`}>{r.status.toLowerCase()}</span></div>
            <p className="small">{r.reason}{r.decisionReason ? ` · ${r.decisionReason}` : ''}</p>
            {r.status === 'PROPOSED' && d.canApproveRefund && (
              <div className="row">
                <button className="btn small primary" onClick={() => run(() => api.post(`/api/refunds/${r.refundId}/decide`, { approve: true }))}>Approve</button>
                <button className="btn small danger" disabled={reason.trim().length < 5} onClick={() => run(() => api.post(`/api/refunds/${r.refundId}/decide`, { approve: false, reason }))}>Reject (uses the reason above)</button>
              </div>
            )}
            {r.status === 'PROPOSED' && !d.canApproveRefund && <p className="muted small">Waiting for another admin to approve.</p>}
          </div>
        ))}
      </>)}

      <PaymentDetails v={v} />
      {d.payments.some((p) => p.status !== 'SUBMITTED') && (
        <details className="card"><summary>All payment reports</summary>
          {d.payments.filter((p) => p.status !== 'SUBMITTED').map((p) => (
            <div key={p.paymentId} className="spread small" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{p.displayName} · week {p.periodNo} · {inr(p.amount)} · {p.utr ?? p.method.toLowerCase()} · {day(p.paidOn)}{p.decisionReason ? ` · ${p.decisionReason}` : ''}</span><Badge s={p.status} />
            </div>
          ))}
        </details>
      )}
    </>
  );
}

function AdminAction({ d, act, onDone, onCancel }: { d: Overview; act: { kind: 'record' | 'refund'; participantId: number }; onDone: () => void; onCancel: () => void }) {
  const who = d.participants.find((p) => p.participantId === act.participantId)!;
  const [f, setF] = useState({ periodNo: String(d.periods[0]?.periodNo ?? 1), amount: '', method: 'UPI', utr: '', paidOn: d.today, reason: '' });
  const [error, setError] = useState<unknown>(null);
  const send = async () => {
    setError(null);
    try {
      if (act.kind === 'record') await api.post(`/api/participants/${act.participantId}/payments`, f);
      else await api.post(`/api/participants/${act.participantId}/refunds`, { amount: f.amount, reason: f.reason });
      onDone();
    } catch (e) { setError(e); }
  };
  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <div className="spread"><h3>{act.kind === 'record' ? `Record a payment from ${who.displayName}` : `Propose a refund to ${who.displayName}`}</h3><button className="btn small ghost" onClick={onCancel}>✕</button></div>
      <ErrorBox error={error} />
      {act.kind === 'record' ? (
        <div className="grid2">
          <Field label="Week"><select value={f.periodNo} onChange={(e) => setF({ ...f, periodNo: e.target.value })}>{d.periods.map((p) => <option key={p.periodNo} value={p.periodNo}>Week {p.periodNo} ({day(p.startsOn)})</option>)}</select></Field>
          <Field label="Amount (₹)"><input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Method"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="UPI">UPI</option><option value="CASH">Cash</option><option value="BANK_TRANSFER">Bank transfer</option><option value="OTHER">Other</option></select></Field>
          {f.method === 'UPI' && <Field label="UTR (optional)"><input type="text" value={f.utr} onChange={(e) => setF({ ...f, utr: e.target.value })} /></Field>}
          <Field label="Paid on"><input type="date" value={f.paidOn} max={d.today} onChange={(e) => setF({ ...f, paidOn: e.target.value })} /></Field>
          <Field label="Where it was reported (optional)"><input type="text" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. UTR sent on WhatsApp" /></Field>
        </div>
      ) : (
        <div className="grid2">
          <Field label="Amount (₹)"><input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Reason (the admin decision)"><input type="text" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. withdrew on medical grounds" /></Field>
        </div>
      )}
      <p className="muted small">{act.kind === 'record' ? (who.isMe ? 'This is your own payment: another admin must confirm it before it counts.' : 'It counts straight away (recorded in the activity log under your name).') : 'Another admin (not you) must approve it before it is owed.'}</p>
      <button className="btn primary" disabled={!f.amount} onClick={send}>{act.kind === 'record' ? (who.isMe ? 'Record - send for confirmation' : 'Record payment') : 'Propose refund'}</button>
    </div>
  );
}
