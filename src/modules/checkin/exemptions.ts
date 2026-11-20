// Emergency / sick-day exemptions (PRD 6). A participant asks for one or more days with a reason (optional evidence).
// Voting follows the challenge's settings at the time of the request (copied onto the request). Too few votes or a tie
// -> admin review. Admins may decide when no voting is configured, and override when the settings allow it.
// Approved: the days are EXCUSED (no fine, no points, not in adherence, streaks pause, team day OK, no rest day used).
// Evidence files are visible to admins only; fellow participants see the reason so they can vote.
import type pg from 'pg';
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, withTx, type Queryable } from '../../core/db.js';
import { daysBetween, isValidDate } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { storeImage } from '../../core/media.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { challengeContext, participantById, participantOf, participatesOn } from './days.js';

export const MAX_EXEMPTION_DAYS = 14;

export interface RequestInput { startDay: unknown; endDay: unknown; reason: unknown; evidence?: Buffer | null }

export async function requestExemption(db: Queryable, mediaDir: string, userId: number, challengeId: number, input: RequestInput, now: Date): Promise<{ requestId: number; status: string }> {
  await lockChallenge(db, challengeId);
  const ctx = await challengeContext(db, challengeId, now);
  const p = await participantOf(db, challengeId, userId);
  if (!p) throw forbidden('You are not taking part in this challenge.');
  if (p.status !== 'ACTIVE') throw conflict(`Your participation is ${p.status.toLowerCase()}.`);
  const cfg = ctx.cfgOn(ctx.today);
  if (!cfg.exemptions.enabled) throw conflict('This challenge does not take exemption requests.');
  const startDay = String(input.startDay ?? ''), endDay = String(input.endDay ?? '');
  if (!isValidDate(startDay) || !isValidDate(endDay) || daysBetween(startDay, endDay) < 0) throw validation('Choose the first and last day (the last on or after the first).');
  if (daysBetween(ctx.ch.startsOn, startDay) < 0 || daysBetween(endDay, ctx.ch.endsOn) < 0) throw validation('The days must be within the challenge.');
  if (daysBetween(startDay, endDay) + 1 > MAX_EXEMPTION_DAYS) throw validation(`Ask for at most ${MAX_EXEMPTION_DAYS} days at a time.`);
  if (!participatesOn(p, startDay) || !participatesOn(p, endDay)) throw validation('You are not taking part on some of those days.');
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5 || reason.length > 1000) throw validation('Explain the reason (5–1000 characters).');
  const overlap = await db.query(
    `SELECT 1 FROM exemption_requests WHERE participant_id = $1 AND status IN ('VOTING','ADMIN_REVIEW','APPROVED') AND start_day <= $3 AND end_day >= $2`, [p.participantId, startDay, endDay]);
  if (overlap.rows[0]) throw conflict('You already have an exemption request covering some of those days.');
  const rest = await db.query(`SELECT day FROM rest_days WHERE participant_id = $1 AND cancelled_at IS NULL AND day BETWEEN $2 AND $3`, [p.participantId, startDay, endDay]);
  if (rest.rows[0]) throw conflict(`${rest.rows[0].day} is a rest day; leave it out of the request.`);
  const done = await db.query(`SELECT day FROM submissions WHERE participant_id = $1 AND status = 'ACHIEVED' AND day BETWEEN $2 AND $3`, [p.participantId, startDay, endDay]);
  if (done.rows[0]) throw conflict(`You reached the target on ${done.rows[0].day}; leave it out of the request.`);

  let evidenceFileId: number | null = null;
  if (input.evidence?.length) {
    const s = await storeImage(mediaDir, userId, input.evidence);
    evidenceFileId = Number((await db.query(
      `INSERT INTO files (owner_user_id, purpose, storage_key, sha256, mime_type, bytes, uploaded_by, created_at) VALUES ($1,'EXEMPTION_EVIDENCE',$2,$3,$4,$5,$1,$6) RETURNING file_id`,
      [userId, s.storageKey, s.sha256, s.mimeType, s.bytes, now])).rows[0].file_id);
  }

  const voting = cfg.exemptions.voting;
  let status = 'ADMIN_REVIEW', reviewReason: string | null = 'No voting is configured: an admin decides.', closes: Date | null = null, voters: number[] = [];
  if (voting) {
    const { rows } = await db.query(
      `SELECT participant_id FROM participants WHERE challenge_id = $1 AND status = 'ACTIVE' AND joined_on <= $2 AND (left_on IS NULL OR left_on >= $2) ${voting.requesterMayVote ? '' : 'AND participant_id <> $3'} ORDER BY participant_id`,
      voting.requesterMayVote ? [challengeId, ctx.today] : [challengeId, ctx.today, p.participantId]);
    voters = rows.map((r) => Number(r.participant_id));
    if (voters.length < voting.minVotes) reviewReason = `Only ${voters.length} eligible voters (at least ${voting.minVotes} votes needed): an admin decides.`;
    else { status = 'VOTING'; reviewReason = null; closes = new Date(now.getTime() + voting.votingHours * 3_600_000); }
  }
  const { rows } = await db.query(
    `INSERT INTO exemption_requests (challenge_id, participant_id, start_day, end_day, reason, evidence_file_id, status, voting, voting_closes_at, eligible_voters, review_reason, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING request_id`,
    [challengeId, p.participantId, startDay, endDay, reason, evidenceFileId, status, voting ? JSON.stringify(voting) : null, closes, voters, reviewReason, now]);
  const requestId = Number(rows[0].request_id);
  await writeAudit(db, now, { actorUserId: userId, challengeId, action: 'EXEMPTION_REQUESTED', entity: 'EXEMPTION', entityId: requestId, after: { startDay, endDay, status, voters: voters.length } });
  return { requestId, status };
}

