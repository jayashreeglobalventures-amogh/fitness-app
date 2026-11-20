// Final settlement (PRD 11): readiness checks -> recommendation (draft) -> Super Admin approval (frozen) -> publish ->
// payouts recorded. Later corrections: a new draft that replaces the approved one only when it is approved.
// Nothing is paid automatically; ties touching prizes need a recorded admin decision.
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, type Queryable } from '../../core/db.js';
import { daysBetween, isValidDate } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { stableStringify } from '../../core/json.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { participantById } from '../checkin/days.js';
import { accountBalances, reconcileMoney } from '../finance/finance.js';
import { leaderboard, type Standing } from '../scoring/ledger.js';
import { allocatePrizes, type TieDecision } from './engine.js';

export interface Check { key: string; ok: boolean; blocking: boolean; label: string; detail?: string; link?: string }

/** What must be true before results can be approved (PRD 11 steps 1-5). */
export async function readiness(db: Queryable, challengeId: number, now: Date, actorUserId: number): Promise<{ checks: Check[]; standings: Standing[]; ready: boolean; config: any }> {
  const board = await leaderboard(db, actorUserId, challengeId, now) as { standings: Standing[] };
  const { ctx } = await reconcileMoney(db, challengeId, now);
  const cfg = ctx.cfgOn(ctx.ch.endsOn);
  const q = async (sql: string) => Number((await db.query(sql, [challengeId])).rows[0].n);
  const ended = daysBetween(ctx.ch.endsOn, ctx.today) > 0;
  const reviews = await q(`SELECT count(*)::int AS n FROM submissions WHERE challenge_id = $1 AND status IN ('PENDING_AI','PENDING_REVIEW')`);
  const exemptions = await q(`SELECT count(*)::int AS n FROM exemption_requests WHERE challenge_id = $1 AND status IN ('VOTING','ADMIN_REVIEW')`);
  const bonuses = await q(`SELECT count(*)::int AS n FROM bonus_submissions s JOIN bonus_activities a USING (activity_id) WHERE a.challenge_id = $1 AND s.status = 'PENDING' AND a.status = 'OPEN'`);
  const payments = await q(`SELECT count(*)::int AS n FROM payments WHERE challenge_id = $1 AND status = 'SUBMITTED'`);
  const refunds = await q(`SELECT count(*)::int AS n FROM refund_proposals WHERE challenge_id = $1 AND status = 'PROPOSED'`);
  const ledgerTotal = Number((await db.query(`SELECT coalesce(sum(l.amount_paise),0)::bigint AS n FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id) WHERE t.challenge_id = $1`, [challengeId])).rows[0].n);
  const bal = await accountBalances(db, challengeId);
  let owedTotal = 0, inFinePools = 0;
  for (const [a, v] of bal) { if (a.startsWith('RECEIVABLE:')) owedTotal += v; if (a.startsWith('FINE_POOL:')) inFinePools += -v; }
  const prizesSet = cfg.prizes.qualificationPoolPct !== null && cfg.prizes.topThreePct !== null && cfg.prizes.topThreeSplitPct !== null && cfg.prizes.distribution !== null;
  const cid = challengeId;
  const checks: Check[] = [
    { key: 'ended', ok: ended, blocking: true, label: 'The challenge is over (last day ended at midnight)' },
    { key: 'reviews', ok: reviews === 0, blocking: true, label: 'All evidence and appeals decided', detail: reviews ? `${reviews} waiting` : undefined, link: `/challenges/${cid}/review` },
    { key: 'exemptions', ok: exemptions === 0, blocking: true, label: 'All exemption requests decided', detail: exemptions ? `${exemptions} open` : undefined, link: `/challenges/${cid}/exemptions` },
    { key: 'bonuses', ok: bonuses === 0, blocking: true, label: 'All weekend bonus submissions decided', detail: bonuses ? `${bonuses} waiting` : undefined, link: `/challenges/${cid}/bonus` },
    { key: 'payments', ok: payments === 0, blocking: true, label: 'All reported payments checked', detail: payments ? `${payments} waiting` : undefined, link: `/challenges/${cid}/money` },
    { key: 'refunds', ok: refunds === 0, blocking: true, label: 'All refund proposals decided', detail: refunds ? `${refunds} waiting` : undefined, link: `/challenges/${cid}/money` },
    { key: 'weeks', ok: inFinePools === 0, blocking: true, label: 'Every week closed (fine pools settled)', detail: inFinePools ? `₹${inFinePools / 100} still in fine pools` : undefined },
    { key: 'ledger', ok: ledgerTotal === 0, blocking: true, label: 'Money ledger balances' },
    { key: 'prizes', ok: prizesSet, blocking: true, label: 'Prize split set in Settings → Prizes', link: `/challenges/${cid}/settings` },
    { key: 'owed', ok: owedTotal <= 0, blocking: false, label: 'Everyone has paid their contributions', detail: owedTotal > 0 ? `₹${owedTotal / 100} still owed - deducted from what those people receive` : undefined },
  ];
  return { checks, standings: board.standings, ready: checks.every((c) => c.ok || !c.blocking), config: cfg };
}

