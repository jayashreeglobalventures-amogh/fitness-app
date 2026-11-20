// Health profile (optional, private by default, consent first): measurements as dated history with progress charts,
// fitness profile and goals, who sees each field, time-limited support access, withdraw consent / delete everything.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { day, ErrorBox, Field, Loading } from '../ui';

type Vis = 'PRIVATE' | 'ADMINS' | 'MEMBERS' | 'PUBLIC';
interface Rec { id: number; on: string; heightCm: number | null; weightKg: number | null; bodyFatPct: number | null; waistCm: number | null; restingHr: number | null; note: string | null; bmi: number | null }
interface HP {
  units: 'METRIC' | 'IMPERIAL'; fitnessLevel: string | null; activityLevel: string | null; goals: string[];
  targetWeightKg: number | null; targetDailySteps: number | null; considerations: string | null; visibility: Record<string, Vis>;
}
interface Health {
  consent: { grantedAt: string; version: number } | null; consentVersion: number; profile: HP; records: Rec[];
  supportGrants: { grantId: number; to: string; reason: string | null; since: string; until: string }[];
}

export const GOAL_LABEL: Record<string, string> = { FAT_LOSS: 'Fat loss', MUSCLE_GAIN: 'Muscle gain', ENDURANCE: 'Endurance', STRENGTH: 'Strength', STEPS: 'Steps', CONSISTENCY: 'Consistency' };
export const FITNESS_LABEL: Record<string, string> = { BEGINNER: 'Beginner', INTERMEDIATE: 'Intermediate', ADVANCED: 'Advanced' };
export const ACTIVITY_LABEL: Record<string, string> = { SEDENTARY: 'Sedentary (mostly sitting)', LIGHT: 'Lightly active', MODERATE: 'Moderately active', ACTIVE: 'Active', VERY_ACTIVE: 'Very active' };
const VIS_LABEL: Record<Vis, string> = { PRIVATE: 'Only me', ADMINS: 'My challenge admins', MEMBERS: 'My challenge members', PUBLIC: 'Everyone in the app' };
const FIELD_LABEL: Record<string, string> = {
  height: 'Height', weight: 'Weight', bmi: 'BMI', bodyFat: 'Body fat', waist: 'Waist', restingHr: 'Resting heart rate',
  fitnessLevel: 'Fitness level', activityLevel: 'Activity level', goals: 'Goals', considerations: 'Health considerations',
};

// ---------- units ----------
const KG_LB = 2.20462;
const r1 = (n: number) => Math.round(n * 10) / 10;
export const fmtHeight = (cm: number, units: string) => {
  if (units === 'METRIC') return `${r1(cm)} cm`;
  const totalIn = cm / 2.54; let ft = Math.floor(totalIn / 12); let inch = Math.round(totalIn - ft * 12);
  if (inch === 12) { ft++; inch = 0; }
  return `${ft} ft ${inch} in`;
};
export const fmtWeight = (kg: number, units: string) => (units === 'METRIC' ? `${r1(kg)} kg` : `${r1(kg * KG_LB)} lb`);
export const fmtWaist = (cm: number, units: string) => (units === 'METRIC' ? `${r1(cm)} cm` : `${r1(cm / 2.54)} in`);
export function bmiNote(bmi: number): string {
  if (bmi < 18.5) return 'below the usual range';
  if (bmi < 25) return 'in the usual range';
  if (bmi < 30) return 'above the usual range';
  return 'well above the usual range';
}

export function HealthPage() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api.get<Health>('/api/me/health').then(setH, setError); }, []);
  const run = async (fn: () => Promise<Health>) => { setError(null); try { setH(await fn()); return true; } catch (e) { setError(e); return false; } };
  if (!h) return error ? <ErrorBox error={error} /> : <Loading />;
  return (
    <>
      <button className="btn ghost small" onClick={() => navigate('/profile')}>← Profile</button>
      <h1 style={{ marginTop: 8 }}>Health profile</h1>
      <ErrorBox error={error} />
      {!h.consent ? <Consent h={h} run={run} /> : (
        <>
          <Summary h={h} />
          <Progress h={h} />
          <AddRecord h={h} run={run} />
          <History h={h} run={run} />
          <FitnessProfile h={h} run={run} />
          <Sharing h={h} run={run} />
          <Support h={h} run={run} />
          <Privacy run={run} />
        </>
      )}
    </>
  );
}

