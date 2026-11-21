// Money in the app (PRD 9): payment details (UPI ID / QR), manual payments confirmed by a Finance Admin, the ledger
// (reconciled from facts, append-only), statements, the finance dashboard, and refunds (Finance Admin proposes, a
// Super Admin approves). Money never affects points (separate engine, separate tables).
import type pg from 'pg';
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, withTx, type Queryable } from '../../core/db.js';
import { addDays, daysBetween, isValidDate, weekdayOf, type Period } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { stableStringify } from '../../core/json.js';
import { storeImage } from '../../core/media.js';
import { contributionFor } from '../challenges/config.js';
import { challengeContext, participantById, participantDays, participantOf, type ChallengeContext } from '../checkin/days.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { classify } from '../scoring/ledger.js';
import { balances, money, type DesiredTx, type Line } from './engine.js';

// ---------- the ledger ----------

async function desired(db: Queryable, ctx: ChallengeContext, challengeId: number, now: Date): Promise<DesiredTx[]> {
  const { rows } = await db.query(`SELECT * FROM participants WHERE challenge_id = $1 ORDER BY participant_id`, [challengeId]);
  const participants = [];
  for (const r of rows) {
    const p = { participantId: Number(r.participant_id), challengeId, userId: Number(r.user_id), status: r.status, joinedOn: r.joined_on, leftOn: r.left_on };
    const days = await participantDays(db, ctx, p, now);
    participants.push({ participantId: p.participantId, joinedOn: p.joinedOn, leftOn: p.leftOn, classes: Object.fromEntries(days.map((d) => [d.day, classify(d)])) });
  }
  const pays = await db.query(`SELECT payment_id, participant_id, period_no, amount_paise, paid_on FROM payments WHERE challenge_id = $1 AND status = 'CONFIRMED'`, [challengeId]);
  const refs = await db.query(`SELECT refund_id, participant_id, amount_paise FROM refund_proposals WHERE challenge_id = $1 AND status = 'APPROVED'`, [challengeId]);
  const { rows: [st] } = await db.query(`SELECT settlement_id, snapshot FROM settlements WHERE challenge_id = $1 AND status IN ('APPROVED','PUBLISHED')`, [challengeId]);
  const pos = await db.query(`SELECT p.* FROM payouts p JOIN settlements s USING (settlement_id) WHERE s.challenge_id = $1`, [challengeId]);
  return money({
    periods: ctx.periods, cfgOn: ctx.cfgOn, participants,
    payments: pays.rows.map((r) => ({ paymentId: Number(r.payment_id), participantId: Number(r.participant_id), periodNo: r.period_no, amount: Number(r.amount_paise), paidOn: r.paid_on })),
    refunds: refs.rows.map((r) => ({ refundId: Number(r.refund_id), participantId: Number(r.participant_id), amount: Number(r.amount_paise) })),
    settlement: st ? { settlementId: Number(st.settlement_id), yearEndUsed: Number(st.snapshot.pools?.yearEndUsed ?? 0),
      prizes: (st.snapshot.prizes?.allocations ?? []).map((a: { participantId: number; total: number }) => ({ participantId: a.participantId, amount: a.total })) } : null,
    payouts: pos.rows.map((r) => ({ payoutId: Number(r.payout_id), participantId: Number(r.participant_id), prize: Number(r.prize_paise), refund: Number(r.refund_paise),
      setoff: Number(r.setoff_paise), paid: Number(r.paid_paise), paidOn: r.paid_on })),
  });
}

