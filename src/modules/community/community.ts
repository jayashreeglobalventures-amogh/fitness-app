// Community feed (PRD 14), one per challenge: announcements (admins), posts with an optional photo, achievement shares
// generated from the person's own points (never health data), comments with one level of replies, reactions, pinned
// posts, reports, moderation (removal with a reason, audited) and posting restrictions (mutes).
// Readers: the challenge's participants and admins. Nothing is hard-deleted.
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, type Queryable } from '../../core/db.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { storeImage } from '../../core/media.js';
import { latestVersion } from '../challenges/challenges.js';
import { accessFor, type Access } from '../identity/permissions.js';

export const EMOJIS = ['👍', '❤️', '🔥', '👏', '💪'] as const;
const POSTS_PER_DAY = 20;
const COMMENTS_PER_DAY = 200;
const PAGE = 20;

interface Member { access: Access; participantStatus: string | null; moderator: boolean; canAnnounce: boolean }

/** Who the caller is to this challenge's community; refuses outsiders and challenges without a feed. */
async function member(db: Queryable, userId: number, challengeId: number): Promise<Member & { cfg: { enabled: boolean; participantsCanPost: boolean; photos: boolean } }> {
  const access = await accessFor(db, userId, challengeId);
  const { rows: [p] } = await db.query(`SELECT status FROM participants WHERE challenge_id = $1 AND user_id = $2`, [challengeId, userId]);
  const { rows: [ch] } = await db.query(`SELECT status FROM challenges WHERE challenge_id = $1`, [challengeId]);
  if (!ch) throw notFound('Challenge not found.');
  const admin = access.permissions.has('challenge.view_admin');
  if (!admin && !p) throw forbidden('Only this challenge\'s participants and admins can see its community.');
  const cfg = (await latestVersion(db, challengeId)).config.community;
  if (!cfg.enabled && !admin) throw forbidden('This challenge has no community feed.');
  return { access, participantStatus: p?.status ?? null, moderator: access.permissions.has('community.moderate'), canAnnounce: access.permissions.has('announcements.manage'), cfg };
}

async function assertCanWrite(db: Queryable, m: Member, userId: number, challengeId: number, now: Date): Promise<void> {
  const admin = m.access.permissions.has('challenge.view_admin');
  if (!admin && m.participantStatus !== 'ACTIVE') throw forbidden('Only active participants can post or comment.');
  const { rows: [mute] } = await db.query(`SELECT until, reason FROM community_mutes WHERE challenge_id = $1 AND user_id = $2 AND until > $3`, [challengeId, userId, now]);
  if (mute) throw forbidden(`You can't post or comment until ${mute.until.toLocaleDateString('en-IN')} (${mute.reason}).`);
}

async function rateLimit(db: Queryable, sql: string, params: unknown[], max: number, what: string): Promise<void> {
  const n = Number((await db.query(sql, params)).rows[0].n);
  if (n >= max) throw conflict(`You've reached today's limit of ${max} ${what}. Try again tomorrow.`);
}

// ---------- posts ----------

export interface NewPost { kind?: unknown; body?: unknown; photo?: Buffer | null; eventId?: unknown }