type Run = (fn: () => Promise<Health>) => Promise<boolean>;

function Consent({ h, run }: { h: Health; run: Run }) {
  const [agree, setAgree] = useState(false);
  return (
    <div className="card">
      <h3>Before you start</h3>
      <p className="small">The health profile is <b>optional</b>. You can take part in every challenge without it.</p>
      <ul className="small" style={{ paddingLeft: 18 }}>
        <li><b>What:</b> height, weight, BMI (worked out for you), body fat, waist, resting heart rate, fitness and activity level, goals, and any health considerations you choose to add.</li>
        <li><b>Why:</b> so you can track your progress over time, and - only if you choose - share parts of it.</li>
        <li><b>Who sees it:</b> only you. You choose, field by field, whether your challenge admins, challenge members or everyone in the app may see something. The finance manager and Super Admins get no access from their role.</li>
        <li><b>Support:</b> if you ever need help with your records, you can let one Super Admin see them for a few hours. Every look is recorded.</li>
        {h.records.length > 0 && <li><b>Earlier records:</b> you have {h.records.length} saved from before. They become visible to you again; sharing starts again as "Only me".</li>}
        <li><b>Your rights:</b> change or delete any entry, withdraw this consent, or delete everything at any time.</li>
        <li>BMI and the other numbers are for tracking only - they are not a medical assessment.</li>
      </ul>
      <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        <span>I agree to the app storing the health information I enter, as described above.</span></label>
      <button className="btn primary" style={{ marginTop: 10 }} disabled={!agree} onClick={() => run(() => api.post<Health>('/api/me/health/consent', { agree: true, version: h.consentVersion }))}>Start my health profile</button>
    </div>
  );
}

const latest = (recs: Rec[], k: keyof Rec) => [...recs].reverse().find((r) => r[k] !== null && r[k] !== undefined);

function Summary({ h }: { h: Health }) {
  const u = h.profile.units;
  const height = latest(h.records, 'heightCm'), weight = latest(h.records, 'weightKg'), fat = latest(h.records, 'bodyFatPct'), waist = latest(h.records, 'waistCm'), hr = latest(h.records, 'restingHr');
  const bmi = weight?.bmi ?? null;
  if (!h.records.length) return <div className="card"><p className="muted small" style={{ margin: 0 }}>No measurements yet. Add your first one below - you only need one value to start.</p></div>;
  const tile = (label: string, value: string | null, on?: string, sub?: string) => value && (
    <div className="stat"><span className="muted small">{label}</span><b>{value}</b><span className="muted small">{sub ? `${sub} · ` : ''}{on ? day(on) : ''}</span></div>);
  return (
    <div className="card">
      <h3>Latest</h3>
      <div className="stats">
        {tile('Weight', weight ? fmtWeight(weight.weightKg!, u) : null, weight?.on)}
        {tile('BMI', bmi !== null ? String(bmi) : null, weight?.on, bmi !== null ? bmiNote(bmi) : undefined)}
        {tile('Height', height ? fmtHeight(height.heightCm!, u) : null, height?.on)}
        {tile('Waist', waist ? fmtWaist(waist.waistCm!, u) : null, waist?.on)}
        {tile('Body fat', fat ? `${fat.bodyFatPct}%` : null, fat?.on)}
        {tile('Resting heart rate', hr ? `${hr.restingHr} bpm` : null, hr?.on)}
      </div>
      {bmi !== null && <p className="muted small" style={{ marginBottom: 0 }}>BMI = weight (kg) ÷ height (m)². It is a rough screening number, not a health assessment - it doesn't tell muscle from fat. For South Asian adults, lower cut-offs (23 and 27.5) are often used. Talk to a doctor about what's right for you.</p>}
    </div>
  );
}

