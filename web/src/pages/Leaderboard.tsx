// Provisional leaderboard: ranking per the challenge's settings, ties flagged, prize eligibility (adherence).
import { useState } from 'react';
import { api } from '../api';
import { Avatar, day, ErrorBox, Loading, useLoad } from '../ui';
import type { ChallengeView } from './Challenge';
import { navigate } from '../router';
import { PersonModal } from './Person';
import { RaceForEveryone } from './RaceTrack';

interface Standing { rank: number; tied: boolean; participantId: number; userId: number; displayName: string; photoFileId?: number | null; status: string; points: number; adherencePct: number | null; successfulDays: number; longestStreak: number; currentStreak: number; eligible: boolean; me: boolean }
interface Board { standings: Standing[]; ranking: string[]; qualificationAdherencePct: number; team: { currentStreak: number; longestStreak: number; breaks: { day: string; previousStreak: number; responsible: number[]; restartOn: string }[] }; asOf: string }
const KEY: Record<string, string> = { POINTS: 'points', ADHERENCE: 'adherence', SUCCESSFUL_DAYS: 'successful days', LONGEST_PERSONAL_STREAK: 'longest streak', EARLIEST_FINAL_SCORE: 'who got there first' };

export function LeaderboardSection({ v }: { v: ChallengeView }) {
  const b = useLoad(() => api.get<Board>(`/api/challenges/${v.challengeId}/leaderboard`), [v.challengeId]);
  const [open, setOpen] = useState<Standing | null>(null);
  if (b.loading && !b.data) return <Loading />;
  if (!b.data) return <ErrorBox error={b.error} />;
  const d = b.data;
  // Prize status (and withdrawn/removed) - shown on hover over the name, and at the top of the profile pop-up.
  const status = (s: Standing) => [
    s.eligible ? `✅ On track for prizes (${d.qualificationAdherencePct}%+ of days)` : `Below ${d.qualificationAdherencePct}% of days - not on track for prizes yet`,
    ...(s.status !== 'ACTIVE' ? [`${s.status[0]}${s.status.slice(1).toLowerCase()}`] : []),
  ];
  const name = (pid: number) => d.standings.find((s) => s.participantId === pid)?.displayName ?? '—';
  return (
    <>
      {/* Admins have the race on the Team tab; everyone else sees it here. */}
      {!v.myPermissions.includes('challenge.view_admin') && <RaceForEveryone challengeId={v.challengeId} startsOn={v.startsOn} endsOn={v.endsOn} />}
      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat"><span>Team streak</span><b>{d.team.currentStreak} day{d.team.currentStreak === 1 ? '' : 's'}</b></div>
        <div className="stat"><span>Best team streak</span><b>{d.team.longestStreak}</b></div>
      </div>
      <div className="card table-wrap"><table>
        <thead><tr><th>#</th><th>Name</th><th>Points</th><th>Adherence</th><th>Streak</th></tr></thead>
        <tbody>{d.standings.map((s) => (
          <tr key={s.participantId} style={s.me ? { background: 'color-mix(in srgb, var(--accent) 10%, transparent)' } : undefined}>
            <td><b>{s.rank}</b>{s.tied && <div className="muted small">tie</div>}</td>
            <td><span className="hover-tip-wrap">
              <button className="person-link" aria-describedby={`tip-${s.participantId}`} onClick={() => (s.me ? navigate('/profile') : setOpen(s))}>
                <Avatar fileId={s.photoFileId} name={s.displayName} size={28} /><span>{s.displayName}{s.me && <span className="muted small"> (you)</span>}</span></button>
              <span role="tooltip" id={`tip-${s.participantId}`} className="hover-tip">{status(s).map((x) => <span key={x}>{x}</span>)}</span>
            </span></td>
            <td><b>{s.points}</b></td>
            <td>{s.adherencePct === null ? '—' : `${s.adherencePct}%`}<div className="muted small">{s.successfulDays} days</div></td>
            <td>{s.currentStreak}<div className="muted small">best {s.longestStreak}</div></td>
          </tr>))}
        </tbody></table></div>
      {open && <PersonModal userId={open.userId} onClose={() => setOpen(null)}
        extra={<p className="small" style={{ marginTop: 0 }}>#{open.rank} · {open.points} points · {status(open).join(' · ')}</p>} />}
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
