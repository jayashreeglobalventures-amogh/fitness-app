// A participant's points, event by event (corrections shown as reversals).
import { api } from '../api';
import { day, ErrorBox, useLoad } from '../ui';

interface Points { total: number; byRule: Record<string, number>; labels: Record<string, string>; currentStreak: number; longestStreak: number; comebacks: number; teamStreak: number;
  events: { eventId: number; rule: string; label: string; kind: string; day: string; points: number; details: Record<string, unknown> }[] }

export function usePoints(participantId: number | undefined) {
  return useLoad(() => (participantId ? api.get<Points>(`/api/participants/${participantId}/points`) : Promise.resolve(null)), [participantId]);
}

export function PointsCard({ participantId }: { participantId: number }) {
  const p = usePoints(participantId);
  if (!p.data) return <ErrorBox error={p.error} />;
  const d = p.data;
  const shown = d.events.filter((e) => e.points !== 0).slice().reverse();
  return (
    <details className="card">
      <summary>Points: {d.total}</summary>
      <div className="stats" style={{ marginBottom: 10 }}>
        {Object.entries(d.byRule).filter(([, v]) => v !== 0).map(([k, v]) => <div key={k} className="stat"><span>{d.labels[k] ?? k}</span><b>{v > 0 ? `+${v}` : v}</b></div>)}
      </div>
      <p className="muted small">Personal streak {d.currentStreak} (best {d.longestStreak}) · team streak {d.teamStreak} · comebacks {d.comebacks}</p>
      <div className="table-wrap"><table><tbody>
        {shown.map((e) => (
          <tr key={e.eventId}><td className="small">{day(e.day)}</td><td className="small">{e.label}{e.kind === 'REVERSAL' ? ' (corrected)' : ''}{typeof e.details.streak === 'number' ? ` · ${e.details.streak} days` : ''}</td>
            <td style={{ textAlign: 'right', color: e.points > 0 ? 'var(--accent)' : 'var(--danger)', fontWeight: 700 }}>{e.points > 0 ? `+${e.points}` : e.points}</td></tr>
        ))}
      </tbody></table></div>
    </details>
  );
}
