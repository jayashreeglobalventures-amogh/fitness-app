// Weekend bonus activities (PRD 6): optional, any format. An admin sets one up for a weekend (what to do, what to
// show); participants submit evidence during that weekend; an admin approves. Approved = +points (max per weekend in
// the settings). It never replaces or makes up for the daily target.
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, type Queryable } from '../../core/db.js';
import { addDays, daysBetween, isValidDate } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { storeImage } from '../../core/media.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { challengeContext, participantById, participantOf, participatesOn } from '../checkin/days.js';
import { weekendKeyOf } from './engine.js';

/** The weekend's days that fall inside the challenge. */
function weekendDays(key: string, startsOn: string, endsOn: string): string[] {
  return [key, addDays(key, key && new Date(`${key}T00:00:00Z`).getUTCDay() === 0 ? 6 : 1)]
    .filter((d) => daysBetween(startsOn, d) >= 0 && daysBetween(d, endsOn) >= 0);
}

export async function createActivity(db: Queryable, actorUserId: number, challengeId: number, input: { day: unknown; title: unknown; description?: unknown; evidence?: unknown }, now: Date): Promise<{ activityId: number; weekendKey: string; days: string[] }> {
  await lockChallenge(db, challengeId);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'bonus.manage');
  const ctx = await challengeContext(db, challengeId, now);
  const day = String(input.day ?? '');
  if (!isValidDate(day)) throw validation('Choose a weekend day.');
  const cfg = ctx.cfgOn(daysBetween(ctx.ch.startsOn, day) >= 0 ? day : ctx.ch.startsOn);
  if (!cfg.scoring.weekendBonus.enabled) throw conflict('Weekend bonuses are switched off in this challenge\'s settings.');
  const key = weekendKeyOf(day, cfg.scoring.weekendBonus.weekend);
  if (!key) throw validation('That day is not part of a weekend.');
  const days = weekendDays(key, ctx.ch.startsOn, ctx.ch.endsOn);
  if (!days.length) throw validation('That weekend is outside the challenge.');
  if (daysBetween(ctx.today, days[days.length - 1]!) < 0) throw validation('That weekend is already over.');
  const title = String(input.title ?? '').trim();
  if (title.length < 3 || title.length > 120) throw validation('Give the activity a title (3–120 characters).');
  const description = String(input.description ?? '').trim().slice(0, 2000);
  const evidence = String(input.evidence ?? '').trim().slice(0, 500) || 'A photo or screenshot showing the activity';
  const { rows } = await db.query(
    `INSERT INTO bonus_activities (challenge_id, weekend_key, title, description, evidence, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING activity_id`,
    [challengeId, key, title, description, evidence, actorUserId, now]);
  const activityId = Number(rows[0].activity_id);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'BONUS_ACTIVITY_CREATED', entity: 'BONUS_ACTIVITY', entityId: activityId, after: { weekendKey: key, title } });
  return { activityId, weekendKey: key, days };
}

export async function cancelActivity(db: Queryable, actorUserId: number, activityId: number, reasonRaw: unknown, now: Date): Promise<void> {
  const a = (await db.query(`SELECT * FROM bonus_activities WHERE activity_id = $1 FOR UPDATE`, [activityId])).rows[0];
  if (!a) throw notFound('Activity not found.');
  requirePermission(await accessFor(db, actorUserId, Number(a.challenge_id)), 'bonus.manage');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason (at least 5 characters). Approved bonuses for it will be reversed.');
  await db.query(`UPDATE bonus_activities SET status = 'CANCELLED', updated_at = $2 WHERE activity_id = $1`, [activityId, now]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(a.challenge_id), action: 'BONUS_ACTIVITY_CANCELLED', entity: 'BONUS_ACTIVITY', entityId: activityId, reason });
}