// ---------- progress chart ----------
const METRICS = [
  { key: 'weightKg', label: 'Weight', fmt: (v: number, u: string) => fmtWeight(v, u), conv: (v: number, u: string) => (u === 'METRIC' ? v : v * KG_LB), unit: (u: string) => (u === 'METRIC' ? 'kg' : 'lb') },
  { key: 'bmi', label: 'BMI', fmt: (v: number) => String(v), conv: (v: number) => v, unit: () => '' },
  { key: 'waistCm', label: 'Waist', fmt: (v: number, u: string) => fmtWaist(v, u), conv: (v: number, u: string) => (u === 'METRIC' ? v : v / 2.54), unit: (u: string) => (u === 'METRIC' ? 'cm' : 'in') },
  { key: 'bodyFatPct', label: 'Body fat', fmt: (v: number) => `${v}%`, conv: (v: number) => v, unit: () => '%' },
  { key: 'restingHr', label: 'Resting heart rate', fmt: (v: number) => `${v} bpm`, conv: (v: number) => v, unit: () => 'bpm' },
] as const;

function Progress({ h }: { h: Health }) {
  const available = METRICS.filter((m) => h.records.filter((r) => r[m.key] !== null).length >= 2);
  const [pick, setPick] = useState<string>(available[0]?.key ?? 'weightKg');
  const m = available.find((x) => x.key === pick) ?? available[0];
  if (!m) return h.records.length ? <div className="card"><h3>Progress</h3><p className="muted small" style={{ margin: 0 }}>Charts appear once a measurement has two or more entries.</p></div> : null;
  const u = h.profile.units;
  const pts = h.records.filter((r) => r[m.key] !== null).map((r) => ({ on: r.on, v: m.conv(r[m.key] as number, u), raw: r[m.key] as number }));
  const target = m.key === 'weightKg' && h.profile.targetWeightKg ? m.conv(h.profile.targetWeightKg, u) : null;
  return (
    <div className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Progress: {m.label}{m.unit(u) ? ` (${m.unit(u)})` : ''}</h3>
        {available.length > 1 && (
          <select value={m.key} onChange={(e) => setPick(e.target.value)} aria-label="Measurement" style={{ maxWidth: 200 }}>
            {available.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        )}
      </div>
      <LineChart points={pts} format={(p) => m.fmt(p.raw, u)} target={target} targetLabel={target !== null ? `Target ${fmtWeight(h.profile.targetWeightKg!, u)}` : ''} />
      {pts.length >= 2 && <p className="muted small" style={{ margin: '6px 0 0' }}>
        {m.label}: {m.fmt(pts[0]!.raw, u)} on {day(pts[0]!.on)} → {m.fmt(pts.at(-1)!.raw, u)} on {day(pts.at(-1)!.on)}.</p>}
    </div>
  );
}

/** One series over time: 2px line, markers, recessive grid, crosshair + tooltip on hover/touch, dashed target line. */
function LineChart({ points, format, target, targetLabel }: { points: { on: string; v: number; raw: number }[]; format: (p: { on: string; v: number; raw: number }) => string; target: number | null; targetLabel: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 220, L = 44, R = 12, T = 12, B = 28;
  const t = (d: string) => new Date(`${d}T00:00:00Z`).getTime();
  const geo = useMemo(() => {
    const xs = points.map((p) => t(p.on));
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const vals = [...points.map((p) => p.v), ...(target !== null ? [target] : [])];
    let y0 = Math.min(...vals), y1 = Math.max(...vals);
    const pad = Math.max((y1 - y0) * 0.15, Math.abs(y1) * 0.02, 0.5);
    y0 -= pad; y1 += pad;
    const sx = (x: number) => L + (x1 === x0 ? (W - L - R) / 2 : ((x - x0) / (x1 - x0)) * (W - L - R));
    const sy = (y: number) => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
    const step = niceStep((y1 - y0) / 4);
    const ticks: number[] = [];
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) ticks.push(Math.round(v * 100) / 100);
    return { sx, sy, ticks, xs };
  }, [points, target]);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${geo.sx(geo.xs[i]!).toFixed(1)},${geo.sy(p.v).toFixed(1)}`).join(' ');
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    points.forEach((_, i) => { if (Math.abs(geo.sx(geo.xs[i]!) - x) < Math.abs(geo.sx(geo.xs[best]!) - x)) best = i; });
    setHover(best);
  };
  const hp = hover !== null ? points[hover] : null;
  const first = points[0]!, last = points.at(-1)!;
  return (
    <div style={{ position: 'relative', marginTop: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Chart from ${day(first.on)} to ${day(last.on)}`}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} style={{ display: 'block', touchAction: 'pan-y' }}>
        {geo.ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={geo.sy(v)} y2={geo.sy(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={L - 6} y={geo.sy(v) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{v}</text>
          </g>
        ))}
        <text x={L} y={H - 8} fontSize="11" fill="var(--muted)">{day(first.on)}</text>
        {points.length > 1 && <text x={W - R} y={H - 8} fontSize="11" fill="var(--muted)" textAnchor="end">{day(last.on)}</text>}
        {target !== null && (
          <g>
            <line x1={L} x2={W - R} y1={geo.sy(target)} y2={geo.sy(target)} stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="5 4" />
            <text x={W - R} y={geo.sy(target) - 5} textAnchor="end" fontSize="11" fill="var(--muted)">{targetLabel}</text>
          </g>
        )}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => <circle key={i} cx={geo.sx(geo.xs[i]!)} cy={geo.sy(p.v)} r={hover === i ? 5 : 4} fill="var(--accent)" stroke="var(--surface)" strokeWidth="2" />)}
        {hp && <line x1={geo.sx(geo.xs[hover!]!)} x2={geo.sx(geo.xs[hover!]!)} y1={T} y2={H - B} stroke="var(--muted)" strokeWidth="1" />}
      </svg>
      {hp && (
        <div className="chart-tip" style={{ left: `${(geo.sx(geo.xs[hover!]!) / W) * 100}%` }}>
          <b>{format(hp)}</b><span className="muted">{day(hp.on)}</span>
        </div>
      )}
    </div>
  );
}
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ---------- entries ----------
const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
interface Draft { on: string; height: string; heightFt: string; heightIn: string; weight: string; fat: string; waist: string; hr: string; note: string }
const emptyDraft = (): Draft => ({ on: todayIst(), height: '', heightFt: '', heightIn: '', weight: '', fat: '', waist: '', hr: '', note: '' });
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