async function compute(db: Queryable, actorUserId: number, challengeId: number, now: Date, decisions: TieDecision[]) {
  const r = await readiness(db, challengeId, now, actorUserId);
  const bal = await accountBalances(db, challengeId);
  const mainPool = -(bal.get('MAIN_POOL') ?? 0);
  const yearEnd = -(bal.get('YEAR_END_POOL') ?? 0);
  // Prizes already booked by an approved settlement are back in the pool for a correction (it replaces them).
  const { rows: [inForce] } = await db.query(`SELECT snapshot FROM settlements WHERE challenge_id = $1 AND status IN ('APPROVED','PUBLISHED')`, [challengeId]);
  const booked = inForce ? (inForce.snapshot.prizes?.allocations ?? []).reduce((a: number, x: { total: number }) => a + x.total, 0) : 0;
  const bookedYearEnd = inForce ? Number(inForce.snapshot.pools?.yearEndUsed ?? 0) : 0;
  // The prize pool as it was before any approved settlement booked prizes or moved the year-end pool:
  // (main + booked - yearEndMoved) + (yearEnd + yearEndMoved) = main + booked + yearEnd.
  const pool = mainPool + booked + yearEnd;
  const prizes = allocatePrizes(r.standings.map((s) => ({ participantId: s.participantId, displayName: s.displayName, rank: s.rank, tied: s.tied, points: s.points, adherencePct: s.adherencePct, eligible: s.eligible })),
    Math.max(0, pool), r.config.prizes, decisions);
  const statements = r.standings.map((s) => {
    const prize = prizes.allocations.find((a) => a.participantId === s.participantId)?.total ?? 0;
    const prizeBefore = -(bal.get(`PRIZE_DUE:${s.participantId}`) ?? 0);
    const refund = -(bal.get(`REFUND_DUE:${s.participantId}`) ?? 0);
    const owed = Math.max(0, bal.get(`RECEIVABLE:${s.participantId}`) ?? 0);
    const alreadyPaidPrize = inForce ? Math.max(0, (inForce.snapshot.prizes?.allocations ?? []).find((a: { participantId: number }) => a.participantId === s.participantId)?.total ?? 0) - prizeBefore : 0;
    const prizeDue = Math.max(0, prize - alreadyPaidPrize);
    const setoff = Math.min(owed, prizeDue + refund);
    return { participantId: s.participantId, displayName: s.displayName, prize, prizeAlreadyPaid: alreadyPaidPrize, refund, owed, setoff, net: prizeDue + refund - setoff, stillOwesAfter: owed - setoff };
  });
  return { readiness: r, snapshot: {
    asOf: now.toISOString(), checks: r.checks, ready: r.ready, standings: r.standings,
    pools: { prizePool: pool, mainPool, yearEndUsed: yearEnd + bookedYearEnd },
    prizes, statements, tieDecisions: decisions, ranking: r.config.leaderboard.ranking, prizeSettings: r.config.prizes,
  } };
}

const tieDecisionsOf = (raw: unknown): TieDecision[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => {
    const x = d as { groupKey?: unknown; reason?: unknown; resolution?: unknown; order?: unknown };
    const reason = String(x.reason ?? '').trim();
    if (reason.length < 5) throw validation('Give a reason for each tie decision (at least 5 characters).');
    if (x.resolution === 'SPLIT_EQUALLY') return { groupKey: String(x.groupKey), reason, decision: { resolution: 'SPLIT_EQUALLY' } };
    if (x.resolution === 'MANUAL_ORDER' && Array.isArray(x.order)) return { groupKey: String(x.groupKey), reason, decision: { resolution: 'MANUAL_ORDER', order: x.order.map(Number) } };
    throw validation('Each tie decision is SPLIT_EQUALLY or MANUAL_ORDER (with the order).');
  });
};

