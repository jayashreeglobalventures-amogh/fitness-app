import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { ErrorBox, Field, Loading, useLoad } from '../ui';

type F = 'fullName' | 'mobile' | 'email' | 'birthDate' | 'gender' | 'location' | 'about';
interface Profile { userId: number; username: string; displayName: string; fields: Record<F, string | null>; visibility: Record<F, string> }
const FIELDS: { key: F; label: string; type: string }[] = [
  { key: 'fullName', label: 'Full name', type: 'text' }, { key: 'mobile', label: 'Mobile number', type: 'tel' }, { key: 'email', label: 'Email', type: 'email' },
  { key: 'birthDate', label: 'Date of birth', type: 'date' }, { key: 'gender', label: 'Gender', type: 'text' }, { key: 'location', label: 'Location', type: 'text' },
  { key: 'about', label: 'About you', type: 'area' },
];
const VIS = { PRIVATE: 'Only me', CHALLENGE_MEMBERS: 'My challenge members', PUBLIC: 'Everyone in the app' };

export function ProfilePage({ onChanged }: { onChanged: () => void }) {
  const { data, error, loading } = useLoad(() => api.get<Profile>('/api/me/profile'), []);
  const [p, setP] = useState<Profile | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setP(data); }, [data]);
  if (loading || !p) return error ? <ErrorBox error={error} /> : <Loading />;
  const setField = (k: F, v: string) => { setP({ ...p, fields: { ...p.fields, [k]: v } }); setSaved(false); };
  const setVis = (k: F, v: string) => { setP({ ...p, visibility: { ...p.visibility, [k]: v } }); setSaved(false); };
  const save = async () => {
    setSaveError(null);
    try { setP(await api.put<Profile>('/api/me/profile', { displayName: p.displayName, fields: p.fields, visibility: p.visibility })); setSaved(true); onChanged(); } catch (e) { setSaveError(e); }
  };
  return (
    <>
      <h1>My profile</h1>
      <p className="muted small">@{p.username} · Everything except your display name is private unless you choose otherwise.</p>
      <div className="card">
        <Field label="Display name (shown in challenges)"><input type="text" value={p.displayName} onChange={(e) => { setP({ ...p, displayName: e.target.value }); setSaved(false); }} maxLength={80} /></Field>
        {FIELDS.map((f) => (
          <div key={f.key} className="grid2" style={{ alignItems: 'end' }}>
            <Field label={f.label}>{f.type === 'area'
              ? <textarea value={p.fields[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} maxLength={1000} />
              : <input type={f.type} value={p.fields[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} />}</Field>
            <Field label="Who can see it"><select value={p.visibility[f.key]} onChange={(e) => setVis(f.key, e.target.value)}>
              {Object.entries(VIS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
        ))}
        <ErrorBox error={saveError} />
        {saved && <div className="alert ok">Saved.</div>}
        <div className="row"><button className="btn primary" onClick={save}>Save profile</button><button className="btn ghost" onClick={() => navigate('/profile/password')}>Change password</button></div>
      </div>
      <div className="card"><h3>Health profile</h3><p className="muted small">Height, weight, BMI and other measurements are coming in a later update. They'll be optional, private by default, and only collected with your explicit consent.</p></div>
    </>
  );
}
