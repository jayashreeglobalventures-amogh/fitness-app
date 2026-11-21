// Admin review queue: the screenshot, what the AI read (and why it wasn't approved), and the decision.
import { useState } from 'react';
import { api } from '../api';
import { Collapsible, day, ErrorBox, Field, Loading, time, useLoad, ViewPhoto } from '../ui';
import type { ChallengeView } from './Challenge';

interface Result { method: string; model: string | null; extractedDate: string | null; extractedValue: number | null; sourceApp: string | null; confidence: number | null; flags: string[]; outcome: string; reason: string | null; at: string }
interface Item { submissionId: number; day: string; fileId: number; receivedAt: string; claimedValue: number | null; status: string; source: string; correctionReason: string | null; appealNote: string | null; decisionReason: string | null; displayName: string; mine: boolean; target: number; results: Result[]; part: boolean }

export function ReviewSection({ v }: { v: ChallengeView }) {
  const q = useLoad(() => api.get<Item[]>(`/api/challenges/${v.challengeId}/review-queue`), [v.challengeId]);
  if (q.loading && !q.data) return <Loading />;
  return (
    <>
      <ErrorBox error={q.error} />
      <p className="muted small">The AI approves only clear, on-target screenshots of the right day. Everything else waits here. Flags are prompts to check, not proof of anything.</p>
      <RemovalRequests challengeId={v.challengeId} />
      {q.data?.length === 0 && <div className="card empty">Nothing to review. ✅</div>}
      {q.data?.map((it) => <ReviewCard key={it.submissionId} it={it} tz={v.timeZone} onDone={q.reload} />)}
    </>
  );
}

