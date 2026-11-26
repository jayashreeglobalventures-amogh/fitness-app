// Participant: today's goal, screenshot upload, rest day, progress and calendar.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { Collapsible, day, DAY_STATUS, ErrorBox, Field, Loading, Modal, newRef, StatusBadge, time, upload, useLoad, ViewPhoto } from '../ui';
import type { ChallengeView } from './Challenge';
import { PointsCard, usePoints } from './Points';
import { CoachCard } from './Coach';
import { MoneyRings } from './MoneyRings';
import { MyCertificate } from './Certificates';

interface DayInfo {
  day: string; status: string; periodNo: number | null;
  submission: { submissionId: number; status: string; finalValue: number | null; claimedValue: number | null; receivedAt: string; decisionReason: string | null; appealed: boolean; fileId?: number } | null;
  parts?: { submissionId: number; status: string; value: number | null; receivedAt: string; fileId: number; decisionReason: string | null }[];
  sync?: { steps: number; syncedAt: string; doubted: boolean; doubtReason: string | null } | null;
  restDay: { restDayId: number; declaredAt: string; source: string } | null;
  exemption: { requestId: number; status: string } | null;
}
interface Dashboard {
  participant: { participantId: number; status: string; joinedOn: string };
  today: (DayInfo & { target: number; unit: string; label: string; deadline: string; restCutoff: string }) | null;
  days: DayInfo[];
  summary: { achieved: number; missed: number; rest: number; excused: number; pending: number; adherencePct: number | null; restDaysUsed: number; restDaysThisPeriod: number; daysLeft: number };
  periods: { periodNo: number; startsOn: string; endsOn: string }[];
  rules: { restDays: { enabled: boolean; perPeriod: number; maxTotal: number; declareBefore: string }; exemptions: { enabled: boolean }; instructions: string; multiplePerDay: { enabled: boolean; combine: 'SUM' | 'HIGHEST' } };
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
  const pts = usePoints(d?.participant.participantId);

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
      <MyCertificate v={v} />
      {!t && <div className="card"><h3>{v.phase === 'UPCOMING' ? `Starts ${day(v.startsOn)}` : 'The challenge has ended'}</h3>
        <p className="muted small">{v.phase === 'UPCOMING' ? 'You can plan rest days now. Evidence can be uploaded from the first day.' : 'Results are provisional until the admins finish the review.'}</p></div>}
      {t && (
        <div className="today-grid">
          <TodayCard v={v} d={d} left={left} onChanged={() => { polls.current = 0; dash.reload(); }} />
          {v.current.config.finance.enabled && <MoneyRings challengeId={v.challengeId} />}
        </div>
      )}

      <div className="stats" style={{ margin: '12px 0' }}>
        <div className="stat"><span>Points</span><b>{pts.data?.total ?? '—'}</b></div>
        <div className="stat"><span>Streak</span><b>{pts.data?.currentStreak ?? '—'}</b></div>
        <div className="stat"><span>Achieved</span><b>{s.achieved}</b></div>
        <div className="stat"><span>Missed</span><b>{s.missed}</b></div>
        <div className="stat"><span>Adherence</span><b>{s.adherencePct === null ? '—' : `${s.adherencePct}%`}</b></div>
        <div className="stat"><span>Days left</span><b>{s.daysLeft}</b></div>
        {d.rules.restDays.enabled && <div className="stat"><span>Rest days</span><b>{s.restDaysUsed}/{d.rules.restDays.maxTotal}</b></div>}
        {s.excused > 0 && <div className="stat"><span>Excused</span><b>{s.excused}</b></div>}
      </div>
      <CoachCard challengeId={v.challengeId} />
      {s.pending > 0 && <p className="muted small">{s.pending} day{s.pending === 1 ? '' : 's'} waiting for verification; points for {s.pending === 1 ? 'it' : 'them'} follow the decision.</p>}
      {d.participant.participantId && <PointsCard participantId={d.participant.participantId} />}
      {d.rules.restDays.enabled && <PlanRest v={v} d={d} onChanged={dash.reload} />}

