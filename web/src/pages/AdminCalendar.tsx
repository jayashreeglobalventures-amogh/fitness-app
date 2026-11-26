// Team tab (admins): a calendar of everyone's days, or one person's, between two dates. Everyone = one row per person
// and a column per day; one person = their month calendar. Tap a day for its details (and the screenshot).
import { useState } from 'react';
import { api } from '../api';
import { Collapsible, day, ErrorBox, Loading, Modal, StatusBadge, useLoad, ViewPhoto, DAY_STATUS } from '../ui';
import type { ChallengeView } from './Challenge';

interface CalDay { day: string; status: string; value: number | null; source: 'APPLE_HEALTH' | 'SCREENSHOT' | null; fileId: number | null; decisionReason: string | null; restDay: boolean; doubted: boolean }
interface CalPerson { participantId: number; displayName: string; status: string; summary: { achieved: number; missed: number; rest: number; excused: number; adherencePct: number | null }; days: CalDay[] }
interface Cal { from: string; to: string; today: string; startsOn: string; endsOn: string; target: number; unit: string; people: CalPerson[] }

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const short = (v: number | null) => (v === null ? '' : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v));
const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const LEGEND: [string, string][] = [['ACHIEVED', 'met'], ['TARGET_MISSED', 'missed'], ['PENDING_VERIFICATION', 'waiting'], ['IN_PROGRESS', 'in progress'], ['REST', 'rest'], ['EXCUSED', 'excused'], ['NOT_SUBMITTED', 'not yet']];

export function AdminCalendar({ v, people }: { v: ChallengeView; people: { participantId: number; displayName: string }[] }) {
  const [who, setWho] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [pick, setPick] = useState<{ person: CalPerson; d: CalDay } | null>(null);
  const qs = new URLSearchParams({ ...(who ? { participantId: who } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const cal = useLoad(() => api.get<Cal>(`/api/challenges/${v.challengeId}/calendar${qs ? `?${qs}` : ''}`), [v.challengeId, qs]);
  const c = cal.data;
  const week = () => { if (!c) return; const end = c.today < c.endsOn ? c.today : c.endsOn; setFrom(addDays(end, -6)); setTo(end); };
  const whole = () => { setFrom(''); setTo(''); };

  return (
    <Collapsible id={`admin-cal-${v.challengeId}`} title="📅 Calendar">
      {/* Phone: person on its own row, From | To, then the two quick buttons. Wider: one line. */}
      <div className="cal-filters">
        <label className="cal-f-who"><span>Participant</span>
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.participantId} value={p.participantId}>{p.displayName}</option>)}
          </select>
        </label>
        <label><span>From</span><input type="date" value={from || c?.from || ''} min={c?.startsOn} max={c?.endsOn} onChange={(e) => setFrom(e.target.value)} /></label>
        <label><span>To</span><input type="date" value={to || c?.to || ''} min={c?.startsOn} max={c?.endsOn} onChange={(e) => setTo(e.target.value)} /></label>
        <button type="button" className="btn ghost small" onClick={week}>Last 7 days</button>
        <button type="button" className="btn ghost small" onClick={whole}>Whole challenge</button>
      </div>
      <ErrorBox error={cal.error} />
      {cal.loading && !c ? <Loading /> : c && (who && c.people[0] ? <OnePerson c={c} p={c.people[0]} onPick={(d) => setPick({ person: c.people[0]!, d })} /> : <Everyone c={c} onPick={(person, d) => setPick({ person, d })} />)}
      {c && (
        <div className="row small muted" style={{ gap: 10, marginTop: 8 }}>
          {LEGEND.map(([s, l]) => <span key={s} className="row" style={{ gap: 4 }}><span className="cal-chip" data-s={s} />{l}</span>)}
          <span>📱 Apple Health</span>
        </div>
      )}
      {pick && c && <DayModal c={c} person={pick.person} d={pick.d} onClose={() => setPick(null)} />}
    </Collapsible>
  );
}