/** Appends to the money ledger whatever differs from what the facts say (reversals, never edits). Idempotent. */
export async function reconcileMoney(db: Queryable, challengeId: number, now: Date): Promise<{ appended: number; ctx: ChallengeContext }> {
  await lockChallenge(db, challengeId);
  const ctx = await challengeContext(db, challengeId, now);
  const want = new Map((await desired(db, ctx, challengeId, now)).map((t) => [t.baseKey, t]));
  const { rows: txs } = await db.query(`SELECT * FROM ledger_transactions WHERE challenge_id = $1 ORDER BY transaction_id`, [challengeId]);
  const { rows: lines } = await db.query(
    `SELECT l.transaction_id, l.account, l.amount_paise FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id) WHERE t.challenge_id = $1 ORDER BY l.line_id`, [challengeId]);
  const linesOf = new Map<number, Line[]>();
  for (const l of lines) linesOf.set(Number(l.transaction_id), [...(linesOf.get(Number(l.transaction_id)) ?? []), { account: l.account, amount: Number(l.amount_paise) }]);
  const byKey = new Map<string, Record<string, any>[]>();
  for (const t of txs) byKey.set(t.base_key, [...(byKey.get(t.base_key) ?? []), t]);
  const canon = (ls: Line[]) => stableStringify([...ls].sort((a, b) => a.account.localeCompare(b.account) || a.amount - b.amount));
  let appended = 0;
  const insert = async (t: { baseKey: string; type: string; participantId: number | null; periodNo: number | null; day: string | null; origin: unknown; lines: Line[] }, kind: 'ENTRY' | 'REVERSAL', reverses: number | null, seq: number) => {
    const { rows } = await db.query(
      `INSERT INTO ledger_transactions (challenge_id, participant_id, period_no, base_key, idem_key, type, kind, reverses_transaction_id, day, origin, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (idem_key) DO NOTHING RETURNING transaction_id`,
      [challengeId, t.participantId, t.periodNo, t.baseKey, `${t.baseKey}#${seq}`, t.type, kind, reverses, t.day, JSON.stringify(t.origin), now]);
    if (!rows[0]) return;
    for (const l of t.lines) await db.query(`INSERT INTO ledger_lines (transaction_id, account, amount_paise) VALUES ($1,$2,$3)`, [rows[0].transaction_id, l.account, l.amount]);
    appended++;
  };
  for (const key of new Set([...want.keys(), ...byKey.keys()])) {
    const hist = byKey.get(key) ?? [];
    const reversed = new Set(hist.filter((h) => h.kind === 'REVERSAL').map((h) => Number(h.reverses_transaction_id)));
    const active = hist.filter((h) => h.kind === 'ENTRY' && !reversed.has(Number(h.transaction_id))).at(-1) ?? null;
    const e = want.get(key);
    if (active && e && canon(linesOf.get(Number(active.transaction_id)) ?? []) === canon(e.lines)) continue;
    let seq = hist.length;
    if (active) {
      const ls = (linesOf.get(Number(active.transaction_id)) ?? []).map((l) => ({ account: l.account, amount: -l.amount }));
      await insert({ baseKey: key, type: active.type, participantId: active.participant_id === null ? null : Number(active.participant_id), periodNo: active.period_no, day: active.day,
        origin: { reason: e ? 'recalculated' : 'no longer applies' }, lines: ls }, 'REVERSAL', Number(active.transaction_id), ++seq);
    }
    if (e) await insert(e, 'ENTRY', null, ++seq);
  }
  return { appended, ctx };
}

export async function reconcileAllMoney(pool: pg.Pool, now: Date): Promise<number> {
  const { rows } = await pool.query(`SELECT challenge_id FROM challenges WHERE status = 'PUBLISHED'`);
  let n = 0;
  for (const r of rows) n += (await withTx(pool, (tx) => reconcileMoney(tx, Number(r.challenge_id), now))).appended;
  return n;
}

export async function accountBalances(db: Queryable, challengeId: number): Promise<Map<string, number>> {
  const { rows } = await db.query(
    `SELECT l.account, sum(l.amount_paise)::bigint AS amount FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id) WHERE t.challenge_id = $1 GROUP BY l.account`, [challengeId]);
  return balances(rows.map((r) => ({ account: r.account, amount: Number(r.amount) })));
}

// ---------- due dates ----------

/** The day a week's contribution is due: the first day of the week on the configured weekday (else its first day). */
export function dueOn(period: Period, dueWeekday: string): string {
  for (let i = 0; i < period.days; i++) { const d = addDays(period.startsOn, i); if (weekdayOf(d) === dueWeekday) return d; }
  return period.startsOn;
}

// ---------- payment details (UPI ID / QR) ----------

export async function paymentSettings(db: Queryable, userId: number, challengeId: number): Promise<unknown> {
  const access = await accessFor(db, userId, challengeId);
  const p = await participantOf(db, challengeId, userId);
  const inv = await db.query(`SELECT 1 FROM invitations WHERE challenge_id = $1 AND user_id = $2 AND status = 'INVITED'`, [challengeId, userId]);
  if (!access.permissions.has('challenge.view_admin') && !p && !inv.rows[0]) throw forbidden();
  const { rows: [s] } = await db.query(`SELECT * FROM payment_settings WHERE challenge_id = $1`, [challengeId]);
  const canEdit = access.permissions.has('finance.settings');
  // After a finance-manager handover the old details are hidden from participants until the new manager saves theirs.
  const hidden = !!s?.needs_update && !canEdit;
  return { upiId: hidden ? null : s?.upi_id ?? null, payeeName: hidden ? null : s?.payee_name ?? null, qrFileId: hidden || !s?.qr_file_id ? null : Number(s.qr_file_id),
    canEdit, needsUpdate: !!s?.needs_update };
}

