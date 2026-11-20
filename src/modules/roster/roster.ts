// Invitations and participants (PRD 5, 13, 14).
// - Accounts are created by an admin; an invitation links an existing account to a challenge.
// - The invitee must explicitly accept the fitness rules (and the financial rules when the challenge has money),
//   for the exact rules version they were shown.
// - The roster locks when the challenge starts: after that a join needs an Admin-approved first day (with a reason),
//   and nobody gets points or penalties for days before it.
// - Status changes (withdraw, remove, suspend, disqualify) take an effective day and a reason; history is kept and
//   past days are never rewritten. joined_on / left_on are what later phases use to decide who is on a day.
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, type Queryable } from '../../core/db.js';
import { addDays, daysBetween, isValidDate, localDay } from '../../core/dates.js';
import { AppError, conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { getChallenge, latestVersion, versions, versionOn } from '../challenges/challenges.js';
import { accessFor, requirePermission } from '../identity/permissions.js';

const today = (now: Date, tz: string) => localDay(now, tz);

/** Marks lapsed invitations EXPIRED (lazily, whenever invitations are read or used). */
async function expireLapsed(db: Queryable, challengeId: number, now: Date): Promise<void> {
  await db.query(`UPDATE invitations SET status = 'EXPIRED', updated_at = $2 WHERE challenge_id = $1 AND status = 'INVITED' AND expires_at <= $2`, [challengeId, now]);
}

export interface InviteInput { userIds: unknown; approvedJoinOn?: unknown; reason?: unknown }

export async function invite(db: Queryable, actorUserId: number, challengeId: number, input: InviteInput, now: Date): Promise<{ invited: number[] }> {
  await lockChallenge(db, challengeId);
  const ch = await getChallenge(db, challengeId);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'roster.manage');
  if (ch.status !== 'PUBLISHED') throw conflict(ch.status === 'DRAFT' ? 'Publish the challenge before inviting people.' : 'This challenge is archived.');
  const cfg = (await latestVersion(db, challengeId)).config;
  const day = today(now, ch.timeZone);
  if (daysBetween(day, ch.endsOn) < 0) throw conflict('This challenge has ended.');
  await expireLapsed(db, challengeId, now);

  const ids = Array.isArray(input.userIds) ? [...new Set(input.userIds.map(Number))] : [];
  if (!ids.length || ids.some((x) => !Number.isSafeInteger(x) || x <= 0)) throw validation('Choose at least one person to invite.');
  if (ids.length > 500) throw validation('Invite at most 500 people at a time.');

  // Roster lock: after the start, a join needs an approved first day (today or later, within the challenge).
  const locked = cfg.registration.lockRosterAtStart && daysBetween(ch.startsOn, day) >= 0;
  let approvedJoinOn: string | null = null;
  let reason: string | null = null;
  if (locked) {
    approvedJoinOn = String(input.approvedJoinOn ?? '');
    reason = String(input.reason ?? '').trim();
    if (!isValidDate(approvedJoinOn)) throw validation(`The challenge has started, so the roster is locked. Choose the first day this person takes part (${day} or later).`);
    if (daysBetween(day, approvedJoinOn) < 0) throw validation(`A late joiner can't start before today (${day}): no points or penalties are given for earlier days.`);
    if (daysBetween(approvedJoinOn, ch.endsOn) < 0) throw validation('The first day must be within the challenge.');
    if (reason.length < 5) throw validation('Give a reason for adding someone after the start (at least 5 characters).');
  }

  if (cfg.registration.maxParticipants !== null) {
    const { rows } = await db.query(
      `SELECT (SELECT count(*) FROM participants WHERE challenge_id = $1 AND status IN ('ACTIVE','SUSPENDED'))
            + (SELECT count(*) FROM invitations WHERE challenge_id = $1 AND status = 'INVITED') AS n`, [challengeId]);
    if (Number(rows[0].n) + ids.length > cfg.registration.maxParticipants) throw conflict(`This challenge is limited to ${cfg.registration.maxParticipants} participants.`);
  }

  const expiresAt = new Date(now.getTime() + cfg.registration.invitationValidDays * 86_400_000);
  const invited: number[] = [];
  for (const userId of ids) {
    const u = await db.query(`SELECT username, status FROM users WHERE user_id = $1`, [userId]);
    if (!u.rows[0]) throw notFound(`User ${userId} not found.`);
    if (u.rows[0].status !== 'ACTIVE') throw conflict(`${u.rows[0].username}'s account is disabled.`);
    const p = await db.query(`SELECT status FROM participants WHERE challenge_id = $1 AND user_id = $2`, [challengeId, userId]);
    if (p.rows[0]) throw conflict(`${u.rows[0].username} is already on the roster (${p.rows[0].status.toLowerCase()}).`);
    const open = await db.query(`SELECT 1 FROM invitations WHERE challenge_id = $1 AND user_id = $2 AND status = 'INVITED'`, [challengeId, userId]);
    if (open.rows[0]) throw conflict(`${u.rows[0].username} already has an open invitation.`);
    const { rows } = await db.query(
      `INSERT INTO invitations (challenge_id, user_id, status, invited_by, invited_at, expires_at, approved_join_on, approval_reason, updated_at)
       VALUES ($1,$2,'INVITED',$3,$4,$5,$6,$7,$4) RETURNING invitation_id`,
      [challengeId, userId, actorUserId, now, expiresAt, approvedJoinOn, reason]);
    const invitationId = Number(rows[0].invitation_id);
    invited.push(invitationId);
    await writeAudit(db, now, { actorUserId, challengeId, action: locked ? 'LATE_JOIN_INVITED' : 'PARTICIPANT_INVITED', entity: 'INVITATION', entityId: invitationId,
      reason, after: { userId, expiresAt: expiresAt.toISOString(), approvedJoinOn } });
  }
  return { invited };
}

