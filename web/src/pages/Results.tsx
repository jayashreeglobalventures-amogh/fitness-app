// Results: final settlement. Admins: readiness, recommendation, tie decisions, approve / publish, payouts.
// Participants: the published results and their own statement.
import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { day, ErrorBox, Field, Loading, useLoad } from '../ui';
import type { ChallengeView } from './Challenge';

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
interface Check { key: string; ok: boolean; blocking: boolean; label: string; detail?: string; link?: string }
interface Statement { participantId: number; displayName: string; prize: number; prizeAlreadyPaid: number; refund: number; owed: number; setoff: number; net: number; stillOwesAfter: number }
interface Allocation { participantId: number; displayName: string; place: number | null; topThree: number; qualification: number; total: number }
interface Issue { kind: string; message: string; groupKey?: string; participants?: number[]; places?: number[]; options?: { resolution: string; explain: string; recommended?: boolean }[] }
interface Snapshot {
  asOf: string; checks: Check[]; ready: boolean; pools: { prizePool: number };
  standings: { participantId: number; displayName: string; rank: number; tied: boolean; points: number; adherencePct: number | null; eligible: boolean; status: string }[];
  prizes: { topThreePool: number; qualificationPool: number; allocations: Allocation[]; unallocated: number; issues: Issue[]; notes: string[] };
  statements: Statement[]; tieDecisions: { groupKey: string; reason: string; decision: { resolution: string; order?: number[] } }[];
  prizeSettings: { qualificationPoolPct: number; topThreePct: number; topThreeSplitPct: number[]; distribution: string; qualificationAdherencePct: number };
}
interface Settlement { settlementId: number; versionNo: number; status: string; reason: string | null; preparedAt: string; approvedAt: string | null; publishedAt: string | null; snapshot: Snapshot }
interface Payout { payoutId: number; settlementId: number; participantId: number; displayName: string; prize: number; refund: number; setoff: number; paid: number; method: string; reference: string | null; paidOn: string }
interface AdminView { admin: true; checks: Check[]; ready: boolean; settlements: Settlement[]; payouts: Payout[]; can: { prepare: boolean; approve: boolean; recordPayout: boolean } }
interface PublicView { admin: false; published: null | { publishedAt: string; versionNo: number; standings: { rank: number; displayName: string; points: number; adherencePct: number | null; eligible: boolean; me: boolean; prize: number }[]; mine: Statement | null; myPayouts: Payout[]; notes: string[]; pool: number } }

export function ResultsSection({ v }: { v: ChallengeView }) {
  const r = useLoad(() => api.get<AdminView | PublicView>(`/api/challenges/${v.challengeId}/results`), [v.challengeId]);
  if (r.loading && !r.data) return <Loading />;
  if (!r.data) return <ErrorBox error={r.error} />;
  return r.data.admin ? <Admin v={v} d={r.data} reload={r.reload} /> : <Public d={r.data} />;
}

function Public({ d }: { d: PublicView }) {
  if (!d.published) return <div className="card empty"><p>Final results aren't published yet.</p><p className="muted small">They come after the last day, once every check-in, payment and appeal is settled and a Super Admin approves them.</p></div>;
  const p = d.published;
  return (
    <>
      <div className="alert ok">Final results, published {new Date(p.publishedAt).toLocaleDateString('en-IN')}. Prize pool {inr(p.pool)}.</div>
      {p.mine && <StatementCard s={p.mine} payouts={p.myPayouts} title="Your settlement" />}
      <div className="card table-wrap"><table>
        <thead><tr><th>#</th><th>Name</th><th>Points</th><th>Adherence</th><th>Prize</th></tr></thead>
        <tbody>{p.standings.map((s) => (
          <tr key={s.displayName} style={s.me ? { background: 'color-mix(in srgb, var(--accent) 10%, transparent)' } : undefined}>
            <td>{s.rank}</td><td>{s.displayName}{!s.eligible && <div><span className="badge">not eligible</span></div>}</td><td>{s.points}</td>
            <td>{s.adherencePct === null ? '—' : `${s.adherencePct}%`}</td><td><b>{s.prize ? inr(s.prize) : '—'}</b></td>
          </tr>))}</tbody></table></div>
      {p.notes.length > 0 && <div className="card">{p.notes.map((n, i) => <p key={i} className="small muted">{n}</p>)}</div>}
    </>
  );
}