export async function submitBonus(db: Queryable, mediaDir: string, userId: number, activityId: number, input: { note?: unknown; image?: Buffer | null }, now: Date): Promise<{ bonusSubmissionId: number }> {
  const a = (await db.query(`SELECT * FROM bonus_activities WHERE activity_id = $1`, [activityId])).rows[0];
  if (!a || a.status !== 'OPEN') throw notFound('Activity not found.');
  const challengeId = Number(a.challenge_id);
  await lockChallenge(db, challengeId);
  const ctx = await challengeContext(db, challengeId, now);
  const p = await participantOf(db, challengeId, userId);
  if (!p) throw forbidden('You are not taking part in this challenge.');
  if (p.status !== 'ACTIVE' || !participatesOn(p, ctx.today)) throw conflict('You are not taking part today.');
  const days = weekendDays(a.weekend_key, ctx.ch.startsOn, ctx.ch.endsOn);
  if (!days.includes(ctx.today)) throw conflict(`Bonus evidence is submitted during the weekend itself (${days.join(' and ')}).`);
  const note = String(input.note ?? '').trim().slice(0, 1000);
  if (!input.image?.length && note.length < 5) throw validation('Add a photo/screenshot or describe what you did.');
  let fileId: number | null = null;
  if (input.image?.length) {
    const s = await storeImage(mediaDir, userId, input.image);
    fileId = Number((await db.query(
      `INSERT INTO files (owner_user_id, purpose, storage_key, sha256, mime_type, bytes, uploaded_by, created_at) VALUES ($1,'BONUS_EVIDENCE',$2,$3,$4,$5,$1,$6) RETURNING file_id`,
      [userId, s.storageKey, s.sha256, s.mimeType, s.bytes, now])).rows[0].file_id);
  }
  const live = await db.query(`SELECT 1 FROM bonus_submissions WHERE activity_id = $1 AND participant_id = $2 AND status IN ('PENDING','APPROVED')`, [activityId, p.participantId]);
  if (live.rows[0]) throw conflict('You already submitted this activity.');
  const { rows } = await db.query(
    `INSERT INTO bonus_submissions (activity_id, participant_id, file_id, note, status, received_at, created_at, updated_at) VALUES ($1,$2,$3,$4,'PENDING',$5,$5,$5) RETURNING bonus_submission_id`,
    [activityId, p.participantId, fileId, note || null, now]);
  const id = Number(rows[0].bonus_submission_id);
  await writeAudit(db, now, { actorUserId: userId, challengeId, action: 'BONUS_SUBMITTED', entity: 'BONUS_SUBMISSION', entityId: id });
  return { bonusSubmissionId: id };
}

export async function decideBonus(db: Queryable, actorUserId: number, bonusSubmissionId: number, input: { approve: unknown; reason?: unknown }, now: Date): Promise<void> {
  const s = (await db.query(`SELECT s.*, a.challenge_id FROM bonus_submissions s JOIN bonus_activities a USING (activity_id) WHERE bonus_submission_id = $1 FOR UPDATE OF s`, [bonusSubmissionId])).rows[0];
  if (!s) throw notFound('Submission not found.');
  const challengeId = Number(s.challenge_id);
  await lockChallenge(db, challengeId);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'bonus.manage');
  const p = await participantById(db, Number(s.participant_id));
  if (p.userId === actorUserId) throw forbidden('You can\'t approve your own bonus; another admin must do it.');
  if (s.status === 'WITHDRAWN') throw conflict('This submission was withdrawn.');
  const approve = input.approve === true;
  const reason = String(input.reason ?? '').trim();
  const changing = s.status !== 'PENDING';
  if ((!approve || changing) && reason.length < 5) throw validation(changing ? 'Give a reason for changing the decision.' : 'Give a reason for not approving.');
  const status = approve ? 'APPROVED' : 'REJECTED';
  if (s.status === status) return;
  await db.query(`UPDATE bonus_submissions SET status = $2, decided_by = $3, decided_at = $4, decision_reason = $5, updated_at = $4 WHERE bonus_submission_id = $1`,
    [bonusSubmissionId, status, actorUserId, now, reason || null]);
  await writeAudit(db, now, { actorUserId, challengeId, action: changing ? 'BONUS_DECISION_CHANGED' : 'BONUS_DECIDED', entity: 'BONUS_SUBMISSION', entityId: bonusSubmissionId,
    reason: reason || null, before: { status: s.status }, after: { status } });
}

