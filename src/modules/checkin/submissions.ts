// Daily evidence: upload, AI-assisted reading, admin review, appeals, and admin-recorded corrections.
// Rules (PRD 6-7):
//  - Evidence counts only for the day it reaches the server (challenge time zone); late evidence never counts for an
//    earlier day. The deadline is judged on received_at, not on when verification runs.
//  - The AI may only APPROVE a clear, on-target reading of the right day. Anything else - unreadable, wrong/unclear
//    date, below target, flagged, duplicate image, AI unavailable - goes to an admin. AI never rejects.
//  - Every reading and decision is kept (verification_results, append-only); overrides need a reason.
//  - An admin never reviews their own evidence.
import type pg from 'pg';
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, withTx, type Queryable } from '../../core/db.js';
import { daysBetween, endOfDay, isValidDate, localDay, parseInstant } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { readImage, storeImage } from '../../core/media.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { ReaderError, type Reading, type ScreenshotReader } from '../verification/reader.js';
import { currentReader } from '../verification/select.js';
import { canSeeBonusFile } from '../scoring/bonus.js';
import { canSeeFinanceFile } from '../finance/finance.js';
import { canSeeProfilePhoto } from '../profile/profile.js';
import { canSeeCommunityPhoto } from '../community/community.js';
import { challengeContext, participantById, participantOf, participatesOn, type ParticipantRow } from './days.js';

export const MAX_AI_ATTEMPTS = 3;

export interface SubmitInput { image: Buffer; clientRef: unknown; claimedValue?: unknown }
export interface Submitted { submissionId: number; status: string; day: string; duplicate: boolean; verify: boolean }

async function insertFile(db: Queryable, mediaDir: string, ownerUserId: number, uploaderUserId: number, purpose: string, image: Buffer, now: Date) {
  const stored = await storeImage(mediaDir, ownerUserId, image);
  const { rows } = await db.query(
    `INSERT INTO files (owner_user_id, purpose, storage_key, sha256, mime_type, bytes, uploaded_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING file_id`,
    [ownerUserId, purpose, stored.storageKey, stored.sha256, stored.mimeType, stored.bytes, uploaderUserId, now]);
  return { fileId: Number(rows[0].file_id), sha256: stored.sha256 };
}

const parseClaim = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  if (!Number.isSafeInteger(n) || n < 0 || n > 10_000_000) throw validation('Enter the total as a whole number.');
  return n;
};

/**
 * Creates the live submission for (participant, day), superseding a previous not-yet-approved one.
 * Shared by participant uploads and admin corrections.
 */
export const MAX_PARTS_PER_DAY = 10;