function StatementCard({ s, payouts, title }: { s: Statement; payouts: Payout[]; title: string }) {
  return (
    <div className="card today">
      <h3>{title}</h3>
      <dl className="kv">
        <dt>Prize</dt><dd>{inr(s.prize)}{s.prizeAlreadyPaid ? ` (${inr(s.prizeAlreadyPaid)} already paid)` : ''}</dd>
        <dt>Refund (unused fine pools, refunds)</dt><dd>{inr(s.refund)}</dd>
        {s.owed > 0 && <><dt>Contributions still unpaid</dt><dd>− {inr(s.setoff)}{s.stillOwesAfter ? ` (still owes ${inr(s.stillOwesAfter)} after this)` : ''}</dd></>}
        <dt><b>To be paid</b></dt><dd><b>{inr(s.net)}</b></dd>
      </dl>
      {payouts.map((p) => <p key={p.payoutId} className="small" style={{ marginTop: 8 }}>✅ {p.paid ? `${inr(p.paid)} paid on ${day(p.paidOn)}${p.reference ? ` · ref ${p.reference}` : ''}` : `Settled on ${day(p.paidOn)} against unpaid contributions`}</p>)}
    </div>
  );
}

function Admin({ v, d, reload }: { v: ChallengeView; d: AdminView; reload: () => void }) {
  const draft = d.settlements.find((s) => s.status === 'DRAFT');
  const inForce = d.settlements.find((s) => s.status === 'APPROVED' || s.status === 'PUBLISHED');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); reload(); } catch (e) { setError(e); } finally { setBusy(false); } };
  const prepare = (tieDecisions?: unknown) => run(() => api.post(`/api/challenges/${v.challengeId}/settlements`, { reason: reason || undefined, tieDecisions: tieDecisions ?? (draft ?? inForce)?.snapshot.tieDecisions.map((t) => ({ groupKey: t.groupKey, reason: t.reason, resolution: t.decision.resolution, order: t.decision.order })) }));
  return (
    <>
      <div className="card">
        <h3>Ready for final results?</h3>
        <ul style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
          {d.checks.map((c) => (
            <li key={c.key} className="small" style={{ padding: '4px 0' }}>{c.ok ? '✅' : c.blocking ? '❌' : '⚠️'} {c.label}{c.detail ? ` · ${c.detail}` : ''}
              {!c.ok && c.link && <> · <a href={c.link} onClick={(e) => { e.preventDefault(); navigate(c.link!); }}>open</a></>}</li>
          ))}
        </ul>
      </div>
      <ErrorBox error={error} />
      {inForce && <SettlementCard v={v} s={inForce} d={d} busy={busy} run={run} />}
      {draft && <SettlementCard v={v} s={draft} d={d} busy={busy} run={run} onPrepare={prepare} />}
      {d.can.prepare && (
        <div className="card">
          {inForce && !draft && <Field label="Reason for a correction (results are already approved)"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          <button className="btn primary" disabled={busy} onClick={() => prepare()}>{draft ? 'Refresh the recommendation' : inForce ? 'Prepare a correction' : 'Prepare the recommendation'}</button>
          <p className="muted small">A recommendation can be prepared any time to preview; approval needs every ❌ above fixed.</p>
        </div>
      )}
    </>
  );
}