export async function setPaymentSettings(db: Queryable, mediaDir: string, actorUserId: number, challengeId: number, input: { upiId?: unknown; payeeName?: unknown; qr?: Buffer | null; removeQr?: unknown }, now: Date): Promise<void> {
  requirePermission(await accessFor(db, actorUserId, challengeId), 'finance.settings');
  const upiId = String(input.upiId ?? '').trim() || null;
  if (upiId && !/^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$/.test(upiId)) throw validation('Enter a UPI ID like name@bank.');
  const payeeName = String(input.payeeName ?? '').trim().slice(0, 80) || null;
  const { rows: [before] } = await db.query(`SELECT * FROM payment_settings WHERE challenge_id = $1`, [challengeId]);
  let qrFileId: number | null = before?.qr_file_id ? Number(before.qr_file_id) : null;
  if (input.qr?.length) {
    const s = await storeImage(mediaDir, actorUserId, input.qr);
    qrFileId = Number((await db.query(
      `INSERT INTO files (owner_user_id, purpose, storage_key, sha256, mime_type, bytes, uploaded_by, created_at) VALUES ($1,'PAYMENT_QR',$2,$3,$4,$5,$1,$6) RETURNING file_id`,
      [actorUserId, s.storageKey, s.sha256, s.mimeType, s.bytes, now])).rows[0].file_id);
  } else if (input.removeQr === 'true' || input.removeQr === true) qrFileId = null;
  await db.query(
    `INSERT INTO payment_settings (challenge_id, upi_id, payee_name, qr_file_id, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (challenge_id) DO UPDATE SET upi_id = EXCLUDED.upi_id, payee_name = EXCLUDED.payee_name, qr_file_id = EXCLUDED.qr_file_id, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at, needs_update = false`,
    [challengeId, upiId, payeeName, qrFileId, actorUserId, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'PAYMENT_DETAILS_CHANGED', entity: 'CHALLENGE', entityId: challengeId,
    before: before ? { upiId: before.upi_id, payeeName: before.payee_name, qrFileId: before.qr_file_id } : null, after: { upiId, payeeName, qrFileId } });
}

// ---------- payments ----------

export interface PaymentInput { periodNo: unknown; amount: unknown; utr?: unknown; paidOn: unknown; note?: unknown; method?: unknown; proof?: Buffer | null; reason?: unknown }

