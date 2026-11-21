// Removing a screenshot (owner, 21 Nov 2026): until that day's midnight people remove their own; afterwards they ask an
// admin (it changes points and fines for a decided day). A removed screenshot is WITHDRAWN - hidden, kept on record;
// the day is worked out without it. An admin can also erase the image itself (e.g. a private photo): the file is
// deleted, the record stays. Everything is in the activity log.
import { writeAudit } from '../../core/audit.js';
import { endOfDay } from '../../core/dates.js';
import { lockChallenge, type Queryable } from '../../core/db.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { eraseImage } from '../../core/media.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { challengeContext, participantById } from './days.js';

async function ownSubmission(db: Queryable, userId: number, submissionId: number) {
  const { rows: [s] } = await db.query(`SELECT * FROM submissions WHERE submission_id = $1 FOR UPDATE`, [submissionId]);
  if (!s) throw notFound('Screenshot not found.');
  const p = await participantById(db, Number(s.participant_id));
  if (p.userId !== userId) throw notFound('Screenshot not found.');
  return { s, p };
}

const dayIsOver = async (db: Queryable, s: Record<string, any>, now: Date) => {
  const ctx = await challengeContext(db, Number(s.challenge_id), now);
  return now >= endOfDay(String(s.day), ctx.ch.timeZone);
};

/** The person removes their own screenshot, until that day's midnight. Optionally asks an admin to erase the image. */
export async function withdraw(db: Queryable, userId: number, submissionId: number, input: { eraseImage?: unknown; reason?: unknown }, now: Date): Promise<void> {
  const { s } = await ownSubmission(db, userId, submissionId);
  await lockChallenge(db, Number(s.challenge_id));
  if (s.status === 'WITHDRAWN') return;
  if (s.status === 'SUPERSEDED') throw conflict('This screenshot was already replaced by a newer one.');
  if (await dayIsOver(db, s, now)) throw conflict('That day is over: ask an admin to remove it instead.');
  await db.query(`UPDATE submissions SET status = 'WITHDRAWN', withdrawn_at = $2, withdrawn_by = $3, withdraw_reason = 'Removed by the participant', updated_at = $2 WHERE submission_id = $1`,
    [submissionId, now, userId]);
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(s.challenge_id), action: 'EVIDENCE_WITHDRAWN', entity: 'SUBMISSION', entityId: submissionId,
    before: { status: s.status, value: s.final_value }, after: { day: s.day } });
  if (input.eraseImage === true) {
    const reason = String(input.reason ?? '').trim() || 'Private photo uploaded by mistake';
    await db.query(`INSERT INTO evidence_requests (challenge_id, submission_id, participant_id, kind, reason, requested_at) VALUES ($1,$2,$3,'ERASE',$4,$5) ON CONFLICT DO NOTHING`,
      [s.challenge_id, submissionId, s.participant_id, reason.slice(0, 500), now]);
  }
}

/** After the day is over: ask an admin to remove a screenshot (and optionally erase its image). */
export async function requestRemoval(db: Queryable, userId: number, submissionId: number, input: { reason?: unknown; eraseImage?: unknown }, now: Date): Promise<{ requestId: number }> {
  const { s } = await ownSubmission(db, userId, submissionId);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw validation('Say why it should be removed (at least 5 characters).');
  if (s.status === 'SUPERSEDED') throw conflict('This screenshot was already replaced by a newer one.');
  const kind = s.status === 'WITHDRAWN' ? 'ERASE' : 'REMOVE';
  if (kind === 'REMOVE' && !(await dayIsOver(db, s, now))) throw conflict('Until midnight you can remove it yourself.');
  const { rows: [f] } = await db.query(`SELECT erased_at FROM files WHERE file_id = $1`, [s.file_id]);
  if (kind === 'ERASE' && f.erased_at) throw conflict('That image has already been erased.');
  const { rows } = await db.query(
    `INSERT INTO evidence_requests (challenge_id, submission_id, participant_id, kind, erase_image, reason, requested_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING RETURNING request_id`, [s.challenge_id, submissionId, s.participant_id, kind, input.eraseImage === true, reason.slice(0, 500), now]);
  if (!rows[0]) throw conflict('You already asked about this screenshot; an admin will look at it.');
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(s.challenge_id), action: 'EVIDENCE_REMOVAL_REQUESTED', entity: 'SUBMISSION', entityId: submissionId, reason,
    after: { kind, eraseImage: input.eraseImage === true } });
  return { requestId: Number(rows[0].request_id) };
}

