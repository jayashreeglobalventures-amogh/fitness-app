// Roster: invite people (existing accounts), follow invitations, change a participant's status from a date.
import { useState } from 'react';
import { api, type Me } from '../api';
import { day, ErrorBox, Field, Loading, useLoad } from '../ui';
import type { ChallengeView } from './Challenge';

interface UserRow { userId: number; username: string; displayName: string; fullName: string | null; status: string }
interface Invitation { invitationId: number; userId: number; username: string; displayName: string; status: string; invitedAt: string; expiresAt: string; approvedJoinOn: string | null }
interface Participant { participantId: number; userId: number; username: string; displayName: string; status: string; joinedOn: string; leftOn: string | null; acceptedAt: string }

const STATUS_BADGE: Record<string, string> = { INVITED: 'info', ACCEPTED: 'ok', ACTIVE: 'ok', DECLINED: 'danger', REVOKED: 'danger', EXPIRED: 'warn', WITHDRAWN: 'warn', REMOVED: 'danger', DISQUALIFIED: 'danger', SUSPENDED: 'warn' };

export function RosterSection({ v, me }: { v: ChallengeView; me: Me }) {
  const canManage = v.myPermissions.includes('roster.manage');
  const people = useLoad(() => (me.canManageAccounts ? api.get<UserRow[]>('/api/admin/users') : Promise.resolve([])), []);
  const invitations = useLoad(() => (canManage ? api.get<Invitation[]>(`/api/challenges/${v.challengeId}/invitations`) : Promise.resolve([])), [v.challengeId]);
  const participants = useLoad(() => api.get<Participant[]>(`/api/challenges/${v.challengeId}/participants`), [v.challengeId]);
  const reload = () => { invitations.reload(); participants.reload(); };
  const [error, setError] = useState<unknown>(null);

  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); reload(); } catch (e) { setError(e); } };
  const onRoster = new Set([...(participants.data ?? []).map((p) => p.userId), ...(invitations.data ?? []).filter((i) => i.status === 'INVITED').map((i) => i.userId)]);
  const invitable = (people.data ?? []).filter((u) => u.status === 'ACTIVE' && !onRoster.has(u.userId));

  return (
    <>
      <ErrorBox error={error} />
      {canManage && v.status === 'PUBLISHED' && <Invite v={v} people={invitable} onDone={reload} />}
      {canManage && v.status === 'DRAFT' && <div className="alert">Publish the challenge to start inviting people.</div>}

      <h2>Participants ({participants.data?.length ?? 0})</h2>
      {participants.loading && <Loading />}
      <ErrorBox error={participants.error} />
      {participants.data?.length === 0 && <div className="card empty">Nobody has joined yet.</div>}
      {participants.data?.map((p) => <ParticipantCard key={p.participantId} p={p} v={v} me={me} canManage={canManage} onChanged={reload} />)}

      {canManage && (<>
        <h2>Invitations</h2>
        {invitations.data?.length === 0 && <div className="card empty">No invitations yet.</div>}
        {invitations.data && invitations.data.length > 0 && (
          <div className="card table-wrap"><table>
            <thead><tr><th>Person</th><th>Status</th><th>Expires</th><th /></tr></thead>
            <tbody>{invitations.data.map((i) => (
              <tr key={i.invitationId}>
                <td>{i.displayName}<br /><span className="muted small">@{i.username}{i.approvedJoinOn ? ` · first day ${day(i.approvedJoinOn)}` : ''}</span></td>
                <td><span className={`badge ${STATUS_BADGE[i.status] ?? ''}`}>{i.status.toLowerCase()}</span></td>
                <td className="small">{i.status === 'INVITED' ? new Date(i.expiresAt).toLocaleDateString('en-IN') : '—'}</td>
                <td><div className="row" style={{ gap: 6 }}>
                  {(i.status === 'INVITED' || i.status === 'EXPIRED') && <button className="btn small" onClick={() => act(() => api.post(`/api/invitations/${i.invitationId}/resend`))}>{i.status === 'EXPIRED' ? 'Re-open' : 'Extend'}</button>}
                  {(i.status === 'INVITED' || i.status === 'EXPIRED') && <button className="btn small ghost danger" onClick={() => confirm(`Revoke ${i.displayName}'s invitation?`) && act(() => api.post(`/api/invitations/${i.invitationId}/revoke`))}>Revoke</button>}
                </div></td>
              </tr>))}
            </tbody></table></div>
        )}
      </>)}
    </>
  );
}

