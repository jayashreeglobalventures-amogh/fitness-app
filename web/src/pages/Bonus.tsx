// Weekend bonus activities: admins set one up for a weekend; participants submit evidence that weekend; admins approve.
import { useState } from 'react';
import { api } from '../api';
import { day, ErrorBox, Field, Loading, upload, useLoad } from '../ui';
import type { ChallengeView } from './Challenge';

interface Sub { bonusSubmissionId: number; displayName: string; mine: boolean; note: string | null; fileId: number | null; status: string; decisionReason: string | null }
interface Activity { activityId: number; weekendKey: string; days: string[]; title: string; description: string; evidence: string; status: string; open: boolean; submissions: Sub[] }
interface List { canManage: boolean; today: string; activities: Activity[] }
const TONE: Record<string, string> = { PENDING: 'info', APPROVED: 'ok', REJECTED: 'danger', WITHDRAWN: '' };

export function BonusSection({ v }: { v: ChallengeView }) {
  const l = useLoad(() => api.get<List>(`/api/challenges/${v.challengeId}/bonuses`), [v.challengeId]);
  const wb = v.current.config.scoring.weekendBonus;
  if (l.loading && !l.data) return <Loading />;
  if (!l.data) return <ErrorBox error={l.error} />;
  return (
    <>
      <p className="muted small">Optional: +{wb.points} points for an extra weekend activity, at most {wb.maxPerWeekend} per weekend. It never replaces the daily goal.</p>
      {l.data.canManage && <NewActivity v={v} onDone={l.reload} />}
      {l.data.activities.length === 0 && <div className="card empty">No weekend activity yet.</div>}
      {l.data.activities.map((a) => <ActivityCard key={a.activityId} a={a} canManage={l.data!.canManage} isParticipant={v.participantStatus === 'ACTIVE'} onChanged={l.reload} />)}
    </>
  );
}

function NewActivity({ v, onDone }: { v: ChallengeView; onDone: () => void }) {
  const [f, setF] = useState({ day: '', title: '', description: '', evidence: '' });
  const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null); try { await api.post(`/api/challenges/${v.challengeId}/bonuses`, f); setF({ day: '', title: '', description: '', evidence: '' }); onDone(); } catch (e) { setError(e); } };
  return (
    <details className="card"><summary>Set up a weekend activity</summary>
      <ErrorBox error={error} />
      <div className="grid2">
        <Field label="A day of that weekend"><input type="date" value={f.day} min={v.today} max={v.endsOn} onChange={(e) => setF({ ...f, day: e.target.value })} /></Field>
        <Field label="Activity"><input type="text" value={f.title} placeholder="e.g. Cycle 10 km, swim 30 min, hike" onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
      </div>
      <Field label="Details (optional)"><textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="What to show as evidence"><input type="text" value={f.evidence} placeholder="e.g. a screenshot of the ride summary" onChange={(e) => setF({ ...f, evidence: e.target.value })} /></Field>
      <button className="btn primary" disabled={!f.day || f.title.trim().length < 3} onClick={save}>Create</button>
    </details>
  );
}

function ActivityCard({ a, canManage, isParticipant, onChanged }: { a: Activity; canManage: boolean; isParticipant: boolean; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); onChanged(); } catch (e) { setError(e); } };
  const mine = a.submissions.find((s) => s.mine && s.status !== 'WITHDRAWN');
  return (
    <div className="card">
      <div className="spread"><h3>{a.title}</h3><span className={`badge ${a.status === 'OPEN' ? (a.open ? 'ok' : '') : 'danger'}`}>{a.status === 'CANCELLED' ? 'cancelled' : a.open ? 'open now' : a.days.map(day).join(' & ')}</span></div>
      {a.description && <p>{a.description}</p>}
      <p className="muted small">Evidence: {a.evidence}</p>
      <ErrorBox error={error} />
      {isParticipant && a.open && !mine && (
        <div className="section">
          <Field label="What did you do?"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <Field label="Photo or screenshot"><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <button className="btn primary small" disabled={!file && note.trim().length < 5} onClick={() => act(() => upload(`/api/bonuses/${a.activityId}/submissions`, { note }, file))}>Submit</button>
        </div>
      )}
      {mine && !canManage && <p className="small">Your submission: <span className={`badge ${TONE[mine.status]}`}>{mine.status.toLowerCase()}</span>{mine.decisionReason ? ` · ${mine.decisionReason}` : ''}
        {mine.status === 'PENDING' && <button className="btn small ghost" onClick={() => act(() => api.post(`/api/bonus-submissions/${mine.bonusSubmissionId}/withdraw`))}>Withdraw</button>}</p>}
      {canManage && a.submissions.length > 0 && (
        <div className="section">
          <Field label="Reason (needed to reject or change a decision)"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {a.submissions.map((s) => (
            <div key={s.bonusSubmissionId} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span><b>{s.displayName}</b> {s.note && <span className="small">· {s.note}</span>} {s.fileId && <a className="small" href={`/api/files/${s.fileId}`} target="_blank" rel="noreferrer">photo</a>}
                <br /><span className={`badge ${TONE[s.status]}`}>{s.status.toLowerCase()}</span></span>
              {!s.mine && s.status !== 'WITHDRAWN' && <span className="row" style={{ gap: 4 }}>
                {s.status !== 'APPROVED' && <button className="btn small primary" onClick={() => act(() => api.post(`/api/bonus-submissions/${s.bonusSubmissionId}/decide`, { approve: true, reason }))}>Approve</button>}
                {s.status !== 'REJECTED' && <button className="btn small danger" disabled={reason.trim().length < 5} onClick={() => act(() => api.post(`/api/bonus-submissions/${s.bonusSubmissionId}/decide`, { approve: false, reason }))}>Reject</button>}
              </span>}
            </div>
          ))}
        </div>
      )}
      {canManage && a.status === 'OPEN' && <button className="btn small ghost danger" style={{ marginTop: 8 }} disabled={reason.trim().length < 5} title="Enter a reason above" onClick={() => confirm('Cancel this activity? Approved bonuses for it are reversed.') && act(() => api.post(`/api/bonuses/${a.activityId}/cancel`, { reason }))}>Cancel activity</button>}
    </div>
  );
}
