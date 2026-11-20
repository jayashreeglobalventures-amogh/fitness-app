// Someone else's profile page: what the viewer may see of their basic profile (each field's own visibility) and of
// their health profile (only through the database's health_shared_with(), never by reading health tables here).
import type { Queryable } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { sharedView } from '../health/health.js';
import { canSeeProfilePhoto, getOwnProfile, PROFILE_FIELDS } from './profile.js';

/** In a challenge together (participant, invitee or challenge role), or the viewer is a Super Admin - as for photos. */
async function sharesChallenge(db: Queryable, viewerId: number, ownerId: number): Promise<boolean> {
  const { rows } = await db.query(
    `WITH member AS (
       SELECT challenge_id, user_id FROM participants
       UNION SELECT challenge_id, user_id FROM invitations WHERE status IN ('INVITED','ACCEPTED')
       UNION SELECT challenge_id, user_id FROM challenge_roles)
     SELECT 1 FROM member a JOIN member b USING (challenge_id) WHERE a.user_id = $1 AND b.user_id = $2
     UNION SELECT 1 FROM platform_roles WHERE user_id = $1 AND role = 'SUPER_ADMIN' LIMIT 1`, [viewerId, ownerId]);
  return !!rows[0];
}

export async function personCard(db: Queryable, viewerId: number, ownerId: number, now: Date): Promise<unknown> {
  const { rows: [u] } = await db.query(`SELECT user_id, status, created_at FROM users WHERE user_id = $1`, [ownerId]);
  if (!u) throw notFound('Person not found.');
  const p = await getOwnProfile(db, ownerId);
  const self = viewerId === ownerId;
  const member = self || (await sharesChallenge(db, viewerId, ownerId));
  const fields: Record<string, string> = {};
  for (const f of PROFILE_FIELDS) {
    const v = p.fields[f];
    if (v && (self || p.visibility[f] === 'PUBLIC' || (p.visibility[f] === 'CHALLENGE_MEMBERS' && member))) fields[f] = v;
  }
  const { rows: common } = await db.query(
    `SELECT DISTINCT c.challenge_id, c.name FROM challenges c
       JOIN (SELECT challenge_id, user_id FROM participants UNION SELECT challenge_id, user_id FROM challenge_roles) a ON a.challenge_id = c.challenge_id AND a.user_id = $1
       JOIN (SELECT challenge_id, user_id FROM participants UNION SELECT challenge_id, user_id FROM challenge_roles) b ON b.challenge_id = c.challenge_id AND b.user_id = $2
      ORDER BY c.challenge_id DESC`, [viewerId, ownerId]);
  return {
    userId: ownerId, displayName: p.displayName, self, joined: u.created_at.toISOString(),
    photoFileId: p.photoFileId && (self || (await canSeeProfilePhoto(db, viewerId, p.photoFileId))) ? p.photoFileId : null,
    fields,
    challengesInCommon: self ? [] : common.map((c) => ({ challengeId: Number(c.challenge_id), name: c.name })),
    health: self ? null : await sharedView(db, viewerId, ownerId, now),
  };
}