/** Prepares (or refreshes) the draft recommendation. A correction to an approved settlement needs a reason. */
export async function prepare(db: Queryable, actorUserId: number, challengeId: number, input: { tieDecisions?: unknown; reason?: unknown }, now: Date): Promise<{ settlementId: number }> {
  await lockChallenge(db, challengeId);
  const access = await accessFor(db, actorUserId, challengeId);
  if (!access.permissions.has('payouts.prepare') && !access.permissions.has('settlement.approve')) throw forbidden();
  const decisions = tieDecisionsOf(input.tieDecisions);
  const { snapshot } = await compute(db, actorUserId, challengeId, now, decisions);
  const { rows: [draft] } = await db.query(`SELECT * FROM settlements WHERE challenge_id = $1 AND status = 'DRAFT' FOR UPDATE`, [challengeId]);
  const { rows: [inForce] } = await db.query(`SELECT * FROM settlements WHERE challenge_id = $1 AND status IN ('APPROVED','PUBLISHED')`, [challengeId]);
  const reason = String(input.reason ?? '').trim() || null;
  if (inForce && !draft && (!reason || reason.length < 5)) throw validation('Results are already approved: give the reason for this correction.');
  let settlementId: number;
  if (draft) {
    await db.query(`UPDATE settlements SET snapshot = $2, prepared_by = $3, prepared_at = $4, updated_at = $4, reason = COALESCE($5, reason) WHERE settlement_id = $1`,
      [draft.settlement_id, JSON.stringify(snapshot), actorUserId, now, reason]);
    settlementId = Number(draft.settlement_id);
  } else {
    const { rows: [v] } = await db.query(`SELECT coalesce(max(version_no), 0) + 1 AS v FROM settlements WHERE challenge_id = $1`, [challengeId]);
    const { rows } = await db.query(
      `INSERT INTO settlements (challenge_id, version_no, status, snapshot, supersedes_id, reason, prepared_by, prepared_at, updated_at) VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,$7) RETURNING settlement_id`,
      [challengeId, v.v, JSON.stringify(snapshot), inForce ? inForce.settlement_id : null, reason, actorUserId, now]);
    settlementId = Number(rows[0].settlement_id);
  }
  await writeAudit(db, now, { actorUserId, challengeId, action: 'SETTLEMENT_PREPARED', entity: 'SETTLEMENT', entityId: settlementId, reason,
    after: { ready: snapshot.ready, issues: snapshot.prizes.issues.map((i) => i.kind), tieDecisions: decisions } });
  return { settlementId };
}

/** Super Admin approval: only if ready, no open tie decisions, and nothing changed since the draft was prepared. */
export async function approve(db: Queryable, actorUserId: number, settlementId: number, input: { unallocatedReason?: unknown }, now: Date): Promise<void> {
  const s0 = (await db.query(`SELECT challenge_id FROM settlements WHERE settlement_id = $1`, [settlementId])).rows[0];
  if (!s0) throw notFound('Settlement not found.');
  const challengeId = Number(s0.challenge_id);
  await lockChallenge(db, challengeId);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'settlement.approve');
  const s = (await db.query(`SELECT * FROM settlements WHERE settlement_id = $1 FOR UPDATE`, [settlementId])).rows[0];
  if (s.status !== 'DRAFT') throw conflict(`This settlement is already ${s.status.toLowerCase()}.`);
  const fresh = await compute(db, actorUserId, challengeId, now, s.snapshot.tieDecisions ?? []);
  const blocking = fresh.snapshot.checks.filter((c: Check) => c.blocking && !c.ok);
  if (blocking.length) throw conflict(`Not ready: ${blocking.map((c: Check) => c.label.toLowerCase()).join('; ')}.`);
  const sig = (x: any) => stableStringify({ a: x.prizes.allocations, st: x.statements, p: x.pools.prizePool });
  if (sig(fresh.snapshot) !== sig(s.snapshot)) throw conflict('Something changed since this recommendation was prepared. Prepare it again, check it, then approve.');
  const ties = fresh.snapshot.prizes.issues.filter((i) => i.kind === 'TIE_NEEDS_DECISION');
  if (ties.length) throw conflict('A tie that affects prizes still needs a decision.');
  const unreason = String(input.unallocatedReason ?? '').trim();
  if (fresh.snapshot.prizes.unallocated > 0 && unreason.length < 5) throw validation(`₹${fresh.snapshot.prizes.unallocated / 100} is not allocated: record what happens to it.`);
  const { rows: [inForce] } = await db.query(`SELECT * FROM settlements WHERE challenge_id = $1 AND status IN ('APPROVED','PUBLISHED') FOR UPDATE`, [challengeId]);
  if (inForce) await db.query(`UPDATE settlements SET status = 'SUPERSEDED', updated_at = $2 WHERE settlement_id = $1`, [inForce.settlement_id, now]);
  await db.query(`UPDATE settlements SET status = 'APPROVED', approved_by = $2, approved_at = $3, updated_at = $3 WHERE settlement_id = $1`, [settlementId, actorUserId, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: inForce ? 'SETTLEMENT_CORRECTION_APPROVED' : 'SETTLEMENT_APPROVED', entity: 'SETTLEMENT', entityId: settlementId,
    reason: unreason || s.reason, after: { prizePool: fresh.snapshot.pools.prizePool, unallocated: fresh.snapshot.prizes.unallocated, supersedes: inForce?.settlement_id ?? null } });
  await reconcileMoney(db, challengeId, now); // books the prizes in the ledger
}