async function invitationForAdmin(db: Queryable, actorUserId: number, invitationId: number) {
  const { rows } = await db.query(`SELECT * FROM invitations WHERE invitation_id = $1 FOR UPDATE`, [invitationId]);
  if (!rows[0]) throw notFound('Invitation not found.');
  requirePermission(await accessFor(db, actorUserId, Number(rows[0].challenge_id)), 'roster.manage');
  return rows[0];
}

export async function revokeInvitation(db: Queryable, actorUserId: number, invitationId: number, now: Date): Promise<void> {
  const inv = await invitationForAdmin(db, actorUserId, invitationId);
  if (inv.status !== 'INVITED' && inv.status !== 'EXPIRED') throw conflict(`This invitation is already ${inv.status.toLowerCase()}.`);
  await db.query(`UPDATE invitations SET status = 'REVOKED', updated_at = $2 WHERE invitation_id = $1`, [invitationId, now]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(inv.challenge_id), action: 'INVITATION_REVOKED', entity: 'INVITATION', entityId: invitationId, before: { status: inv.status } });
}

/** Re-opens an expired invitation (or extends an open one) for another validity period. */
export async function resendInvitation(db: Queryable, actorUserId: number, invitationId: number, now: Date): Promise<void> {
  const inv = await invitationForAdmin(db, actorUserId, invitationId);
  const challengeId = Number(inv.challenge_id);
  await lockChallenge(db, challengeId);
  if (inv.status !== 'INVITED' && inv.status !== 'EXPIRED') throw conflict(`This invitation is ${inv.status.toLowerCase()}; send a new one instead.`);
  if (inv.status === 'EXPIRED') {
    const open = await db.query(`SELECT 1 FROM invitations WHERE challenge_id = $1 AND user_id = $2 AND status = 'INVITED'`, [challengeId, inv.user_id]);
    if (open.rows[0]) throw conflict('This person already has another open invitation.');
  }
  const cfg = (await latestVersion(db, challengeId)).config;
  const expiresAt = new Date(now.getTime() + cfg.registration.invitationValidDays * 86_400_000);
  await db.query(`UPDATE invitations SET status = 'INVITED', expires_at = $2, updated_at = $3 WHERE invitation_id = $1`, [invitationId, expiresAt, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'INVITATION_RESENT', entity: 'INVITATION', entityId: invitationId,
    before: { status: inv.status, expiresAt: inv.expires_at.toISOString() }, after: { status: 'INVITED', expiresAt: expiresAt.toISOString() } });
}