export async function vote(db: Queryable, userId: number, requestId: number, voteRaw: unknown, now: Date): Promise<{ status: string }> {
  const r0 = (await db.query(`SELECT challenge_id FROM exemption_requests WHERE request_id = $1`, [requestId])).rows[0];
  if (!r0) throw notFound('Request not found.');
  await lockChallenge(db, Number(r0.challenge_id));
  const r = (await db.query(`SELECT * FROM exemption_requests WHERE request_id = $1 FOR UPDATE`, [requestId])).rows[0];
  const me = await participantOf(db, Number(r.challenge_id), userId);
  if (!me || !(r.eligible_voters as (string | number)[]).map(Number).includes(me.participantId)) throw forbidden('You are not one of the voters for this request.');
  if (r.status !== 'VOTING' || now >= r.voting_closes_at) throw conflict('Voting on this request has closed.');
  const v = String(voteRaw ?? '');
  if (v !== 'APPROVE' && v !== 'REJECT') throw validation('Vote APPROVE or REJECT.');
  await db.query(
    `INSERT INTO exemption_votes (request_id, voter_participant_id, vote, cast_at, updated_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (request_id, voter_participant_id) DO UPDATE SET vote = EXCLUDED.vote, updated_at = EXCLUDED.updated_at`, [requestId, me.participantId, v, now]);
  return { status: await resolve(db, requestId, now) };
}

/** Closes a vote when everyone has voted or the window has passed. Returns the (possibly new) status. */
export async function resolve(db: Queryable, requestId: number, now: Date): Promise<string> {
  const r = (await db.query(`SELECT * FROM exemption_requests WHERE request_id = $1 FOR UPDATE`, [requestId])).rows[0];
  if (r.status !== 'VOTING') return r.status;
  const { rows } = await db.query(`SELECT count(*) FILTER (WHERE vote = 'APPROVE')::int AS yes, count(*) FILTER (WHERE vote = 'REJECT')::int AS no FROM exemption_votes WHERE request_id = $1`, [requestId]);
  const yes = rows[0].yes as number, no = rows[0].no as number, total = yes + no;
  const voters = (r.eligible_voters as unknown[]).length;
  if (now < r.voting_closes_at && total < voters) return 'VOTING';
  const voting = r.voting as { minVotes: number; approvalThresholdPct: number };
  let status: string, reviewReason: string | null = null;
  if (total < voting.minVotes) { status = 'ADMIN_REVIEW'; reviewReason = `Only ${total} vote${total === 1 ? '' : 's'} (at least ${voting.minVotes} needed): an admin decides.`; }
  else if (yes === no) { status = 'ADMIN_REVIEW'; reviewReason = `Tie (${yes}–${no}): an admin decides.`; }
  else status = (yes / total) * 100 >= voting.approvalThresholdPct ? 'APPROVED' : 'REJECTED';
  await db.query(
    `UPDATE exemption_requests SET status = $2, review_reason = $3, decided_at = CASE WHEN $2 IN ('APPROVED','REJECTED') THEN $4::timestamptz END,
       decision_method = CASE WHEN $2 IN ('APPROVED','REJECTED') THEN 'VOTE' END, decision_reason = CASE WHEN $2 IN ('APPROVED','REJECTED') THEN $5 END, updated_at = $4 WHERE request_id = $1`,
    [requestId, status, reviewReason, now, `Vote ${yes} approve – ${no} reject`]);
  await writeAudit(db, now, { actorUserId: null, challengeId: Number(r.challenge_id), action: 'EXEMPTION_VOTE_CLOSED', entity: 'EXEMPTION', entityId: requestId,
    after: { yes, no, eligible: voters, status, reviewReason } });
  return status;
}

