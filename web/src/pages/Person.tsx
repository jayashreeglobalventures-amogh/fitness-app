// Someone's profile page: only what they chose to share with the viewer (the server decides; health data comes from
// the database's sharing check).
import { api } from '../api';
import { navigate } from '../router';
import { Avatar, day, ErrorBox, Loading, useLoad } from '../ui';
import { ACTIVITY_LABEL, bmiNote, FITNESS_LABEL, fmtHeight, fmtWaist, fmtWeight, GOAL_LABEL } from './Health';

interface Dated { value: number; on: string }
interface PersonCard {
  userId: number; displayName: string; self: boolean; joined: string; photoFileId: number | null; fields: Record<string, string>;
  challengesInCommon: { challengeId: number; name: string }[];
  health: null | {
    support: boolean;
    values: { heightCm?: Dated; weightKg?: Dated; bmi?: Dated; bodyFatPct?: Dated; waistCm?: Dated; restingHr?: Dated; fitnessLevel?: string; activityLevel?: string; goals?: string[]; considerations?: string };
    history: { on: string; heightCm: number | null; weightKg: number | null; bodyFatPct: number | null; waistCm: number | null; restingHr: number | null }[] | null;
  };
}
const FIELD: Record<string, string> = { fullName: 'Full name', mobile: 'Mobile', email: 'Email', birthDate: 'Date of birth', gender: 'Gender', location: 'Location', about: 'About' };

export function PersonPage({ userId }: { userId: number }) {
  const p = useLoad(() => api.get<PersonCard>(`/api/people/${userId}`), [userId]);
  if (p.loading) return <Loading />;
  if (!p.data) return <ErrorBox error={p.error} />;
  const d = p.data;
  if (d.self) { navigate('/profile'); return null; }
  const v = d.health?.values ?? {};
  const units = 'METRIC';
  const row = (label: string, value: string | null | undefined, on?: string) => value ? (
    <div className="spread" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}><span className="muted small">{label}</span><span>{value}{on && <span className="muted small"> · {day(on)}</span>}</span></div>) : null;
  return (
    <>
      <button className="btn ghost small" onClick={() => history.back()}>← Back</button>
      <div className="card" style={{ marginTop: 8 }}>
        <div className="row" style={{ alignItems: 'center', gap: 14 }}>
          <Avatar fileId={d.photoFileId} name={d.displayName} size={72} />
          <div>
            <h1 style={{ margin: 0 }}>{d.displayName}</h1>
            {d.challengesInCommon.length > 0 && <p className="muted small" style={{ margin: '4px 0 0' }}>In {d.challengesInCommon.map((c) => c.name).join(', ')} with you</p>}
          </div>
        </div>
        {Object.keys(d.fields).length > 0 && <div style={{ marginTop: 12 }}>{Object.entries(d.fields).map(([k, val]) => <div key={k}>{row(FIELD[k] ?? k, val)}</div>)}</div>}
      </div>
      {d.health && (
        <div className="card">
          <h3>Health</h3>
          {d.health.support && <div className="alert warn small">You can see this because {d.displayName} gave you temporary support access. This view is recorded.</div>}
          {row('Height', v.heightCm ? fmtHeight(v.heightCm.value, units) : null, v.heightCm?.on)}
          {row('Weight', v.weightKg ? fmtWeight(v.weightKg.value, units) : null, v.weightKg?.on)}
          {row('BMI', v.bmi ? `${v.bmi.value} (${bmiNote(v.bmi.value)})` : null, v.bmi?.on)}
          {row('Waist', v.waistCm ? fmtWaist(v.waistCm.value, units) : null, v.waistCm?.on)}
          {row('Body fat', v.bodyFatPct ? `${v.bodyFatPct.value}%` : null, v.bodyFatPct?.on)}
          {row('Resting heart rate', v.restingHr ? `${v.restingHr.value} bpm` : null, v.restingHr?.on)}
          {row('Fitness level', v.fitnessLevel ? FITNESS_LABEL[v.fitnessLevel] : null)}
          {row('Activity level', v.activityLevel ? ACTIVITY_LABEL[v.activityLevel] : null)}
          {row('Goals', v.goals?.length ? v.goals.map((g) => GOAL_LABEL[g] ?? g).join(', ') : null)}
          {row('Health considerations', v.considerations)}
          {d.health.history && d.health.history.length > 0 && (
            <details style={{ marginTop: 10 }}><summary className="small">All records ({d.health.history.length})</summary>
              <div className="table-wrap"><table>
                <thead><tr><th>Date</th><th>Weight</th><th>Waist</th><th>Body fat</th><th>Rest HR</th><th>Height</th></tr></thead>
                <tbody>{d.health.history.map((r, i) => (
                  <tr key={i}><td>{day(r.on)}</td><td>{r.weightKg ?? '—'}</td><td>{r.waistCm ?? '—'}</td><td>{r.bodyFatPct ?? '—'}</td><td>{r.restingHr ?? '—'}</td><td>{r.heightCm ?? '—'}</td></tr>))}
                </tbody></table></div>
            </details>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>Shared by {d.displayName}. For tracking only - not a medical assessment.</p>
        </div>
      )}
    </>
  );
}