const paise = (rupees: unknown): number => {
  const n = Number(String(rupees ?? '').replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw validation('Enter the amount in rupees.');
  return Math.round(n * 100);
};

async function insertPayment(db: Queryable, mediaDir: string, actorUserId: number, p: { participantId: number; challengeId: number; userId: number }, ctx: ChallengeContext, input: PaymentInput, now: Date, onBehalf: boolean): Promise<{ paymentId: number }> {
  const periodNo = Number(input.periodNo);
  const period = ctx.periods.find((x) => x.periodNo === periodNo);
  if (!period) throw validation('Choose which week this payment is for.');
  const amount = paise(input.amount);
  const method = onBehalf ? String(input.method ?? 'UPI') : 'UPI';
  if (!['UPI', 'CASH', 'BANK_TRANSFER', 'OTHER'].includes(method)) throw validation('Unknown payment method.');
  const utr = String(input.utr ?? '').replace(/\s/g, '').toUpperCase() || null;
  if (method === 'UPI' && !utr) throw validation('Enter the UPI reference (UTR) from your payment app.');
  if (utr && !/^[A-Z0-9]{6,30}$/.test(utr)) throw validation('The UTR is 6–30 letters and digits (usually 12 digits).');
  const paidOn = String(input.paidOn ?? '');
  if (!isValidDate(paidOn) || daysBetween(paidOn, ctx.today) < 0) throw validation('Enter the date you paid (not in the future).');
  if (daysBetween(addDays(ctx.ch.startsOn, -30), paidOn) < 0) throw validation('That date is too long before the challenge.');
  if (utr) {
    const dup = await db.query(`SELECT 1 FROM payments WHERE challenge_id = $1 AND upper(utr) = $2 AND status IN ('SUBMITTED','CONFIRMED')`, [p.challengeId, utr]);
    if (dup.rows[0]) throw conflict('This UTR has already been reported.');
  }
  let proof: number | null = null;
  if (input.proof?.length) {
    const s = await storeImage(mediaDir, p.userId, input.proof);
    proof = Number((await db.query(
      `INSERT INTO files (owner_user_id, purpose, storage_key, sha256, mime_type, bytes, uploaded_by, created_at) VALUES ($1,'PAYMENT_PROOF',$2,$3,$4,$5,$6,$7) RETURNING file_id`,
      [p.userId, s.storageKey, s.sha256, s.mimeType, s.bytes, actorUserId, now])).rows[0].file_id);
  }
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const { rows } = await db.query(
    `INSERT INTO payments (challenge_id, participant_id, period_no, amount_paise, method, utr, paid_on, proof_file_id, note, status, submitted_by, submitted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTED',$10,$11,$11) RETURNING payment_id`,
    [p.challengeId, p.participantId, periodNo, amount, method, utr, paidOn, proof, note, actorUserId, now]);
  return { paymentId: Number(rows[0].payment_id) };
}

/** A participant reports a payment (UTR + date; the date may be in the past, e.g. paid before the app was live). */
export async function submitPayment(db: Queryable, mediaDir: string, userId: number, challengeId: number, input: PaymentInput, now: Date): Promise<{ paymentId: number }> {
  await lockChallenge(db, challengeId);
  const ctx = await challengeContext(db, challengeId, now);
  const p = await participantOf(db, challengeId, userId);
  if (!p) throw forbidden('You are not taking part in this challenge.');
  if (!ctx.cfgOn(ctx.today < ctx.ch.startsOn ? ctx.ch.startsOn : ctx.today).finance.enabled) throw conflict('This challenge has no payments.');
  const r = await insertPayment(db, mediaDir, userId, p, ctx, input, now, false);
  await writeAudit(db, now, { actorUserId: userId, challengeId, action: 'PAYMENT_REPORTED', entity: 'PAYMENT', entityId: r.paymentId, after: { periodNo: input.periodNo } });
  return r;
}

/** A Finance Admin records a payment on someone's behalf (cash, bank transfer, or a UTR they received). */
export async function recordPayment(db: Queryable, mediaDir: string, actorUserId: number, participantId: number, input: PaymentInput, now: Date): Promise<{ paymentId: number }> {
  const p = await participantById(db, participantId);
  await lockChallenge(db, p.challengeId);
  requirePermission(await accessFor(db, actorUserId, p.challengeId), 'payments.verify');
  if (p.userId === actorUserId) throw forbidden('You can\'t record your own payment; another admin must do it.');
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw validation('Say where this payment was reported (at least 5 characters).');
  const ctx = await challengeContext(db, p.challengeId, now);
  const r = await insertPayment(db, mediaDir, actorUserId, p, ctx, { ...input, note: [reason, String(input.note ?? '')].filter(Boolean).join(' · ') }, now, true);
  await writeAudit(db, now, { actorUserId, challengeId: p.challengeId, action: 'PAYMENT_RECORDED_BY_ADMIN', entity: 'PAYMENT', entityId: r.paymentId, reason, after: { participantId } });
  return r;
}

export async function decidePayment(db: Queryable, actorUserId: number, paymentId: number, input: { confirm: unknown; reason?: unknown }, now: Date): Promise<void> {
  const pay0 = (await db.query(`SELECT challenge_id FROM payments WHERE payment_id = $1`, [paymentId])).rows[0];
  if (!pay0) throw notFound('Payment not found.');
  await lockChallenge(db, Number(pay0.challenge_id));
  const pay = (await db.query(`SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE`, [paymentId])).rows[0];
  const access = await accessFor(db, actorUserId, Number(pay.challenge_id));
  const p = await participantById(db, Number(pay.participant_id));
  if (p.userId === actorUserId) throw forbidden('You can\'t confirm your own payment; another admin must do it.');
  // Two-person rule: money an admin recorded on someone's behalf is confirmed by a different admin.
  const recordedByAdmin = Number(pay.submitted_by) !== p.userId;
  if (recordedByAdmin) {
    if (Number(pay.submitted_by) === actorUserId) throw forbidden('You recorded this payment, so another admin must confirm it.');
    if (!access.permissions.has('payments.verify') && !access.permissions.has('payments.countersign')) throw forbidden();
  } else requirePermission(access, 'payments.verify');
  const confirm = input.confirm === true;
  const reason = String(input.reason ?? '').trim();
  const changing = pay.status === 'CONFIRMED' || pay.status === 'REJECTED';
  if (pay.status === 'WITHDRAWN') throw conflict('This payment report was withdrawn.');
  if ((!confirm || changing) && reason.length < 5) throw validation(changing ? 'Give a reason for changing the decision.' : 'Give a reason for rejecting (e.g. no such UTR received).');
  const status = confirm ? 'CONFIRMED' : 'REJECTED';
  if (pay.status === status) return;
  await db.query(`UPDATE payments SET status = $2, decided_by = $3, decided_at = $4, decision_reason = $5, updated_at = $4 WHERE payment_id = $1`, [paymentId, status, actorUserId, now, reason || null]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(pay.challenge_id), action: changing ? 'PAYMENT_DECISION_CHANGED' : confirm ? 'PAYMENT_CONFIRMED' : 'PAYMENT_REJECTED',
    entity: 'PAYMENT', entityId: paymentId, reason: reason || null, before: { status: pay.status }, after: { status, amountPaise: Number(pay.amount_paise), utr: pay.utr } });
}