function ReviewCard({ it, tz, onDone }: { it: Item; tz: string; onDone: () => void }) {
  const ai = [...it.results].reverse().find((r) => r.method === 'AI' && r.outcome !== 'ERROR');
  const flags = [...new Set(it.results.flatMap((r) => r.flags ?? []))];
  const [value, setValue] = useState(String(ai?.extractedValue ?? it.claimedValue ?? ''));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (outcome: 'ACHIEVED' | 'BELOW_TARGET' | 'REJECTED' | 'APPROVED') => {
    setBusy(true); setError(null);
    try { await api.post(`/api/submissions/${it.submissionId}/review`, { outcome, value: outcome === 'REJECTED' ? undefined : Number(value), reason }); onDone(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const n = Number(value);
  return (
    <Collapsible id={`review-${it.submissionId}`} title={<span className="spread" style={{ width: '100%' }}><span>{it.displayName} · {day(it.day)}</span><span className="muted small" style={{ fontWeight: 400 }}>uploaded {time(it.receivedAt, tz)}</span></span>}>
      <div className="grid2">
        <ViewPhoto fileId={it.fileId} alt={`Evidence from ${it.displayName}`}><img className="shot" src={`/api/files/${it.fileId}`} alt={`Evidence from ${it.displayName}`} loading="lazy" /></ViewPhoto>
        <div>
          <dl className="kv">
            <dt>Target</dt><dd>{it.target.toLocaleString('en-IN')}</dd>
            {it.claimedValue !== null && <><dt>They say</dt><dd>{it.claimedValue.toLocaleString('en-IN')}</dd></>}
            {ai && <><dt>AI read</dt><dd>{ai.extractedValue?.toLocaleString('en-IN') ?? '—'} on {ai.extractedDate ?? '—'}{ai.sourceApp ? ` · ${ai.sourceApp}` : ''}</dd>
              <dt>AI sure</dt><dd>{ai.confidence === null ? '—' : `${Math.round(ai.confidence * 100)}%`}</dd></>}
          </dl>
          {flags.length > 0 && <div className="row" style={{ margin: '10px 0' }}>{flags.map((f) => <span key={f} className="badge warn">{f.toLowerCase().replace(/_/g, ' ')}</span>)}</div>}
          {it.results.filter((r) => r.reason).slice(-3).map((r, i) => <p key={i} className="small muted">{r.method === 'AI' ? 'AI' : r.method === 'SYSTEM' ? 'System' : 'Admin'}: {r.reason}</p>)}
          {it.source === 'ADMIN_CORRECTION' && <div className="alert small">Recorded by an admin: {it.correctionReason}</div>}
          {it.appealNote && <div className="alert warn small">Appeal: {it.appealNote}{it.decisionReason ? ` (earlier decision: ${it.decisionReason})` : ''}</div>}
          {it.mine ? <div className="alert">This is your own evidence: another admin must review it.</div> : (
            <>
              <ErrorBox error={error} />
              {it.part && <p className="small muted" style={{ marginTop: 0 }}>One of several screenshots for the day: approve the number it shows; the day's result comes from all approved screenshots together.</p>}
              <Field label={it.part ? 'Number shown in this screenshot' : 'Total shown in the screenshot'}><input type="number" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
              <Field label={it.appealNote ? 'Reason (required)' : it.part ? 'Reason (required to decline)' : 'Reason (required to reject)'}><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              {it.part ? (
                <div className="row">
                  <button className="btn primary small" disabled={busy || value === '' || !(n >= 0)} onClick={() => decide('APPROVED')}>Approve</button>
                  <button className="btn small danger" disabled={busy || reason.trim().length < 5} onClick={() => decide('REJECTED')}>Decline</button>
                </div>
              ) : (
                <div className="row">
                  <button className="btn primary small" disabled={busy || !(n >= it.target)} onClick={() => decide('ACHIEVED')}>Target reached</button>
                  <button className="btn small" disabled={busy || !(value !== '' && n < it.target)} onClick={() => decide('BELOW_TARGET')}>Below target</button>
                  <button className="btn small danger" disabled={busy || reason.trim().length < 5} onClick={() => decide('REJECTED')}>Reject</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Collapsible>
  );
}

interface EvReq { requestId: number; submissionId: number; kind: 'REMOVE' | 'ERASE'; eraseImage: boolean; reason: string; requestedAt: string; day: string; status: string; value: number | null; part: boolean; fileId: number | null; displayName: string; mine: boolean }

/** Requests from participants to remove a screenshot after its day (and/or erase the image). */
function RemovalRequests({ challengeId }: { challengeId: number }) {
  const q = useLoad(() => api.get<EvReq[]>(`/api/challenges/${challengeId}/evidence-requests`), [challengeId]);
  if (!q.data?.length) return null;
  return (
    <>
      <h3 style={{ margin: '4px 0 8px' }}>Requests to remove screenshots ({q.data.length})</h3>
      {q.data.map((r) => <RemovalCard key={r.requestId} r={r} onDone={q.reload} />)}
    </>
  );
}

function RemovalCard({ r, onDone }: { r: EvReq; onDone: () => void }) {
  const [erase, setErase] = useState(r.kind === 'ERASE' || r.eraseImage);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const decide = async (approve: boolean) => {
    setError(null);
    try { await api.post(`/api/evidence-requests/${r.requestId}/decide`, { approve, erase, note }); onDone(); } catch (e) { setError(e); }
  };
  const effect = r.kind === 'ERASE' ? 'The screenshot was already removed; this only erases the image.'
    : r.part ? 'Removing it takes its number out of that day\'s total; points and fines are recalculated.'
      : 'Removing it leaves that day without evidence (a missed day unless it has a rest day or exemption); points and fines are recalculated.';
  return (
    <Collapsible id={`evreq-${r.requestId}`} title={<span className="spread" style={{ width: '100%' }}><span>{r.displayName} · {day(r.day)} · {r.kind === 'ERASE' ? 'erase image' : 'remove'}</span><span className="badge warn">request</span></span>}>
      <ErrorBox error={error} />
      <div className="grid2">
        {r.fileId ? <ViewPhoto fileId={r.fileId} alt={`Screenshot from ${r.displayName}`}><img className="shot" src={`/api/files/${r.fileId}`} alt={`Screenshot from ${r.displayName}`} loading="lazy" /></ViewPhoto>
          : <p className="muted small">Image already erased.</p>}
        <div>
          <p className="small" style={{ marginTop: 0 }}><b>Their reason:</b> “{r.reason}”</p>
          <p className="small muted">{r.value !== null ? `Counted: ${r.value.toLocaleString('en-IN')}. ` : ''}{effect}</p>
          {r.mine ? <div className="alert">This is about your own screenshot: another admin must decide.</div> : (
            <>
              {r.kind === 'REMOVE' && <label className="check small"><input type="checkbox" checked={erase} onChange={(e) => setErase(e.target.checked)} />
                <span>Also erase the image permanently{r.eraseImage ? ' (they asked for this - a private photo)' : ''}</span></label>}
              <Field label="Note (required to decline)"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="row">
                <button className="btn primary small" onClick={() => decide(true)}>{r.kind === 'ERASE' ? 'Erase the image' : erase ? 'Remove and erase' : 'Remove'}</button>
                <button className="btn small" disabled={note.trim().length < 5} onClick={() => decide(false)}>Decline</button>
              </div>
            </>
          )}
        </div>
      </div>
    </Collapsible>
  );
}
