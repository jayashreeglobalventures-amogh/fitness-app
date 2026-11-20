// Super Admin: the activity log (who did what, when, where, from which device; before → after) and server errors.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { deviceName } from '../PhoneNotifications';
import { navigate } from '../router';
import { ErrorBox, Loading, useLoad } from '../ui';

interface Item {
  id: number; at: string; action: string; entity: string; entityId: string; targetName: string | null;
  actor: { userId: number; name: string; username: string } | null; challenge: { challengeId: number; name: string } | null;
  reason: string | null; before: unknown; after: unknown; ip: string | null; device: string | null;
}
interface Page<T> { items: T[]; nextBefore: number | null }
interface Facets { people: { userId: number; name: string; username: string }[]; challenges: { challengeId: number; name: string }[]; actions: { action: string; count: number }[] }
interface ErrorItem { id: number; at: string; source: string; user: { userId: number; name: string } | null; method: string | null; path: string | null; message: string; stack: string | null; ip: string | null; device: string | null }

// Plain-language names for actions; anything not listed is shown from its code ("REST_DAY_DECLARED" → "rest day declared").
const LABEL: Record<string, string> = {
  SIGNED_IN: 'signed in', SIGNED_OUT: 'signed out', SIGN_IN_FAILED: 'failed to sign in', SIGN_IN_LOCKED: 'was locked out after failed sign-ins', SIGN_IN_BLOCKED: 'tried to sign in while locked out',
  USER_CREATED: 'created an account', PASSWORD_RESET: 'reset a password', PASSWORD_CHANGED: 'changed their password', USER_ENABLED: 'enabled an account', USER_DISABLED: 'disabled an account',
  PROFILE_UPDATED: 'updated a profile', PROFILE_PHOTO_SET: 'set a profile photo', PROFILE_PHOTO_REMOVED: 'removed a profile photo',
  PLATFORM_ROLE_GRANTED: 'made someone Super Admin', CHALLENGE_ROLE_GRANTED: 'gave a challenge role', CHALLENGE_ROLE_REVOKED: 'removed a challenge role',
  CHALLENGE_CREATED: 'created a challenge', CHALLENGE_DUPLICATED: 'duplicated a challenge', CHALLENGE_CONFIG_EDITED: 'edited the challenge settings', CHALLENGE_RULES_VERSIONED: 'changed the rules (new version)',
  CHALLENGE_PUBLISHED: 'published a challenge', CHALLENGE_ARCHIVED: 'archived a challenge',
  PARTICIPANT_INVITED: 'invited someone', LATE_JOIN_INVITED: 'invited someone (late join)', INVITATION_ACCEPTED: 'accepted an invitation', INVITATION_DECLINED: 'declined an invitation',
  INVITATION_REVOKED: 'revoked an invitation', INVITATION_RESENT: 'resent an invitation', PARTICIPANT_STATUS_CHANGED: 'changed a participant\'s status',
  EVIDENCE_SUBMITTED: 'submitted step evidence', EVIDENCE_RECORDED_BY_ADMIN: 'recorded evidence for someone', EVIDENCE_REVIEWED: 'reviewed step evidence', EVIDENCE_DECISION_OVERRIDDEN: 'overrode an evidence decision', EVIDENCE_APPEALED: 'appealed an evidence decision',
  REST_DAY_DECLARED: 'declared a rest day', REST_DAY_CANCELLED: 'cancelled a rest day', REST_DAY_CORRECTED: 'corrected a rest day', REST_DAY_CORRECTION_CANCELLED: 'cancelled a rest-day correction',
  EXEMPTION_REQUESTED: 'requested an exemption', EXEMPTION_WITHDRAWN: 'withdrew an exemption', EXEMPTION_DECIDED: 'decided an exemption', EXEMPTION_OVERRIDDEN: 'overrode an exemption decision', EXEMPTION_VOTE_CLOSED: 'closed an exemption vote',
  BONUS_ACTIVITY_CREATED: 'created a bonus activity', BONUS_ACTIVITY_CANCELLED: 'cancelled a bonus activity', BONUS_SUBMITTED: 'submitted a bonus', BONUS_WITHDRAWN: 'withdrew a bonus', BONUS_DECIDED: 'decided a bonus', BONUS_DECISION_CHANGED: 'changed a bonus decision',
  PAYMENT_REPORTED: 'reported a payment', PAYMENT_WITHDRAWN: 'withdrew a payment report', PAYMENT_RECORDED_BY_ADMIN: 'recorded a payment for someone', PAYMENT_CONFIRMED: 'confirmed a payment', PAYMENT_REJECTED: 'rejected a payment',
  PAYMENT_DECISION_CHANGED: 'changed a payment decision', PAYMENT_DETAILS_CHANGED: 'changed the UPI / QR details', REFUND_PROPOSED: 'proposed a refund', REFUND_APPROVED: 'approved a refund', REFUND_REJECTED: 'rejected a refund', PAYOUT_RECORDED: 'recorded a payout',
  FINANCE_HANDOVER_STARTED: 'started a finance-manager handover', FINANCE_HANDOVER_ACCEPTED: 'accepted the finance-manager handover', FINANCE_HANDOVER_CANCELLED: 'cancelled a finance-manager handover',
  SETTLEMENT_PREPARED: 'prepared the settlement', SETTLEMENT_APPROVED: 'approved the settlement', SETTLEMENT_CORRECTION_APPROVED: 'approved a settlement correction', SETTLEMENT_DRAFT_DISCARDED: 'discarded a settlement draft', RESULTS_PUBLISHED: 'published the results',
  ANNOUNCEMENT_POSTED: 'posted an announcement', POST_REMOVED: 'removed a community post', COMMENT_REMOVED: 'removed a comment', COMMUNITY_MUTED: 'muted someone in the community', COMMUNITY_UNMUTED: 'unmuted someone in the community',
  PHONE_NOTIFICATIONS_ON: 'turned phone notifications on', PHONE_NOTIFICATIONS_OFF: 'turned phone notifications off',
};
const label = (a: string) => LABEL[a] ?? a.toLowerCase().replaceAll('_', ' ');
const isFailure = (a: string) => a.startsWith('SIGN_IN_') || a.endsWith('_REJECTED') || a.endsWith('_REMOVED') || a.includes('OVERRIDDEN') || a === 'USER_DISABLED' || a === 'COMMUNITY_MUTED';
const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