async function createSubmission(db: Queryable, mediaDir: string, p: ParticipantRow, day: string, receivedAt: Date, input: SubmitInput,
  actorUserId: number, source: 'PARTICIPANT' | 'ADMIN_CORRECTION', correctionReason: string | null, now: Date, aiEnabled: boolean, multi = false): Promise<Submitted> {
  const clientRef = String(input.clientRef ?? '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientRef)) throw validation('Missing upload reference.');
  // Idempotency: the same upload sent twice (retry, double tap) returns the first result.
  const again = await db.query(`SELECT submission_id, status, day FROM submissions WHERE participant_id = $1 AND client_ref = $2`, [p.participantId, clientRef]);
  if (again.rows[0]) return { submissionId: Number(again.rows[0].submission_id), status: again.rows[0].status, day: again.rows[0].day, duplicate: false, verify: false };
  const claimedValue = parseClaim(input.claimedValue);

  const rest = await db.query(`SELECT 1 FROM rest_days WHERE participant_id = $1 AND day = $2 AND cancelled_at IS NULL`, [p.participantId, day]);
  if (rest.rows[0]) throw conflict('This day is a declared rest day.');
  const ex = await db.query(`SELECT 1 FROM exemption_requests WHERE participant_id = $1 AND status = 'APPROVED' AND $2::date BETWEEN start_day AND end_day`, [p.participantId, day]);
  if (ex.rows[0]) throw conflict('This day is covered by an approved exemption.');

  let prev: { submission_id: string; status: string } | undefined;
  if (multi) {
    // Several screenshots a day: each one is an extra part; nothing is replaced.
    const { rows: [c] } = await db.query(`SELECT count(*)::int AS n FROM submissions WHERE participant_id = $1 AND day = $2 AND part AND status NOT IN ('REJECTED','WITHDRAWN')`, [p.participantId, day]);
    if (c.n >= MAX_PARTS_PER_DAY) throw conflict(`You can add up to ${MAX_PARTS_PER_DAY} screenshots a day.`);
  } else {
    const live = await db.query(`SELECT submission_id, status FROM submissions WHERE participant_id = $1 AND day = $2 AND status NOT IN ('SUPERSEDED','WITHDRAWN') AND NOT part FOR UPDATE`, [p.participantId, day]);
    prev = live.rows[0];
    if (prev && prev.status === 'ACHIEVED') throw conflict('Your evidence for this day is already verified.');
    if (prev) await db.query(`UPDATE submissions SET status = 'SUPERSEDED', updated_at = $2 WHERE submission_id = $1`, [prev.submission_id, now]);
  }

  const file = await insertFile(db, mediaDir, p.userId, actorUserId, 'STEP_EVIDENCE', input.image, now);
  if (multi) {
    // The same picture twice on one day would count twice: refused.
    const same = await db.query(
      `SELECT 1 FROM submissions s JOIN files f USING (file_id) WHERE s.participant_id = $1 AND s.day = $2 AND s.part AND s.status NOT IN ('REJECTED','WITHDRAWN') AND f.sha256 = $3 AND s.file_id <> $4`,
      [p.participantId, day, file.sha256, file.fileId]);
    if (same.rows[0]) throw conflict('You already added this screenshot today. Add a different one (e.g. from another device).');
  }
  // The same image used for any other submission (anyone's, any day) is never auto-approved.
  const dup = await db.query(
    `SELECT s.submission_id FROM submissions s JOIN files f USING (file_id) WHERE f.sha256 = $1 AND (s.participant_id <> $2 OR s.day <> $3) LIMIT 1`,
    [file.sha256, p.participantId, day]);
  const duplicate = !!dup.rows[0];
  const status = duplicate || !aiEnabled ? 'PENDING_REVIEW' : 'PENDING_AI';
  const { rows } = await db.query(
    `INSERT INTO submissions (challenge_id, participant_id, day, file_id, received_at, client_ref, claimed_value, status, source, recorded_by, correction_reason, supersedes_id, part, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$14,$13,$13) RETURNING submission_id`,
    [p.challengeId, p.participantId, day, file.fileId, receivedAt, clientRef, claimedValue, status, source, actorUserId, correctionReason, prev ? prev.submission_id : null, now, multi]);
  const submissionId = Number(rows[0].submission_id);
  if (duplicate || !aiEnabled) {
    await db.query(`INSERT INTO verification_results (submission_id, method, outcome, flags, reason, created_at) VALUES ($1,'SYSTEM','NEEDS_REVIEW',$2,$3,$4)`,
      [submissionId, JSON.stringify(duplicate ? ['DUPLICATE_IMAGE'] : []), duplicate ? `The same image was already used for submission ${dup.rows[0].submission_id}.` : 'Manual review (automatic reading is off).', now]);
  }
  return { submissionId, status, day, duplicate, verify: status === 'PENDING_AI' };
}

/** A participant uploads today's evidence. */
export async function submit(db: Queryable, mediaDir: string, userId: number, challengeId: number, input: SubmitInput, now: Date): Promise<Submitted> {
  await lockChallenge(db, challengeId);
  const ctx = await challengeContext(db, challengeId, now);
  if (ctx.ch.status !== 'PUBLISHED') throw conflict('This challenge is not open.');
  const p = await participantOf(db, challengeId, userId);
  if (!p) throw forbidden('You are not taking part in this challenge.');
  if (p.status !== 'ACTIVE') throw conflict(`Your participation is ${p.status.toLowerCase()}.`);
  const day = ctx.today; // evidence belongs to the day it arrives
  if (daysBetween(ctx.ch.startsOn, day) < 0) throw conflict(`The challenge starts on ${ctx.ch.startsOn}.`);
  if (daysBetween(day, ctx.ch.endsOn) < 0) throw conflict('The challenge has ended; evidence can no longer be submitted.');
  if (!participatesOn(p, day)) throw conflict('You are not taking part on this day.');
  const cfg = ctx.cfgOn(day);
  const r = await createSubmission(db, mediaDir, p, day, now, input, userId, 'PARTICIPANT', null, now, cfg.verification.mode === 'AI_ASSISTED' && currentReader() !== null, cfg.submission.multiplePerDay.enabled);
  await writeAudit(db, now, { actorUserId: userId, challengeId, action: 'EVIDENCE_SUBMITTED', entity: 'SUBMISSION', entityId: r.submissionId, after: { day, status: r.status, duplicate: r.duplicate } });
  return r;
}

export interface CorrectionInput extends SubmitInput { day: unknown; receivedAt: unknown; reason: unknown }

/**
 * An admin records evidence on a participant's behalf with its ORIGINAL time (e.g. sent on WhatsApp before the app
 * was live). It must have arrived before that day's deadline. Then it is verified like any other submission.
 */
export async function recordCorrection(db: Queryable, mediaDir: string, actorUserId: number, participantId: number, input: CorrectionInput, now: Date): Promise<Submitted> {
  const p0 = await participantById(db, participantId);
  await lockChallenge(db, p0.challengeId);
  const ctx = await challengeContext(db, p0.challengeId, now);
  requirePermission(await accessFor(db, actorUserId, p0.challengeId), 'submissions.review');
  if (p0.userId === actorUserId) throw forbidden('You can\'t record a correction for yourself; another admin must do it.');
  const day = String(input.day ?? '');
  if (!isValidDate(day) || daysBetween(ctx.ch.startsOn, day) < 0 || daysBetween(day, ctx.today) < 0) throw validation('Choose a challenge day up to today.');
  if (!participatesOn(p0, day)) throw validation('The participant was not taking part on that day.');
  const receivedAt = parseInstant(input.receivedAt, ctx.ch.timeZone);
  if (!receivedAt) throw validation('Enter the original date and time the evidence was sent.');
  if (receivedAt > now) throw validation('The original time can\'t be in the future.');
  if (localDay(receivedAt, ctx.ch.timeZone) !== day) throw validation(`The original time must be on ${day} (${ctx.ch.timeZone}): evidence counts only for the day it was sent, before midnight.`);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason (at least 5 characters), e.g. where the evidence came from.');
  const cfg = ctx.cfgOn(day);
  const r = await createSubmission(db, mediaDir, p0, day, receivedAt, input, actorUserId, 'ADMIN_CORRECTION', reason, now, cfg.verification.mode === 'AI_ASSISTED' && currentReader() !== null, cfg.submission.multiplePerDay.enabled);
  await writeAudit(db, now, { actorUserId, challengeId: p0.challengeId, action: 'EVIDENCE_RECORDED_BY_ADMIN', entity: 'SUBMISSION', entityId: r.submissionId, reason,
    after: { participantId, day, receivedAt: receivedAt.toISOString() } });
  return r;
}

/** What the AI reading means. Only a clean, confident, on-target reading of the right day is approved. */
export function judge(reading: Reading, day: string, target: number, minConfidence: number, claimed: number | null): { approve: boolean; flags: string[]; reason: string } {
  const flags = [...reading.flags];
  if (!reading.readable) flags.push('UNREADABLE');
  if (reading.date === null) flags.push('DATE_NOT_VISIBLE');
  else if (reading.date !== day) flags.push('DATE_MISMATCH');
  if (reading.value === null) flags.push('VALUE_NOT_VISIBLE');
  else if (reading.value < target) flags.push('BELOW_TARGET');
  if (reading.confidence < minConfidence) flags.push('LOW_CONFIDENCE');
  if (claimed !== null && reading.value !== null && Math.abs(claimed - reading.value) > Math.max(50, reading.value * 0.02)) flags.push('CLAIM_MISMATCH');
  const unique = [...new Set(flags)];
  return unique.length
    ? { approve: false, flags: unique, reason: `Needs review: ${unique.join(', ').toLowerCase().replace(/_/g, ' ')}.` }
    : { approve: true, flags: [], reason: `Read automatically: ${reading.value} on ${reading.date}.` };
}

/** Runs the AI reading of one PENDING_AI submission. Never holds a transaction during the network call. */
export async function verifySubmission(pool: pg.Pool, mediaDir: string, submissionId: number, now: () => Date, reader: ScreenshotReader | null = currentReader()): Promise<string> {
  const { rows } = await pool.query(
    `SELECT s.*, f.storage_key, f.mime_type FROM submissions s JOIN files f USING (file_id) WHERE s.submission_id = $1`, [submissionId]);
  const s = rows[0];
  if (!s || s.status !== 'PENDING_AI') return s?.status ?? 'NONE';
  const ctx = await challengeContext(pool, Number(s.challenge_id), now());
  const cfg = ctx.cfgOn(s.day);

  let reading: Reading | null = null;
  let failure: ReaderError | null = null;
  if (!reader) failure = new ReaderError('Automatic reading is not configured.', false);
  else {
    try {
      reading = await reader.read(await readImage(mediaDir, s.storage_key), s.mime_type, { expectedDay: s.day, timeZone: ctx.ch.timeZone, metricLabel: cfg.activity.label, unit: cfg.activity.unit });
    } catch (e) {
      failure = e instanceof ReaderError ? e : new ReaderError('Screenshot reading failed.', true);
    }
  }

  return withTx(pool, async (tx) => {
    const cur = (await tx.query(`SELECT status, ai_attempts FROM submissions WHERE submission_id = $1 FOR UPDATE`, [submissionId])).rows[0];
    const at = now();
    if (failure) {
      const attempts = Number(cur.ai_attempts) + 1;
      const giveUp = !failure.retryable || attempts >= MAX_AI_ATTEMPTS;
      await tx.query(`INSERT INTO verification_results (submission_id, method, provider, outcome, reason, created_at) VALUES ($1,'AI',$2,'ERROR',$3,$4)`,
        [submissionId, null, failure.message + (giveUp ? ' Sent to manual review.' : ' Will retry.'), at]);
      if (cur.status !== 'PENDING_AI') return cur.status;
      await tx.query(`UPDATE submissions SET ai_attempts = $2, status = $3, updated_at = $4 WHERE submission_id = $1`, [submissionId, attempts, giveUp ? 'PENDING_REVIEW' : 'PENDING_AI', at]);
      return giveUp ? 'PENDING_REVIEW' : 'PENDING_AI';
    }
    const r = reading!;
    // A part (one of several screenshots a day) isn't judged against the target: the day's total is.
    const verdict = judge(r, s.day, s.part ? 0 : cfg.activity.dailyTarget, cfg.verification.autoApproveMinConfidence, s.claimed_value);
    await tx.query(
      `INSERT INTO verification_results (submission_id, method, provider, model, extracted_date, extracted_value, source_app, confidence, readable, flags, outcome, reason, created_at)
       VALUES ($1,'AI',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [submissionId, r.provider, r.model, r.date, r.value, r.sourceApp, r.confidence, r.readable, JSON.stringify(verdict.flags), verdict.approve ? 'AUTO_APPROVED' : 'NEEDS_REVIEW',
        [verdict.reason, r.notes].filter(Boolean).join(' '), at]);
    if (cur.status !== 'PENDING_AI') return cur.status; // decided or superseded meanwhile: keep the reading, change nothing
    if (verdict.approve) {
      const approved = s.part ? 'APPROVED' : 'ACHIEVED';
      await tx.query(`UPDATE submissions SET status = $5, final_value = $2, ai_attempts = ai_attempts + 1, decided_at = $3, decision_reason = $4, updated_at = $3 WHERE submission_id = $1`,
        [submissionId, r.value, at, verdict.reason, approved]);
      return approved;
    }
    await tx.query(`UPDATE submissions SET status = 'PENDING_REVIEW', ai_attempts = ai_attempts + 1, updated_at = $2 WHERE submission_id = $1`, [submissionId, at]);
    return 'PENDING_REVIEW';
  });
}

export interface ReviewInput { outcome: unknown; value?: unknown; reason?: unknown }

/** An admin decides (or overrides) a submission. */
export async function review(db: Queryable, actorUserId: number, submissionId: number, input: ReviewInput, now: Date): Promise<void> {
  const s0 = (await db.query(`SELECT * FROM submissions WHERE submission_id = $1`, [submissionId])).rows[0];
  if (!s0) throw notFound('Submission not found.');
  const challengeId = Number(s0.challenge_id);
  await lockChallenge(db, challengeId);
  const s = (await db.query(`SELECT * FROM submissions WHERE submission_id = $1 FOR UPDATE`, [submissionId])).rows[0];
  requirePermission(await accessFor(db, actorUserId, challengeId), 'submissions.review');
  const p = await participantById(db, Number(s.participant_id));
  if (p.userId === actorUserId) throw forbidden('You can\'t review your own evidence; another admin must do it.');
  if (s.status === 'SUPERSEDED') throw conflict('This evidence was replaced by a newer upload.');
  if (s.status === 'WITHDRAWN') throw conflict('This screenshot was removed.');
  const outcome = String(input.outcome ?? '');
  // One of several screenshots a day: approve (its number counts towards the day) or decline. Otherwise the day's result.
  if (s.part ? !['APPROVED', 'REJECTED'].includes(outcome) : !['ACHIEVED', 'BELOW_TARGET', 'REJECTED'].includes(outcome)) {
    throw validation(s.part ? 'Choose: approve or decline.' : 'Choose: target reached, below target, or rejected.');
  }
  const ctx = await challengeContext(db, challengeId, now);
  const target = ctx.cfgOn(s.day).activity.dailyTarget;
  let value: number | null = null;
  if (outcome !== 'REJECTED') {
    value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < 0) throw validation('Enter the total shown in the screenshot.');
    if (outcome === 'ACHIEVED' && value < target) throw validation(`${value} is below the target of ${target}.`);
    if (s.part && value > 10_000_000) throw validation('That number is too large.');
    if (outcome === 'BELOW_TARGET' && value >= target) throw validation(`${value} reaches the target of ${target}.`);
  }
  const reason = String(input.reason ?? '').trim();
  // Changing a decision - directly, or by deciding an appeal against it - always needs a reason.
  const override = s.status === 'ACHIEVED' || s.status === 'BELOW_TARGET' || s.status === 'REJECTED' || s.status === 'APPROVED' || !!s.appealed_at;
  if ((outcome === 'REJECTED' || override) && reason.length < 5) throw validation(override ? 'Give a reason for changing a decision (at least 5 characters).' : 'Give a reason for rejecting (at least 5 characters).');
  if (override && !s.appealed_at && s.status === outcome && s.final_value === value) return;

  await db.query(`UPDATE submissions SET status = $2, final_value = $3, decided_by = $4, decided_at = $5, decision_reason = $6, updated_at = $5 WHERE submission_id = $1`,
    [submissionId, outcome, value, actorUserId, now, reason || null]);
  await db.query(`INSERT INTO verification_results (submission_id, method, extracted_value, outcome, reason, actor_user_id, created_at) VALUES ($1,'ADMIN',$2,$3,$4,$5,$6)`,
    [submissionId, value, outcome, reason || null, actorUserId, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: override ? 'EVIDENCE_DECISION_OVERRIDDEN' : 'EVIDENCE_REVIEWED', entity: 'SUBMISSION', entityId: submissionId, reason: reason || null,
    before: { status: s.status, finalValue: s.final_value }, after: { status: outcome, finalValue: value } });
}

/** The participant asks for a second look at a below-target or rejected decision (once per submission). */
export async function appeal(db: Queryable, userId: number, submissionId: number, noteRaw: unknown, now: Date): Promise<void> {
  const s = (await db.query(`SELECT * FROM submissions WHERE submission_id = $1 FOR UPDATE`, [submissionId])).rows[0];
  if (!s) throw notFound('Submission not found.');
  const p = await participantById(db, Number(s.participant_id));
  if (p.userId !== userId) throw notFound('Submission not found.');
  if (s.status !== 'BELOW_TARGET' && s.status !== 'REJECTED') throw conflict('Only a below-target or rejected decision can be appealed.');
  if (s.appealed_at) throw conflict('This decision was already appealed.');
  const note = String(noteRaw ?? '').trim();
  if (note.length < 5) throw validation('Explain why the decision should change (at least 5 characters).');
  await db.query(`UPDATE submissions SET status = 'PENDING_REVIEW', appealed_at = $2, appeal_note = $3, updated_at = $2 WHERE submission_id = $1`, [submissionId, now, note.slice(0, 1000)]);
  await db.query(`INSERT INTO verification_results (submission_id, method, outcome, reason, actor_user_id, created_at) VALUES ($1,'SYSTEM','APPEALED',$2,$3,$4)`,
    [submissionId, `Appeal: ${note.slice(0, 500)}`, userId, now]);
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(s.challenge_id), action: 'EVIDENCE_APPEALED', entity: 'SUBMISSION', entityId: submissionId, before: { status: s.status } });
}

const resultOf = (r: Record<string, unknown>) => ({
  method: r.method, provider: r.provider, model: r.model, extractedDate: r.extracted_date, extractedValue: r.extracted_value, sourceApp: r.source_app,
  confidence: r.confidence === null ? null : Number(r.confidence), readable: r.readable, flags: r.flags, outcome: r.outcome, reason: r.reason,
  actorUserId: r.actor_user_id ? Number(r.actor_user_id) : null, at: (r.created_at as Date).toISOString(),
});

/** Admin review queue: waiting for a decision (or stuck waiting for the AI for more than 5 minutes). */
export async function reviewQueue(db: Queryable, actorUserId: number, challengeId: number, now: Date): Promise<unknown[]> {
  requirePermission(await accessFor(db, actorUserId, challengeId), 'submissions.review');
  const { rows } = await db.query(
    `SELECT s.*, u.display_name, u.user_id AS owner_id FROM submissions s JOIN participants p USING (participant_id) JOIN users u ON u.user_id = p.user_id
      WHERE s.challenge_id = $1 AND (s.status = 'PENDING_REVIEW' OR (s.status = 'PENDING_AI' AND s.created_at < $2::timestamptz - interval '5 minutes'))
      ORDER BY s.received_at`, [challengeId, now]);
  const ids = rows.map((r) => r.submission_id);
  const res = ids.length ? (await db.query(`SELECT * FROM verification_results WHERE submission_id = ANY($1) ORDER BY result_id`, [ids])).rows : [];
  const ctx = await challengeContext(db, challengeId, now);
  return rows.map((s) => ({
    ...submissionOf(s), displayName: s.display_name, mine: Number(s.owner_id) === actorUserId, target: ctx.cfgOn(s.day).activity.dailyTarget,
    results: res.filter((r) => r.submission_id === s.submission_id).map(resultOf),
  }));
}

const submissionOf = (s: Record<string, unknown>) => ({
  submissionId: Number(s.submission_id), participantId: Number(s.participant_id), day: s.day, fileId: Number(s.file_id), receivedAt: (s.received_at as Date).toISOString(),
  claimedValue: s.claimed_value, status: s.status, finalValue: s.final_value, source: s.source, correctionReason: s.correction_reason,
  appealNote: s.appeal_note, decisionReason: s.decision_reason, decidedAt: s.decided_at ? (s.decided_at as Date).toISOString() : null,
  part: !!s.part,
});

/** One submission with its history: for its owner or a reviewer. */
export async function submissionDetail(db: Queryable, actorUserId: number, submissionId: number): Promise<unknown> {
  const s = (await db.query(`SELECT * FROM submissions WHERE submission_id = $1`, [submissionId])).rows[0];
  if (!s) throw notFound('Submission not found.');
  const p = await participantById(db, Number(s.participant_id));
  if (p.userId !== actorUserId) {
    const access = await accessFor(db, actorUserId, Number(s.challenge_id));
    if (!access.permissions.has('submissions.review')) throw notFound('Submission not found.');
  }
  const res = (await db.query(`SELECT * FROM verification_results WHERE submission_id = $1 ORDER BY result_id`, [submissionId])).rows;
  return { ...submissionOf(s), displayName: p.displayName, results: res.map(resultOf) };
}

/** Whether a user may see a stored file: its owner, or a reviewer of the challenge the file is evidence in. */
export async function canSeeFile(db: Queryable, userId: number, fileId: number): Promise<{ storageKey: string; mimeType: string; purpose: string } | null> {
  const f = (await db.query(`SELECT * FROM files WHERE file_id = $1`, [fileId])).rows[0];
  if (!f || f.erased_at) return null; // erased by an admin: gone for everyone
  const out = { storageKey: String(f.storage_key), mimeType: String(f.mime_type), purpose: String(f.purpose) };
  if (Number(f.owner_user_id) === userId) return out;
  const uses = await db.query(
    `SELECT challenge_id, 'submissions.review' AS perm FROM submissions WHERE file_id = $1
     UNION SELECT challenge_id, 'exemptions.review' FROM exemption_requests WHERE evidence_file_id = $1`, [fileId]);
  for (const u of uses.rows) {
    const access = await accessFor(db, userId, Number(u.challenge_id));
    if (access.permissions.has(u.perm)) return out;
  }
  if (await canSeeBonusFile(db, userId, fileId)) return out;
  if (await canSeeFinanceFile(db, userId, fileId)) return out;
  if (await canSeeProfilePhoto(db, userId, fileId)) return out;
  if (await canSeeCommunityPhoto(db, userId, fileId)) return out;
  return null;
}

/** Submissions waiting for the AI: picked up again by the scheduler (retries) and after a restart. */
export async function pendingAi(pool: pg.Pool, now: Date): Promise<number[]> {
  const { rows } = await pool.query(
    `SELECT submission_id FROM submissions WHERE status = 'PENDING_AI' AND updated_at < $1::timestamptz - interval '1 minute' ORDER BY submission_id LIMIT 20`, [now]);
  return rows.map((r) => Number(r.submission_id));
}

export const deadlineOf = endOfDay;