function toPayload(d: Draft, units: string) {
  const ft = numOrNull(d.heightFt), inch = numOrNull(d.heightIn);
  const heightCm = units === 'METRIC' ? numOrNull(d.height) : ft === null && inch === null ? null : ((ft ?? 0) * 12 + (inch ?? 0)) * 2.54;
  const w = numOrNull(d.weight), wa = numOrNull(d.waist);
  return {
    measuredOn: d.on, heightCm, weightKg: w === null ? null : units === 'METRIC' ? w : w / KG_LB,
    waistCm: wa === null ? null : units === 'METRIC' ? wa : wa * 2.54, bodyFatPct: numOrNull(d.fat), restingHr: numOrNull(d.hr), note: d.note || null,
  };
}
function fromRecord(r: Rec, units: string): Draft {
  const s = (n: number | null, f = (x: number) => x) => (n === null ? '' : String(r1(f(n))));
  const totalIn = r.heightCm === null ? null : r.heightCm / 2.54;
  return {
    on: r.on, height: s(r.heightCm), heightFt: totalIn === null ? '' : String(Math.floor(totalIn / 12)), heightIn: totalIn === null ? '' : String(Math.round(totalIn % 12)),
    weight: s(r.weightKg, (x) => (units === 'METRIC' ? x : x * KG_LB)), fat: s(r.bodyFatPct), waist: s(r.waistCm, (x) => (units === 'METRIC' ? x : x / 2.54)),
    hr: r.restingHr === null ? '' : String(r.restingHr), note: r.note ?? '',
  };
}

