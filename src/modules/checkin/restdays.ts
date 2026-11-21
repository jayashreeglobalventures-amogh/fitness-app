// Rest days (PRD 6): declared in the app before the configured local time ON the rest day (or any earlier time),
// at most perPeriod per week and maxTotal overall. No evidence, no fine, no points; streaks pause; counts as a team
// success. No retroactive declaration by the participant - only an audited admin correction.
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, type Queryable } from '../../core/db.js';
import { daysBetween, isValidDate, parseInstant } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { challengeContext, participantById, participantOf, participatesOn, periodOf, restCutoff, type ChallengeContext, type ParticipantRow } from './days.js';

async function checkAllowed(db: Queryable, ctx: ChallengeContext, p: ParticipantRow, day: string): Promise<number> {
  if (!isValidDate(day) || daysBetween(ctx.ch.startsOn, day) < 0 || daysBetween(day, ctx.ch.endsOn) < 0) throw validation('Choose a day within the challenge.');
  const cfg = ctx.cfgOn(day);
  if (!cfg.restDays.enabled) throw conflict('This challenge has no rest days.');
  if (!participatesOn(p, day)) throw conflict('Not taking part on that day.');
  const period = periodOf(ctx.periods, day)!;
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE period_no = $2)::int AS in_period, count(*)::int AS total FROM rest_days WHERE participant_id = $1 AND cancelled_at IS NULL`,
    [p.participantId, period.periodNo]);
  if (rows[0].in_period >= cfg.restDays.perPeriod) throw conflict(`You already have ${cfg.restDays.perPeriod} rest day${cfg.restDays.perPeriod === 1 ? '' : 's'} in week ${period.periodNo}.`);
  if (rows[0].total >= cfg.restDays.maxTotal) throw conflict(`You have used all ${cfg.restDays.maxTotal} rest days.`);
  const sub = await db.query(`SELECT status FROM submissions WHERE participant_id = $1 AND day = $2 AND status NOT IN ('SUPERSEDED','WITHDRAWN')`, [p.participantId, day]);
  if (sub.rows[0]) throw conflict('Evidence was already submitted for that day, so it can\'t become a rest day.');
  const ex = await db.query(`SELECT 1 FROM exemption_requests WHERE participant_id = $1 AND status IN ('VOTING','ADMIN_REVIEW','APPROVED') AND $2::date BETWEEN start_day AND end_day`, [p.participantId, day]);
  if (ex.rows[0]) throw conflict('That day is part of an exemption request.');
  const dup = await db.query(`SELECT 1 FROM rest_days WHERE participant_id = $1 AND day = $2 AND cancelled_at IS NULL`, [p.participantId, day]);
  if (dup.rows[0]) throw conflict('That day is already a rest day.');
  return period.periodNo;
}

export async function declare(db: Queryable, userId: number, challengeId: number, dayRaw: unknown, now: Date): Promise<{ restDayId: number }> {
  await lockChallenge(db, challengeId);
  const ctx = await challengeContext(db, challengeId, now);
  const p = await participantOf(db, challengeId, userId);
  if (!p) throw forbidden('You are not taking part in this challenge.');
  if (p.status !== 'ACTIVE') throw conflict(`Your participation is ${p.status.toLowerCase()}.`);
  const day = String(dayRaw ?? '');
  const periodNo = await checkAllowed(db, ctx, p, day);
  const cfg = ctx.cfgOn(day);
  if (now >= restCutoff(cfg, day)) throw conflict(`A rest day must be declared before ${cfg.restDays.declareBefore} on the day itself.`);
  const { rows } = await db.query(
    `INSERT INTO rest_days (challenge_id, participant_id, day, period_no, declared_at, source, declared_by, created_at) VALUES ($1,$2,$3,$4,$5,'PARTICIPANT',$6,$5) RETURNING rest_day_id`,
    [challengeId, p.participantId, day, periodNo, now, userId]);
  const restDayId = Number(rows[0].rest_day_id);
  await writeAudit(db, now, { actorUserId: userId, challengeId, action: 'REST_DAY_DECLARED', entity: 'REST_DAY', entityId: restDayId, after: { day, declaredAt: now.toISOString() } });
  return { restDayId };
}

export async function cancel(db: Queryable, userId: number, restDayId: number, now: Date): Promise<void> {
  const r = (await db.query(`SELECT * FROM rest_days WHERE rest_day_id = $1 FOR UPDATE`, [restDayId])).rows[0];
  if (!r || r.cancelled_at) throw notFound('Rest day not found.');
  const p = await participantById(db, Number(r.participant_id));
  if (p.userId !== userId) throw notFound('Rest day not found.');
  const ctx = await challengeContext(db, Number(r.challenge_id), now);
  const cfg = ctx.cfgOn(r.day);
  if (now >= restCutoff(cfg, r.day)) throw conflict(`A rest day can only be cancelled before ${cfg.restDays.declareBefore} on that day.`);
  await db.query(`UPDATE rest_days SET cancelled_at = $2, cancelled_by = $3 WHERE rest_day_id = $1`, [restDayId, now, userId]);
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(r.challenge_id), action: 'REST_DAY_CANCELLED', entity: 'REST_DAY', entityId: restDayId, before: { day: r.day } });
}

/**
 * Audited admin correction: records a rest day for a participant (e.g. declared on WhatsApp before the app was live),
 * with the original declaration time. The weekly and total limits still apply.
 */
export async function adminDeclare(db: Queryable, actorUserId: number, participantId: number, input: { day: unknown; declaredAt?: unknown; reason: unknown }, now: Date): Promise<{ restDayId: number; afterCutoff: boolean }> {
  const p = await participantById(db, participantId);
  await lockChallenge(db, p.challengeId);
  requirePermission(await accessFor(db, actorUserId, p.challengeId), 'restdays.correct');
  if (p.userId === actorUserId) throw forbidden('You can\'t correct your own rest days; another admin must do it.');
  const ctx = await challengeContext(db, p.challengeId, now);
  const day = String(input.day ?? '');
  const periodNo = await checkAllowed(db, ctx, p, day);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason (at least 5 characters).');
  const declaredAt = input.declaredAt ? parseInstant(input.declaredAt, ctx.ch.timeZone) : now;
  if (!declaredAt || declaredAt > now) throw validation('The original declaration time must be a valid time, not in the future.');
  const afterCutoff = declaredAt >= restCutoff(ctx.cfgOn(day), day);
  const { rows } = await db.query(
    `INSERT INTO rest_days (challenge_id, participant_id, day, period_no, declared_at, source, declared_by, reason, created_at) VALUES ($1,$2,$3,$4,$5,'ADMIN_CORRECTION',$6,$7,$8) RETURNING rest_day_id`,
    [p.challengeId, participantId, day, periodNo, declaredAt, actorUserId, reason, now]);
  const restDayId = Number(rows[0].rest_day_id);
  await writeAudit(db, now, { actorUserId, challengeId: p.challengeId, action: 'REST_DAY_CORRECTED', entity: 'REST_DAY', entityId: restDayId, reason,
    after: { participantId, day, declaredAt: declaredAt.toISOString(), afterCutoff } });
  return { restDayId, afterCutoff };
}

export async function adminCancel(db: Queryable, actorUserId: number, restDayId: number, reasonRaw: unknown, now: Date): Promise<void> {
  const r = (await db.query(`SELECT * FROM rest_days WHERE rest_day_id = $1 FOR UPDATE`, [restDayId])).rows[0];
  if (!r || r.cancelled_at) throw notFound('Rest day not found.');
  requirePermission(await accessFor(db, actorUserId, Number(r.challenge_id)), 'restdays.correct');
  const p = await participantById(db, Number(r.participant_id));
  if (p.userId === actorUserId) throw forbidden('You can\'t correct your own rest days; another admin must do it.');
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason (at least 5 characters).');
  await db.query(`UPDATE rest_days SET cancelled_at = $2, cancelled_by = $3, cancel_reason = $4 WHERE rest_day_id = $1`, [restDayId, now, actorUserId, reason]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(r.challenge_id), action: 'REST_DAY_CORRECTION_CANCELLED', entity: 'REST_DAY', entityId: restDayId, reason, before: { day: r.day } });
}
