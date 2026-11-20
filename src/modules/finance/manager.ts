// The finance manager (owner, 21 Nov 2026): exactly one per challenge, changed only by an admin, through a handover:
//   1. An admin starts it, seeing the checks: money held, payment reports still waiting, refunds still waiting.
//      They confirm the money is being handed over.
//   2. The incoming manager confirms they RECEIVED that amount and that the accounts are settled with them.
//   3. The role moves; the old payment details (UPI ID / QR) are hidden from participants and the new manager is asked
//      to enter theirs.
// Everything is audited. When there is no finance manager yet, the same flow appoints the first one (amount ₹0).
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, type Queryable } from '../../core/db.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { accountBalances, reconcileMoney } from './finance.js';

async function checks(db: Queryable, challengeId: number, now: Date) {
  await reconcileMoney(db, challengeId, now);
  const bal = await accountBalances(db, challengeId);
  const q = async (sql: string) => Number((await db.query(sql, [challengeId])).rows[0].n);
  return {
    cashHeld: bal.get('CASH') ?? 0,
    pendingPayments: await q(`SELECT count(*)::int AS n FROM payments WHERE challenge_id = $1 AND status = 'SUBMITTED'`),
    pendingRefunds: await q(`SELECT count(*)::int AS n FROM refund_proposals WHERE challenge_id = $1 AND status = 'PROPOSED'`),
  };
}

const current = async (db: Queryable, challengeId: number) =>
  (await db.query(`SELECT r.user_id, u.display_name, u.username FROM challenge_roles r JOIN users u USING (user_id) WHERE r.challenge_id = $1 AND r.role = 'FINANCE_ADMIN'`, [challengeId])).rows[0] ?? null;

/** What an admin sees before (and while) changing the finance manager. */
export async function financeManagerView(db: Queryable, actorUserId: number, challengeId: number, now: Date): Promise<unknown> {
  const access = await accessFor(db, actorUserId, challengeId);
  if (!access.permissions.has('challenge.view_admin')) throw forbidden();
  const cur = await current(db, challengeId);
  const c = await checks(db, challengeId, now);
  const { rows: [h] } = await db.query(
    `SELECT h.*, t.display_name AS to_name, t.username AS to_username FROM finance_handovers h JOIN users t ON t.user_id = h.to_user_id WHERE h.challenge_id = $1 AND h.status = 'PENDING'`, [challengeId]);
  const { rows: history } = await db.query(
    `SELECT h.*, f.display_name AS from_name, t.display_name AS to_name FROM finance_handovers h LEFT JOIN users f ON f.user_id = h.from_user_id JOIN users t ON t.user_id = h.to_user_id
      WHERE h.challenge_id = $1 AND h.status <> 'PENDING' ORDER BY h.handover_id DESC LIMIT 20`, [challengeId]);
  return {
    current: cur ? { userId: Number(cur.user_id), displayName: cur.display_name, username: cur.username } : null,
    checks: { cashHeld: c.cashHeld / 100, pendingPayments: c.pendingPayments, pendingRefunds: c.pendingRefunds },
    pending: h ? { handoverId: Number(h.handover_id), toUserId: Number(h.to_user_id), toName: h.to_name, toUsername: h.to_username, cashHeld: Number(h.cash_held_paise) / 100,
      initiatedAt: h.initiated_at.toISOString(), adminNote: h.admin_note } : null,
    history: history.map((x) => ({ handoverId: Number(x.handover_id), from: x.from_name, to: x.to_name, status: x.status, cashHeld: Number(x.cash_held_paise) / 100,
      received: x.received_paise === null ? null : Number(x.received_paise) / 100, acceptedAt: x.accepted_at?.toISOString() ?? null, cancelReason: x.cancel_reason })),
    canChange: access.permissions.has('finance.manager.assign'),
  };
}

export async function startHandover(db: Queryable, actorUserId: number, challengeId: number, input: { toUserId: unknown; confirmHandedOver: unknown; note?: unknown }, now: Date): Promise<{ handoverId: number }> {
  await lockChallenge(db, challengeId);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'finance.manager.assign');
  const toUserId = Number(input.toUserId);
  const u = (await db.query(`SELECT status FROM users WHERE user_id = $1`, [toUserId])).rows[0];
  if (!u) throw notFound('User not found.');
  if (u.status !== 'ACTIVE') throw conflict('That account is disabled.');
  if (toUserId === actorUserId) throw forbidden('An admin can\'t appoint themselves as finance manager; another admin must.');
  const cur = await current(db, challengeId);
  if (cur && Number(cur.user_id) === toUserId) throw conflict('That person is already the finance manager.');
  const open = await db.query(`SELECT 1 FROM finance_handovers WHERE challenge_id = $1 AND status = 'PENDING'`, [challengeId]);
  if (open.rows[0]) throw conflict('A handover is already waiting for the new finance manager. Cancel it first.');
  const c = await checks(db, challengeId, now);
  if (cur && input.confirmHandedOver !== true) throw validation(`Confirm that the money held (₹${(c.cashHeld / 100).toLocaleString('en-IN')}) and the records are being handed over.`);
  const note = String(input.note ?? '').trim().slice(0, 1000) || null;
  const { rows } = await db.query(
    `INSERT INTO finance_handovers (challenge_id, from_user_id, to_user_id, status, cash_held_paise, pending_payments, pending_refunds, admin_note, initiated_by, initiated_at, updated_at)
     VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8,$9,$9) RETURNING handover_id`,
    [challengeId, cur ? cur.user_id : null, toUserId, c.cashHeld, c.pendingPayments, c.pendingRefunds, note, actorUserId, now]);
  const handoverId = Number(rows[0].handover_id);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'FINANCE_HANDOVER_STARTED', entity: 'FINANCE_HANDOVER', entityId: handoverId, reason: note,
    after: { from: cur ? Number(cur.user_id) : null, to: toUserId, cashHeldPaise: c.cashHeld, pendingPayments: c.pendingPayments, pendingRefunds: c.pendingRefunds } });
  return { handoverId };
}