export interface AcceptInput { rulesVersionNo: unknown; acceptFitnessRules: unknown; acceptFinancialRules?: unknown }

/** The invitee accepts: they must agree to the rules version they were shown. Creates the ACTIVE participant. */
export async function accept(db: Queryable, userId: number, invitationId: number, input: AcceptInput, now: Date): Promise<{ participantId: number; joinedOn: string }> {
  const { rows } = await db.query(`SELECT * FROM invitations WHERE invitation_id = $1`, [invitationId]);
  const inv0 = rows[0];
  if (!inv0 || Number(inv0.user_id) !== userId) throw notFound('Invitation not found.');
  const challengeId = Number(inv0.challenge_id);
  await lockChallenge(db, challengeId);
  const inv = (await db.query(`SELECT * FROM invitations WHERE invitation_id = $1 FOR UPDATE`, [invitationId])).rows[0];
  if (inv.status === 'INVITED' && inv.expires_at <= now) {
    await db.query(`UPDATE invitations SET status = 'EXPIRED', updated_at = $2 WHERE invitation_id = $1`, [invitationId, now]);
    throw new AppError('CONFLICT', 'This invitation has expired. Ask an admin to send it again.');
  }
  if (inv.status !== 'INVITED') throw conflict(`This invitation is ${inv.status.toLowerCase()}.`);
  const ch = await getChallenge(db, challengeId);
  if (ch.status !== 'PUBLISHED') throw conflict('This challenge is not open.');

  const all = await versions(db, challengeId);
  const latest = all[all.length - 1]!;
  if (Number(input.rulesVersionNo) !== latest.versionNo) throw conflict('The rules have changed since you opened them. Please read the current rules and accept again.');
  if (input.acceptFitnessRules !== true) throw validation('You must accept the challenge rules to join.');
  const money = latest.config.finance.enabled;
  if (money && input.acceptFinancialRules !== true) throw validation('You must accept the payment and fine rules to join.');

  const day = today(now, ch.timeZone);
  if (daysBetween(day, ch.endsOn) < 0) throw conflict('This challenge has ended.');
  let joinedOn: string;
  if (daysBetween(ch.startsOn, day) < 0) joinedOn = ch.startsOn; // before the start: from day one
  else {
    const cfgNow = versionOn(all, day).config;
    if (cfgNow.registration.lockRosterAtStart) {
      if (!inv.approved_join_on) throw conflict('The challenge has started and the roster is locked. An admin must approve your first day.');
      // Never retroactive: if the approved first day has passed, the first day becomes today.
      joinedOn = daysBetween(day, inv.approved_join_on) >= 0 ? inv.approved_join_on : day;
    } else joinedOn = day;
  }

  const { rows: pr } = await db.query(
    `INSERT INTO participants (challenge_id, user_id, invitation_id, status, joined_on, rules_version_no, fitness_rules_accepted_at, financial_rules_accepted_at, created_at, updated_at)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$6,$6) ON CONFLICT (challenge_id, user_id) DO NOTHING RETURNING participant_id`,
    [challengeId, userId, invitationId, joinedOn, latest.versionNo, now, money ? now : null]);
  if (!pr[0]) throw conflict('You are already on this challenge\'s roster.');
  const participantId = Number(pr[0].participant_id);
  await db.query(`UPDATE invitations SET status = 'ACCEPTED', responded_at = $2, updated_at = $2 WHERE invitation_id = $1`, [invitationId, now]);
  await db.query(`INSERT INTO participant_status_history (participant_id, from_status, to_status, effective_on, reason, actor_user_id, at) VALUES ($1, NULL, 'ACTIVE', $2, 'Accepted invitation', $3, $4)`,
    [participantId, joinedOn, userId, now]);
  await writeAudit(db, now, { actorUserId: userId, challengeId, action: 'INVITATION_ACCEPTED', entity: 'PARTICIPANT', entityId: participantId,
    after: { invitationId, joinedOn, rulesVersionNo: latest.versionNo, financialRulesAccepted: money } });
  return { participantId, joinedOn };
}