export async function createPost(db: Queryable, mediaDir: string, userId: number, challengeId: number, input: NewPost, now: Date): Promise<{ postId: number }> {
  await lockChallenge(db, challengeId);
  const m = await member(db, userId, challengeId);
  await assertCanWrite(db, m, userId, challengeId, now);
  const kind = String(input.kind ?? 'POST');
  if (!['ANNOUNCEMENT', 'POST', 'ACHIEVEMENT'].includes(kind)) throw validation('Unknown kind of post.');
  if (kind === 'ANNOUNCEMENT' && !m.canAnnounce) throw forbidden('Only admins post announcements.');
  if (kind !== 'ANNOUNCEMENT' && !m.cfg.participantsCanPost && !m.access.permissions.has('challenge.view_admin')) throw forbidden('In this challenge only admins post. You can still react and comment.');
  await rateLimit(db, `SELECT count(*) AS n FROM posts WHERE author_user_id = $1 AND challenge_id = $2 AND created_at > $3::timestamptz - interval '1 day'`, [userId, challengeId, now], POSTS_PER_DAY, 'posts');
  let body = String(input.body ?? '').trim();
  if (body.length > 2000) throw validation('A post can be at most 2,000 characters.');
  let achievement: Record<string, unknown> | null = null;
  if (kind === 'ACHIEVEMENT') {
    // Built from the person's OWN points event, so nothing private (health data, money) can be shared by accident.
    const { rows: [e] } = await db.query(
      `SELECT e.rule, e.day, e.points, e.details FROM scoring_events e JOIN participants p USING (participant_id)
        WHERE e.event_id = $1 AND p.user_id = $2 AND e.challenge_id = $3 AND e.kind = 'AWARD' AND e.points > 0
          AND e.rule IN ('PERSONAL_STREAK','TEAM_STREAK','COMEBACK','WEEKEND_BONUS')`, [Number(input.eventId), userId, challengeId]);
    if (!e) throw validation('Choose one of your own achievements to share.');
    achievement = { rule: e.rule, day: e.day, points: e.points, streak: e.details?.streak ?? e.details?.teamStreak ?? null };
    const line = e.rule === 'PERSONAL_STREAK' ? `🔥 Reached a ${e.details.streak}-day streak!` : e.rule === 'TEAM_STREAK' ? `🤝 Our team made it ${e.details.teamStreak} days in a row!`
      : e.rule === 'COMEBACK' ? '💪 Made a comeback!' : '🏅 Completed the weekend bonus activity!';
    body = body ? `${line}\n${body}` : line;
  }
  let photoFileId: number | null = null;
  if (input.photo?.length) {
    if (!m.cfg.photos) throw forbidden('Photos are switched off in this challenge\'s community.');
    if (input.photo.length > 5 * 1024 * 1024) throw validation('The photo is larger than 5 MB.');
    const s = await storeImage(mediaDir, userId, input.photo);
    photoFileId = Number((await db.query(
      `INSERT INTO files (owner_user_id, purpose, storage_key, sha256, mime_type, bytes, uploaded_by, created_at) VALUES ($1,'COMMUNITY_PHOTO',$2,$3,$4,$5,$1,$6) RETURNING file_id`,
      [userId, s.storageKey, s.sha256, s.mimeType, s.bytes, now])).rows[0].file_id);
  }
  if (!body && !photoFileId) throw validation('Write something or add a photo.');
  const { rows } = await db.query(
    `INSERT INTO posts (challenge_id, author_user_id, kind, body, photo_file_id, achievement, pinned_at, pinned_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING post_id`,
    [challengeId, userId, kind, body, photoFileId, achievement ? JSON.stringify(achievement) : null, kind === 'ANNOUNCEMENT' ? now : null, kind === 'ANNOUNCEMENT' ? userId : null, now]);
  const postId = Number(rows[0].post_id);
  if (kind === 'ANNOUNCEMENT') await writeAudit(db, now, { actorUserId: userId, challengeId, action: 'ANNOUNCEMENT_POSTED', entity: 'POST', entityId: postId });
  return { postId };
}

const reactionsOf = async (db: Queryable, postIds: number[], userId: number) => {
  if (!postIds.length) return new Map<number, { emoji: string; count: number; mine: boolean }[]>();
  const { rows } = await db.query(
    `SELECT post_id, emoji, count(*)::int AS n, bool_or(user_id = $2) AS mine FROM reactions WHERE post_id = ANY($1) GROUP BY post_id, emoji`, [postIds, userId]);
  const out = new Map<number, { emoji: string; count: number; mine: boolean }[]>();
  for (const r of rows) out.set(Number(r.post_id), [...(out.get(Number(r.post_id)) ?? []), { emoji: r.emoji, count: r.n, mine: r.mine }]);
  for (const [k, v] of out) out.set(k, v.sort((a, b) => EMOJIS.indexOf(a.emoji as never) - EMOJIS.indexOf(b.emoji as never)));
  return out;
};

