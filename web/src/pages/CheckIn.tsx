// Participant: today's goal, screenshot upload, rest day, progress and calendar.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { day, DAY_STATUS, ErrorBox, Field, Loading, newRef, StatusBadge, time, upload, useLoad } from '../ui';
import type { ChallengeView } from './Challenge';

interface DayInfo {
  day: string; status: string; periodNo: number | null;
  submission: { submissionId: number; status: string; finalValue: number | null; claimedValue: number | null; receivedAt: string; decisionReason: string | null; appealed: boolean } | null;
  restDay: { restDayId: number; declaredAt: string; source: string } | null;
  exemption: { requestId: number; status: string } | null;
}
interface Dashboard {
  participant: { status: string; joinedOn: string };
  today: (DayInfo & { target: number; unit: string; label: string; deadline: string; restCutoff: string }) | null;
  days: DayInfo[];
  summary: { achieved: number; missed: number; rest: number; excused: number; pending: number; adherencePct: number | null; restDaysUsed: number; restDaysThisPeriod: number; daysLeft: number };
  periods: { periodNo: number; startsOn: string; endsOn: string }[];
  rules: { restDays: { enabled: boolean; perPeriod: number; maxTotal: number; declareBefore: string }; exemptions: { enabled: boolean }; instructions: string };
  serverNow: string; timeZone: string;
}

