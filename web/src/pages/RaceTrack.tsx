// Team tab: everyone on a race track. Each lane is a participant; their face moves right with every successful day;
// the finish line is the challenge's last day and a dashed line shows where someone hitting every day would be today.
// Hover (or tap) a face for the details. The table below the track has the same numbers for reading row by row.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Avatar, Collapsible, DAY_STATUS, useLoad } from '../ui';

interface Standing { participantId: number; userId: number; displayName: string; photoFileId?: number | null; points: number; adherencePct: number | null; successfulDays: number; currentStreak: number; eligible: boolean; status: string }
export interface RacePerson { participantId: number; displayName: string; status: string; day: { status: string } | null; summary: { achieved: number; missed: number; rest: number; excused: number } }

const STATUS_FACE: Record<string, string> = {
  ACHIEVED: '✅', SUBMITTED: '⏳', PENDING_VERIFICATION: '⏳', IN_PROGRESS: '🔄', REST: '😴', EXCUSED: '🤒',
  NOT_SUBMITTED: '🚶', TARGET_MISSED: '⚠️', REJECTED: '⚠️', MISSED_DEADLINE: '⚠️',
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function RaceTrack({ challengeId, startsOn, endsOn, today, people }: { challengeId: number; startsOn: string; endsOn: string; today: string; people: RacePerson[] }) {
  const board = useLoad(() => api.get<{ standings: Standing[]; qualificationAdherencePct: number }>(`/api/challenges/${challengeId}/leaderboard`), [challengeId]);
  const [tip, setTip] = useState<number | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setTip(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  const total = daysBetween(startsOn, endsOn) + 1;
  const elapsed = Math.max(0, Math.min(total, daysBetween(startsOn, today) + 1));
  const stand = new Map((board.data?.standings ?? []).map((s) => [s.participantId, s]));
  const lanes = people.filter((p) => p.status === 'ACTIVE' || stand.has(p.participantId))
    .map((p) => ({ p, s: stand.get(p.participantId) }))
    .sort((a, b) => b.p.summary.achieved - a.p.summary.achieved || (b.s?.points ?? 0) - (a.s?.points ?? 0) || a.p.displayName.localeCompare(b.p.displayName));
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;

  return (
    <Collapsible id={`race-${challengeId}`} title="🏁 The race" defaultOpen>
      <p className="muted small" style={{ marginTop: 0 }}>Each face moves one step for every successful day. 🏁 = day {total} ({new Date(`${endsOn}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' })}). The dashed line is where someone who hit every day would be now (day {elapsed}). Hover or tap a face for details.</p>
      <div className="race" onClick={() => setTip(null)}>
        {lanes.map(({ p, s }) => {
          const done = p.summary.achieved;
          const counted = done + p.summary.missed;
          const today = p.day?.status ?? '';
          const label = `${p.displayName}: ${done} successful day${done === 1 ? '' : 's'} of ${counted} counted; ${s?.points ?? 0} points; streak ${s?.currentStreak ?? 0}; today ${DAY_STATUS[today]?.label ?? 'not taking part'}`;
          return (
            <div key={p.participantId} className="lane">
              <span className="lane-name" title={p.displayName}>{p.displayName}</span>
              <div className="lane-track">
                <span className="pace" style={{ left: pct(elapsed) }} aria-hidden="true" />
                <span className="finish" aria-hidden="true">🏁</span>
                <button type="button" className="runner" style={{ left: `clamp(0px, calc(${pct(done)} - 15px), calc(100% - 30px))` }} aria-label={label}
                  aria-expanded={tip === p.participantId} onClick={(e) => { e.stopPropagation(); setTip(tip === p.participantId ? null : p.participantId); }}
                  onMouseEnter={() => setTip(p.participantId)} onMouseLeave={() => setTip((t) => (t === p.participantId ? null : t))}
                  onFocus={() => setTip(p.participantId)} onBlur={() => setTip((t) => (t === p.participantId ? null : t))}>
                  <Avatar fileId={s?.photoFileId} name={p.displayName} size={26} />
                  {STATUS_FACE[today] && <span className="runner-status" aria-hidden="true">{STATUS_FACE[today]}</span>}
                </button>
                {tip === p.participantId && (
                  <div className="race-tip" role="tooltip" style={{ left: `clamp(0px, calc(${pct(done)} - 90px), calc(100% - 180px))` }}>
                    <b>{p.displayName}</b>
                    <div>✅ {done} of {counted} days{p.summary.rest ? ` · 😴 ${p.summary.rest} rest` : ''}{p.summary.excused ? ` · 🤒 ${p.summary.excused} excused` : ''}</div>
                    <div>🔥 Streak {s?.currentStreak ?? 0} · ⭐ {s?.points ?? 0} points</div>
                    <div>📊 Adherence {s?.adherencePct == null ? '—' : `${s.adherencePct}%`}{s ? (s.eligible ? ' · prize line ✓' : ` · below ${board.data?.qualificationAdherencePct ?? 80}%`) : ''}</div>
                    <div>Today: {STATUS_FACE[today] ?? ''} {DAY_STATUS[today]?.label ?? '—'}</div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {!lanes.length && <p className="muted small">Nobody has joined yet.</p>}
      </div>
      <div className="race-legend small muted" style={{ marginTop: 8 }}>
        {[['✅', 'done today'], ['⏳', 'being checked'], ['🔄', 'in progress'], ['🚶', 'not sent yet'], ['⚠️', 'missed'], ['😴', 'rest day'], ['🤒', 'excused']].map(([e, l]) => <span key={l}>{e} {l}</span>)}
      </div>
    </Collapsible>
  );
}
