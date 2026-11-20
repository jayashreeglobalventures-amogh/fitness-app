import { api, type ChallengeListItem, type Me } from '../api';
import { navigate } from '../router';
import { day, ErrorBox, Loading, PHASE_LABEL, useLoad } from '../ui';

const ROLE_LABEL: Record<string, string> = { CHALLENGE_ADMIN: 'Challenge admin', FINANCE_ADMIN: 'Finance admin' };

export function ChallengesPage({ me }: { me: Me }) {
  const { data, error, loading } = useLoad(() => api.get<ChallengeListItem[]>('/api/challenges'), []);
  return (
    <>
      <div className="spread">
        <h1>Challenges</h1>
        {me.canCreateChallenges && <button className="btn primary small" onClick={() => navigate('/challenges/new')}>New challenge</button>}
      </div>
      <ErrorBox error={error} />
      {loading && <Loading />}
      {data?.length === 0 && <div className="card empty">No challenges yet.</div>}
      {data?.map((c) => (
        <div key={c.challengeId} className="card clickable" onClick={() => navigate(`/challenges/${c.challengeId}`)}>
          <div className="spread">
            <h3>{c.name}</h3>
            <span className={`badge ${c.phase}`}>{PHASE_LABEL[c.phase]}</span>
          </div>
          <p className="muted small">{day(c.startsOn)} – {day(c.endsOn)} · {c.category.toLowerCase()}</p>
          <div className="row">
            {c.openInvitationId && <span className="badge info">Invited</span>}
            {c.participantStatus && <span className="badge ok">{c.participantStatus === 'ACTIVE' ? 'Participating' : c.participantStatus.toLowerCase()}</span>}
            {c.myRoles.map((r) => <span key={r} className="badge">{ROLE_LABEL[r] ?? r}</span>)}
            {me.superAdmin && !c.myRoles.length && <span className="badge">Super admin</span>}
          </div>
        </div>
      ))}
    </>
  );
}