export async function publish(db: Queryable, actorUserId: number, settlementId: number, now: Date): Promise<void> {
  const s = (await db.query(`SELECT * FROM settlements WHERE settlement_id = $1 FOR UPDATE`, [settlementId])).rows[0];
  if (!s) throw notFound('Settlement not found.');
  requirePermission(await accessFor(db, actorUserId, Number(s.challenge_id)), 'settlement.approve');
  if (s.status !== 'APPROVED') throw conflict('Only approved results can be published.');
  await db.query(`UPDATE settlements SET status = 'PUBLISHED', published_at = $2, updated_at = $2 WHERE settlement_id = $1`, [settlementId, now]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(s.challenge_id), action: 'RESULTS_PUBLISHED', entity: 'SETTLEMENT', entityId: settlementId });
}

export async function discardDraft(db: Queryable, actorUserId: number, settlementId: number, now: Date): Promise<void> {
  const s = (await db.query(`SELECT * FROM settlements WHERE settlement_id = $1 FOR UPDATE`, [settlementId])).rows[0];
  if (!s) throw notFound('Settlement not found.');
  const access = await accessFor(db, actorUserId, Number(s.challenge_id));
  if (!access.permissions.has('payouts.prepare') && !access.permissions.has('settlement.approve')) throw forbidden();
  if (s.status !== 'DRAFT') throw conflict('Only a draft can be discarded.');
  await db.query(`UPDATE settlements SET status = 'DISCARDED', updated_at = $2 WHERE settlement_id = $1`, [settlementId, now]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(s.challenge_id), action: 'SETTLEMENT_DRAFT_DISCARDED', entity: 'SETTLEMENT', entityId: settlementId });
}

/** Records the money actually paid to a participant: their prize + refund, minus anything they still owe. */
export async function recordPayout(db: Queryable, actorUserId: number, settlementId: number, participantId: number, input: { method?: unknown; reference?: unknown; paidOn?: unknown; note?: unknown }, now: Date): Promise<{ payoutId: number; paid: number }> {
  const s = (await db.query(`SELECT * FROM settlements WHERE settlement_id = $1`, [settlementId])).rows[0];
  if (!s) throw notFound('Settlement not found.');
  const challengeId = Number(s.challenge_id);
  await lockChallenge(db, challengeId);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'payouts.record');
  if (s.status !== 'APPROVED' && s.status !== 'PUBLISHED') throw conflict('Payouts are recorded only for approved results.');
  const p = await participantById(db, participantId);
  if (p.challengeId !== challengeId) throw notFound('Participant not found.');
  if (p.userId === actorUserId) throw forbidden('You can\'t record a payout to yourself; another admin must do it.');
  const { ctx } = await reconcileMoney(db, challengeId, now);
  const bal = await accountBalances(db, challengeId);
  const prize = Math.max(0, -(bal.get(`PRIZE_DUE:${participantId}`) ?? 0));
  const refund = Math.max(0, -(bal.get(`REFUND_DUE:${participantId}`) ?? 0));
  const owed = Math.max(0, bal.get(`RECEIVABLE:${participantId}`) ?? 0);
  if (prize + refund === 0) throw conflict('Nothing is owed to this person.');
  const setoff = Math.min(owed, prize + refund);
  const paid = prize + refund - setoff;
  const method = paid === 0 ? 'NONE' : String(input.method ?? 'UPI');
  if (!['UPI', 'CASH', 'BANK_TRANSFER', 'OTHER', 'NONE'].includes(method)) throw validation('Unknown payout method.');
  const reference = String(input.reference ?? '').trim().slice(0, 60) || null;
  if (paid > 0 && method === 'UPI' && !reference) throw validation('Enter the UPI reference (UTR) of the payout.');
  const paidOn = String(input.paidOn ?? ctx.today);
  if (!isValidDate(paidOn) || daysBetween(paidOn, ctx.today) < 0) throw validation('Enter the date it was paid (not in the future).');
  const existing = await db.query(`SELECT 1 FROM payouts WHERE settlement_id = $1 AND participant_id = $2`, [settlementId, participantId]);
  if (existing.rows[0]) throw conflict('A payout for this person is already recorded for these results.');
  const { rows } = await db.query(
    `INSERT INTO payouts (settlement_id, participant_id, prize_paise, refund_paise, setoff_paise, paid_paise, method, reference, paid_on, note, recorded_by, recorded_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING payout_id`,
    [settlementId, participantId, prize, refund, setoff, paid, method, reference, paidOn, String(input.note ?? '').trim().slice(0, 500) || null, actorUserId, now]);
  const payoutId = Number(rows[0].payout_id);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'PAYOUT_RECORDED', entity: 'PAYOUT', entityId: payoutId, after: { participantId, prize, refund, setoff, paid, method, reference } });
  await reconcileMoney(db, challengeId, now);
  return { payoutId, paid };
}