type Filters = { user: string; challenge: string; action: string; from: string; to: string; q: string };
const EMPTY: Filters = { user: '', challenge: '', action: '', from: '', to: '', q: '' };
const qs = (f: Filters, extra: Record<string, string> = {}) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)).toString();

export function ActivityLogPage() {
  const [tab, setTab] = useState<'activity' | 'errors'>('activity');
  return (
    <>
      <button className="btn ghost small" onClick={() => navigate('/admin/users')}>← People</button>
      <h1 style={{ marginTop: 8 }}>Activity log</h1>
      <p className="muted small">Everything people did in the app and what broke on the server. Entries can't be edited or deleted. Times are India time.</p>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        <button className={`btn small ${tab === 'activity' ? 'primary' : 'ghost'}`} onClick={() => setTab('activity')}>Activity</button>
        <button className={`btn small ${tab === 'errors' ? 'primary' : 'ghost'}`} onClick={() => setTab('errors')}>Errors</button>
      </div>
      {tab === 'activity' ? <Activity /> : <Errors />}
    </>
  );
}

function Activity() {
  const facets = useLoad(() => api.get<Facets>('/api/admin/activity/facets'), []);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [items, setItems] = useState<Item[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setLoading(true); setError(null);
    api.get<Page<Item>>(`/api/admin/activity?${qs(filters)}`).then((p) => { setItems(p.items); setNext(p.nextBefore); }, setError).finally(() => setLoading(false));
  }, [filters]);
  const more = async () => {
    try { const p = await api.get<Page<Item>>(`/api/admin/activity?${qs(filters, { before: String(next) })}`); setItems((x) => [...x, ...p.items]); setNext(p.nextBefore); } catch (e) { setError(e); }
  };
  const set = (k: keyof Filters, v: string, now = true) => { const f = { ...draft, [k]: v }; setDraft(f); if (now) setFilters(f); };
  const f = facets.data;

  return (
    <>
      <div className="card">
        <div className="grid2">
          <label className="small">Person<select value={draft.user} onChange={(e) => set('user', e.target.value)}>
            <option value="">Everyone</option>{f?.people.map((p) => <option key={p.userId} value={p.userId}>{p.name} (@{p.username})</option>)}</select></label>
          <label className="small">Challenge<select value={draft.challenge} onChange={(e) => set('challenge', e.target.value)}>
            <option value="">All (and app-wide)</option>{f?.challenges.map((c) => <option key={c.challengeId} value={c.challengeId}>{c.name}</option>)}</select></label>
          <label className="small">What happened<select value={draft.action} onChange={(e) => set('action', e.target.value)}>
            <option value="">Everything</option>
            <option value="SIGNED_IN,SIGNED_OUT,SIGN_IN_FAILED,SIGN_IN_LOCKED,SIGN_IN_BLOCKED">Sign-ins and sign-outs</option>
            <option value="SIGN_IN_FAILED,SIGN_IN_LOCKED,SIGN_IN_BLOCKED">Failed sign-ins only</option>
            {f?.actions.map((a) => <option key={a.action} value={a.action}>{label(a.action)} ({a.count})</option>)}</select></label>
          <label className="small">Search<input type="search" style={{ display: 'block', width: '100%' }} value={draft.q} placeholder="Name, reason, amount, IP…" onChange={(e) => set('q', e.target.value, false)}
            onKeyDown={(e) => { if (e.key === 'Enter') setFilters(draft); }} onBlur={() => setFilters(draft)} /></label>
          <label className="small">From<input type="date" value={draft.from} onChange={(e) => set('from', e.target.value)} /></label>
          <label className="small">To<input type="date" value={draft.to} onChange={(e) => set('to', e.target.value)} /></label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn ghost small" onClick={() => { setDraft(EMPTY); setFilters(EMPTY); }}>Clear filters</button>
          <a className="btn ghost small" href={`/api/admin/activity.csv?${qs(filters)}`}>Download CSV</a>
        </div>
      </div>
      <ErrorBox error={error ?? facets.error} />
      {loading && !items.length ? <Loading /> : !items.length ? <div className="empty"><p className="muted">Nothing matches these filters.</p></div> : (
        <div className="card" style={{ padding: 0 }}>
          {items.map((it) => <Row key={it.id} it={it} />)}
        </div>
      )}
      {next && <button className="btn ghost" style={{ width: '100%' }} onClick={more}>Show older</button>}
    </>
  );
}