export async function decide(db: Queryable, actorUserId: number, requestId: number, input: { approve: unknown; reason: unknown }, now: Date): Promise<void> {
  const r0 = (await db.query(`SELECT challenge_id FROM exemption_requests WHERE request_id = $1`, [requestId])).rows[0];
  if (!r0) throw notFound('Request not found.');
  await lockChallenge(db, Number(r0.challenge_id));
  await resolve(db, requestId, now);
  const r = (await db.query(`SELECT * FROM exemption_requests WHERE request_id = $1 FOR UPDATE`, [requestId])).rows[0];
  requirePermission(await accessFor(db, actorUserId, Number(r.challenge_id)), 'exemptions.review');
  const p = await participantById(db, Number(r.participant_id));
  if (p.userId === actorUserId) throw forbidden('You can\'t decide your own exemption; another admin must do it.');
  if (r.status === 'WITHDRAWN') throw conflict('This request was withdrawn.');
  const override = r.status !== 'ADMIN_REVIEW';
  if (override && r.voting && !(r.voting as { adminOverride: boolean }).adminOverride) throw forbidden('The challenge settings do not allow admins to override the vote.');
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason for the decision (at least 5 characters).');
  const status = input.approve === true ? 'APPROVED' : 'REJECTED';
  const method = override ? 'ADMIN_OVERRIDE' : 'ADMIN';
  await db.query(`UPDATE exemption_requests SET status = $2, decided_by = $3, decided_at = $4, decision_reason = $5, decision_method = $6, updated_at = $4 WHERE request_id = $1`,
    [requestId, status, actorUserId, now, reason, method]);
  await writeAudit(db, now, { actorUserId, challengeId: Number(r.challenge_id), action: override ? 'EXEMPTION_OVERRIDDEN' : 'EXEMPTION_DECIDED', entity: 'EXEMPTION', entityId: requestId, reason,
    before: { status: r.status }, after: { status, method } });
}

export async function withdraw(db: Queryable, userId: number, requestId: number, now: Date): Promise<void> {
  const r = (await db.query(`SELECT * FROM exemption_requests WHERE request_id = $1 FOR UPDATE`, [requestId])).rows[0];
  if (!r) throw notFound('Request not found.');
  const p = await participantById(db, Number(r.participant_id));
  if (p.userId !== userId) throw notFound('Request not found.');
  if (r.status !== 'VOTING' && r.status !== 'ADMIN_REVIEW') throw conflict('Only an open request can be withdrawn.');
  await db.query(`UPDATE exemption_requests SET status = 'WITHDRAWN', updated_at = $2 WHERE request_id = $1`, [requestId, now]);
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(r.challenge_id), action: 'EXEMPTION_WITHDRAWN', entity: 'EXEMPTION', entityId: requestId });
}

/** Requests in a challenge, as the caller may see them. Tallies are shown to admins, and to everyone once closed. */
export async function listRequests(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown[]> {
  const access = await accessFor(db, userId, challengeId);
  const admin = access.permissions.has('exemptions.review');
  const me = await participantOf(db, challengeId, userId);
  if (!admin && !me) throw forbidden();
  const open = await db.query(`SELECT request_id FROM exemption_requests WHERE challenge_id = $1 AND status = 'VOTING' AND voting_closes_at <= $2`, [challengeId, now]);
  for (const o of open.rows) await resolve(db, Number(o.request_id), now);
  const { rows } = await db.query(
    `SELECT r.*, u.display_name, p.user_id,
            (SELECT count(*) FILTER (WHERE vote = 'APPROVE') FROM exemption_votes v WHERE v.request_id = r.request_id)::int AS yes,
            (SELECT count(*) FILTER (WHERE vote = 'REJECT') FROM exemption_votes v WHERE v.request_id = r.request_id)::int AS no,
            (SELECT vote FROM exemption_votes v WHERE v.request_id = r.request_id AND v.voter_participant_id = $2) AS my_vote
       FROM exemption_requests r JOIN participants p USING (participant_id) JOIN users u ON u.user_id = p.user_id
      WHERE r.challenge_id = $1 ORDER BY r.created_at DESC`, [challengeId, me?.participantId ?? 0]);
  return rows.map((r) => {
    const showTally = admin || r.status !== 'VOTING';
    const mine = Number(r.user_id) === userId;
    return {
      requestId: Number(r.request_id), participantId: Number(r.participant_id), displayName: r.display_name, mine,
      startDay: r.start_day, endDay: r.end_day, reason: r.reason, status: r.status, reviewReason: r.review_reason,
      votingClosesAt: r.voting_closes_at?.toISOString() ?? null, eligibleVoters: (r.eligible_voters as unknown[]).length,
      canVote: !!me && r.status === 'VOTING' && (r.eligible_voters as (string | number)[]).map(Number).includes(me.participantId),
      myVote: r.my_vote, tally: showTally ? { approve: r.yes, reject: r.no } : null,
      evidenceFileId: admin || mine ? (r.evidence_file_id ? Number(r.evidence_file_id) : null) : null,
      decisionMethod: r.decision_method, decisionReason: r.decision_reason, decidedAt: r.decided_at?.toISOString() ?? null,
      canDecide: admin && !mine && r.status !== 'WITHDRAWN' && (r.status === 'ADMIN_REVIEW' || !r.voting || (r.voting as { adminOverride: boolean }).adminOverride),
    };
  });
}

/** Closes every vote whose window has passed (scheduler). */
export async function closeDueVotes(pool: pg.Pool, now: Date): Promise<number> {
  const { rows } = await pool.query(`SELECT request_id, challenge_id FROM exemption_requests WHERE status = 'VOTING' AND voting_closes_at <= $1`, [now]);
  for (const r of rows) await withTx(pool, async (tx) => { await lockChallenge(tx, Number(r.challenge_id)); await resolve(tx, Number(r.request_id), now); });
  return rows.length;
}