function SettlementCard({ v, s, d, busy, run, onPrepare }: { v: ChallengeView; s: Settlement; d: AdminView; busy: boolean; run: (fn: () => Promise<unknown>) => void; onPrepare?: (ties: unknown) => void }) {
  const snap = s.snapshot;
  const [unallocatedReason, setUnallocatedReason] = useState('');
  const [tieReason, setTieReason] = useState('');
  const ties = snap.prizes.issues.filter((i) => i.kind === 'TIE_NEEDS_DECISION');
  const label = s.status === 'DRAFT' ? `Recommendation (draft, version ${s.versionNo})` : s.status === 'APPROVED' ? `Approved results (version ${s.versionNo}), not yet published` : `Published results (version ${s.versionNo})`;
  const name = (pid: number) => snap.standings.find((x) => x.participantId === pid)?.displayName ?? pid;
  return (
    <div className="card" style={s.status === 'DRAFT' ? { borderColor: 'var(--warn)' } : undefined}>
      <div className="spread"><h3>{label}</h3><span className={`badge ${s.status === 'DRAFT' ? 'warn' : 'ok'}`}>{s.status.toLowerCase()}</span></div>
      <p className="muted small">Prepared {new Date(s.preparedAt).toLocaleString('en-IN')}{s.reason ? ` · ${s.reason}` : ''}</p>
      <div className="stats" style={{ margin: '8px 0' }}>
        <div className="stat"><span>Prize pool</span><b>{inr(snap.pools.prizePool)}</b></div>
        <div className="stat"><span>Top three ({snap.prizeSettings.topThreePct}%)</span><b>{inr(snap.prizes.topThreePool)}</b></div>
        <div className="stat"><span>Qualifiers ({snap.prizeSettings.qualificationPoolPct}%)</span><b>{inr(snap.prizes.qualificationPool)}</b></div>
        {snap.prizes.unallocated > 0 && <div className="stat"><span>Not allocated</span><b>{inr(snap.prizes.unallocated)}</b></div>}
      </div>
      {ties.map((t) => (
        <div key={t.groupKey} className="alert warn">
          <b>Tie needs a decision.</b> {t.message}
          <ul>{t.options?.map((o) => <li key={o.resolution} className="small">{o.recommended ? <b>Recommended: </b> : null}{o.explain}</li>)}</ul>
          {s.status === 'DRAFT' && onPrepare && (<>
            <Field label="Reason for the decision"><input type="text" value={tieReason} onChange={(e) => setTieReason(e.target.value)} /></Field>
            <div className="row">
              <button className="btn small primary" disabled={busy || tieReason.trim().length < 5} onClick={() => onPrepare([...snap.tieDecisions.map((x) => ({ groupKey: x.groupKey, reason: x.reason, resolution: x.decision.resolution, order: x.decision.order })), { groupKey: t.groupKey, reason: tieReason, resolution: 'SPLIT_EQUALLY' }])}>Share equally</button>
              {t.participants && t.participants.length === 2 && <button className="btn small" disabled={busy || tieReason.trim().length < 5} onClick={() => onPrepare([...snap.tieDecisions.map((x) => ({ groupKey: x.groupKey, reason: x.reason, resolution: x.decision.resolution, order: x.decision.order })), { groupKey: t.groupKey, reason: tieReason, resolution: 'MANUAL_ORDER', order: t.participants }])}>{name(t.participants[0]!)} ahead of {name(t.participants[1]!)}</button>}
              {t.participants && t.participants.length === 2 && <button className="btn small" disabled={busy || tieReason.trim().length < 5} onClick={() => onPrepare([...snap.tieDecisions.map((x) => ({ groupKey: x.groupKey, reason: x.reason, resolution: x.decision.resolution, order: x.decision.order })), { groupKey: t.groupKey, reason: tieReason, resolution: 'MANUAL_ORDER', order: [...(t.participants ?? [])].reverse() }])}>{name(t.participants[1]!)} ahead of {name(t.participants[0]!)}</button>}
            </div>
          </>)}
        </div>
      ))}
      {snap.prizes.issues.filter((i) => i.kind !== 'TIE_NEEDS_DECISION').map((i, k) => <div key={k} className="alert warn small">{i.message}</div>)}
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Name</th><th>Points</th><th>Adh.</th><th>Prize</th><th>Refund</th><th>Unpaid</th><th>To pay</th><th /></tr></thead>
        <tbody>{snap.standings.map((st) => {
          const a = snap.prizes.allocations.find((x) => x.participantId === st.participantId)!;
          const m = snap.statements.find((x) => x.participantId === st.participantId)!;
          const paidOut = d.payouts.find((p) => p.settlementId === s.settlementId && p.participantId === st.participantId);
          return (
            <tr key={st.participantId}>
              <td>{st.rank}{st.tied && <div className="muted small">tie</div>}</td>
              <td>{st.displayName}{!st.eligible && <div><span className="badge">not eligible</span></div>}{a.place && <div className="muted small">place {a.place}: {inr(a.topThree)}</div>}</td>
              <td>{st.points}</td><td className="small">{st.adherencePct === null ? '—' : `${st.adherencePct}%`}</td>
              <td>{inr(a.total)}</td><td>{inr(m.refund)}</td><td>{m.owed ? `− ${inr(m.setoff)}` : '—'}</td><td><b>{inr(m.net)}</b></td>
              <td>{s.status !== 'DRAFT' && (paidOut ? <span className="badge ok">paid</span> : d.can.recordPayout && (m.net > 0 || m.setoff > 0) && <PayoutButton v={v} s={s} st={st} net={m.net} run={run} />)}</td>
            </tr>);
        })}</tbody>
      </table></div>
      {snap.prizes.notes.map((n, i) => <p key={i} className="small muted">{n}</p>)}
      {s.status === 'DRAFT' && d.can.approve && (
        <div className="section">
          {snap.prizes.unallocated > 0 && <Field label="What happens to the money not allocated (required)"><input type="text" value={unallocatedReason} onChange={(e) => setUnallocatedReason(e.target.value)} /></Field>}
          <div className="row">
            <button className="btn primary" disabled={busy || !snap.ready || ties.length > 0} onClick={() => confirm('Approve these final results? They are then frozen; later changes need a correction.') && run(() => api.post(`/api/settlements/${s.settlementId}/approve`, { unallocatedReason }))}>Approve final results</button>
            <button className="btn ghost" disabled={busy} onClick={() => run(() => api.post(`/api/settlements/${s.settlementId}/discard`))}>Discard draft</button>
          </div>
          {!snap.ready && <p className="muted small">Approval opens once every ❌ check above is fixed (then refresh the recommendation).</p>}
        </div>
      )}
      {s.status === 'DRAFT' && !d.can.approve && <p className="muted small">A Super Admin approves the final results.</p>}
      {s.status === 'APPROVED' && d.can.approve && <button className="btn primary" disabled={busy} onClick={() => run(() => api.post(`/api/settlements/${s.settlementId}/publish`))}>Publish results to participants</button>}
    </div>
  );
}

function PayoutButton({ v, s, st, net, run }: { v: ChallengeView; s: Settlement; st: { participantId: number; displayName: string }; net: number; run: (fn: () => Promise<unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ method: net > 0 ? 'UPI' : 'NONE', reference: '', paidOn: v.today });
  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>{net > 0 ? 'Record payout' : 'Settle'}</button>;
  return (
    <div style={{ minWidth: 200 }}>
      {net > 0 && <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="UPI">UPI</option><option value="BANK_TRANSFER">Bank</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select>}
      {net > 0 && <input type="text" placeholder="UTR / reference" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} style={{ marginTop: 4 }} />}
      <input type="date" value={f.paidOn} max={v.today} onChange={(e) => setF({ ...f, paidOn: e.target.value })} style={{ marginTop: 4 }} />
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn small primary" onClick={() => run(() => api.post(`/api/settlements/${s.settlementId}/payouts/${st.participantId}`, f))}>Save {net > 0 ? inr(net) : ''}</button>
        <button className="btn small ghost" onClick={() => setOpen(false)}>✕</button>
      </div>
    </div>
  );
}
