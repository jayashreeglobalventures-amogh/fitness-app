// Emergency / sick-day exemptions: request, vote, and (admins) decide.
import { useState } from 'react';
import { api } from '../api';
import { day, ErrorBox, Field, Loading, time, upload, useLoad, ViewPhoto } from '../ui';
import type { ChallengeView } from './Challenge';

interface Req {
  requestId: number; displayName: string; mine: boolean; startDay: string; endDay: string; reason: string; status: string; reviewReason: string | null;
  votingClosesAt: string | null; eligibleVoters: number; canVote: boolean; myVote: string | null; tally: { approve: number; reject: number } | null;
  evidenceFileId: number | null; decisionMethod: string | null; decisionReason: string | null; canDecide: boolean;
}
const TONE: Record<string, string> = { VOTING: 'info', ADMIN_REVIEW: 'warn', APPROVED: 'ok', REJECTED: 'danger', WITHDRAWN: '' };
const LABEL: Record<string, string> = { VOTING: 'Voting', ADMIN_REVIEW: 'Admin review', APPROVED: 'Approved', REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn' };

export function ExemptionsSection({ v }: { v: ChallengeView }) {
  const list = useLoad(() => api.get<Req[]>(`/api/challenges/${v.challengeId}/exemptions`), [v.challengeId]);
  const isParticipant = v.participantStatus === 'ACTIVE';
  return (
    <>
      <p className="muted small">An approved exemption means no fine, no points either way, the days don't count toward adherence, your streak pauses, and it doesn't use a rest day.</p>
      {isParticipant && v.current.config.exemptions.enabled && <RequestForm v={v} onDone={list.reload} />}
      {list.loading && !list.data && <Loading />}
      <ErrorBox error={list.error} />
      {list.data?.length === 0 && <div className="card empty">No requests yet.</div>}
      {list.data?.map((r) => <RequestCard key={r.requestId} r={r} tz={v.timeZone} onChanged={list.reload} />)}
    </>
  );
}

function RequestForm({ v, onDone }: { v: ChallengeView; onDone: () => void }) {
  const [start, setStart] = useState(v.today);
  const [end, setEnd] = useState(v.today);
  const [reason, setReason] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setError(null);
    try { await upload(`/api/challenges/${v.challengeId}/exemptions`, { startDay: start, endDay: end, reason }, file); setReason(''); setFile(null); onDone(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <details className="card">
      <summary>Request an exemption</summary>
      <ErrorBox error={error} />
      <div className="grid2">
        <Field label="From"><input type="date" value={start} min={v.startsOn} max={v.endsOn} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={end} min={start} max={v.endsOn} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <Field label="Reason" hint="Fellow participants see this so they can vote."><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></Field>
      <Field label="Evidence (optional)" hint="Only admins can see it."><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      <button className="btn primary" disabled={busy || reason.trim().length < 5} onClick={send}>Send request</button>
    </details>
  );
}

function RequestCard({ r, tz, onChanged }: { r: Req; tz: string; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); onChanged(); } catch (e) { setError(e); } };
  return (
    <div className="card">
      <div className="spread">
        <h3>{r.mine ? 'You' : r.displayName} · {day(r.startDay)}{r.endDay !== r.startDay ? ` – ${day(r.endDay)}` : ''}</h3>
        <span className={`badge ${TONE[r.status] ?? ''}`}>{LABEL[r.status] ?? r.status}</span>
      </div>
      <p>{r.reason}</p>
      {r.evidenceFileId && <p className="small"><ViewPhoto fileId={r.evidenceFileId} alt="Exemption evidence">View evidence</ViewPhoto></p>}
      {r.status === 'VOTING' && r.votingClosesAt && <p className="muted small">Voting closes {time(r.votingClosesAt, tz)} · {r.eligibleVoters} voters</p>}
      {r.tally && <p className="small">Votes: {r.tally.approve} approve · {r.tally.reject} reject</p>}
      {r.reviewReason && r.status === 'ADMIN_REVIEW' && <p className="small muted">{r.reviewReason}</p>}
      {r.decisionReason && <p className="small muted">{r.decisionMethod === 'VOTE' ? 'Decided by vote' : 'Admin decision'}: {r.decisionReason}</p>}
      <ErrorBox error={error} />
      {r.canVote && (
        <div className="row">
          <button className={`btn small ${r.myVote === 'APPROVE' ? 'primary' : ''}`} onClick={() => act(() => api.post(`/api/exemptions/${r.requestId}/vote`, { vote: 'APPROVE' }))}>Approve</button>
          <button className={`btn small ${r.myVote === 'REJECT' ? 'primary' : ''}`} onClick={() => act(() => api.post(`/api/exemptions/${r.requestId}/vote`, { vote: 'REJECT' }))}>Reject</button>
          {r.myVote && <span className="muted small">You voted {r.myVote.toLowerCase()} (you can change it until voting closes)</span>}
        </div>
      )}
      {r.mine && (r.status === 'VOTING' || r.status === 'ADMIN_REVIEW') && <button className="btn small ghost" onClick={() => confirm('Withdraw this request?') && act(() => api.post(`/api/exemptions/${r.requestId}/withdraw`))}>Withdraw</button>}
      {r.canDecide && (
        <div className="section">
          <Field label={r.status === 'ADMIN_REVIEW' ? 'Admin decision: reason' : 'Override the result: reason'}><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="row">
            <button className="btn small primary" disabled={reason.trim().length < 5} onClick={() => act(() => api.post(`/api/exemptions/${r.requestId}/decide`, { approve: true, reason }))}>Approve</button>
            <button className="btn small danger" disabled={reason.trim().length < 5} onClick={() => act(() => api.post(`/api/exemptions/${r.requestId}/decide`, { approve: false, reason }))}>Reject</button>
          </div>
        </div>
      )}
    </div>
  );
}
