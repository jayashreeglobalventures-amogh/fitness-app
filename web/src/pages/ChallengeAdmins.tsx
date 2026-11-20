// Admins tab: challenge admins (any admin can add more; at least 2) and the finance manager (exactly one; changed
// through a handover the new manager accepts).
import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Field, useLoad } from '../ui';
import type { ChallengeView } from './Challenge';

interface Role { userId: number; username: string; displayName: string; role: string }
interface UserRow { userId: number; username: string; displayName: string; status: string }
interface FM {
  current: { userId: number; displayName: string; username: string } | null;
  checks: { cashHeld: number; pendingPayments: number; pendingRefunds: number };
  pending: { handoverId: number; toUserId: number; toName: string; toUsername: string; cashHeld: number; initiatedAt: string; adminNote: string | null } | null;
  history: { handoverId: number; from: string | null; to: string; status: string; cashHeld: number; received: number | null; acceptedAt: string | null; cancelReason: string | null }[];
  canChange: boolean;
}
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function AdminsSection({ v }: { v: ChallengeView }) {
  const canManage = v.myPermissions.includes('challenge.roles.manage');
  const roles = useLoad(() => api.get<Role[]>(`/api/challenges/${v.challengeId}/roles`), [v.challengeId]);
  const people = useLoad(() => (canManage ? api.get<UserRow[]>('/api/admin/users') : Promise.resolve([])), [canManage]);
  const fm = useLoad(() => api.get<FM>(`/api/challenges/${v.challengeId}/finance-manager`), [v.challengeId]);
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const admins = (roles.data ?? []).filter((r) => r.role === 'CHALLENGE_ADMIN');
  const change = async (uid: number, role: string, grant: boolean) => {
    setError(null);
    try { await api.post(`/api/challenges/${v.challengeId}/roles`, { userId: uid, role, grant }); roles.reload(); fm.reload(); setUserId(''); } catch (e) { setError(e); }
  };
  const candidates = (people.data ?? []).filter((u) => u.status === 'ACTIVE' && !admins.some((a) => a.userId === u.userId));
  return (
    <>
      <ErrorBox error={error ?? roles.error} />
      <div className="card">
        <div className="spread"><h3>Challenge admins ({admins.length})</h3>{admins.length < 2 && <span className="badge warn">at least 2 needed</span>}</div>
        <p className="muted small">Invitations, roster, evidence, rest days, exemptions, bonuses, settings. Any admin can add more admins (no limit). A challenge needs at least 2, so nothing depends on one person, and one admin's money requests are approved by another.</p>
        {admins.map((r) => (
          <div key={r.userId} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <span>{r.displayName} <span className="muted small">@{r.username}</span></span>
            {canManage && <button className="btn small ghost danger" disabled={v.status === 'PUBLISHED' && admins.length <= 2} title={admins.length <= 2 ? 'At least 2 admins are needed' : ''} onClick={() => change(r.userId, 'CHALLENGE_ADMIN', false)}>Remove</button>}
          </div>
        ))}
        {canManage && (
          <div className="row" style={{ marginTop: 10 }}>
            <select value={userId} onChange={(e) => setUserId(e.target.value)} style={{ flex: 1, minWidth: 180 }}>
              <option value="">Choose a person…</option>
              {candidates.map((u) => <option key={u.userId} value={u.userId}>{u.displayName} (@{u.username})</option>)}
            </select>
            <button className="btn primary" disabled={!userId} onClick={() => change(Number(userId), 'CHALLENGE_ADMIN', true)}>Make admin</button>
          </div>
        )}
      </div>
      {v.current.config.finance.enabled && fm.data && <FinanceManager v={v} d={fm.data} people={people.data ?? []} onChanged={() => { fm.reload(); roles.reload(); }} />}
      <p className="muted small">Super Admins can do everything. No admin role gives access to anyone's health data.</p>
    </>
  );
}

function FinanceManager({ v, d, people, onChanged }: { v: ChallengeView; d: FM; people: UserRow[]; onChanged: () => void }) {
  const [to, setTo] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); setOpen(false); setTo(''); setConfirmed(false); setNote(''); onChanged(); } catch (e) { setError(e); } };
  const choices = people.filter((u) => u.status === 'ACTIVE' && u.userId !== d.current?.userId);
  return (
    <div className="card">
      <h3>Finance manager</h3>
      <p className="muted small">Exactly one per challenge: payment details, confirming payments, fines and refunds. Only an admin can change it, through a handover the new manager accepts.</p>
      <ErrorBox error={error} />
      <p>{d.current ? <><b>{d.current.displayName}</b> <span className="muted small">@{d.current.username}</span></> : <span className="badge warn">none appointed</span>}</p>
      {d.pending && (
        <div className="alert warn">
          Waiting for <b>{d.pending.toName}</b> to accept: they must confirm receiving {inr(d.pending.cashHeld)} and that the accounts are settled.
          {d.canChange && (<div className="row" style={{ marginTop: 8 }}>
            <input type="text" placeholder="Reason to cancel" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1 }} />
            <button className="btn small ghost danger" disabled={reason.trim().length < 5} onClick={() => run(() => api.post(`/api/finance-handovers/${d.pending!.handoverId}/cancel`, { reason }))}>Cancel handover</button>
          </div>)}
        </div>
      )}
      {d.canChange && !d.pending && !open && <button className="btn" onClick={() => setOpen(true)}>{d.current ? 'Change finance manager' : 'Appoint a finance manager'}</button>}
      {open && (
        <div className="section">
          <h3>Checks before the change</h3>
          <ul className="small" style={{ paddingLeft: 18 }}>
            <li>Money held now (received − paid out): <b>{inr(d.checks.cashHeld)}</b>{d.current ? ' - to be handed over to the new manager' : ''}</li>
            <li>Payment reports still to check: <b>{d.checks.pendingPayments}</b>{d.checks.pendingPayments ? ' - best cleared first, or the new manager takes them over' : ''}</li>
            <li>Refunds still to approve: <b>{d.checks.pendingRefunds}</b></li>
          </ul>
          <Field label="New finance manager"><select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose a person…</option>{choices.map((u) => <option key={u.userId} value={u.userId}>{u.displayName} (@{u.username})</option>)}</select></Field>
          {d.current && <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I confirm {d.current.displayName} is handing over {inr(d.checks.cashHeld)} and the payment records to the new manager.</span></label>}
          <Field label="Note (optional)"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <p className="muted small">The new manager must confirm the amount they received and that the accounts are settled. Then the role moves, and they're asked to enter their own UPI ID and QR (the old ones are hidden from participants).</p>
          <div className="row">
            <button className="btn primary" disabled={!to || (!!d.current && !confirmed)} onClick={() => run(() => api.post(`/api/challenges/${v.challengeId}/finance-handovers`, { toUserId: Number(to), confirmHandedOver: confirmed, note }))}>Start handover</button>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
      {d.history.length > 0 && (
        <details style={{ marginTop: 10 }}><summary className="small">History</summary>
          {d.history.map((x) => <p key={x.handoverId} className="small muted">{x.from ?? '—'} → {x.to}: {x.status.toLowerCase()}{x.received !== null ? `, received ${inr(x.received)}` : ''}{x.acceptedAt ? ` on ${new Date(x.acceptedAt).toLocaleDateString('en-IN')}` : ''}{x.cancelReason ? ` (${x.cancelReason})` : ''}</p>)}
        </details>
      )}
    </div>
  );
}
