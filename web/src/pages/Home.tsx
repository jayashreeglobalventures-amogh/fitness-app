import { api, type ChallengeListItem, type Me } from '../api';
import { navigate } from '../router';
import { day, ErrorBox, Loading, PHASE_LABEL, useLoad } from '../ui';

const daysLeft = (endsOn: string) => {
  const end = Date.parse(`${endsOn}T23:59:59+05:30`);
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
};

export function HomePage({ me }: { me: Me }) {
  const { data, error, loading } = useLoad(() => api.get<ChallengeListItem[]>('/api/challenges'), []);
  const invites = (data ?? []).filter((c) => c.openInvitationId);
  const mine = (data ?? []).filter((c) => c.participantStatus && c.phase !== 'ARCHIVED');
  return (
    <>
      <h1>Hi, {me.displayName}</h1>
      <ErrorBox error={error} />
      {loading && <Loading />}
      {invites.map((c) => (
        <div key={c.challengeId} className="card clickable" onClick={() => navigate(`/challenges/${c.challengeId}`)}>
          <span className="badge info">Invitation</span>
          <h3 style={{ marginTop: 10 }}>You're invited to {c.name}</h3>
          <p className="muted small">{day(c.startsOn)} – {day(c.endsOn)} · Read the rules and accept to join.</p>
        </div>
      ))}
      {mine.length > 0 && <h2>My challenges</h2>}
      {mine.map((c) => (
        <div key={c.challengeId} className="card clickable" onClick={() => navigate(`/challenges/${c.challengeId}`)}>
          <div className="spread"><h3>{c.name}</h3><span className={`badge ${c.phase}`}>{PHASE_LABEL[c.phase]}</span></div>
          <div className="stats" style={{ marginTop: 8 }}>
            <div className="stat"><span>{c.phase === 'UPCOMING' ? 'Starts' : 'Ends'}</span><b>{day(c.phase === 'UPCOMING' ? c.startsOn : c.endsOn)}</b></div>
            {c.phase === 'ACTIVE' && <div className="stat"><span>Days left</span><b>{daysLeft(c.endsOn)}</b></div>}
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>Daily check-ins, points and the leaderboard arrive in the next update.</p>
        </div>
      ))}
      {!loading && !invites.length && !mine.length && (
        <div className="card empty">
          <p>You're not in a challenge yet.</p>
          <button className="btn" onClick={() => navigate('/challenges')}>See challenges</button>
        </div>
      )}
    </>
  );
}
