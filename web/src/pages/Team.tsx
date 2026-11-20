// Admin: everyone's status on a day, what's waiting, and audited corrections (evidence / rest days recorded with
// their original time - e.g. for days before the app was live).
import { useState } from 'react';
import { api, type Me } from '../api';
import { day, ErrorBox, Field, Loading, newRef, StatusBadge, upload, useLoad } from '../ui';
import { navigate } from '../router';
import type { ChallengeView } from './Challenge';

interface Person {
  participantId: number; userId: number; displayName: string; username: string; status: string;
  day: { status: string; submission: { finalValue: number | null } | null } | null;
  summary: { achieved: number; missed: number; rest: number; excused: number; pending: number; adherencePct: number | null; restDaysUsed: number };
}
interface Overview { day: string; today: string; counts: Record<string, number>; people: Person[]; waiting: { reviews: number; exemptions_review: number; exemptions_voting: number; rest_today: number } }

export function TeamSection({ v, me }: { v: ChallengeView; me: Me }) {
  const [pick, setPick] = useState('');
  const o = useLoad(() => api.get<Overview>(`/api/challenges/${v.challengeId}/overview${pick ? `?day=${pick}` : ''}`), [v.challengeId, pick]);
  const [open, setOpen] = useState<number | null>(null);
  const canCorrect = v.myPermissions.includes('submissions.review');
  if (o.loading && !o.data) return <Loading />;
  if (!o.data) return <ErrorBox error={o.error} />;
  const d = o.data;
  return (
    <>
      <div className="spread">
        <input type="date" value={pick || d.day} min={v.startsOn} max={v.endsOn} onChange={(e) => setPick(e.target.value)} style={{ maxWidth: 200 }} aria-label="Day" />
        <span className="muted small">{d.day === d.today ? 'Today' : day(d.day)}</span>
      </div>
      <div className="stats" style={{ margin: '12px 0' }}>
        {Object.entries(d.counts).map(([k, n]) => <div key={k} className="stat"><span><StatusBadge status={k} /></span><b>{n}</b></div>)}
      </div>
      {(d.waiting.reviews > 0 || d.waiting.exemptions_review > 0) && (
        <div className="alert warn">
          {d.waiting.reviews > 0 && <div>{d.waiting.reviews} screenshot{d.waiting.reviews === 1 ? '' : 's'} to review. <button className="btn small ghost" onClick={() => navigate(`/challenges/${v.challengeId}/review`)}>Open</button></div>}
          {d.waiting.exemptions_review > 0 && <div>{d.waiting.exemptions_review} exemption request{d.waiting.exemptions_review === 1 ? '' : 's'} need an admin. <button className="btn small ghost" onClick={() => navigate(`/challenges/${v.challengeId}/exemptions`)}>Open</button></div>}
        </div>
      )}
      <div className="card table-wrap"><table>
        <thead><tr><th>Person</th><th>{d.day === d.today ? 'Today' : day(d.day)}</th><th>So far</th><th /></tr></thead>
        <tbody>{d.people.map((p) => (
          <tr key={p.participantId}>
            <td><b>{p.displayName}</b>{p.status !== 'ACTIVE' && <><br /><span className="badge warn">{p.status.toLowerCase()}</span></>}</td>
            <td>{p.day ? <StatusBadge status={p.day.status} /> : '—'}{p.day?.submission?.finalValue != null && <div className="muted small">{p.day.submission.finalValue.toLocaleString('en-IN')}</div>}</td>
            <td className="small">{p.summary.achieved}✓ {p.summary.missed}✗{p.summary.rest ? ` ${p.summary.rest} rest` : ''}{p.summary.excused ? ` ${p.summary.excused} excused` : ''}<br />
              <span className="muted">{p.summary.adherencePct === null ? '—' : `${p.summary.adherencePct}%`}</span></td>
            <td>{canCorrect && p.userId !== me.userId && <button className="btn small ghost" onClick={() => setOpen(open === p.participantId ? null : p.participantId)}>Correct</button>}</td>
          </tr>))}
        </tbody></table></div>
      {open && <Correction v={v} person={d.people.find((p) => p.participantId === open)!} defaultDay={d.day} onDone={() => { setOpen(null); o.reload(); }} />}
    </>
  );
}

function Correction({ v, person, defaultDay, onDone }: { v: ChallengeView; person: Person; defaultDay: string; onDone: () => void }) {
  const [kind, setKind] = useState<'evidence' | 'rest'>('evidence');
  const [dayPick, setDayPick] = useState(defaultDay);
  const [at, setAt] = useState('');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      if (kind === 'evidence') await upload(`/api/participants/${person.participantId}/submissions`, { clientRef: newRef(), day: dayPick, receivedAt: at, reason }, file);
      else await api.post(`/api/participants/${person.participantId}/rest-days`, { day: dayPick, declaredAt: at || undefined, reason });
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h3>Correction for {person.displayName}</h3>
      <p className="muted small">For evidence or rest days sent outside the app (e.g. on WhatsApp before the app was live). Use the ORIGINAL time it was sent. Evidence still goes through the normal check; everything is recorded in the audit log.</p>
      <div className="subnav inline" style={{ margin: '0 0 12px' }}>
        <button aria-current={kind === 'evidence'} onClick={() => setKind('evidence')}>Record evidence</button>
        <button aria-current={kind === 'rest'} onClick={() => setKind('rest')}>Record rest day</button>
      </div>
      <ErrorBox error={error} />
      <div className="grid2">
        <Field label="Challenge day"><input type="date" value={dayPick} min={v.startsOn} max={v.today} onChange={(e) => setDayPick(e.target.value)} /></Field>
        <Field label={`Originally sent at (${v.timeZone} time)`}><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
      </div>
      {kind === 'evidence' && <Field label="Screenshot"><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>}
      <Field label="Reason / where it came from"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sent on the Calamari WhatsApp group at 9:40 pm" /></Field>
      <button className="btn primary" disabled={busy || reason.trim().length < 5 || (kind === 'evidence' && (!file || !at))} onClick={send}>Save correction</button>
    </div>
  );
}