export async function cancelHandover(db: Queryable, actorUserId: number, handoverId: number, reasonRaw: unknown, now: Date): Promise<void> {
  const h = (await db.query(`SELECT * FROM finance_handovers WHERE handover_id = $1 FOR UPDATE`, [handoverId])).rows[0];
  if (!h) throw notFound('Handover not found.');
  requirePermission(await accessFor(db, actorUserId, Number(h.challenge_id)), 'finance.manager.assign');
  if (h.status !== 'PENDING') throw conflict('This handover is no longer open.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason (at least 5 characters).');
  await db.query(`UPDATE finance_handovers SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = $3, cancel_reason = $4, updated_at = $3 WHERE handover_id = $1`, [handoverId, actorUserId, now, reason]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(h.challenge_id), action: 'FINANCE_HANDOVER_CANCELLED', entity: 'FINANCE_HANDOVER', entityId: handoverId, reason });
}

/** What the incoming manager sees (and only they, or admins). */
export async function handoverForMe(db: Queryable, userId: number, handoverId: number): Promise<unknown> {
  const { rows: [h] } = await db.query(
    `SELECT h.*, c.name AS challenge_name, f.display_name AS from_name FROM finance_handovers h JOIN challenges c USING (challenge_id) LEFT JOIN users f ON f.user_id = h.from_user_id WHERE h.handover_id = $1`, [handoverId]);
  if (!h) throw notFound('Handover not found.');
  const access = await accessFor(db, userId, Number(h.challenge_id));
  if (Number(h.to_user_id) !== userId && !access.permissions.has('challenge.view_admin')) throw notFound('Handover not found.');
  return {
    handoverId: Number(h.handover_id), challengeId: Number(h.challenge_id), challengeName: h.challenge_name, status: h.status, fromName: h.from_name,
    cashHeld: Number(h.cash_held_paise) / 100, pendingPayments: h.pending_payments, pendingRefunds: h.pending_refunds, adminNote: h.admin_note,
    forMe: Number(h.to_user_id) === userId,
  };
}

/** The incoming manager confirms receipt of the amount and that the accounts are settled; the role moves to them. */
export async function acceptHandover(db: Queryable, userId: number, handoverId: number, input: { receivedAmount: unknown; accountsSettled: unknown; statement?: unknown }, now: Date): Promise<void> {
  const h0 = (await db.query(`SELECT challenge_id FROM finance_handovers WHERE handover_id = $1`, [handoverId])).rows[0];
  if (!h0) throw notFound('Handover not found.');
  const challengeId = Number(h0.challenge_id);
  await lockChallenge(db, challengeId);
  const h = (await db.query(`SELECT * FROM finance_handovers WHERE handover_id = $1 FOR UPDATE`, [handoverId])).rows[0];
  if (Number(h.to_user_id) !== userId) throw notFound('Handover not found.');
  if (h.status !== 'PENDING') throw conflict('This handover is no longer open.');
  const received = Math.round(Number(String(input.receivedAmount ?? '').replace(/[,\s₹]/g, '')) * 100);
  if (!Number.isFinite(received) || received !== Number(h.cash_held_paise)) {
    throw validation(`Enter the amount you received. It must match the amount being handed over (₹${(Number(h.cash_held_paise) / 100).toLocaleString('en-IN')}); if it doesn't, don't accept - ask the admin.`);
  }
  if (input.accountsSettled !== true) throw validation('Confirm that the accounts have been settled with you.');
  const statement = String(input.statement ?? '').trim().slice(0, 1000) || null;
  await db.query(`DELETE FROM challenge_roles WHERE challenge_id = $1 AND role = 'FINANCE_ADMIN'`, [challengeId]);
  await db.query(`INSERT INTO challenge_roles (challenge_id, user_id, role, granted_by, granted_at) VALUES ($1,$2,'FINANCE_ADMIN',$3,$4)`, [challengeId, userId, h.initiated_by, now]);
  await db.query(`UPDATE finance_handovers SET status = 'ACCEPTED', received_paise = $2, accept_statement = $3, accepted_at = $4, updated_at = $4 WHERE handover_id = $1`,
    [handoverId, received, statement, now]);
  // The previous manager's UPI ID / QR must not be used any more.
  await db.query(`UPDATE payment_settings SET needs_update = true, updated_at = $2 WHERE challenge_id = $1`, [challengeId, now]);
  await writeAudit(db, now, { actorUserId: userId, challengeId, action: 'FINANCE_HANDOVER_ACCEPTED', entity: 'FINANCE_HANDOVER', entityId: handoverId, reason: statement,
    after: { from: h.from_user_id === null ? null : Number(h.from_user_id), to: userId, receivedPaise: received, accountsSettled: true } });
}
