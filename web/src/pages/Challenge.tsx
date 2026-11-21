// One challenge. Members: overview + rules (+ invitation acceptance). Admins: Settings, Roster and Admins sections too.
import { useState } from 'react';
import type { ChallengeConfig, ConfigCheck } from '../../../src/modules/challenges/config';
import { api, type Me, type Phase } from '../api';
import { navigate } from '../router';
import { day, ErrorBox, Loading, PHASE_LABEL, useLoad } from '../ui';
import { AdminsSection } from './ChallengeAdmins';
import { BonusSection } from './Bonus';
import { LeaderboardSection } from './Leaderboard';
import { CheckInSection } from './CheckIn';
import { ExemptionsSection } from './Exemptions';
import { ReviewSection } from './Review';
import { TeamSection } from './Team';
import { RosterSection } from './Roster';
import { RulesSummary } from './RulesSummary';
import { HeadsUp, SettingsSection } from './Settings';
import { DemoSection } from './Demo';
import { MoneySection } from './Money';
import { ResultsSection } from './Results';

export interface ChallengeView {
  challengeId: number; slug: string; name: string; category: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; timeZone: string;
  startsOn: string; endsOn: string; phase: Phase; today: string; acceptVersionNo: number;
  current: { versionNo: number; effectiveFrom: string; config: ChallengeConfig };
  upcoming: { versionNo: number; effectiveFrom: string; config: ChallengeConfig } | null;
  versions?: { versionNo: number; effectiveFrom: string; reason: string | null; createdAt: string; config: ChallengeConfig }[];
  myRoles: string[]; myPermissions: string[]; check?: ConfigCheck; participantStatus?: string | null;
}

export function ChallengePage({ me, id, section }: { me: Me; id: number; section: string }) {
  const view = useLoad(() => api.get<ChallengeView>(`/api/challenges/${id}`), [id]);
  const invites = useLoad(() => api.get<{ invitationId: number; challengeId: number }[]>('/api/me/invitations'), [id]);
  const v = view.data;
  if (view.loading && !v) return <Loading />;
  if (!v) return <ErrorBox error={view.error} />;
  const can = (p: string) => v.myPermissions.includes(p);
  const isAdmin = can('challenge.view_admin');
  const isParticipant = !!v.participantStatus;
  const live = v.status === 'PUBLISHED';
  const sections = [
    { key: 'today', label: 'Today', show: isParticipant && live },
    { key: 'team', label: 'Team', show: isAdmin && live },
    { key: 'leaderboard', label: 'Leaderboard', show: (isParticipant || isAdmin) && live },
    { key: 'results', label: 'Results', show: (isParticipant || isAdmin) && live && (isAdmin || v.phase === 'FINISHED') },
    { key: 'review', label: 'Review', show: can('submissions.review') && live },
    { key: 'bonus', label: 'Bonus', show: (isParticipant || can('bonus.manage')) && live && v.current.config.scoring.weekendBonus.enabled },
    { key: 'money', label: 'Money', show: live && (v.upcoming ?? v.current).config.finance.enabled && (isParticipant || can('finance.view') || can('finance.settings') || can('refunds.approve')) },
    { key: 'exemptions', label: 'Exemptions', show: (isParticipant || can('exemptions.review')) && live && (v.current.config.exemptions.enabled || can('exemptions.review')) },
    { key: 'roster', label: 'Roster', show: isAdmin },
    { key: 'admins', label: 'Admins', show: isAdmin },
    { key: 'settings', label: 'Settings', show: isAdmin },
    { key: 'overview', label: 'Rules', show: true },
    { key: 'demo', label: 'Demo', show: true },
  ].filter((s) => s.show);
  const fallback = sections[0]!.key;
  const active = section === 'default' ? fallback : sections.some((s) => s.key === section) ? section : fallback;
  const invitation = invites.data?.find((i) => i.challengeId === id);

  return (
    <>
      <button className="btn ghost small" onClick={() => navigate('/challenges')}>← Challenges</button>
      <div className="spread" style={{ marginTop: 8 }}>
        <h1>{v.name}</h1>
        <span className={`badge ${v.phase}`}>{PHASE_LABEL[v.phase]}</span>
      </div>
      <p className="muted small">{day(v.startsOn)} – {day(v.endsOn)} · {v.timeZone}</p>
      {sections.length > 1 && (
        <div className="subnav" role="tablist">
          {sections.map((s) => <button key={s.key} aria-current={s.key === active} onClick={() => navigate(`/challenges/${id}/${s.key}`)}
            ref={s.key === active ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'center' }) : undefined}>{s.label}</button>)}
        </div>
      )}
      {active === 'today' && <CheckInSection v={v} />}
      {active === 'team' && <TeamSection v={v} me={me} />}
      {active === 'review' && <ReviewSection v={v} />}
      {active === 'leaderboard' && <LeaderboardSection v={v} />}
      {active === 'demo' && <DemoSection v={v} />}
      {active === 'money' && <MoneySection v={v} />}
      {active === 'results' && <ResultsSection v={v} />}
      {active === 'bonus' && <BonusSection v={v} />}
      {active === 'exemptions' && <ExemptionsSection v={v} />}
      {active === 'overview' && <Overview v={v} invitationId={invitation?.invitationId ?? null} onChanged={() => { view.reload(); invites.reload(); }} />}
      {active === 'settings' && <SettingsSection v={v} me={me} onSaved={view.reload} />}
      {active === 'roster' && <RosterSection v={v} me={me} />}
      {active === 'admins' && <AdminsSection v={v} />}
    </>
  );
}