export async function withdrawPayment(db: Queryable, userId: number, paymentId: number, now: Date): Promise<void> {
  const pay = (await db.query(`SELECT * FROM payments WHERE payment_id = $1 FOR UPDATE`, [paymentId])).rows[0];
  if (!pay) throw notFound('Payment not found.');
  const p = await participantById(db, Number(pay.participant_id));
  if (p.userId !== userId) throw notFound('Payment not found.');
  if (pay.status !== 'SUBMITTED') throw conflict('Only a payment that hasn\'t been checked yet can be withdrawn.');
  await db.query(`UPDATE payments SET status = 'WITHDRAWN', updated_at = $2 WHERE payment_id = $1`, [paymentId, now]);
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(pay.challenge_id), action: 'PAYMENT_WITHDRAWN', entity: 'PAYMENT', entityId: paymentId });
}

// ---------- refunds (withdrawal etc.) ----------

export async function proposeRefund(db: Queryable, actorUserId: number, participantId: number, input: { amount: unknown; reason: unknown }, now: Date): Promise<{ refundId: number }> {
  const p = await participantById(db, participantId);
  await lockChallenge(db, p.challengeId);
  requirePermission(await accessFor(db, actorUserId, p.challengeId), 'payouts.prepare');
  if (p.userId === actorUserId) throw forbidden('You can\'t propose a refund to yourself.');
  const amount = paise(input.amount);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw validation('Give the reason (e.g. the withdrawal decision).');
  const { rows } = await db.query(
    `INSERT INTO refund_proposals (challenge_id, participant_id, amount_paise, reason, status, proposed_by, proposed_at) VALUES ($1,$2,$3,$4,'PROPOSED',$5,$6) RETURNING refund_id`,
    [p.challengeId, participantId, amount, reason, actorUserId, now]);
  const refundId = Number(rows[0].refund_id);
  await writeAudit(db, now, { actorUserId, challengeId: p.challengeId, action: 'REFUND_PROPOSED', entity: 'REFUND', entityId: refundId, reason, after: { participantId, amountPaise: amount } });
  return { refundId };
}

export async function decideRefund(db: Queryable, actorUserId: number, refundId: number, input: { approve: unknown; reason?: unknown }, now: Date): Promise<void> {
  const r0 = (await db.query(`SELECT challenge_id FROM refund_proposals WHERE refund_id = $1`, [refundId])).rows[0];
  if (!r0) throw notFound('Refund not found.');
  await lockChallenge(db, Number(r0.challenge_id));
  const r = (await db.query(`SELECT * FROM refund_proposals WHERE refund_id = $1 FOR UPDATE`, [refundId])).rows[0];
  requirePermission(await accessFor(db, actorUserId, Number(r.challenge_id)), 'refunds.approve');
  if (Number(r.proposed_by) === actorUserId) throw forbidden('The person who proposed a refund can\'t approve it; another admin must.');
  const p = await participantById(db, Number(r.participant_id));
  if (p.userId === actorUserId) throw forbidden('You can\'t approve a refund to yourself.');
  if (r.status !== 'PROPOSED') throw conflict(`This refund is already ${r.status.toLowerCase()}.`);
  const approve = input.approve === true;
  const reason = String(input.reason ?? '').trim();
  if (!approve && reason.length < 5) throw validation('Give a reason for rejecting.');
  await db.query(`UPDATE refund_proposals SET status = $2, decided_by = $3, decided_at = $4, decision_reason = $5 WHERE refund_id = $1`,
    [refundId, approve ? 'APPROVED' : 'REJECTED', actorUserId, now, reason || null]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(r.challenge_id), action: approve ? 'REFUND_APPROVED' : 'REFUND_REJECTED', entity: 'REFUND', entityId: refundId, reason: reason || null,
    after: { participantId: Number(r.participant_id), amountPaise: Number(r.amount_paise) } });
}

// ---------- statements ----------

const rupees = (p: number) => p / 100;

/** One participant's money, week by week (for themselves or a finance viewer). */
/**
 * Fine-pool money carried over (CARRY_FORWARD), in paise: into = credited against week N's contribution; from = week M's
 * leftover went to week N. Reversals (a week recalculated after a late decision) count against their original entry.
 */