function Row({ it }: { it: Item }) {
  const [open, setOpen] = useState(false);
  const who = it.actor ? it.actor.name : it.action.startsWith('SIGN_IN') ? 'Someone' : 'The system';
  const target = it.entity === 'USER' && it.targetName && it.actor?.userId !== Number(it.entityId) ? it.targetName : null;
  const changes = diff(it.before, it.after);
  return (
    <div className="log-row">
      <button className="log-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`log-dot${isFailure(it.action) ? ' bad' : ''}`} aria-hidden="true" />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span><b>{who}</b> {label(it.action)}{target && <> · <b>{target}</b></>}{it.challenge && <span className="muted"> · {it.challenge.name}</span>}</span>
          <span className="muted small" style={{ display: 'block' }}>
            {when(it.at)}{it.device ? ` · ${deviceName(it.device)}` : ''}{it.ip ? ` · ${it.ip}` : ''}
          </span>
          {it.reason && <span className="small" style={{ display: 'block' }}>“{it.reason}”</span>}
        </span>
        <span className="muted small" aria-hidden="true">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="log-detail small">
          <p className="muted" style={{ margin: '0 0 6px' }}>#{it.id} · {it.entity} {it.entityId}{it.actor ? ` · by @${it.actor.username}` : ''}</p>
          {changes.length > 0 ? (
            <table className="log-table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
              <tbody>{changes.map(([k, b, a]) => <tr key={k}><td>{k}</td><td>{b}</td><td>{a}</td></tr>)}</tbody></table>
          ) : <p className="muted" style={{ margin: 0 }}>No further details recorded.</p>}
          {it.device && <p className="muted" style={{ margin: '6px 0 0', overflowWrap: 'anywhere' }}>Device: {it.device}</p>}
        </div>
      )}
    </div>
  );
}

/** Flattens before/after into rows of [field, before, after], showing only what differs. */
function diff(before: unknown, after: unknown): [string, string, string][] {
  const flat = (v: unknown, pre = '', out: Record<string, string> = {}) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flat(x, pre ? `${pre}.${k}` : k, out);
    else if (pre) out[pre] = v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);
    else if (v !== null && v !== undefined) out.value = typeof v === 'string' ? v : JSON.stringify(v);
    return out;
  };
  const b = flat(before), a = flat(after);
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => (b[k] ?? '—') !== (a[k] ?? '—')).map((k) => [k, b[k] ?? '—', a[k] ?? '—']);
}

function Errors() {
  const [items, setItems] = useState<ErrorItem[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<number | null>(null);
  const load = async (before?: number) => {
    try {
      const p = await api.get<Page<ErrorItem>>(`/api/admin/errors${before ? `?before=${before}` : ''}`);
      setItems((x) => (before ? [...x, ...p.items] : p.items)); setNext(p.nextBefore);
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  if (loading) return <Loading />;
  return (
    <>
      <ErrorBox error={error} />
      {!items.length ? <div className="empty"><p className="muted">No server errors recorded. 🎉</p></div> : (
        <div className="card" style={{ padding: 0 }}>
          {items.map((e) => (
            <div key={e.id} className="log-row">
              <button className="log-head" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                <span className="log-dot bad" aria-hidden="true" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{e.message}</b>
                  <span className="muted small" style={{ display: 'block' }}>
                    {when(e.at)} · {e.source === 'REQUEST' ? `${e.method} ${e.path}` : `background: ${e.path}`}{e.user ? ` · ${e.user.name}` : ''}{e.device ? ` · ${deviceName(e.device)}` : ''}{e.ip ? ` · ${e.ip}` : ''}
                  </span>
                </span>
              </button>
              {open === e.id && e.stack && <pre className="log-detail small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{e.stack}</pre>}
            </div>
          ))}
        </div>
      )}
      {next && <button className="btn ghost" style={{ width: '100%' }} onClick={() => load(next)}>Show older</button>}
    </>
  );
}