export async function withdrawBonus(db: Queryable, userId: number, bonusSubmissionId: number, now: Date): Promise<void> {
  const s = (await db.query(`SELECT s.*, a.challenge_id FROM bonus_submissions s JOIN bonus_activities a USING (activity_id) WHERE bonus_submission_id = $1 FOR UPDATE OF s`, [bonusSubmissionId])).rows[0];
  if (!s) throw notFound('Submission not found.');
  const p = await participantById(db, Number(s.participant_id));
  if (p.userId !== userId) throw notFound('Submission not found.');
  if (s.status !== 'PENDING') throw conflict('Only a pending submission can be withdrawn.');
  await db.query(`UPDATE bonus_submissions SET status = 'WITHDRAWN', updated_at = $2 WHERE bonus_submission_id = $1`, [bonusSubmissionId, now]);
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(s.challenge_id), action: 'BONUS_WITHDRAWN', entity: 'BONUS_SUBMISSION', entityId: bonusSubmissionId });
}

/** Activities with (for admins) every submission, or (for participants) their own. */
export async function listBonuses(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const access = await accessFor(db, userId, challengeId);
  const admin = access.permissions.has('bonus.manage');
  const me = await participantOf(db, challengeId, userId);
  if (!admin && !me) throw forbidden();
  const ctx = await challengeContext(db, challengeId, now);
  const acts = (await db.query(`SELECT * FROM bonus_activities WHERE challenge_id = $1 ORDER BY weekend_key DESC, activity_id DESC`, [challengeId])).rows;
  const subs = (await db.query(
    `SELECT s.*, u.display_name, p.user_id FROM bonus_submissions s JOIN participants p USING (participant_id) JOIN users u ON u.user_id = p.user_id
      JOIN bonus_activities a USING (activity_id) WHERE a.challenge_id = $1 ORDER BY s.received_at`, [challengeId])).rows;
  return {
    canManage: admin, today: ctx.today,
    activities: acts.map((a) => {
      const days = weekendDays(a.weekend_key, ctx.ch.startsOn, ctx.ch.endsOn);
      const mine = subs.filter((s) => Number(s.activity_id) === Number(a.activity_id));
      const view = (s: Record<string, any>) => ({ bonusSubmissionId: Number(s.bonus_submission_id), displayName: s.display_name, mine: Number(s.user_id) === userId, note: s.note,
        fileId: s.file_id ? Number(s.file_id) : null, status: s.status, decisionReason: s.decision_reason, receivedAt: s.received_at.toISOString() });
      return {
        activityId: Number(a.activity_id), weekendKey: a.weekend_key, days, title: a.title, description: a.description, evidence: a.evidence, status: a.status,
        open: a.status === 'OPEN' && days.includes(ctx.today),
        submissions: admin ? mine.map(view) : mine.filter((s) => Number(s.user_id) === userId).map(view),
      };
    }),
  };
}

/** Whether a user may see a bonus evidence file (owner or a bonus manager). */
export async function canSeeBonusFile(db: Queryable, userId: number, fileId: number): Promise<boolean> {
  const { rows } = await db.query(`SELECT a.challenge_id FROM bonus_submissions s JOIN bonus_activities a USING (activity_id) WHERE s.file_id = $1`, [fileId]);
  for (const r of rows) if ((await accessFor(db, userId, Number(r.challenge_id))).permissions.has('bonus.manage')) return true;
  return false;
}
