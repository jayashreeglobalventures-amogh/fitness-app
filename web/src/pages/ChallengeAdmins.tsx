import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Field, useLoad } from '../ui';
import type { ChallengeView } from './Challenge';

const LABEL: Record<string, string> = { CHALLENGE_ADMIN: 'Challenge admin', FINANCE_ADMIN: 'Finance admin' };
const ABOUT: Record<string, string> = {
  CHALLENGE_ADMIN: 'Invitations, roster, submissions, rest days, exemptions, announcements. Cannot change money rules or approve the final settlement.',
  FINANCE_ADMIN: 'Payment QR, payment confirmations, fine pools, reconciliation, payout statements. Cannot approve the final settlement or see health data.',
};

export function AdminsSection({ v }: { v: ChallengeView }) {
  const canManage = v.myPermissions.includes('challenge.roles.manage');
  const roles = useLoad(() => api.get<{ userId: number; username: string; displayName: string; role: string }[]>(`/api/challenges/${v.challengeId}/roles`), [v.challengeId]);
  const people = useLoad(() => (canManage ? api.get<{ userId: number; username: string; displayName: string; status: string }[]>('/api/admin/users') : Promise.resolve([])), []);
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('CHALLENGE_ADMIN');
  const [error, setError] = useState<unknown>(null);
  const change = async (uid: number, r: string, grant: boolean) => {
    setError(null);
    try { await api.post(`/api/challenges/${v.challengeId}/roles`, { userId: uid, role: r, grant }); roles.reload(); } catch (e) { setError(e); }
  };
  return (
    <>
      <div className="grid2">{Object.keys(LABEL).map((r) => <div key={r} className="card"><h3>{LABEL[r]}</h3><p className="muted small">{ABOUT[r]}</p></div>)}</div>
      <p className="muted small">Super Admins can do everything. Nobody's admin role gives them access to anyone's health data.</p>
      <ErrorBox error={error ?? roles.error} />
      <div className="card">
        {roles.data?.length === 0 && <p className="muted">No challenge-specific admins yet.</p>}
        {roles.data?.map((r) => (
          <div key={`${r.userId}-${r.role}`} className="spread" style={{ padding: '6px 0' }}>
            <span>{r.displayName} <span className="muted small">@{r.username}</span> · {LABEL[r.role]}</span>
            {canManage && <button className="btn small ghost danger" onClick={() => change(r.userId, r.role, false)}>Remove</button>}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="card">
          <h3>Add an admin</h3>
          <div className="grid2">
            <Field label="Person"><select value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">Choose…</option>
              {people.data?.filter((u) => u.status === 'ACTIVE').map((u) => <option key={u.userId} value={u.userId}>{u.displayName} (@{u.username})</option>)}</select></Field>
            <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
          <button className="btn primary" disabled={!userId} onClick={() => change(Number(userId), role, true)}>Add</button>
        </div>
      )}
    </>
  );
}