function RecordForm({ units, initial, onSave, onCancel, saveLabel }: { units: string; initial: Draft; onSave: (p: ReturnType<typeof toPayload>) => Promise<boolean>; onCancel?: () => void; saveLabel: string }) {
  const [d, setD] = useState(initial);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [k]: e.target.value });
  const metric = units === 'METRIC';
  const any = [d.height, d.heightFt, d.heightIn, d.weight, d.fat, d.waist, d.hr].some((x) => x.trim() !== '');
  return (
    <>
      <div className="grid2">
        <Field label="Date"><input type="date" value={d.on} max={todayIst()} onChange={set('on')} /></Field>
        {metric ? <Field label="Height (cm)"><input type="number" inputMode="decimal" step="0.1" value={d.height} onChange={set('height')} /></Field>
          : <Field label="Height (ft / in)"><div className="row" style={{ flexWrap: 'nowrap' }}>
              <input type="number" inputMode="numeric" placeholder="ft" value={d.heightFt} onChange={set('heightFt')} />
              <input type="number" inputMode="numeric" placeholder="in" value={d.heightIn} onChange={set('heightIn')} /></div></Field>}
        <Field label={`Weight (${metric ? 'kg' : 'lb'})`}><input type="number" inputMode="decimal" step="0.1" value={d.weight} onChange={set('weight')} /></Field>
        <Field label={`Waist (${metric ? 'cm' : 'in'})`}><input type="number" inputMode="decimal" step="0.1" value={d.waist} onChange={set('waist')} /></Field>
        <Field label="Body fat (%)"><input type="number" inputMode="decimal" step="0.1" value={d.fat} onChange={set('fat')} /></Field>
        <Field label="Resting heart rate (bpm)"><input type="number" inputMode="numeric" value={d.hr} onChange={set('hr')} /></Field>
      </div>
      <Field label="Note (optional)"><input type="text" maxLength={200} value={d.note} onChange={set('note')} placeholder="e.g. morning, before breakfast" /></Field>
      <div className="row">
        <button className="btn primary" disabled={!any || !d.on} onClick={async () => { if (await onSave(toPayload(d, units)) && !onCancel) setD(emptyDraft()); }}>{saveLabel}</button>
        {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </>
  );
}

function AddRecord({ h, run }: { h: Health; run: Run }) {
  return (
    <div className="card">
      <h3>Add a measurement</h3>
      <p className="muted small">Fill in only what you measured. Each entry is kept with its date - new entries never replace old ones.</p>
      <RecordForm units={h.profile.units} initial={emptyDraft()} saveLabel="Save" onSave={(p) => run(() => api.post<Health>('/api/me/health/records', p))} />
    </div>
  );
}

function History({ h, run }: { h: Health; run: Run }) {
  const [edit, setEdit] = useState<number | null>(null);
  const [sure, setSure] = useState<number | null>(null);
  if (!h.records.length) return null;
  const u = h.profile.units;
  const c = (v: string | null) => v ?? <span className="muted">—</span>;
  return (
    <div className="card">
      <h3>History</h3>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Weight</th><th>BMI</th><th>Waist</th><th>Body fat</th><th>Rest HR</th><th>Height</th><th /></tr></thead>
        <tbody>{[...h.records].reverse().map((r) => (
          <tr key={r.id}>
            <td>{day(r.on)}{r.note && <div className="muted small">{r.note}</div>}</td>
            <td>{c(r.weightKg !== null ? fmtWeight(r.weightKg, u) : null)}</td>
            <td>{c(r.bmi !== null && r.weightKg !== null ? String(r.bmi) : null)}</td>
            <td>{c(r.waistCm !== null ? fmtWaist(r.waistCm, u) : null)}</td>
            <td>{c(r.bodyFatPct !== null ? `${r.bodyFatPct}%` : null)}</td>
            <td>{c(r.restingHr !== null ? String(r.restingHr) : null)}</td>
            <td>{c(r.heightCm !== null ? fmtHeight(r.heightCm, u) : null)}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button className="link" onClick={() => setEdit(edit === r.id ? null : r.id)}>Edit</button>{' '}
              <button className="link" onClick={() => (sure === r.id ? run(() => api.post<Health>(`/api/me/health/records/${r.id}/delete`)).then(() => setSure(null)) : setSure(r.id))}>{sure === r.id ? 'Tap again to delete' : 'Delete'}</button>
            </td>
          </tr>))}
        </tbody></table></div>
      {edit !== null && (
        <div className="section">
          <b className="small">Correct the entry of {day(h.records.find((r) => r.id === edit)!.on)}</b>
          <RecordForm key={edit} units={u} initial={fromRecord(h.records.find((r) => r.id === edit)!, u)} saveLabel="Save changes" onCancel={() => setEdit(null)}
            onSave={async (p) => { const ok = await run(() => api.put<Health>(`/api/me/health/records/${edit}`, p)); if (ok) setEdit(null); return ok; }} />
        </div>
      )}
    </div>
  );
}