const postOut = (r: Record<string, any>, userId: number, m: Member, reactions: { emoji: string; count: number; mine: boolean }[]) => ({
  postId: Number(r.post_id), kind: r.kind, body: r.status === 'VISIBLE' || m.moderator ? r.body : '', photoFileId: r.photo_file_id && (r.status === 'VISIBLE' || m.moderator) ? Number(r.photo_file_id) : null,
  status: r.status, removedReason: m.moderator ? r.removed_reason : null, pinned: !!r.pinned_at, createdAt: r.created_at.toISOString(),
  author: { userId: Number(r.author_user_id), displayName: r.display_name, photoFileId: r.author_photo ? Number(r.author_photo) : null },
  mine: Number(r.author_user_id) === userId, comments: Number(r.comment_count), reactions,
  canDelete: Number(r.author_user_id) === userId && r.status === 'VISIBLE', canModerate: m.moderator,
});

/** The feed: pinned posts first, then newest; 20 at a time (pass `before` = the last post id for the next page). */
export async function feed(db: Queryable, userId: number, challengeId: number, beforeRaw: unknown, now: Date): Promise<unknown> {
  const m = await member(db, userId, challengeId);
  const before = beforeRaw ? Number(beforeRaw) : null;
  const statusFilter = m.moderator ? `p.status IN ('VISIBLE','REMOVED')` : `p.status = 'VISIBLE'`;
  const select = `SELECT p.*, u.display_name, pr.photo_file_id AS author_photo,
      (SELECT count(*) FROM comments c WHERE c.post_id = p.post_id AND c.status = 'VISIBLE') AS comment_count
    FROM posts p JOIN users u ON u.user_id = p.author_user_id LEFT JOIN user_profiles pr ON pr.user_id = p.author_user_id`;
  const pinned = before ? [] : (await db.query(`${select} WHERE p.challenge_id = $1 AND p.pinned_at IS NOT NULL AND p.status = 'VISIBLE' ORDER BY p.pinned_at DESC`, [challengeId])).rows;
  const { rows } = await db.query(
    `${select} WHERE p.challenge_id = $1 AND ${statusFilter} AND p.pinned_at IS NULL ${before ? 'AND p.post_id < $3' : ''} ORDER BY p.post_id DESC LIMIT $2`,
    before ? [challengeId, PAGE + 1, before] : [challengeId, PAGE + 1]);
  const page = rows.slice(0, PAGE);
  const all = [...pinned, ...page];
  const reactions = await reactionsOf(db, all.map((r) => Number(r.post_id)), userId);
  const { rows: [mute] } = await db.query(`SELECT until, reason FROM community_mutes WHERE challenge_id = $1 AND user_id = $2 AND until > $3`, [challengeId, userId, now]);
  const admin = m.access.permissions.has('challenge.view_admin');
  return {
    pinned: pinned.map((r) => postOut(r, userId, m, reactions.get(Number(r.post_id)) ?? [])),
    posts: page.map((r) => postOut(r, userId, m, reactions.get(Number(r.post_id)) ?? [])),
    nextBefore: rows.length > PAGE ? Number(page[page.length - 1]!.post_id) : null,
    can: {
      post: !mute && (admin || (m.participantStatus === 'ACTIVE' && m.cfg.participantsCanPost)), comment: !mute && (admin || m.participantStatus === 'ACTIVE'),
      announce: m.canAnnounce, moderate: m.moderator, photos: m.cfg.photos,
    },
    muted: mute ? { until: mute.until.toISOString(), reason: mute.reason } : null,
    emojis: EMOJIS,
  };
}

async function postFor(db: Queryable, postId: number) {
  const { rows: [p] } = await db.query(`SELECT * FROM posts WHERE post_id = $1`, [postId]);
  if (!p) throw notFound('Post not found.');
  return p;
}

export async function deletePost(db: Queryable, userId: number, postId: number, now: Date): Promise<void> {
  const p = await postFor(db, postId);
  if (Number(p.author_user_id) !== userId) throw forbidden('You can only delete your own posts.');
  if (p.status !== 'VISIBLE') return;
  await db.query(`UPDATE posts SET status = 'DELETED', pinned_at = NULL, updated_at = $2 WHERE post_id = $1`, [postId, now]);
}