function Overview({ v, invitationId, onChanged }: { v: ChallengeView; invitationId: number | null; onChanged: () => void }) {
  const isAdmin = v.myPermissions.includes('challenge.view_admin');
  return (
    <>
      {isAdmin && <AdminStatus v={v} onChanged={onChanged} />}
      {invitationId && <AcceptInvitation v={v} invitationId={invitationId} onDone={onChanged} />}
      {v.upcoming && (
        <div className="alert warn">Rules change on {day(v.upcoming.effectiveFrom)}. Until then the rules below apply.</div>
      )}
      <div className="card">
        {v.current.config.basics.description && <p>{v.current.config.basics.description}</p>}
        <RulesSummary c={v.current.config} periods={v.check?.periods} />
      </div>
      {v.upcoming && (
        <details className="card"><summary>Rules from {day(v.upcoming.effectiveFrom)}</summary><RulesSummary c={v.upcoming.config} /></details>
      )}
    </>
  );
}

function AdminStatus({ v, onChanged }: { v: ChallengeView; onChanged: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canPublish = v.myPermissions.includes('challenge.publish');
  const publish = async () => {
    if (!confirm(`Publish ${v.name}? People can then be invited. Later rule changes create a new version.`)) return;
    setBusy(true); setError(null);
    try { await api.post(`/api/challenges/${v.challengeId}/publish`); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="spread">
        <div>
          <h3>{v.status === 'DRAFT' ? 'Draft: only admins can see this challenge' : `Published · rules version ${v.current.versionNo}`}</h3>
          <p className="muted small">{v.status === 'DRAFT' ? 'Check the settings, then publish to start inviting people.' : 'Rule changes now create a new version that applies from a future day.'}</p>
        </div>
        {v.status === 'DRAFT' && canPublish && <button className="btn primary" onClick={publish} disabled={busy || v.check?.ok === false}>Publish</button>}
      </div>
      <ErrorBox error={error} />
      {v.check && !v.check.ok && <ErrorBox error={{ message: 'The settings have problems to fix before publishing:', details: { errors: v.check.errors } }} />}
      <HeadsUp count={v.check?.warnings.length ?? 0} />
    </div>
  );
}

function AcceptInvitation({ v, invitationId, onDone }: { v: ChallengeView; invitationId: number; onDone: () => void }) {
  const [fitness, setFitness] = useState(false);
  const [money, setMoney] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const needsMoney = (v.upcoming ?? v.current).config.finance.enabled;
  const accept = async () => {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/invitations/${invitationId}/accept`, { rulesVersionNo: v.acceptVersionNo, acceptFitnessRules: fitness, acceptFinancialRules: money });
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const decline = async () => {
    if (!confirm('Decline this invitation?')) return;
    try { await api.post(`/api/invitations/${invitationId}/decline`); navigate('/challenges'); } catch (e) { setError(e); }
  };
  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <h3>You're invited</h3>
      <p className="muted small">Read the rules below. To join, confirm that you accept them.</p>
      <ErrorBox error={error} />
      <label className="check"><input type="checkbox" checked={fitness} onChange={(e) => setFitness(e.target.checked)} /><span>I accept the challenge rules (daily goal, evidence, rest days, points and penalties).</span></label>
      {needsMoney && <label className="check"><input type="checkbox" checked={money} onChange={(e) => setMoney(e.target.checked)} /><span>I accept the payment rules: weekly contributions, fines for missed days, and how the prize pool is shared.</span></label>}
      <div className="row">
        <button className="btn primary" disabled={busy || !fitness || (needsMoney && !money)} onClick={accept}>Join {v.name}</button>
        <button className="btn ghost" onClick={decline}>Decline</button>
      </div>
    </div>
  );
}