export async function carriedInto(db: Queryable, challengeId: number, participantId: number): Promise<{ into: Map<number, number>; from: Map<number, number> }> {
  const { rows } = await db.query(
    `SELECT t.period_no AS from_period, (coalesce(o.origin, t.origin)->>'intoPeriod')::int AS into_period, -sum(l.amount_paise)::bigint AS amount
       FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id) LEFT JOIN ledger_transactions o ON o.transaction_id = t.reverses_transaction_id
      WHERE t.challenge_id = $1 AND t.participant_id = $2 AND t.type = 'UNUSED_FINE_POOL' AND l.account = $3
        AND coalesce(o.origin, t.origin)->>'to' = 'CARRY_FORWARD'
      GROUP BY 1, 2`, [challengeId, participantId, `RECEIVABLE:${participantId}`]);
  const into = new Map<number, number>(), from = new Map<number, number>();
  for (const r of rows) {
    const amt = Number(r.amount);
    if (!amt) continue;
    into.set(r.into_period, (into.get(r.into_period) ?? 0) + amt);
    from.set(r.from_period, r.into_period);
  }
  return { into, from };
}

async function statementOf(db: Queryable, ctx: ChallengeContext, participantId: number) {
  const bal = await db.query(
    `SELECT l.account, sum(l.amount_paise)::bigint AS amount FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id)
      WHERE t.challenge_id = $1 AND (l.account = $2 OR l.account = $3 OR l.account LIKE $4) GROUP BY l.account`,
    [ctx.ch.challengeId, `RECEIVABLE:${participantId}`, `REFUND_DUE:${participantId}`, `FINE_POOL:${participantId}:%`]);
  const b = new Map(bal.rows.map((r) => [r.account as string, Number(r.amount)]));
  const fines = (await db.query(
    `SELECT t.period_no, sum(l.amount_paise)::bigint AS amount FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id)
      WHERE t.challenge_id = $1 AND t.type = 'FINE' AND l.account = 'MAIN_POOL' AND t.participant_id = $2 GROUP BY t.period_no`, [ctx.ch.challengeId, participantId])).rows;
  const unused = (await db.query(
    `SELECT t.period_no, sum(l.amount_paise)::bigint AS amount FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id)
      WHERE t.challenge_id = $1 AND t.type = 'UNUSED_FINE_POOL' AND l.account LIKE 'FINE_POOL:%' AND t.participant_id = $2 GROUP BY t.period_no`, [ctx.ch.challengeId, participantId])).rows;
  const dues = (await db.query(
    `SELECT t.period_no, sum(l.amount_paise)::bigint AS amount FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id)
      WHERE t.challenge_id = $1 AND t.type = 'CONTRIBUTION_DUE' AND l.account = $2 GROUP BY t.period_no`, [ctx.ch.challengeId, `RECEIVABLE:${participantId}`])).rows;
  const pays = (await db.query(`SELECT * FROM payments WHERE participant_id = $1 ORDER BY submitted_at`, [participantId])).rows;
  const carried = await carriedInto(db, ctx.ch.challengeId, participantId);
  let credit = 0; // confirmed payments beyond what earlier weeks needed (e.g. paid the full amount before a carry-over)
  const weeks = ctx.periods.map((per) => {
    const cfg = ctx.cfgOn(per.startsOn);
    const carriedIn = carried.into.get(per.periodNo) ?? 0;
    const fullDue = Number(dues.find((d) => d.period_no === per.periodNo)?.amount ?? 0);
    // What is owed for the week: the contribution, less fine-pool money carried over from an earlier week.
    const due = Math.max(0, fullDue - carriedIn);
    const paidHere = pays.filter((x) => x.period_no === per.periodNo && x.status === 'CONFIRMED').reduce((a, x) => a + Number(x.amount_paise), 0);
    const fromEarlier = fullDue ? Math.min(credit, due) : 0;
    const paid = paidHere + fromEarlier;
    if (fullDue) credit = credit - fromEarlier + Math.max(0, paidHere - (due - fromEarlier));
    const pending = pays.filter((x) => x.period_no === per.periodNo && x.status === 'SUBMITTED').reduce((a, x) => a + Number(x.amount_paise), 0);
    const dueDay = dueOn(per, cfg.finance.dueWeekday);
    const overdueFrom = addDays(dueDay, cfg.finance.graceDays + 1);
    const status = fullDue === 0 ? 'NOT_DUE' : paid >= due ? 'PAID' : pending > 0 && paid + pending >= due ? 'CHECKING'
      : daysBetween(overdueFrom, ctx.today) >= 0 ? 'OVERDUE' : daysBetween(dueDay, ctx.today) >= 0 ? 'DUE' : 'UPCOMING';
    const c = contributionFor(cfg, per.periodNo);
    return {
      periodNo: per.periodNo, startsOn: per.startsOn, endsOn: per.endsOn, dueOn: dueDay, overdueFrom,
      due: rupees(due), paid: rupees(paid), pending: rupees(pending), status, creditUsed: rupees(fromEarlier),
      finePool: fullDue ? rupees(c.finePool) : 0, fines: rupees(-Number(fines.find((f) => f.period_no === per.periodNo)?.amount ?? 0)),
      unused: rupees(Number(unused.find((f) => f.period_no === per.periodNo)?.amount ?? 0)), unusedTo: carried.from.has(per.periodNo) ? 'CARRY_FORWARD' : cfg.finance.unusedFinePool === 'CARRY_FORWARD' ? 'REFUND' : cfg.finance.unusedFinePool,
      carriedTo: carried.from.get(per.periodNo) ?? null, carriedIn: rupees(carriedIn), fullDue: rupees(fullDue),
      finePoolLeft: rupees(-(b.get(`FINE_POOL:${participantId}:${per.periodNo}`) ?? 0)),
    };
  });
  return {
    weeks,
    owed: rupees(b.get(`RECEIVABLE:${participantId}`) ?? 0),
    refundDue: rupees(-(b.get(`REFUND_DUE:${participantId}`) ?? 0)),
    payments: pays.map((x) => ({ paymentId: Number(x.payment_id), periodNo: x.period_no, amount: rupees(Number(x.amount_paise)), method: x.method, utr: x.utr, paidOn: x.paid_on,
      status: x.status, decisionReason: x.decision_reason, proofFileId: x.proof_file_id ? Number(x.proof_file_id) : null, submittedAt: x.submitted_at.toISOString() })),
  };
}