function Invite({ v, people, onDone }: { v: ChallengeView; people: UserRow[]; onDone: () => void }) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [joinOn, setJoinOn] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const locked = v.phase === 'ACTIVE' && v.current.config.registration.lockRosterAtStart;
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/challenges/${v.challengeId}/invitations`, { userIds: [...picked], ...(locked ? { approvedJoinOn: joinOn, reason } : {}) });
      setPicked(new Set()); setReason(''); onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <details className="card" open={people.length > 0}>
      <summary>Invite people</summary>
      <p className="muted small">People need an account first (People tab). Each invited person sees the challenge and accepts the rules themselves.</p>
      <ErrorBox error={error} />
      {people.length === 0 ? <p className="muted">Everyone with an account is already invited or on the roster.</p> : (
        <div style={{ maxHeight: 280, overflowY: 'auto', marginBottom: 12 }}>
          {people.map((u) => (
            <label key={u.userId} className="check"><input type="checkbox" checked={picked.has(u.userId)} onChange={() => toggle(u.userId)} />
              <span>{u.displayName}{u.fullName && u.fullName !== u.displayName ? ` (${u.fullName})` : ''} <span className="muted small">@{u.username}</span></span></label>
          ))}
        </div>
      )}
      {locked && (
        <div className="alert warn">
          The challenge has started, so the roster is locked. Late joiners start on an approved day (today or later) and get no points or penalties for earlier days.
          <div className="grid2" style={{ marginTop: 10 }}>
            <Field label="First day"><input type="date" value={joinOn} min={v.today} max={v.endsOn} onChange={(e) => setJoinOn(e.target.value)} /></Field>
            <Field label="Reason"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          </div>
        </div>
      )}
      <button className="btn primary" disabled={busy || picked.size === 0} onClick={send}>Invite {picked.size || ''}</button>
    </details>
  );
}

const NEXT: Record<string, string[]> = { ACTIVE: ['SUSPENDED', 'WITHDRAWN', 'REMOVED', 'DISQUALIFIED'], SUSPENDED: ['ACTIVE', 'WITHDRAWN', 'REMOVED', 'DISQUALIFIED'], DISQUALIFIED: ['ACTIVE'] };

function ParticipantCard({ p, v, me, canManage, onChanged }: { p: Participant; v: ChallengeView; me: Me; canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [effectiveOn, setEffectiveOn] = useState(v.today);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<unknown>(null);
  const options = (NEXT[p.status] ?? []).filter((s) => !(p.status === 'DISQUALIFIED' && !me.superAdmin && s === 'ACTIVE'));
  const mine = p.userId === me.userId;
  const save = async () => {
    setError(null);
    try { await api.post(`/api/participants/${p.participantId}/status`, { toStatus: to, effectiveOn, reason, financialOutcome: outcome || null }); setOpen(false); onChanged(); } catch (e) { setError(e); }
  };
  return (
    <div className="card">
      <div className="spread">
        <div><b>{p.displayName}</b> <span className="muted small">@{p.username}</span><br />
          <span className="muted small">From {day(p.joinedOn)}{p.leftOn ? ` to ${day(p.leftOn)}` : ''}</span></div>
        <div className="row"><span className={`badge ${STATUS_BADGE[p.status] ?? ''}`}>{p.status.toLowerCase()}</span>
          {canManage && !mine && options.length > 0 && <button className="btn small" onClick={() => setOpen((x) => !x)}>Change</button>}</div>
      </div>
      {open && (
        <div className="section">
          <ErrorBox error={error} />
          <div className="grid2">
            <Field label="New status"><select value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{options.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}</select></Field>
            <Field label="From (first day it applies)"><input type="date" min={v.today} value={effectiveOn} onChange={(e) => setEffectiveOn(e.target.value)} /></Field>
          </div>
          <Field label="Reason"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {v.current.config.finance.enabled && <Field label="Money outcome (optional)" hint="e.g. no refund, refund of week 3"><input type="text" value={outcome} onChange={(e) => setOutcome(e.target.value)} /></Field>}
          <button className="btn primary" disabled={!to} onClick={save}>Save</button>
        </div>
      )}
    </div>
  );
}
