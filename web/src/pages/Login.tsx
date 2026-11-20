import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { ErrorBox, Field } from '../ui';

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/api/auth/login', { username, password }); onSignedIn(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 16 }}><span className="brand-dot" aria-hidden="true" />Fitness</div>
        <h1>Sign in</h1>
        <p className="muted small">Your admin gives you a username and a temporary password.</p>
        <ErrorBox error={error} />
        <Field label="Username"><input type="text" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

export function ChangePasswordPage({ forced, onDone }: { forced?: boolean; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) { setError(new Error('The new passwords do not match.')); return; }
    setBusy(true); setError(null);
    try { await api.post('/api/auth/change-password', { current, next }); onDone(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const form = (
    <form className="card" onSubmit={submit}>
      <h1>{forced ? 'Choose your password' : 'Change password'}</h1>
      {forced && <p className="muted small">You signed in with a temporary password. Choose your own (at least 10 characters) to continue.</p>}
      <ErrorBox error={error} />
      <Field label={forced ? 'Temporary password' : 'Current password'}><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
      <Field label="New password"><input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
      <Field label="New password again"><input type="password" autoComplete="new-password" minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} required /></Field>
      <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
    </form>
  );
  return forced ? <div className="login">{form}</div> : form;
}