/** The signed-in participant's money in a challenge, plus the pool totals (everyone may see those). */
export async function myMoney(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const p = await participantOf(db, challengeId, userId);
  if (!p) throw forbidden('You are not taking part in this challenge.');
  const { ctx } = await reconcileMoney(db, challengeId, now);
  const bal = await accountBalances(db, challengeId);
  return { ...(await statementOf(db, ctx, p.participantId)), pools: poolsOf(bal), today: ctx.today, finance: ctx.cfgOn(ctx.today < ctx.ch.startsOn ? ctx.ch.startsOn : ctx.today).finance };
}

function poolsOf(bal: Map<string, number>) {
  let refunds = 0, receivable = 0, fineLeft = 0, prizes = 0;
  for (const [a, v] of bal) {
    if (a.startsWith('PRIZE_DUE:')) prizes += -v;
    if (a.startsWith('REFUND_DUE:')) refunds += -v;
    if (a.startsWith('RECEIVABLE:')) receivable += v;
    if (a.startsWith('FINE_POOL:')) fineLeft += -v;
  }
  return { prizePool: rupees(-(bal.get('MAIN_POOL') ?? 0)), yearEndPool: rupees(-(bal.get('YEAR_END_POOL') ?? 0)), collected: rupees(bal.get('CASH') ?? 0),
    stillOwed: rupees(receivable), refundsDue: rupees(refunds), inFinePools: rupees(fineLeft), prizesDue: rupees(prizes) };
}

