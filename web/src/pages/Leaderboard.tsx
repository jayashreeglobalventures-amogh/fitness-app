// Provisional leaderboard: ranking per the challenge's settings, ties flagged, prize eligibility (adherence).
import { api } from '../api';
import { day, ErrorBox, Loading, useLoad } from '../ui';
import type { ChallengeView } from './Challenge';

interface Standing { rank: number; tied: boolean; participantId: number; displayName: string; status: string; points: number; adherencePct: number | null; successfulDays: number; longestStreak: number; currentStreak: number; eligible: boolean; me: boolean }
interface Board { standings: Standing[]; ranking: string[]; qualificationAdherencePct: number; team: { currentStreak: number; longestStreak: number; breaks: { day: string; previousStreak: number; responsible: number[]; restartOn: string }[] }; asOf: string }
const KEY: Record<string, string> = { POINTS: 'points', ADHERENCE: 'adherence', SUCCESSFUL_DAYS: 'successful days', LONGEST_PERSONAL_STREAK: 'longest streak', EARLIEST_FINAL_SCORE: 'who got there first' };

export function LeaderboardSection({ v }: { v: ChallengeView }) {
  const b = useLoad(() => api.get<Board>(`/api/challenges/${v.challengeId}/leaderboard`), [v.challengeId]);
  if (b.loading && !b.data) return <Loading />;
  if (!b.data) return <ErrorBox error={b.error} />;
  const d = b.data;
  const name = (pid: number) => d.standings.find((s) => s.participantId === pid)?.displayName ?? '—';
  return (
    <>
      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat"><span>Team streak</span><b>{d.team.currentStreak} day{d.team.currentStreak === 1 ? '' : 's'}</b></div>
        <div className="stat"><span>Best team streak</span><b>{d.team.longestStreak}</b></div>
      </div>
      <div className="card table-wrap"><table>
        <thead><tr><th>#</th><th>Name</th><th>Points</th><th>Adherence</th><th>Streak</th></tr></thead>
        <tbody>{d.standings.map((s) => (
          <tr key={s.participantId} style={s.me ? { background: 'color-mix(in srgb, var(--accent) 10%, transparent)' } : undefined}>
            <td><b>{s.rank}</b>{s.tied && <div className="muted small">tie</div>}</td>
            <td>{s.displayName}{s.me && <span className="muted small"> (you)</span>}
              <div>{s.eligible ? <span className="badge ok">on track for prizes</span> : <span className="badge">below {d.qualificationAdherencePct}%</span>}
                {s.status !== 'ACTIVE' && <span className="badge warn" style={{ marginLeft: 4 }}>{s.status.toLowerCase()}</span>}</div></td>
            <td><b>{s.points}</b></td>
            <td>{s.adherencePct === null ? '—' : `${s.adherencePct}%`}<div className="muted small">{s.successfulDays} days</div></td>
            <td>{s.currentStreak}<div className="muted small">best {s.longestStreak}</div></td>
          </tr>))}
        </tbody></table></div>
      <p className="muted small">Provisional until the final review. Ranked by {d.ranking.map((k) => KEY[k] ?? k).join(', then ')}. Ties that remain are decided by an admin.</p>
      {d.team.breaks.length > 0 && (
        <details className="card"><summary>Team streak history</summary>
          {d.team.breaks.slice().reverse().map((x) => (
            <p key={x.day} className="small">{day(x.day)}: a {x.previousStreak}-day team streak ended ({x.responsible.map(name).join(', ')} missed). Restarted {day(x.restartOn)}.</p>
          ))}
        </details>
      )}
    </>
  );
}