export async function react(db: Queryable, userId: number, postId: number, emojiRaw: unknown, now: Date): Promise<unknown> {
  const p = await postFor(db, postId);
  await member(db, userId, Number(p.challenge_id));
  if (p.status !== 'VISIBLE') throw conflict('This post is no longer available.');
  const emoji = String(emojiRaw ?? '');
  if (!(EMOJIS as readonly string[]).includes(emoji)) throw validation('Unknown reaction.');
  // Toggle: reacting again with the same emoji takes it back.
  const del = await db.query(`DELETE FROM reactions WHERE post_id = $1 AND user_id = $2 AND emoji = $3`, [postId, userId, emoji]);
  if (!del.rowCount) await db.query(`INSERT INTO reactions (post_id, user_id, emoji, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [postId, userId, emoji, now]);
  return (await reactionsOf(db, [postId], userId)).get(postId) ?? [];
}

// ---------- comments ----------

export async function comments(db: Queryable, userId: number, postId: number): Promise<unknown[]> {
  const p = await postFor(db, postId);
  const m = await member(db, userId, Number(p.challenge_id));
  if (p.status !== 'VISIBLE' && !m.moderator) throw notFound('Post not found.');
  const { rows } = await db.query(
    `SELECT c.*, u.display_name, pr.photo_file_id AS author_photo FROM comments c JOIN users u ON u.user_id = c.author_user_id LEFT JOIN user_profiles pr ON pr.user_id = c.author_user_id
      WHERE c.post_id = $1 AND c.status ${m.moderator ? "IN ('VISIBLE','REMOVED')" : "= 'VISIBLE'"} ORDER BY c.comment_id`, [postId]);
  return rows.map((c) => ({
    commentId: Number(c.comment_id), parentId: c.parent_comment_id ? Number(c.parent_comment_id) : null, body: c.body, status: c.status, removedReason: m.moderator ? c.removed_reason : null,
    createdAt: c.created_at.toISOString(), author: { userId: Number(c.author_user_id), displayName: c.display_name, photoFileId: c.author_photo ? Number(c.author_photo) : null },
    mine: Number(c.author_user_id) === userId,
  }));
}

export async function addComment(db: Queryable, userId: number, postId: number, input: { body: unknown; parentId?: unknown }, now: Date): Promise<{ commentId: number }> {
  const p = await postFor(db, postId);
  const challengeId = Number(p.challenge_id);
  const m = await member(db, userId, challengeId);
  await assertCanWrite(db, m, userId, challengeId, now);
  if (p.status !== 'VISIBLE') throw conflict('This post is no longer available.');
  await rateLimit(db, `SELECT count(*) AS n FROM comments c JOIN posts p USING (post_id) WHERE c.author_user_id = $1 AND p.challenge_id = $2 AND c.created_at > $3::timestamptz - interval '1 day'`, [userId, challengeId, now], COMMENTS_PER_DAY, 'comments');
  const body = String(input.body ?? '').trim();
  if (!body || body.length > 1000) throw validation('A comment is 1–1,000 characters.');
  let parent: number | null = null;
  if (input.parentId != null && input.parentId !== '') {
    const { rows: [pc] } = await db.query(`SELECT comment_id, parent_comment_id, post_id FROM comments WHERE comment_id = $1`, [Number(input.parentId)]);
    if (!pc || Number(pc.post_id) !== postId) throw validation('That comment isn\'t on this post.');
    parent = pc.parent_comment_id ? Number(pc.parent_comment_id) : Number(pc.comment_id); // one level of replies
  }
  const { rows } = await db.query(`INSERT INTO comments (post_id, parent_comment_id, author_user_id, body, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING comment_id`, [postId, parent, userId, body, now]);
  return { commentId: Number(rows[0].comment_id) };
}

export async function deleteComment(db: Queryable, userId: number, commentId: number): Promise<void> {
  const { rows: [c] } = await db.query(`SELECT * FROM comments WHERE comment_id = $1`, [commentId]);
  if (!c) throw notFound('Comment not found.');
  if (Number(c.author_user_id) !== userId) throw forbidden('You can only delete your own comments.');
  await db.query(`UPDATE comments SET status = 'DELETED' WHERE comment_id = $1 AND status = 'VISIBLE'`, [commentId]);
}

// ---------- reports and moderation ----------

export async function report(db: Queryable, userId: number, target: { postId?: unknown; commentId?: unknown }, reasonRaw: unknown, now: Date): Promise<void> {
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 3 || reason.length > 500) throw validation('Say briefly what is wrong (3–500 characters).');
  let challengeId: number, postId: number | null = null, commentId: number | null = null;
  if (target.commentId != null) {
    const { rows: [c] } = await db.query(`SELECT c.comment_id, p.challenge_id FROM comments c JOIN posts p USING (post_id) WHERE c.comment_id = $1`, [Number(target.commentId)]);
    if (!c) throw notFound('Comment not found.');
    challengeId = Number(c.challenge_id); commentId = Number(c.comment_id);
  } else {
    const p = await postFor(db, Number(target.postId));
    challengeId = Number(p.challenge_id); postId = Number(p.post_id);
  }
  await member(db, userId, challengeId);
  await db.query(`INSERT INTO community_reports (challenge_id, post_id, comment_id, reporter_user_id, reason, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [challengeId, postId, commentId, userId, reason, now]);
}

export async function reports(db: Queryable, userId: number, challengeId: number): Promise<unknown[]> {
  const m = await member(db, userId, challengeId);
  if (!m.moderator) throw forbidden();
  const { rows } = await db.query(
    `SELECT r.*, u.display_name AS reporter, coalesce(p.body, c.body) AS body, coalesce(pa.display_name, ca.display_name) AS author, coalesce(p.status, c.status) AS target_status,
            coalesce(p.author_user_id, c.author_user_id) AS author_user_id
       FROM community_reports r JOIN users u ON u.user_id = r.reporter_user_id
       LEFT JOIN posts p ON p.post_id = r.post_id LEFT JOIN users pa ON pa.user_id = p.author_user_id
       LEFT JOIN comments c ON c.comment_id = r.comment_id LEFT JOIN users ca ON ca.user_id = c.author_user_id
      WHERE r.challenge_id = $1 AND r.status = 'OPEN' ORDER BY r.created_at`, [challengeId]);
  return rows.map((r) => ({ reportId: Number(r.report_id), postId: r.post_id ? Number(r.post_id) : null, commentId: r.comment_id ? Number(r.comment_id) : null, reporter: r.reporter,
    reason: r.reason, body: r.body, author: r.author, authorUserId: Number(r.author_user_id), targetStatus: r.target_status, createdAt: r.created_at.toISOString() }));
}

/** A moderator removes a post or comment (reason required, audited); open reports on it are closed as actioned. */
export async function remove(db: Queryable, userId: number, target: { postId?: unknown; commentId?: unknown }, reasonRaw: unknown, now: Date): Promise<void> {
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason for removing it (at least 5 characters).');
  if (target.commentId != null) {
    const { rows: [c] } = await db.query(`SELECT c.*, p.challenge_id FROM comments c JOIN posts p USING (post_id) WHERE c.comment_id = $1`, [Number(target.commentId)]);
    if (!c) throw notFound('Comment not found.');
    const m = await member(db, userId, Number(c.challenge_id));
    if (!m.moderator) throw forbidden();
    await db.query(`UPDATE comments SET status = 'REMOVED', removed_by = $2, removed_reason = $3 WHERE comment_id = $1`, [c.comment_id, userId, reason]);
    await db.query(`UPDATE community_reports SET status = 'ACTIONED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE comment_id = $1 AND status = 'OPEN'`, [c.comment_id, userId, now, reason]);
    await writeAudit(db, now, { actorUserId: userId, challengeId: Number(c.challenge_id), action: 'COMMENT_REMOVED', entity: 'COMMENT', entityId: Number(c.comment_id), reason, before: { author: Number(c.author_user_id), body: c.body } });
    return;
  }
  const p = await postFor(db, Number(target.postId));
  const m = await member(db, userId, Number(p.challenge_id));
  if (!m.moderator) throw forbidden();
  await db.query(`UPDATE posts SET status = 'REMOVED', pinned_at = NULL, removed_by = $2, removed_reason = $3, updated_at = $4 WHERE post_id = $1`, [p.post_id, userId, reason, now]);
  await db.query(`UPDATE community_reports SET status = 'ACTIONED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE post_id = $1 AND status = 'OPEN'`, [p.post_id, userId, now, reason]);
  await writeAudit(db, now, { actorUserId: userId, challengeId: Number(p.challenge_id), action: 'POST_REMOVED', entity: 'POST', entityId: Number(p.post_id), reason, before: { author: Number(p.author_user_id), body: p.body } });
}

export async function dismissReport(db: Queryable, userId: number, reportId: number, noteRaw: unknown, now: Date): Promise<void> {
  const { rows: [r] } = await db.query(`SELECT * FROM community_reports WHERE report_id = $1`, [reportId]);
  if (!r) throw notFound('Report not found.');
  const m = await member(db, userId, Number(r.challenge_id));
  if (!m.moderator) throw forbidden();
  await db.query(`UPDATE community_reports SET status = 'DISMISSED', decided_by = $2, decided_at = $3, decision_note = $4 WHERE report_id = $1 AND status = 'OPEN'`,
    [reportId, userId, now, String(noteRaw ?? '').trim().slice(0, 500) || null]);
}

export async function pin(db: Queryable, userId: number, postId: number, on: boolean, now: Date): Promise<void> {
  const p = await postFor(db, postId);
  const m = await member(db, userId, Number(p.challenge_id));
  if (!m.moderator) throw forbidden();
  if (p.status !== 'VISIBLE') throw conflict('Only a visible post can be pinned.');
  await db.query(`UPDATE posts SET pinned_at = $2, pinned_by = $3, updated_at = $4 WHERE post_id = $1`, [postId, on ? now : null, on ? userId : null, now]);
}

/** Posting restriction: until a time, with a reason (audited). days = 0 lifts it. */
export async function mute(db: Queryable, actorUserId: number, challengeId: number, input: { userId: unknown; days: unknown; reason: unknown }, now: Date): Promise<void> {
  const m = await member(db, actorUserId, challengeId);
  if (!m.moderator) throw forbidden();
  const target = Number(input.userId);
  if (target === actorUserId) throw validation('You can\'t mute yourself.');
  const days = Number(input.days);
  if (!Number.isFinite(days) || days < 0 || days > 60) throw validation('Mute for 0–60 days (0 lifts it).');
  const reason = String(input.reason ?? '').trim();
  if (days > 0 && reason.length < 5) throw validation('Give a reason (at least 5 characters).');
  if (days === 0) await db.query(`DELETE FROM community_mutes WHERE challenge_id = $1 AND user_id = $2`, [challengeId, target]);
  else await db.query(
    `INSERT INTO community_mutes (challenge_id, user_id, until, reason, muted_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (challenge_id, user_id) DO UPDATE SET until = EXCLUDED.until, reason = EXCLUDED.reason, muted_by = EXCLUDED.muted_by, created_at = EXCLUDED.created_at`,
    [challengeId, target, new Date(now.getTime() + days * 86_400_000), reason, actorUserId, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: days ? 'COMMUNITY_MUTED' : 'COMMUNITY_UNMUTED', entity: 'USER', entityId: target, reason: reason || null, after: { days } });
}

/** Achievements the person may share (their own positive milestone events). */
export async function myAchievements(db: Queryable, userId: number, challengeId: number): Promise<unknown[]> {
  await member(db, userId, challengeId);
  const { rows } = await db.query(
    `SELECT e.event_id, e.rule, e.day, e.points, e.details FROM scoring_events e JOIN participants p USING (participant_id)
      WHERE p.user_id = $1 AND e.challenge_id = $2 AND e.kind = 'AWARD' AND e.points > 0 AND e.rule IN ('PERSONAL_STREAK','TEAM_STREAK','COMEBACK','WEEKEND_BONUS')
        AND NOT EXISTS (SELECT 1 FROM scoring_events r WHERE r.reverses_event_id = e.event_id)
      ORDER BY e.day DESC LIMIT 20`, [userId, challengeId]);
  return rows.map((r) => ({ eventId: Number(r.event_id), rule: r.rule, day: r.day, points: r.points, streak: r.details?.streak ?? r.details?.teamStreak ?? null }));
}

/** Whether a viewer may see a community photo: a member of that challenge, while the post is visible (moderators always). */
export async function canSeeCommunityPhoto(db: Queryable, userId: number, fileId: number): Promise<boolean> {
  const { rows } = await db.query(`SELECT challenge_id, status FROM posts WHERE photo_file_id = $1`, [fileId]);
  for (const r of rows) {
    try {
      const m = await member(db, userId, Number(r.challenge_id));
      if (r.status === 'VISIBLE' || m.moderator) return true;
    } catch { /* not a member */ }
  }
  return false;
}