      <div className="card">
        <h3>Calendar</h3>
        <Calendar days={d.days} today={t?.day ?? null} onPick={setSelected} />
        <div className="legend">{['ACHIEVED', 'PENDING_VERIFICATION', 'MISSED_DEADLINE', 'REST', 'EXCUSED'].map((k) => <StatusBadge key={k} status={k} />)}</div>
      </div>
      {selected && <DayDetail v={v} info={d.days.find((x) => x.day === selected)!} d={d} onChanged={dash.reload} onClose={() => setSelected(null)} />}
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
  const multi = d.rules.multiplePerDay.enabled;
  const parts = t.parts ?? [];
  const canUpload = ['NOT_SUBMITTED', 'SUBMITTED', 'PENDING_VERIFICATION', 'TARGET_MISSED', 'REJECTED', 'IN_PROGRESS'].includes(t.status) && left !== 'closed';
  const beforeCutoff = Date.now() < Date.parse(t.restCutoff);
  const restAllowed = d.rules.restDays.enabled && !t.submission && t.status === 'NOT_SUBMITTED' && beforeCutoff
    && d.summary.restDaysThisPeriod < d.rules.restDays.perPeriod && d.summary.restDaysUsed < d.rules.restDays.maxTotal;

  return (
    <Collapsible id={`today-${v.challengeId}`} className="today" title={
      <span className="spread" style={{ width: '100%' }}>
        <span><span className="muted small" style={{ fontWeight: 400 }}>Today · {day(t.day)}</span><span className="target" style={{ display: 'block' }}>{t.target.toLocaleString('en-IN')} <span className="muted" style={{ fontSize: 16 }}>{t.unit}</span></span></span>
        <span style={{ textAlign: 'right', fontWeight: 400 }}><StatusBadge status={t.status} /><span className="muted small" style={{ display: 'block', marginTop: 6 }}>{left === 'closed' ? 'Deadline passed' : `Midnight deadline · ${left}`}</span></span>
      </span>}>
      <ErrorBox error={error} />
      {t.status === 'ACHIEVED' && <div className="alert ok" style={{ marginTop: 12 }}>Done for today: {countedOf(t, t.target).value?.toLocaleString('en-IN')} {t.unit}{countedOf(t, t.target).synced ? ' (from Apple Health)' : ''}. 🎉</div>}
      {t.status === 'SUBMITTED' && <div className="alert" style={{ marginTop: 12 }}>Reading your screenshot…</div>}
      {t.status === 'PENDING_VERIFICATION' && <div className="alert" style={{ marginTop: 12 }}>{multi ? 'An admin will check a screenshot. You can add more until midnight.' : 'An admin will check your screenshot. You can upload a clearer one until midnight.'}</div>}
      {t.status === 'IN_PROGRESS' && <div className="alert" style={{ marginTop: 12 }}>{(countedOf(t, t.target).value ?? 0).toLocaleString('en-IN')} of {t.target.toLocaleString('en-IN')} {t.unit} so far. {countedOf(t, t.target).synced ? 'Keep going - your Shortcut sends the latest count, or upload a screenshot before midnight.' : 'Add another screenshot (e.g. from your watch) before midnight.'}</div>}
      <SyncLine info={t} unit={t.unit} tz={d.timeZone} />
      {multi && parts.length > 0 && <Parts parts={parts} combine={d.rules.multiplePerDay.combine} unit={t.unit} dayOver={left === 'closed'} onChanged={onChanged} />}
      {!multi && t.submission?.fileId && <div className="small" style={{ marginTop: 8 }}><ViewPhoto fileId={t.submission.fileId} alt="My screenshot for today">View my screenshot</ViewPhoto> · <RemoveScreenshot submissionId={t.submission.submissionId} dayOver={left === 'closed'} onChanged={onChanged} /></div>}
      {(t.status === 'TARGET_MISSED' || t.status === 'REJECTED') && <div className="alert error" style={{ marginTop: 12 }}>{DAY_STATUS[t.status]!.label}{t.submission?.decisionReason ? `: ${t.submission.decisionReason}` : '.'} You can upload new evidence until midnight.</div>}
      {t.status === 'REST' && <div className="alert" style={{ marginTop: 12 }}>Rest day. Enjoy it. {beforeCutoff && <button className="btn small ghost" onClick={cancelRest}>Cancel rest day</button>}</div>}
      {t.status === 'EXCUSED' && <div className="alert" style={{ marginTop: 12 }}>Excused by an approved exemption. Get well soon.</div>}

      {canUpload && (
        <div style={{ marginTop: 14 }}>
          <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          {!file ? (
            <div className="dropzone" role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}>
              <b>{multi && parts.length ? 'Add another screenshot' : 'Upload today\'s screenshot'}</b><span className="muted small">{multi ? `${d.rules.instructions} You can add several (e.g. phone and watch): ${d.rules.multiplePerDay.combine === 'SUM' ? 'their steps are added up' : 'the highest counts'}.` : d.rules.instructions}</span>
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
    </Collapsible>
  );
}

/**
 * Remove my screenshot: directly until that day's midnight; afterwards by asking an admin. Either way it can be marked
 * as a private photo, so an admin erases the image itself.
 */
function RemoveScreenshot({ submissionId, dayOver, onChanged }: { submissionId: number; dayOver: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [privatePhoto, setPrivatePhoto] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const go = async () => {
    setError(null);
    try {
      if (dayOver) { await api.post(`/api/submissions/${submissionId}/removal-request`, { reason, eraseImage: privatePhoto }); setDone(true); }
      else { await api.post(`/api/submissions/${submissionId}/withdraw`, { eraseImage: privatePhoto, reason: privatePhoto ? 'Private photo uploaded by mistake' : undefined }); onChanged(); }
      setOpen(false);
    } catch (e) { setError(e); }
  };
  if (done) return <span className="muted small">Sent to the admins.</span>;
  if (!open) return <button type="button" className="linklike small" onClick={() => setOpen(true)}>{dayOver ? 'Ask to remove' : 'Remove'}</button>;
  return (
    <div className="section" style={{ marginTop: 6 }}>
      <ErrorBox error={error} />
      <p className="small" style={{ marginTop: 0 }}>{dayOver
        ? 'This day is already decided, so an admin has to remove it (points and fines are then recalculated).'
        : 'Remove this screenshot? Until midnight you can upload another one.'}</p>
      {dayOver && <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why should it be removed?" style={{ width: '100%' }} maxLength={500} />}
      <label className="check small"><input type="checkbox" checked={privatePhoto} onChange={(e) => setPrivatePhoto(e.target.checked)} />
        <span>It's a private photo - ask an admin to erase the image</span></label>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn small danger" disabled={dayOver && reason.trim().length < 5} onClick={go}>{dayOver ? 'Send to an admin' : 'Remove it'}</button>
        <button className="btn small ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

const PART_LABEL: Record<string, string> = { PENDING_AI: 'reading…', PENDING_REVIEW: 'waiting for an admin', APPROVED: 'approved', REJECTED: 'declined' };
/** Several screenshots a day: each one, its number and state, and the day's total. */
function Parts({ parts, combine, unit, dayOver, onChanged }: { parts: NonNullable<DayInfo['parts']>; combine: 'SUM' | 'HIGHEST'; unit: string; dayOver: boolean; onChanged: () => void }) {
  const approved = parts.filter((p) => p.status === 'APPROVED').map((p) => p.value ?? 0);
  const total = approved.length ? (combine === 'SUM' ? approved.reduce((a, v) => a + v, 0) : Math.max(...approved)) : 0;
  return (
    <div className="parts">
      {parts.map((p, i) => (
        <div key={p.submissionId} className="spread small" style={{ padding: '4px 0' }}>
          <span><ViewPhoto fileId={p.fileId} alt={`Screenshot ${i + 1}`}>Screenshot {i + 1}</ViewPhoto> <RemoveScreenshot submissionId={p.submissionId} dayOver={dayOver} onChanged={onChanged} /></span>
          <span><b>{p.value !== null && p.status === 'APPROVED' ? p.value.toLocaleString('en-IN') : '—'}</b> <span className={`badge ${p.status === 'APPROVED' ? 'ok' : p.status === 'REJECTED' ? 'danger' : ''}`}>{PART_LABEL[p.status] ?? p.status}</span></span>
        </div>
      ))}
      {parts.filter((p) => p.status === 'REJECTED' && p.decisionReason).map((p) => <p key={p.submissionId} className="muted small" style={{ margin: 0 }}>Declined: {p.decisionReason}</p>)}
      <div className="spread" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 4 }}>
        <b className="small">{combine === 'SUM' ? 'Total (approved, added up)' : 'Highest approved'}</b><b>{total.toLocaleString('en-IN')} {unit}</b>
      </div>
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

/** Successful days in a row up to and including `upTo` (rest days and exemptions pause it; a miss resets it). */
function streakOn(days: DayInfo[], upTo: string): number {
  let n = 0;
  for (const x of days) {
    if (x.day > upTo) break;
    if (x.status === 'ACHIEVED') n++;
    else if (x.status === 'TARGET_MISSED' || x.status === 'REJECTED' || x.status === 'MISSED_DEADLINE') n = 0;
  }
  return n;
}

/** A cheerful post about a successful day, for the participant to edit or post as it is. */
export function achievementPost(o: { challenge: string; dayNo: number; totalDays: number; date: string; steps: number | null; target: number; unit: string; streak: number }): string {
  const cheers = ['Another one in the bag! 🎉', 'Done and dusted! ✅', 'Target smashed! 💥', 'Steps done, feeling great! 😄', 'One more day closer to the finish line! 🏁'];
  const lines = [`${cheers[(o.dayNo + (o.steps ?? 0)) % cheers.length] ?? cheers[0]} Day ${o.dayNo} of ${o.totalDays} in ${o.challenge}.`];
  if (o.steps !== null) {
    const pct = Math.round((o.steps / o.target) * 100);
    lines.push(`👟 ${o.steps.toLocaleString('en-IN')} ${o.unit} on ${o.date}${pct >= 110 ? ` - ${pct}% of the ${o.target.toLocaleString('en-IN')} target 💪` : ` - target of ${o.target.toLocaleString('en-IN')} reached 💪`}`);
  }
  if (o.streak >= 2) lines.push(`🔥 ${o.streak}-day streak and counting!`);
  lines.push('Who\'s walking with me tomorrow? 🚶‍♀️🚶‍♂️');
  return lines.join('\n');
}

/** The number that counts for a day: steps synced from Apple Health when they meet the target (or there's nothing else), else the screenshot's. */
export function countedOf(info: DayInfo, target: number): { value: number | null; synced: boolean } {
  const sy = info.sync && !info.sync.doubted ? info.sync : null;
  const shot = info.submission?.finalValue ?? null;
  if (sy && (sy.steps >= target || shot === null || sy.steps > shot)) return { value: sy.steps, synced: true };
  return { value: shot, synced: false };
}

/** A line about the day's synced steps (or an admin's request for a screenshot instead). */
function SyncLine({ info, unit, tz }: { info: DayInfo; unit: string; tz: string }) {
  const sy = info.sync;
  if (!sy) return null;
  if (sy.doubted) return <div className="alert warn small" style={{ marginTop: 10 }}>⚠️ An admin asked for a screenshot of your {sy.steps.toLocaleString('en-IN')} synced {unit}{sy.doubtReason ? ` (${sy.doubtReason})` : ''}. Upload one, or send it to an admin.</div>;
  return <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>📱 From Apple Health: <b>{sy.steps.toLocaleString('en-IN')}</b> {unit} · synced {time(sy.syncedAt, tz)}</p>;
}

function DayDetail({ v, info, d, onChanged, onClose }: { v: ChallengeView; info: DayInfo; d: Dashboard; onChanged: () => void; onClose: () => void }) {
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
  const dayNo = Math.round((Date.parse(`${info.day}T00:00:00Z`) - Date.parse(`${v.startsOn}T00:00:00Z`)) / 86_400_000) + 1;
  const totalDays = Math.round((Date.parse(`${v.endsOn}T00:00:00Z`) - Date.parse(`${v.startsOn}T00:00:00Z`)) / 86_400_000) + 1;
  const target = v.current.config.activity.dailyTarget;
  const unit = v.current.config.activity.unit;
  const streak = info.status === 'ACHIEVED' ? streakOn(d.days, info.day) : 0;
  const counted = countedOf(info, target);
  const shotId = info.parts?.length ? info.parts.filter((p) => p.status === 'APPROVED').at(-1)?.fileId ?? null : s?.fileId ?? null;
  const share = () => {
    const body = achievementPost({ challenge: v.name, dayNo, totalDays, date: day(info.day), steps: counted.value, target, unit, streak });
    try { sessionStorage.setItem(`fit:community-draft:${v.challengeId}`, JSON.stringify({ body, fileId: shotId })); } catch { /* storage blocked: the post opens empty */ }
    navigate(`/community/${v.challengeId}`);
  };
  const summary = info.status === 'ACHIEVED' ? `Target met${counted.value != null ? ` with ${counted.value.toLocaleString('en-IN')} ${unit}` : ''}. 🎉`
    : info.status === 'TARGET_MISSED' ? `Below the target${s?.finalValue != null ? `: ${s.finalValue.toLocaleString('en-IN')} of ${target.toLocaleString('en-IN')} ${unit}` : ''}.`
      : info.status === 'MISSED_DEADLINE' ? 'No screenshot arrived before midnight.'
        : info.status === 'REST' ? 'Rest day. 😴' : info.status === 'EXCUSED' ? 'Excused by an approved exemption.'
          : info.status === 'UPCOMING' ? 'Still to come.' : DAY_STATUS[info.status]?.label ?? info.status;
  return (
    <Modal title={<span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>{day(info.day)} <StatusBadge status={info.status} /></span>} onClose={onClose}>
      <ErrorBox error={error} />
      <p style={{ marginTop: 0 }}><b>{summary}</b></p>
      <dl className="kv">
        <dt>Day</dt><dd>{dayNo} of {totalDays}</dd>
        <dt>Target</dt><dd>{target.toLocaleString('en-IN')} {unit}</dd>
        {counted.value != null && <><dt>Counted</dt><dd>{counted.value.toLocaleString('en-IN')} {unit}{counted.synced ? ' · 📱 Apple Health' : ''}</dd></>}
        {info.sync && <><dt>Synced</dt><dd>{info.sync.steps.toLocaleString('en-IN')} {unit} · {time(info.sync.syncedAt, d.timeZone)}{info.sync.doubted ? ' · ⚠️ admin asked for a screenshot' : ''}</dd></>}
        {s && <><dt>Uploaded</dt><dd>{time(s.receivedAt, d.timeZone)}</dd></>}
        {streak >= 2 && <><dt>Streak</dt><dd>🔥 {streak} days in a row</dd></>}
        {s?.decisionReason && <><dt>Note</dt><dd>{s.decisionReason}</dd></>}
      </dl>
      {info.status === 'ACHIEVED' && v.current.config.community.enabled && (
        <button className="btn primary" style={{ width: '100%', margin: '4px 0 10px' }} onClick={share}>📣 Post to the community</button>
      )}
      {s?.fileId && !(info.parts?.length) && <div className="small"><ViewPhoto fileId={s.fileId} alt={`My screenshot for ${info.day}`}>View screenshot</ViewPhoto> · <RemoveScreenshot submissionId={s.submissionId} dayOver={info.day < (d.today?.day ?? '9999')} onChanged={onChanged} /></div>}
      {(info.parts?.length ?? 0) > 0 && <Parts parts={info.parts!} combine={d.rules.multiplePerDay.combine} unit={d.today?.unit ?? ''} dayOver={info.day < (d.today?.day ?? '9999')} onChanged={onChanged} />}
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
    </Modal>
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