/** The Results tab. Admins: readiness, the draft and the results in force, payouts. Participants: published results only. */
export async function resultsView(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const access = await accessFor(db, userId, challengeId);
  const isAdmin = access.permissions.has('challenge.view_admin');
  const me = (await db.query(`SELECT participant_id FROM participants WHERE challenge_id = $1 AND user_id = $2`, [challengeId, userId])).rows[0];
  if (!isAdmin && !me) throw forbidden();
  const { rows: list } = await db.query(`SELECT * FROM settlements WHERE challenge_id = $1 AND status IN ('DRAFT','APPROVED','PUBLISHED') ORDER BY version_no`, [challengeId]);
  const pays = (await db.query(`SELECT p.*, u.display_name FROM payouts p JOIN participants x USING (participant_id) JOIN users u ON u.user_id = x.user_id JOIN settlements s USING (settlement_id) WHERE s.challenge_id = $1 ORDER BY p.recorded_at`, [challengeId])).rows
    .map((r) => ({ payoutId: Number(r.payout_id), settlementId: Number(r.settlement_id), participantId: Number(r.participant_id), displayName: r.display_name, prize: Number(r.prize_paise), refund: Number(r.refund_paise),
      setoff: Number(r.setoff_paise), paid: Number(r.paid_paise), method: r.method, reference: r.reference, paidOn: r.paid_on }));
  const view = (r: Record<string, any>) => ({ settlementId: Number(r.settlement_id), versionNo: r.version_no, status: r.status, reason: r.reason, preparedAt: r.prepared_at.toISOString(),
    approvedAt: r.approved_at?.toISOString() ?? null, publishedAt: r.published_at?.toISOString() ?? null, snapshot: r.snapshot });
  if (isAdmin) {
    const r = await readiness(db, challengeId, now, userId);
    return {
      admin: true, checks: r.checks, ready: r.ready, settlements: list.map(view), payouts: pays,
      can: { prepare: access.permissions.has('payouts.prepare') || access.permissions.has('settlement.approve'), approve: access.permissions.has('settlement.approve'), recordPayout: access.permissions.has('payouts.record') },
    };
  }
  const pub = list.find((x) => x.status === 'PUBLISHED');
  if (!pub) return { admin: false, published: null };
  const snap = pub.snapshot;
  const pid = Number(me.participant_id);
  return {
    admin: false,
    published: {
      publishedAt: pub.published_at.toISOString(), versionNo: pub.version_no,
      standings: snap.standings.map((s: Standing) => ({ rank: s.rank, displayName: s.displayName, points: s.points, adherencePct: s.adherencePct, eligible: s.eligible, me: s.participantId === pid,
        prize: snap.prizes.allocations.find((a: { participantId: number }) => a.participantId === s.participantId)?.total ?? 0 })),
      mine: snap.statements.find((s: { participantId: number }) => s.participantId === pid) ?? null,
      myPayouts: pays.filter((p) => p.participantId === pid),
      notes: snap.prizes.notes, pool: snap.pools.prizePool, prizeSettings: snap.prizeSettings,
    },
  };
}
