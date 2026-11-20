// People: admins create accounts (username + temporary password, shown once) and reset passwords.
import { useState, type FormEvent } from 'react';
import { api, type Me } from '../api';
import { navigate } from '../router';
import { ErrorBox, Field, Loading, useLoad } from '../ui';

interface UserRow { userId: number; username: string; displayName: string; fullName: string | null; mobile: string | null; status: string; mustChangePassword: boolean; superAdmin: boolean; lastLoginAt: string | null }

export function AccountsPage({ me }: { me: Me }) {
  const list = useLoad(() => api.get<UserRow[]>('/api/admin/users'), []);
  const [form, setForm] = useState({ username: '', displayName: '', fullName: '', mobile: '' });
  const [secret, setSecret] = useState<{ username: string; tempPassword: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setSecret(null);
    try {
      const r = await api.post<{ username: string; tempPassword: string }>('/api/admin/users', { ...form, fullName: form.fullName || null, mobile: form.mobile || null });
      setSecret(r); setForm({ username: '', displayName: '', fullName: '', mobile: '' }); list.reload();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const reset = async (u: UserRow) => {
    if (!confirm(`Reset ${u.displayName}'s password? They will be signed out and get a new temporary password.`)) return;
    setError(null);
    try { setSecret(await api.post(`/api/admin/users/${u.userId}/reset-password`)); list.reload(); } catch (err) { setError(err); }
  };
  const setEnabled = async (u: UserRow, enabled: boolean) => {
    if (!confirm(`${enabled ? 'Enable' : 'Disable'} ${u.displayName}'s account?`)) return;
    try { await api.post(`/api/admin/users/${u.userId}/status`, { enabled }); list.reload(); } catch (err) { setError(err); }
  };

  return (
    <>
      <div className="spread">
        <h1>People</h1>
        {me.superAdmin && <button className="btn ghost small" onClick={() => navigate('/admin/activity')}>📜 Activity log</button>}
      </div>
      {secret && (
        <div className="alert ok">
          <b>Share these sign-in details with the person</b> (shown only once):
          <p style={{ marginTop: 8 }}>Username: <b>{secret.username}</b></p>
          <div className="secret">{secret.tempPassword}</div>
          <p className="small muted" style={{ marginTop: 8 }}>They'll be asked to choose their own password when they first sign in.</p>
        </div>
      )}
      <ErrorBox error={error} />
      <form className="card" onSubmit={create}>
        <h3>Create an account</h3>
        <div className="grid2">
          <Field label="Username" hint="3–32: a–z, 0–9, . _ -"><input type="text" autoCapitalize="none" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></Field>
          <Field label="Display name"><input type="text" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required /></Field>
          <Field label="Full name (optional)"><input type="text" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
          <Field label="Mobile (optional)"><input type="tel" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} /></Field>
        </div>
        <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
      {list.loading && <Loading />}
      <div className="card table-wrap"><table>
        <thead><tr><th>Person</th><th>Status</th><th /></tr></thead>
        <tbody>{list.data?.map((u) => (
          <tr key={u.userId}>
            <td><b>{u.displayName}</b>{u.superAdmin && <span className="badge" style={{ marginLeft: 6 }}>Super admin</span>}<br />
              <span className="muted small">@{u.username}{u.fullName ? ` · ${u.fullName}` : ''}{u.mobile ? ` · ${u.mobile}` : ''}</span></td>
            <td className="small">{u.status === 'DISABLED' ? <span className="badge danger">disabled</span> : u.mustChangePassword ? <span className="badge warn">not signed in yet</span> : <span className="badge ok">active</span>}</td>
            <td><div className="row" style={{ gap: 6 }}>
              {u.userId !== me.userId && <button className="btn small" onClick={() => reset(u)}>Reset password</button>}
              {me.superAdmin && u.userId !== me.userId && <button className="btn small ghost" onClick={() => setEnabled(u, u.status !== 'ACTIVE')}>{u.status === 'ACTIVE' ? 'Disable' : 'Enable'}</button>}
            </div></td>
          </tr>))}
        </tbody></table></div>
    </>
  );
}
