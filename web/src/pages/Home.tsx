import { useState } from 'react';
import { api, type ChallengeListItem, type Me } from '../api';
import { navigate } from '../router';
import { day, ErrorBox, Loading, PHASE_LABEL, useLoad } from '../ui';

const daysLeft = (endsOn: string) => {
  const end = Date.parse(`${endsOn}T23:59:59+05:30`);
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
};

function InstallHint() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('fit:install-hint') === 'done'; } catch { return false; } });
  if (!ios || standalone || hidden) return null;
  const close = () => { try { localStorage.setItem('fit:install-hint', 'done'); } catch { /* private mode */ } setHidden(true); };
  return (
    <div className="alert">
      <div className="spread"><b>Add Fitness to your Home Screen</b><button className="btn small ghost" onClick={close} aria-label="Dismiss">✕</button></div>
      <p className="small" style={{ margin: '6px 0 0' }}>In Safari, tap the Share button, then “Add to Home Screen”. It then opens full-screen like an app.</p>
    </div>
  );
}

export function HomePage({ me }: { me: Me }) {
  const { data, error, loading } = useLoad(() => api.get<ChallengeListItem[]>('/api/challenges'), []);
  const invites = (data ?? []).filter((c) => c.openInvitationId);
  const mine = (data ?? []).filter((c) => c.participantStatus && c.phase !== 'ARCHIVED');
  return (
    <>
      <h1>Hi, {me.displayName}</h1>
      <InstallHint />
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
          <p className="muted small" style={{ marginTop: 10 }}>Tap to check in, see your points and the leaderboard.</p>
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