function Everyone({ c, onPick }: { c: Cal; onPick: (p: CalPerson, d: CalDay) => void }) {
  if (!c.people.length) return <div className="empty">No participants yet.</div>;
  const dates = c.people[0]!.days.map((d) => d.day);
  return (
    <div className="table-wrap heat-wrap">
      <table className="heat">
        <thead><tr><th>Person</th>{dates.map((d) => <th key={d} className={d === c.today ? 'today' : ''}>{Number(d.slice(8))}<div className="muted">{DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]}</div></th>)}<th>%</th></tr></thead>
        <tbody>{c.people.map((p) => (
          <tr key={p.participantId}>
            <th>{p.displayName}{p.status !== 'ACTIVE' && <div className="muted small">{p.status.toLowerCase()}</div>}</th>
            {p.days.map((d) => (
              <td key={d.day}>
                <button type="button" data-s={d.status} title={`${p.displayName} · ${day(d.day)}: ${DAY_STATUS[d.status]?.label ?? d.status}${d.value !== null ? ` · ${d.value.toLocaleString('en-IN')}` : ''}`} onClick={() => onPick(p, d)}>
                  {short(d.value)}{d.source === 'APPLE_HEALTH' && <span className="heat-src">📱</span>}
                </button>
              </td>
            ))}
            <td className="small">{p.summary.adherencePct === null ? '—' : `${Math.round(p.summary.adherencePct)}`}</td>
          </tr>))}
        </tbody>
      </table>
    </div>
  );
}

function OnePerson({ c, p, onPick }: { c: Cal; p: CalPerson; onPick: (d: CalDay) => void }) {
  const lead = p.days.length ? new Date(`${p.days[0]!.day}T00:00:00Z`).getUTCDay() : 0;
  return (
    <>
      <div className="spread" style={{ marginBottom: 8 }}>
        <span className="small"><b>{p.displayName}</b> · {p.summary.achieved}✓ {p.summary.missed}✗{p.summary.rest ? ` · ${p.summary.rest} rest` : ''} · {p.summary.adherencePct === null ? '—' : `${p.summary.adherencePct}%`}</span>
        <ReportButton participantId={p.participantId} name={p.displayName} label="📄 Download PDF" />
      </div>
      <div className="cal">
        {DOW.map((x, i) => <div key={i} className="dow">{x}</div>)}
        {Array.from({ length: lead }, (_, i) => <button key={`b${i}`} className="blank" tabIndex={-1} aria-hidden="true" />)}
        {p.days.map((d) => (
          <button key={d.day} data-s={d.status} aria-current={d.day === c.today ? 'date' : undefined} title={`${day(d.day)}: ${DAY_STATUS[d.status]?.label ?? d.status}`} onClick={() => onPick(d)}>
            {Number(d.day.slice(8))}{d.value !== null && <span className="cal-val">{short(d.value)}{d.source === 'APPLE_HEALTH' ? '📱' : ''}</span>}
          </button>
        ))}
      </div>
    </>
  );
}

function DayModal({ c, person, d, onClose }: { c: Cal; person: CalPerson; d: CalDay; onClose: () => void }) {
  return (
    <Modal title={<span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>{person.displayName} · {day(d.day)} <StatusBadge status={d.status} /></span>} onClose={onClose}>
      <dl className="kv">
        <dt>Target</dt><dd>{c.target.toLocaleString('en-IN')} {c.unit}</dd>
        <dt>Counted</dt><dd>{d.value === null ? '—' : `${d.value.toLocaleString('en-IN')} ${c.unit}`}</dd>
        <dt>From</dt><dd>{d.source === 'APPLE_HEALTH' ? '📱 Apple Health' : d.source === 'SCREENSHOT' ? 'Screenshot' : d.restDay ? 'Rest day' : '—'}{d.doubted ? ' · ⚠️ synced steps doubted' : ''}</dd>
        {d.decisionReason && <><dt>Note</dt><dd>{d.decisionReason}</dd></>}
      </dl>
      {d.fileId && <p className="small"><ViewPhoto fileId={d.fileId} alt={`${person.displayName}'s screenshot for ${d.day}`}>View screenshot</ViewPhoto></p>}
      <p className="muted small" style={{ marginBottom: 0 }}>To change this day, use <b>Correct</b> in the Team table (or Review for screenshots).</p>
    </Modal>
  );
}

/**
 * Downloads a participant's PDF report. On iPhone/iPad the installed app has no Back button on a PDF page, so the file
 * goes to the Share sheet instead (Save to Files, WhatsApp, Mail…); elsewhere it downloads.
 */
export function ReportButton({ participantId, name, label = '📄 PDF', src, primary }: { participantId: number; name: string; label?: string; src?: string; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(src ?? `/api/participants/${participantId}/report.pdf`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(r.status === 403 ? 'You can\'t download this.' : 'The PDF could not be made. Please try again.');
      const filename = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? `${name}.pdf`;
      const file = new File([await r.blob()], filename, { type: 'application/pdf' });
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (ios && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: filename }).catch(() => undefined); return; }
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className={`btn small ${primary ? 'primary' : 'ghost'}`} disabled={busy} onClick={go} title={`Download ${name} (PDF)`}>{busy ? 'Making…' : label}</button>
      {error ? <ErrorBox error={error} /> : null}
    </>
  );
}