/** Admins: open requests, with the screenshot and what the day becomes. */
export async function pendingRequests(db: Queryable, actorUserId: number, challengeId: number): Promise<unknown[]> {
  requirePermission(await accessFor(db, actorUserId, challengeId), 'submissions.review');
  const { rows } = await db.query(
    `SELECT r.*, s.day, s.status AS sub_status, s.final_value, s.part, s.file_id, s.received_at, f.erased_at, u.display_name, u.user_id AS owner_id
       FROM evidence_requests r JOIN submissions s USING (submission_id) JOIN files f ON f.file_id = s.file_id
       JOIN participants p ON p.participant_id = r.participant_id JOIN users u ON u.user_id = p.user_id
      WHERE r.challenge_id = $1 AND r.status = 'PENDING' ORDER BY r.requested_at`, [challengeId]);
  return rows.map((r) => ({
    requestId: Number(r.request_id), submissionId: Number(r.submission_id), kind: r.kind, eraseImage: r.erase_image, reason: r.reason, requestedAt: r.requested_at.toISOString(),
    day: r.day, status: r.sub_status, value: r.final_value, part: r.part, fileId: r.erased_at ? null : Number(r.file_id), displayName: r.display_name,
    mine: Number(r.owner_id) === actorUserId,
  }));
}

/** An admin approves (remove; erase the image if chosen) or declines a request. Points and fines follow automatically. */
export async function decideRequest(db: Queryable, actorUserId: number, requestId: number, input: { approve?: unknown; erase?: unknown; note?: unknown }, now: Date): Promise<{ eraseKey: string | null }> {
  const { rows: [r] } = await db.query(`SELECT * FROM evidence_requests WHERE request_id = $1 FOR UPDATE`, [requestId]);
  if (!r) throw notFound('Request not found.');
  await lockChallenge(db, Number(r.challenge_id));
  requirePermission(await accessFor(db, actorUserId, Number(r.challenge_id)), 'submissions.review');
  const p = await participantById(db, Number(r.participant_id));
  if (p.userId === actorUserId) throw forbidden('This is about your own screenshot; another admin must decide.');
  if (r.status !== 'PENDING') throw conflict('This request has already been decided.');
  const note = String(input.note ?? '').trim().slice(0, 500) || null;
  const approve = input.approve === true;
  if (!approve && (!note || note.length < 5)) throw validation('Give a reason for declining (at least 5 characters).');
  await db.query(`UPDATE evidence_requests SET status = $2, decided_by = $3, decided_at = $4, decision_note = $5 WHERE request_id = $1`,
    [requestId, approve ? 'APPROVED' : 'DECLINED', actorUserId, now, note]);
  const { rows: [s] } = await db.query(`SELECT * FROM submissions WHERE submission_id = $1 FOR UPDATE`, [r.submission_id]);
  let eraseKey: string | null = null;
  if (approve) {
    if (r.kind === 'REMOVE' && s.status !== 'WITHDRAWN') {
      await db.query(`UPDATE submissions SET status = 'WITHDRAWN', withdrawn_at = $2, withdrawn_by = $3, withdraw_reason = $4, updated_at = $2 WHERE submission_id = $1`,
        [s.submission_id, now, actorUserId, `Removed on request: ${r.reason}`.slice(0, 500)]);
    }
    if (r.kind === 'ERASE' || input.erase === true) eraseKey = await markErased(db, Number(s.file_id), actorUserId, now);
  }
  await writeAudit(db, now, { actorUserId, challengeId: Number(r.challenge_id), action: approve ? (r.kind === 'ERASE' ? 'EVIDENCE_IMAGE_ERASED' : 'EVIDENCE_REMOVED_ON_REQUEST') : 'EVIDENCE_REMOVAL_DECLINED',
    entity: 'SUBMISSION', entityId: Number(s.submission_id), reason: note ?? r.reason,
    before: { status: s.status, value: s.final_value }, after: { requestId, erased: eraseKey !== null } });
  return { eraseKey };
}

/** Marks a file erased (the caller deletes it from storage after the transaction commits). */
async function markErased(db: Queryable, fileId: number, actorUserId: number, now: Date): Promise<string | null> {
  const { rows: [f] } = await db.query(`UPDATE files SET erased_at = $2, erased_by = $3 WHERE file_id = $1 AND erased_at IS NULL RETURNING storage_key`, [fileId, now, actorUserId]);
  return f ? String(f.storage_key) : null;
}

/** Deletes an erased image from storage (after the decision is saved). */
export const deleteErased = (mediaDir: string, storageKey: string) => eraseImage(mediaDir, storageKey);