export async function decline(db: Queryable, userId: number, invitationId: number, now: Date): Promise<void> {
  const { rows } = await db.query(`SELECT * FROM invitations WHERE invitation_id = $1 FOR UPDATE`, [invitationId]);
  const inv = rows[0];
  if (!inv || Number(inv.user_id) !== userId) throw notFound('Invitation not found.');
  if (inv.status !== 'INVITED') throw conflict(`This invitation is ${inv.status.toLowerCase()}.`);
  await db.query(`UPDATE invitations SET status = 'DECLINED', responded_at = $2, updated_at = $2 WHERE invitation_id = $1`, [invitationId, now]);
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(inv.challenge_id), action: 'INVITATION_DECLINED', entity: 'INVITATION', entityId: invitationId });
}

export async function myInvitations(db: Queryable, userId: number, now: Date): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT i.invitation_id, i.challenge_id, i.expires_at, i.approved_join_on, c.name, c.starts_on, c.ends_on
       FROM invitations i JOIN challenges c USING (challenge_id)
      WHERE i.user_id = $1 AND i.status = 'INVITED' AND i.expires_at > $2 AND c.status = 'PUBLISHED' ORDER BY c.starts_on`, [userId, now]);
  return rows.map((r) => ({ invitationId: Number(r.invitation_id), challengeId: Number(r.challenge_id), name: r.name, startsOn: r.starts_on, endsOn: r.ends_on,
    expiresAt: r.expires_at.toISOString(), approvedJoinOn: r.approved_join_on }));
}

export async function listInvitations(db: Queryable, actorUserId: number, challengeId: number, now: Date): Promise<unknown[]> {
  requirePermission(await accessFor(db, actorUserId, challengeId), 'roster.manage');
  await expireLapsed(db, challengeId, now);
  const { rows } = await db.query(
    `SELECT i.*, u.username, u.display_name FROM invitations i JOIN users u USING (user_id) WHERE i.challenge_id = $1 ORDER BY i.invited_at DESC, i.invitation_id DESC`, [challengeId]);
  return rows.map((r) => ({ invitationId: Number(r.invitation_id), userId: Number(r.user_id), username: r.username, displayName: r.display_name, status: r.status,
    invitedAt: r.invited_at.toISOString(), expiresAt: r.expires_at.toISOString(), respondedAt: r.responded_at?.toISOString() ?? null, approvedJoinOn: r.approved_join_on }));
}

/** The roster. Admins see everyone; participants see fellow participants' display names and status only. */
export async function listParticipants(db: Queryable, actorUserId: number, challengeId: number): Promise<unknown[]> {
  const access = await accessFor(db, actorUserId, challengeId);
  const admin = access.permissions.has('challenge.view_admin');
  if (!admin) {
    const me = await db.query(`SELECT 1 FROM participants WHERE challenge_id = $1 AND user_id = $2`, [challengeId, actorUserId]);
    if (!me.rows[0]) throw forbidden();
  }
  const { rows } = await db.query(
    `SELECT p.*, u.username, u.display_name FROM participants p JOIN users u USING (user_id) WHERE p.challenge_id = $1 ORDER BY u.display_name`, [challengeId]);
  return rows.map((r) => admin
    ? { participantId: Number(r.participant_id), userId: Number(r.user_id), username: r.username, displayName: r.display_name, status: r.status,
        joinedOn: r.joined_on, leftOn: r.left_on, rulesVersionNo: r.rules_version_no, acceptedAt: r.fitness_rules_accepted_at.toISOString() }
    : { participantId: Number(r.participant_id), displayName: r.display_name, status: r.status });
}

const TRANSITIONS: Record<string, string[]> = {
  ACTIVE: ['SUSPENDED', 'WITHDRAWN', 'REMOVED', 'DISQUALIFIED'],
  SUSPENDED: ['ACTIVE', 'WITHDRAWN', 'REMOVED', 'DISQUALIFIED'],
  DISQUALIFIED: ['ACTIVE'], // reversal: Super Admin only (below)
  WITHDRAWN: [], REMOVED: [], COMPLETED: [],
};
const LEAVING = new Set(['WITHDRAWN', 'REMOVED', 'DISQUALIFIED']);

export interface StatusChange { toStatus: unknown; effectiveOn: unknown; reason: unknown; financialOutcome?: unknown }

/**
 * Changes a participant's status from an effective day. For a leaving status, the effective day is the first day
 * they no longer take part (left_on = the day before). Never earlier than today: past days are not rewritten.
 */
export async function changeStatus(db: Queryable, actorUserId: number, participantId: number, input: StatusChange, now: Date): Promise<void> {
  const { rows } = await db.query(`SELECT * FROM participants WHERE participant_id = $1`, [participantId]);
  if (!rows[0]) throw notFound('Participant not found.');
  const challengeId = Number(rows[0].challenge_id);
  await lockChallenge(db, challengeId);
  const p = (await db.query(`SELECT * FROM participants WHERE participant_id = $1 FOR UPDATE`, [participantId])).rows[0];
  const access = await accessFor(db, actorUserId, challengeId);
  requirePermission(access, 'roster.manage');
  if (Number(p.user_id) === actorUserId) throw forbidden('You can\'t change your own participation status; another admin must do it.');
  const ch = await getChallenge(db, challengeId);

  const to = String(input.toStatus ?? '');
  if (!(TRANSITIONS[p.status] ?? []).includes(to)) throw validation(`A ${p.status.toLowerCase()} participant can't become ${to.toLowerCase() || '(nothing)'}.`);
  if (p.status === 'DISQUALIFIED' && !access.platformRoles.includes('SUPER_ADMIN')) throw forbidden('Only a Super Admin can reverse a disqualification.');
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason (at least 5 characters).');
  const effectiveOn = String(input.effectiveOn ?? '');
  if (!isValidDate(effectiveOn)) throw validation('Choose the effective day (YYYY-MM-DD).');
  const day = today(now, ch.timeZone);
  if (daysBetween(day, effectiveOn) < 0) throw validation(`The effective day can't be in the past (today is ${day}): earlier results are never rewritten.`);
  const financialOutcome = input.financialOutcome == null ? null : String(input.financialOutcome).trim().slice(0, 500) || null;

  let leftOn: string | null = p.left_on;
  if (LEAVING.has(to)) {
    // Before the person's first day, leaving means they never take part (left_on = joined_on - 1).
    leftOn = daysBetween(p.joined_on, effectiveOn) <= 0 ? addDays(p.joined_on, -1) : addDays(effectiveOn, -1);
  } else if (to === 'ACTIVE' && p.status === 'DISQUALIFIED') leftOn = null;

  await db.query(`UPDATE participants SET status = $2, left_on = $3, updated_at = $4 WHERE participant_id = $1`, [participantId, to, leftOn, now]);
  await db.query(
    `INSERT INTO participant_status_history (participant_id, from_status, to_status, effective_on, reason, financial_outcome, actor_user_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [participantId, p.status, to, effectiveOn, reason, financialOutcome, actorUserId, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'PARTICIPANT_STATUS_CHANGED', entity: 'PARTICIPANT', entityId: participantId, reason,
    before: { status: p.status, leftOn: p.left_on }, after: { status: to, effectiveOn, leftOn, financialOutcome } });
}
