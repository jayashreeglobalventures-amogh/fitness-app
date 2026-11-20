// Admin view of a challenge's participation: every participant's day status for a chosen day, their running counts,
// and what is waiting for an admin.
import { writeAudit } from '../../core/audit.js';
import type { Queryable } from '../../core/db.js';
import { daysBetween, isValidDate } from '../../core/dates.js';
import { forbidden, validation } from '../../core/errors.js';
import { accessFor } from '../identity/permissions.js';
import { challengeContext, participantById, participantDays, summarize, type ParticipantRow } from './days.js';

export async function adminOverview(db: Queryable, actorUserId: number, challengeId: number, dayRaw: unknown, now: Date): Promise<unknown> {
  const access = await accessFor(db, actorUserId, challengeId);
  if (!access.permissions.has('challenge.view_admin')) throw forbidden();
  const ctx = await challengeContext(db, challengeId, now);
  const day = dayRaw ? String(dayRaw) : (daysBetween(ctx.ch.startsOn, ctx.today) < 0 ? ctx.ch.startsOn : daysBetween(ctx.today, ctx.ch.endsOn) < 0 ? ctx.ch.endsOn : ctx.today);
  if (!isValidDate(day)) throw validation('Choose a day (YYYY-MM-DD).');
  const { rows } = await db.query(
    `SELECT p.*, u.display_name, u.username, pr.mobile FROM participants p JOIN users u USING (user_id) LEFT JOIN user_profiles pr ON pr.user_id = p.user_id
      WHERE p.challenge_id = $1 ORDER BY u.display_name`, [challengeId]);
  // Mobile numbers only for those who manage the roster (the same admins who enter them when creating accounts),
  // for WhatsApp reminders.
  const canRemind = access.permissions.has('roster.manage');
  const reminded = canRemind ? await remindersOn(db, challengeId, day) : new Map<number, { at: string; by: string }>();
  const people = [];
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const p: ParticipantRow = { participantId: Number(r.participant_id), challengeId, userId: Number(r.user_id), status: r.status, joinedOn: r.joined_on, leftOn: r.left_on, displayName: r.display_name };
    const days = await participantDays(db, ctx, p, now);
    const d = days.find((x) => x.day === day);
    if (d) counts[d.status] = (counts[d.status] ?? 0) + 1;
    people.push({ participantId: p.participantId, userId: p.userId, displayName: r.display_name, username: r.username, status: p.status, day: d ?? null, summary: summarize(days, ctx),
      ...(canRemind ? { mobile: r.mobile ?? null, reminded: reminded.get(p.participantId) ?? null } : {}) });
  }
  const pend = await db.query(
    `SELECT (SELECT count(*) FROM submissions WHERE challenge_id = $1 AND (status = 'PENDING_REVIEW' OR (status = 'PENDING_AI' AND created_at < $2::timestamptz - interval '5 minutes')))::int AS reviews,
            (SELECT count(*) FROM exemption_requests WHERE challenge_id = $1 AND status = 'ADMIN_REVIEW')::int AS exemptions_review,
            (SELECT count(*) FROM exemption_requests WHERE challenge_id = $1 AND status = 'VOTING')::int AS exemptions_voting,
            (SELECT count(*) FROM rest_days WHERE challenge_id = $1 AND day = $3 AND cancelled_at IS NULL)::int AS rest_today`, [challengeId, now, day]);
  return { day, today: ctx.today, periods: ctx.periods, counts, people, waiting: pend.rows[0], canRemind, timeZone: ctx.ch.timeZone };
}

/** The latest WhatsApp reminder per participant for a day (from the activity log). */
async function remindersOn(db: Queryable, challengeId: number, day: string): Promise<Map<number, { at: string; by: string }>> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (a.entity_id) a.entity_id, a.at, u.display_name FROM audit_log a LEFT JOIN users u ON u.user_id = a.actor_user_id
      WHERE a.challenge_id = $1 AND a.action = 'WHATSAPP_REMINDER' AND a.after->>'day' = $2 ORDER BY a.entity_id, a.at DESC`, [challengeId, day]);
  return new Map(rows.map((r) => [Number(r.entity_id), { at: r.at.toISOString(), by: r.display_name }]));
}

/**
 * Records that an admin opened a WhatsApp reminder (to a person, or to the group). The message itself is sent from
 * the admin's own WhatsApp; the app can't know whether they pressed send, so this records the intent.
 */
export async function recordReminder(db: Queryable, actorUserId: number, challengeId: number, input: { participantId?: unknown; day?: unknown; group?: unknown; names?: unknown }, now: Date): Promise<void> {
  const access = await accessFor(db, actorUserId, challengeId);
  if (!access.permissions.has('roster.manage')) throw forbidden();
  const day = String(input.day ?? '');
  if (!isValidDate(day)) throw validation('Choose a day (YYYY-MM-DD).');
  if (input.group) {
    const names = Array.isArray(input.names) ? input.names.map(String).slice(0, 200) : [];
    await writeAudit(db, now, { actorUserId, challengeId, action: 'WHATSAPP_GROUP_REMINDER', entity: 'CHALLENGE', entityId: challengeId, after: { day, names } });
    return;
  }
  const p = await participantById(db, Number(input.participantId));
  if (p.challengeId !== challengeId) throw validation('That person is not in this challenge.');
  await writeAudit(db, now, { actorUserId, challengeId, action: 'WHATSAPP_REMINDER', entity: 'PARTICIPANT', entityId: p.participantId, after: { day, to: p.displayName } });
}

/** One participant's calendar: for the participant themself or an admin of the challenge. */
export async function participantCalendar(db: Queryable, actorUserId: number, participantId: number, now: Date): Promise<unknown> {
  const p = await participantById(db, participantId);
  if (p.userId !== actorUserId) {
    const access = await accessFor(db, actorUserId, p.challengeId);
    if (!access.permissions.has('challenge.view_admin')) throw forbidden();
  }
  const ctx = await challengeContext(db, p.challengeId, now);
  const days = await participantDays(db, ctx, p, now);
  return { participant: p, days, summary: summarize(days, ctx), periods: ctx.periods, today: ctx.today };
}
