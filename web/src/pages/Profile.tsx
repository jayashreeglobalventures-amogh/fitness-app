import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { Avatar, ErrorBox, Field, Loading, upload, useLoad } from '../ui';
import { PhotoCropper } from '../PhotoCropper';
import { PhoneNotifications } from '../PhoneNotifications';

type F = 'fullName' | 'mobile' | 'email' | 'birthDate' | 'gender' | 'location' | 'about';
interface Profile { userId: number; username: string; displayName: string; fields: Record<F, string | null>; visibility: Record<F, string>; photoFileId: number | null; photoVisibility: string }
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
    try { setP(await api.put<Profile>('/api/me/profile', { displayName: p.displayName, fields: p.fields, visibility: p.visibility, photoVisibility: p.photoVisibility })); setSaved(true); onChanged(); } catch (e) { setSaveError(e); }
  };
  return (
    <>
      <h1>My profile</h1>
      <p className="muted small">@{p.username} · Everything except your display name is private unless you choose otherwise.</p>
      <PhotoCard p={p} onChanged={(np) => { setP(np); onChanged(); }} />
      <PhoneNotifications />
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
      <div className="card clickable" role="link" tabIndex={0} onClick={() => navigate('/profile/health')} onKeyDown={(e) => { if (e.key === 'Enter') navigate('/profile/health'); }}>
        <div className="spread"><h3 style={{ margin: 0 }}>Health profile</h3><span aria-hidden="true">›</span></div>
        <p className="muted small" style={{ marginBottom: 0 }}>Optional: height, weight, BMI, waist, body fat, resting heart rate, goals - with progress charts. Private unless you choose to share.</p>
      </div>
      <p className="muted small" style={{ textAlign: 'center' }}><a href="/privacy.html">Privacy policy</a></p>
    </>
  );
}

function PhotoCard({ p, onChanged }: { p: Profile; onChanged: (p: Profile) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<File | null>(null);
  const pick = (f: File | null) => { if (f) setEditing(f); if (input.current) input.current.value = ''; };
  const save = async (f: File) => {
    setEditing(null); setBusy(true); setError(null);
    try { onChanged(await upload<Profile>('/api/me/photo', {}, f)); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const remove = async () => { setBusy(true); setError(null); try { onChanged(await api.post<Profile>('/api/me/photo/remove')); } catch (e) { setError(e); } finally { setBusy(false); } };
  const setVis = async (v: string) => { setError(null); try { onChanged(await api.put<Profile>('/api/me/profile', { photoVisibility: v })); } catch (e) { setError(e); } };
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', gap: 16 }}>
        <Avatar key={p.photoFileId ?? 0} fileId={p.photoFileId} name={p.displayName} size={88} />
        <div className="stack" style={{ flex: 1, minWidth: 180 }}>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          {editing && <PhotoCropper file={editing} onCancel={() => setEditing(null)} onDone={(f) => void save(f)} />}
          <div className="row">
            <button className="btn primary small" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : p.photoFileId ? 'Change photo' : 'Add a photo'}</button>
            {p.photoFileId && <button className="btn ghost small" disabled={busy} onClick={remove}>Remove</button>}
          </div>
          <Field label="Who can see your photo"><select value={p.photoVisibility} onChange={(e) => void setVis(e.target.value)}>
            {Object.entries(VIS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        </div>
      </div>
      <p className="muted small" style={{ margin: 0 }}>Take one with the camera or choose from your gallery, then position and zoom it.</p>
      <ErrorBox error={error} />
    </div>
  );
}