function useCountdown(iso: string | undefined, skew: number) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  if (!iso) return '';
  const ms = Date.parse(iso) - (Date.now() + skew);
  if (ms <= 0) return 'closed';
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h} h ${m} min left` : `${m} min left`;
}

export function CheckInSection({ v }: { v: ChallengeView }) {
  const dash = useLoad(() => api.get<Dashboard>(`/api/challenges/${v.challengeId}/me`), [v.challengeId]);
  const d = dash.data;
  const skew = d ? Date.parse(d.serverNow) - Date.now() : 0;
  const left = useCountdown(d?.today?.deadline, skew);
  const [selected, setSelected] = useState<string | null>(null);

  // While the AI is reading a fresh upload, refresh every few seconds (at most a minute).
  const polls = useRef(0);
  useEffect(() => {
    if (d?.today?.status !== 'SUBMITTED' || polls.current > 20) return;
    const t = setTimeout(() => { polls.current++; dash.reload(); }, 3000);
    return () => clearTimeout(t);
  }, [d, dash]);

  if (dash.loading && !d) return <Loading />;
  if (!d) return <ErrorBox error={dash.error} />;
  const t = d.today;
  const s = d.summary;

  return (
    <>
      {!t && <div className="card"><h3>{v.phase === 'UPCOMING' ? `Starts ${day(v.startsOn)}` : 'The challenge has ended'}</h3>
        <p className="muted small">{v.phase === 'UPCOMING' ? 'You can plan rest days now. Evidence can be uploaded from the first day.' : 'Results are provisional until the admins finish the review.'}</p></div>}
      {t && <TodayCard v={v} d={d} left={left} onChanged={() => { polls.current = 0; dash.reload(); }} />}

      <div className="stats" style={{ margin: '12px 0' }}>
        <div className="stat"><span>Achieved</span><b>{s.achieved}</b></div>
        <div className="stat"><span>Missed</span><b>{s.missed}</b></div>
        <div className="stat"><span>Adherence</span><b>{s.adherencePct === null ? '—' : `${s.adherencePct}%`}</b></div>
        <div className="stat"><span>Days left</span><b>{s.daysLeft}</b></div>
        {d.rules.restDays.enabled && <div className="stat"><span>Rest days</span><b>{s.restDaysUsed}/{d.rules.restDays.maxTotal}</b></div>}
        {s.excused > 0 && <div className="stat"><span>Excused</span><b>{s.excused}</b></div>}
      </div>
      {s.pending > 0 && <p className="muted small">{s.pending} day{s.pending === 1 ? '' : 's'} waiting for verification. Points and the leaderboard arrive in the next update.</p>}

      <div className="card">
        <h3>Calendar</h3>
        <Calendar days={d.days} today={t?.day ?? null} onPick={setSelected} />
        <div className="legend">{['ACHIEVED', 'PENDING_VERIFICATION', 'MISSED_DEADLINE', 'REST', 'EXCUSED'].map((k) => <StatusBadge key={k} status={k} />)}</div>
      </div>
      {selected && <DayDetail info={d.days.find((x) => x.day === selected)!} d={d} onChanged={dash.reload} onClose={() => setSelected(null)} />}
      {d.rules.restDays.enabled && <PlanRest v={v} d={d} onChanged={dash.reload} />}
    </>
  );
}

function TodayCard({ v, d, left, onChanged }: { v: ChallengeView; d: Dashboard; left: string; onChanged: () => void }) {
  const t = d.today!;
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [claimed, setClaimed] = useState('');
  const [ref, setRef] = useState(newRef());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pick = (f: File | null) => { setFile(f); setRef(newRef()); setError(null); setPreview(f ? URL.createObjectURL(f) : null); };
  const send = async () => {
    setBusy(true); setError(null);
    try { await upload(`/api/challenges/${v.challengeId}/submissions`, { clientRef: ref, claimedValue: claimed }, file); pick(null); setClaimed(''); onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  const rest = async () => {
    if (!confirm('Take today as your rest day? You can cancel it until the cut-off time.')) return;
    try { await api.post(`/api/challenges/${v.challengeId}/rest-days`, { day: t.day }); onChanged(); } catch (e) { setError(e); }
  };
  const cancelRest = async () => {
    try { await api.post(`/api/rest-days/${t.restDay!.restDayId}/cancel`); onChanged(); } catch (e) { setError(e); }
  };
  const canUpload = ['NOT_SUBMITTED', 'SUBMITTED', 'PENDING_VERIFICATION', 'TARGET_MISSED', 'REJECTED'].includes(t.status) && left !== 'closed';
  const beforeCutoff = Date.now() < Date.parse(t.restCutoff);
  const restAllowed = d.rules.restDays.enabled && !t.submission && t.status === 'NOT_SUBMITTED' && beforeCutoff
    && d.summary.restDaysThisPeriod < d.rules.restDays.perPeriod && d.summary.restDaysUsed < d.rules.restDays.maxTotal;

  return (
    <div className="card today">
      <div className="spread">
        <div><span className="muted small">Today · {day(t.day)}</span><div className="target">{t.target.toLocaleString('en-IN')} <span className="muted" style={{ fontSize: 16 }}>{t.unit}</span></div></div>
        <div style={{ textAlign: 'right' }}><StatusBadge status={t.status} /><div className="muted small" style={{ marginTop: 6 }}>{left === 'closed' ? 'Deadline passed' : `Midnight deadline · ${left}`}</div></div>
      </div>
      <ErrorBox error={error} />
      {t.status === 'ACHIEVED' && <div className="alert ok" style={{ marginTop: 12 }}>Done for today: {t.submission?.finalValue?.toLocaleString('en-IN')} {t.unit}. 🎉</div>}
      {t.status === 'SUBMITTED' && <div className="alert" style={{ marginTop: 12 }}>Reading your screenshot…</div>}
      {t.status === 'PENDING_VERIFICATION' && <div className="alert" style={{ marginTop: 12 }}>An admin will check your screenshot. You can upload a clearer one until midnight.</div>}
      {(t.status === 'TARGET_MISSED' || t.status === 'REJECTED') && <div className="alert error" style={{ marginTop: 12 }}>{DAY_STATUS[t.status]!.label}{t.submission?.decisionReason ? `: ${t.submission.decisionReason}` : '.'} You can upload new evidence until midnight.</div>}
      {t.status === 'REST' && <div className="alert" style={{ marginTop: 12 }}>Rest day. Enjoy it. {beforeCutoff && <button className="btn small ghost" onClick={cancelRest}>Cancel rest day</button>}</div>}
      {t.status === 'EXCUSED' && <div className="alert" style={{ marginTop: 12 }}>Excused by an approved exemption. Get well soon.</div>}

      {canUpload && (
        <div style={{ marginTop: 14 }}>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          {!file ? (
            <div className="dropzone" role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}>
              <b>Upload today's screenshot</b><span className="muted small">{d.rules.instructions}</span>
            </div>
          ) : (
            <div className="stack">
              <img className="preview" src={preview!} alt="Selected screenshot" />
              <Field label={`Your total today (optional)`} hint="Helps the check; the screenshot is what counts.">
                <input type="number" inputMode="numeric" value={claimed} onChange={(e) => setClaimed(e.target.value)} placeholder={String(t.target)} />
              </Field>
              <div className="row"><button className="btn primary" disabled={busy} onClick={send}>{busy ? 'Uploading…' : 'Submit'}</button><button className="btn ghost" onClick={() => pick(null)}>Choose another</button></div>
            </div>
          )}
        </div>
      )}
      {restAllowed && !file && <button className="btn ghost small" style={{ marginTop: 10 }} onClick={rest}>Take today as a rest day (until {d.rules.restDays.declareBefore})</button>}
    </div>
  );
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function Calendar({ days, today, onPick }: { days: DayInfo[]; today: string | null; onPick: (d: string) => void }) {
  if (!days.length) return null;
  const lead = new Date(`${days[0]!.day}T00:00:00Z`).getUTCDay();
  return (
    <div className="cal">
      {DOW.map((x) => <div key={x} className="dow">{x}</div>)}
      {Array.from({ length: lead }, (_, i) => <button key={`b${i}`} className="blank" tabIndex={-1} aria-hidden="true" />)}
      {days.map((x) => (
        <button key={x.day} data-s={x.status} aria-current={x.day === today ? 'date' : undefined} title={`${day(x.day)}: ${DAY_STATUS[x.status]?.label ?? x.status}`} onClick={() => onPick(x.day)}>
          {Number(x.day.slice(8))}
        </button>
      ))}
    </div>
  );
}

function DayDetail({ info, d, onChanged, onClose }: { info: DayInfo; d: Dashboard; onChanged: () => void; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const s = info.submission;
  const appeal = async () => {
    setError(null);
    try { await api.post(`/api/submissions/${s!.submissionId}/appeal`, { note }); setNote(''); onChanged(); } catch (e) { setError(e); }
  };
  const cancelRest = async () => { try { await api.post(`/api/rest-days/${info.restDay!.restDayId}/cancel`); onChanged(); onClose(); } catch (e) { setError(e); } };
  // Shown for today and later; the server enforces the cut-off time in the challenge's time zone.
  const canCancelRest = info.restDay && info.status === 'REST' && info.day >= (d.today?.day ?? '');
  return (
    <div className="card">
      <div className="spread"><h3>{day(info.day)}</h3><div className="row"><StatusBadge status={info.status} /><button className="btn small ghost" onClick={onClose} aria-label="Close">✕</button></div></div>
      <ErrorBox error={error} />
      {s && <dl className="kv">
        <dt>Uploaded</dt><dd>{time(s.receivedAt, d.timeZone)}</dd>
        {s.finalValue !== null && <><dt>Counted</dt><dd>{s.finalValue.toLocaleString('en-IN')}</dd></>}
        {s.decisionReason && <><dt>Note</dt><dd>{s.decisionReason}</dd></>}
      </dl>}
      {info.restDay && <p className="small muted">Rest day declared {time(info.restDay.declaredAt, d.timeZone)}{info.restDay.source === 'ADMIN_CORRECTION' ? ' (recorded by an admin)' : ''}.</p>}
      {canCancelRest && <button className="btn small" onClick={cancelRest}>Cancel this rest day</button>}
      {info.exemption && <p className="small muted">Exemption request: {info.exemption.status.toLowerCase().replace('_', ' ')}.</p>}
      {s && (s.status === 'BELOW_TARGET' || s.status === 'REJECTED') && !s.appealed && (
        <div className="section">
          <Field label="Ask an admin to look again" hint="One appeal per decision."><input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why should the decision change?" /></Field>
          <button className="btn small" disabled={note.trim().length < 5} onClick={appeal}>Send appeal</button>
        </div>
      )}
      {s?.appealed && s.status !== 'PENDING_REVIEW' && <p className="small muted">You appealed this decision.</p>}
    </div>
  );
}

function PlanRest({ v, d, onChanged }: { v: ChallengeView; d: Dashboard; onChanged: () => void }) {
  const [dayPick, setDayPick] = useState('');
  const [error, setError] = useState<unknown>(null);
  const planned = d.days.filter((x) => x.restDay && x.day > (d.today?.day ?? ''));
  const plan = async () => {
    setError(null);
    try { await api.post(`/api/challenges/${v.challengeId}/rest-days`, { day: dayPick }); setDayPick(''); onChanged(); } catch (e) { setError(e); }
  };
  return (
    <details className="card">
      <summary>Plan a rest day</summary>
      <p className="muted small">{d.rules.restDays.perPeriod} per week, {d.rules.restDays.maxTotal} in total, declared before {d.rules.restDays.declareBefore} on the day. You've used {d.summary.restDaysUsed}.</p>
      <ErrorBox error={error} />
      <div className="row">
        <input type="date" value={dayPick} min={d.today?.day ?? v.startsOn} max={v.endsOn} onChange={(e) => setDayPick(e.target.value)} style={{ maxWidth: 200 }} />
        <button className="btn" disabled={!dayPick} onClick={plan}>Declare</button>
      </div>
      {planned.length > 0 && <p className="small" style={{ marginTop: 10 }}>Planned: {planned.map((x) => day(x.day)).join(', ')} (tap the day in the calendar to cancel)</p>}
    </details>
  );
}