/** The Finance dashboard: every participant's position, the pools, payments to check, refunds, and reconciliation. */
export async function financeOverview(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const access = await accessFor(db, userId, challengeId);
  if (!access.permissions.has('finance.view') && !access.permissions.has('refunds.approve')) throw forbidden();
  const { ctx } = await reconcileMoney(db, challengeId, now);
  const bal = await accountBalances(db, challengeId);
  const { rows: people } = await db.query(`SELECT p.participant_id, p.status, u.display_name FROM participants p JOIN users u USING (user_id) WHERE p.challenge_id = $1 ORDER BY u.display_name`, [challengeId]);
  const rows = [];
  for (const r of people) {
    const s = await statementOf(db, ctx, Number(r.participant_id));
    rows.push({ participantId: Number(r.participant_id), displayName: r.display_name, status: r.status, owed: s.owed, refundDue: s.refundDue,
      paid: Math.round(s.weeks.reduce((a, w) => a + w.paid - w.creditUsed, 0) * 100) / 100, fines: s.weeks.reduce((a, w) => a + w.fines, 0),
      overdueWeeks: s.weeks.filter((w) => w.status === 'OVERDUE').map((w) => w.periodNo), checking: s.weeks.filter((w) => w.status === 'CHECKING').map((w) => w.periodNo) });
  }
  const { rows: pays } = await db.query(
    `SELECT x.*, u.display_name, p.user_id FROM payments x JOIN participants p USING (participant_id) JOIN users u ON u.user_id = p.user_id
      WHERE x.challenge_id = $1 ORDER BY (x.status = 'SUBMITTED') DESC, x.submitted_at DESC LIMIT 200`, [challengeId]);
  const { rows: refunds } = await db.query(
    `SELECT r.*, u.display_name FROM refund_proposals r JOIN participants p USING (participant_id) JOIN users u ON u.user_id = p.user_id WHERE r.challenge_id = $1 ORDER BY r.proposed_at DESC`, [challengeId]);
  // Reconciliation: what the ledger says vs the source records.
  const { rows: [chk] } = await db.query(
    `SELECT (SELECT coalesce(sum(l.amount_paise), 0) FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id) WHERE t.challenge_id = $1)::bigint AS ledger_total,
            (SELECT coalesce(sum(amount_paise), 0) FROM payments WHERE challenge_id = $1 AND status = 'CONFIRMED')::bigint AS confirmed,
            (SELECT coalesce(sum(l.amount_paise), 0) FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id)
              WHERE t.challenge_id = $1 AND t.type = 'CONTRIBUTION_DUE' AND l.account LIKE 'RECEIVABLE:%')::bigint AS due,
            (SELECT coalesce(sum(p.paid_paise), 0) FROM payouts p JOIN settlements s USING (settlement_id) WHERE s.challenge_id = $1)::bigint AS paid_out,
            (SELECT coalesce(sum(p.setoff_paise), 0) FROM payouts p JOIN settlements s USING (settlement_id) WHERE s.challenge_id = $1)::bigint AS set_off,
            (SELECT coalesce(-sum(l.amount_paise), 0) FROM ledger_lines l JOIN ledger_transactions t USING (transaction_id)
              WHERE t.challenge_id = $1 AND t.type = 'UNUSED_FINE_POOL' AND l.account LIKE 'RECEIVABLE:%')::bigint AS carried`, [challengeId]);
  const pools = poolsOf(bal);
  const cents = (x: number) => Math.round(x * 100);
  const checks = [
    { name: 'Every entry balances (the ledger adds up to zero)', ok: Number(chk.ledger_total) === 0 },
    { name: 'Money held = confirmed payments − payouts', ok: cents(pools.collected) === Number(chk.confirmed) - Number(chk.paid_out) },
    { name: 'Owed + held = contributions due − carried-over fine money − payouts − set-offs (nothing counted twice)',
      ok: cents(pools.stillOwed + pools.collected) === Number(chk.due) - Number(chk.carried) - Number(chk.paid_out) - Number(chk.set_off) },
  ];
  return {
    pools, checks, participants: rows, periods: ctx.periods, today: ctx.today,
    canConfirm: access.permissions.has('payments.verify'), canCountersign: access.permissions.has('payments.countersign') || access.permissions.has('payments.verify'),
    canProposeRefund: access.permissions.has('payouts.prepare'), canApproveRefund: access.permissions.has('refunds.approve'),
    payments: pays.map((x) => ({ paymentId: Number(x.payment_id), participantId: Number(x.participant_id), displayName: x.display_name, mine: Number(x.user_id) === userId,
      recordedByAdmin: Number(x.submitted_by) !== Number(x.user_id), recordedByMe: Number(x.submitted_by) === userId,
      periodNo: x.period_no, amount: rupees(Number(x.amount_paise)), method: x.method, utr: x.utr, paidOn: x.paid_on, note: x.note, status: x.status,
      proofFileId: x.proof_file_id ? Number(x.proof_file_id) : null, decisionReason: x.decision_reason, submittedAt: x.submitted_at.toISOString() })),
    refunds: refunds.map((r) => ({ refundId: Number(r.refund_id), participantId: Number(r.participant_id), displayName: r.display_name, amount: rupees(Number(r.amount_paise)), reason: r.reason,
      status: r.status, proposedBy: Number(r.proposed_by), decisionReason: r.decision_reason })),
  };
}

/** Whether a user may see a payment file: QR for anyone in the challenge; proofs for their owner or finance viewers. */
export async function canSeeFinanceFile(db: Queryable, userId: number, fileId: number): Promise<boolean> {
  const qr = await db.query(`SELECT challenge_id, needs_update FROM payment_settings WHERE qr_file_id = $1`, [fileId]);
  for (const r of qr.rows) {
    const cid = Number(r.challenge_id);
    if ((await accessFor(db, userId, cid)).permissions.has('challenge.view_admin')) return true;
    if (r.needs_update) continue;
    const ok = await db.query(`SELECT 1 FROM participants WHERE challenge_id = $1 AND user_id = $2 UNION SELECT 1 FROM invitations WHERE challenge_id = $1 AND user_id = $2 AND status = 'INVITED'`, [cid, userId]);
    if (ok.rows[0]) return true;
  }
  const proof = await db.query(`SELECT challenge_id FROM payments WHERE proof_file_id = $1`, [fileId]);
  for (const r of proof.rows) if ((await accessFor(db, userId, Number(r.challenge_id))).permissions.has('finance.view')) return true;
  return false;
}