// ---------- profile, sharing, support, privacy ----------
function FitnessProfile({ h, run }: { h: Health; run: Run }) {
  const [p, setP] = useState(h.profile);
  const [saved, setSaved] = useState(false);
  useEffect(() => setP(h.profile), [h.profile]);
  const u = p.units;
  const [tw, setTw] = useState(p.targetWeightKg === null ? '' : String(r1(u === 'METRIC' ? p.targetWeightKg : p.targetWeightKg * KG_LB)));
  useEffect(() => setTw(h.profile.targetWeightKg === null ? '' : String(r1(h.profile.units === 'METRIC' ? h.profile.targetWeightKg : h.profile.targetWeightKg * KG_LB))), [h.profile]);
  const toggle = (g: string) => setP({ ...p, goals: p.goals.includes(g) ? p.goals.filter((x) => x !== g) : [...p.goals, g] });
  const save = async () => {
    const t = numOrNull(tw);
    const ok = await run(() => api.put<Health>('/api/me/health/profile', {
      units: p.units, fitnessLevel: p.fitnessLevel, activityLevel: p.activityLevel, goals: p.goals,
      targetWeightKg: t === null ? null : u === 'METRIC' ? t : t / KG_LB, targetDailySteps: p.targetDailySteps, considerations: p.considerations,
    }));
    setSaved(ok);
  };
  return (
    <div className="card">
      <h3>Fitness profile and goals</h3>
      <div className="grid2">
        <Field label="Units"><select value={p.units} onChange={(e) => { setP({ ...p, units: e.target.value as HP['units'] }); setSaved(false); }}>
          <option value="METRIC">Metric (cm, kg)</option><option value="IMPERIAL">Imperial (ft/in, lb)</option></select></Field>
        <Field label="Fitness level"><select value={p.fitnessLevel ?? ''} onChange={(e) => setP({ ...p, fitnessLevel: e.target.value || null })}>
          <option value="">Not set</option>{Object.entries(FITNESS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Activity level"><select value={p.activityLevel ?? ''} onChange={(e) => setP({ ...p, activityLevel: e.target.value || null })}>
          <option value="">Not set</option>{Object.entries(ACTIVITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label={`Target weight (${u === 'METRIC' ? 'kg' : 'lb'}, optional)`}><input type="number" inputMode="decimal" step="0.1" value={tw} onChange={(e) => setTw(e.target.value)} /></Field>
        <Field label="Target daily steps (optional)"><input type="number" inputMode="numeric" value={p.targetDailySteps ?? ''} onChange={(e) => setP({ ...p, targetDailySteps: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
      </div>
      <Field label="Goals">
        <div className="row" style={{ gap: 6 }}>
          {Object.entries(GOAL_LABEL).map(([k, l]) => <button key={k} className={`btn small ${p.goals.includes(k) ? 'primary' : 'ghost'}`} aria-pressed={p.goals.includes(k)} onClick={() => toggle(k)}>{l}</button>)}
        </div>
      </Field>
      <Field label="Health considerations (optional, private by default)" hint="Anything you'd like to keep in mind - e.g. an injury. Can be shared at most with your challenge admins.">
        <textarea rows={2} maxLength={1000} value={p.considerations ?? ''} onChange={(e) => setP({ ...p, considerations: e.target.value || null })} />
      </Field>
      {saved && <div className="alert ok small">Saved.</div>}
      <button className="btn primary" onClick={save}>Save</button>
    </div>
  );
}

function Sharing({ h, run }: { h: Health; run: Run }) {
  const [vis, setVis] = useState(h.profile.visibility);
  const [saved, setSaved] = useState(false);
  useEffect(() => setVis(h.profile.visibility), [h.profile.visibility]);
  const changed = Object.keys(vis).some((k) => vis[k] !== h.profile.visibility[k]);
  return (
    <div className="card">
      <h3>Who can see what</h3>
      <p className="muted small">Everything starts as "Only me". Making your basic profile public never makes health data public. "Challenge admins" means the admins of challenges you take part in (not the finance manager).</p>
      {Object.keys(FIELD_LABEL).map((f) => (
        <div key={f} className="spread" style={{ padding: '4px 0' }}>
          <span className="small">{FIELD_LABEL[f]}</span>
          <select value={vis[f] ?? 'PRIVATE'} onChange={(e) => { setVis({ ...vis, [f]: e.target.value as Vis }); setSaved(false); }} style={{ maxWidth: 220 }}>
            {(f === 'considerations' ? (['PRIVATE', 'ADMINS'] as Vis[]) : (Object.keys(VIS_LABEL) as Vis[])).map((v) => <option key={v} value={v}>{VIS_LABEL[v]}</option>)}
          </select>
        </div>
      ))}
      {saved && <div className="alert ok small">Sharing updated.</div>}
      <button className="btn primary" disabled={!changed} style={{ marginTop: 8 }} onClick={async () => setSaved(await run(() => api.put<Health>('/api/me/health/profile', { visibility: vis })))}>Save sharing</button>
    </div>
  );
}

function Support({ h, run }: { h: Health; run: Run }) {
  const [admins, setAdmins] = useState<{ userId: number; name: string }[]>([]);
  const [to, setTo] = useState('');
  const [hours, setHours] = useState('4');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open) api.get<{ userId: number; name: string }[]>('/api/health/support-admins').then(setAdmins, () => undefined); }, [open]);
  const t = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="card">
      <h3>Support access</h3>
      <p className="muted small">Only if you need help with your records: let one Super Admin see your health profile for a few hours. It ends by itself, you can stop it any time, and every look is recorded.</p>
      {h.supportGrants.map((g) => (
        <div key={g.grantId} className="alert warn small">
          <b>{g.to}</b> can see your health profile until {t(g.until)}{g.reason ? ` (${g.reason})` : ''}.{' '}
          <button className="btn small ghost" onClick={() => run(() => api.post<Health>(`/api/me/health/support/${g.grantId}/revoke`))}>Stop now</button>
        </div>
      ))}
      {!open ? <button className="btn ghost" onClick={() => setOpen(true)}>Give support access…</button> : (
        <>
          <div className="grid2">
            <Field label="To"><select value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{admins.map((a) => <option key={a.userId} value={a.userId}>{a.name}</option>)}</select></Field>
            <Field label="For"><select value={hours} onChange={(e) => setHours(e.target.value)}>{[1, 4, 24, 72].map((n) => <option key={n} value={n}>{n} hour{n > 1 ? 's' : ''}</option>)}</select></Field>
          </div>
          <Field label="Why (optional)"><input type="text" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="row">
            <button className="btn primary" disabled={!to} onClick={async () => { if (await run(() => api.post<Health>('/api/me/health/support', { granteeUserId: Number(to), hours: Number(hours), reason }))) { setOpen(false); setTo(''); setReason(''); } }}>Give access</button>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}

function Privacy({ run }: { run: Run }) {
  const [step, setStep] = useState<null | 'withdraw' | 'delete'>(null);
  const [typed, setTyped] = useState('');
  return (
    <div className="card">
      <h3>Your data</h3>
      {step === null && (
        <div className="row">
          <button className="btn ghost" onClick={() => setStep('withdraw')}>Withdraw consent</button>
          <button className="btn ghost danger" onClick={() => setStep('delete')}>Delete all my health data</button>
        </div>
      )}
      {step === 'withdraw' && (
        <div className="section">
          <p className="small">Withdrawing stops all sharing straight away (including support access), and nothing new can be added. What about the records you've saved?</p>
          <div className="row">
            <button className="btn ghost" onClick={() => run(() => api.post<Health>('/api/me/health/withdraw', { deleteData: false }))}>Withdraw, keep my records hidden</button>
            <button className="btn danger" onClick={() => run(() => api.post<Health>('/api/me/health/withdraw', { deleteData: true }))}>Withdraw and delete everything</button>
            <button className="btn ghost" onClick={() => setStep(null)}>Cancel</button>
          </div>
        </div>
      )}
      {step === 'delete' && (
        <div className="section">
          <p className="small">This permanently erases every measurement, your goals, considerations and sharing settings. <b>It can't be undone.</b> Type <b>DELETE</b> to confirm.</p>
          <div className="row">
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ maxWidth: 140 }} aria-label="Type DELETE to confirm" />
            <button className="btn danger" disabled={typed !== 'DELETE'} onClick={async () => { if (await run(() => api.post<Health>('/api/me/health/delete-all'))) { setStep(null); setTyped(''); } }}>Delete everything</button>
            <button className="btn ghost" onClick={() => { setStep(null); setTyped(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
