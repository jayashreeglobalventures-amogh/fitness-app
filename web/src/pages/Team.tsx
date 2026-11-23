// Admin: everyone's status on a day, what's waiting, and audited corrections (evidence / rest days recorded with
// their original time - e.g. for days before the app was live).
import { useState } from 'react';
import { api, type Me } from '../api';
import { closeModal, day, ErrorBox, Field, Loading, Modal, newRef, StatusBadge, upload, useLoad } from '../ui';
import { navigate } from '../router';
import type { ChallengeView } from './Challenge';
import { WhatsAppReminders } from './WhatsAppReminders';
import { AtRiskCard } from './Coach';
import { RaceTrack } from './RaceTrack';

interface Person {
  participantId: number; userId: number; displayName: string; username: string; status: string;
  day: { status: string; submission: { finalValue: number | null } | null } | null;
  summary: { achieved: number; missed: number; rest: number; excused: number; pending: number; adherencePct: number | null; restDaysUsed: number };
  mobile?: string | null; reminded?: { at: string; by: string } | null;
}
interface Overview {
  day: string; today: string; counts: Record<string, number>; people: Person[]; waiting: { reviews: number; exemptions_review: number; exemptions_voting: number; rest_today: number };
  canRemind: boolean; timeZone: string;
}

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
      <RaceTrack challengeId={v.challengeId} startsOn={v.startsOn} endsOn={v.endsOn} today={d.today} people={d.people} />
      {d.day === d.today && <AtRiskCard challengeId={v.challengeId} name={v.name} mobiles={new Map(d.people.map((p) => [p.participantId, p.mobile ?? null]))} />}
      {d.canRemind && d.day === d.today && <WhatsAppReminders challengeId={v.challengeId} name={v.name} day={d.day} people={d.people} timeZone={d.timeZone} onSent={o.reload} />}
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
      {open && <Correction v={v} person={d.people.find((p) => p.participantId === open)!} defaultDay={d.day} onClose={() => setOpen(null)} onSaved={() => o.reload()} />}
    </>
  );
}

function Correction({ v, person, defaultDay, onClose, onSaved }: { v: ChallengeView; person: Person; defaultDay: string; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'evidence' | 'rest'>('evidence');
  const [dayPick, setDayPick] = useState(defaultDay);
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [steps, setSteps] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      if (kind === 'evidence') await upload(`/api/participants/${person.participantId}/submissions`, { clientRef: newRef(), day: dayPick, reason, value: steps.trim() }, file);
      else await api.post(`/api/participants/${person.participantId}/rest-days`, { day: dayPick, reason });
      onSaved(); closeModal();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Correct: ${person.displayName}`} onClose={onClose}>
      <p className="muted small" style={{ marginTop: 0 }}>For a screenshot or rest day sent outside the app (e.g. on WhatsApp). It counts for the day you pick. Enter the steps to approve it straight away; leave them empty and the screenshot goes through the normal check. Everything is recorded in the activity log.</p>
      <div className="subnav inline" style={{ margin: '0 0 12px' }}>
        <button aria-current={kind === 'evidence'} onClick={() => setKind('evidence')}>Record evidence</button>
        <button aria-current={kind === 'rest'} onClick={() => setKind('rest')}>Record rest day</button>
      </div>
      <ErrorBox error={error} />
      <Field label="Challenge day"><input type="date" value={dayPick} min={v.startsOn} max={v.today} onChange={(e) => setDayPick(e.target.value)} /></Field>
      {kind === 'evidence' && <Field label="Screenshot"><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>}
      {kind === 'evidence' && (
        <Field label="Steps (approves it straight away)">
          <input type="text" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="e.g. 8214 - or leave empty for the normal check" />
        </Field>
      )}
      <Field label="Note (optional)"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sent on the WhatsApp group" /></Field>
      <button className="btn primary" disabled={busy || !dayPick || (kind === 'evidence' && !file)} onClick={send}>{kind === 'evidence' && steps.trim() ? 'Save and approve' : 'Save'}</button>
    </Modal>
  );
}
