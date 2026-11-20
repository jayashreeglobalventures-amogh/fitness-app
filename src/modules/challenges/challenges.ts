// Challenges: create, edit rules (versioned), publish, duplicate, archive, admin roles.
// Lifecycle: DRAFT -> PUBLISHED -> ARCHIVED. "Active"/"finished" are not stored: they follow from the dates.
// Rules are versioned (challenge_versions): a DRAFT's single version is edited in place; once PUBLISHED every
// change is a NEW version effective from a future day, so days already played keep the rules they were played under.
import { writeAudit } from '../../core/audit.js';
import { lockChallenge, type Queryable } from '../../core/db.js';
import { daysBetween, isValidDate, localDay } from '../../core/dates.js';
import { conflict, forbidden, notFound, validation } from '../../core/errors.js';
import { accessFor, requirePermission, type ChallengeRole } from '../identity/permissions.js';
import { changedSections, FINANCIAL_SECTIONS, normalizeConfig, validateConfig, type ChallengeConfig, type ConfigIssue } from './config.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export interface ChallengeRow {
  challengeId: number; slug: string; name: string; category: string; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  timeZone: string; startsOn: string; endsOn: string;
}

export interface ChallengeVersion { versionNo: number; effectiveFrom: string; config: ChallengeConfig; reason: string | null; createdAt: string }

function rowOf(r: Record<string, unknown>): ChallengeRow {
  return { challengeId: Number(r.challenge_id), slug: String(r.slug), name: String(r.name), category: String(r.category), status: r.status as ChallengeRow['status'],
    timeZone: String(r.time_zone), startsOn: String(r.starts_on), endsOn: String(r.ends_on) };
}

export async function getChallenge(db: Queryable, challengeId: number, forUpdate = false): Promise<ChallengeRow> {
  if (!Number.isSafeInteger(challengeId)) throw notFound('Challenge not found.');
  const { rows } = await db.query(`SELECT * FROM challenges WHERE challenge_id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [challengeId]);
  if (!rows[0]) throw notFound('Challenge not found.');
  return rowOf(rows[0]);
}

export async function versions(db: Queryable, challengeId: number): Promise<ChallengeVersion[]> {
  const { rows } = await db.query(
    `SELECT version_no, effective_from, config, reason, created_at FROM challenge_versions WHERE challenge_id = $1 ORDER BY version_no`, [challengeId]);
  return rows.map((r) => ({ versionNo: r.version_no, effectiveFrom: r.effective_from, config: normalizeConfig(r.config), reason: r.reason, createdAt: r.created_at.toISOString() }));
}

export async function latestVersion(db: Queryable, challengeId: number): Promise<ChallengeVersion> {
  const all = await versions(db, challengeId);
  if (!all.length) throw notFound('Challenge has no configuration.');
  return all[all.length - 1]!;
}

/** The rules in force on a challenge day: the newest version whose effective_from is on or before it. */
export function versionOn(all: ChallengeVersion[], day: string): ChallengeVersion {
  let pick = all[0]!;
  for (const v of all) if (daysBetween(v.effectiveFrom, day) >= 0) pick = v;
  return pick;
}

function invalid(errors: ConfigIssue[]): never {
  throw validation('The challenge settings are not valid.', { errors });
}

async function mirror(db: Queryable, challengeId: number, c: ChallengeConfig, now: Date): Promise<void> {
  await db.query(`UPDATE challenges SET name = $2, category = $3, time_zone = $4, starts_on = $5, ends_on = $6, updated_at = $7 WHERE challenge_id = $1`,
    [challengeId, c.basics.name, c.basics.category, c.basics.timeZone, c.basics.startDate, c.basics.endDate, now]);
}

export async function createChallenge(db: Queryable, actorUserId: number, slugRaw: unknown, config: unknown, now: Date, duplicatedFrom: number | null = null): Promise<{ challengeId: number; warnings: ConfigIssue[] }> {
  requirePermission(await accessFor(db, actorUserId, null), 'challenge.create');
  const slug = String(slugRaw ?? '').trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw validation('Short name (slug): 2–63 characters, a–z, 0–9 and hyphens, starting with a letter or digit.');
  const check = validateConfig(config);
  if (!check.ok) invalid(check.errors);
  const c = normalizeConfig(config) as ChallengeConfig;
  const dup = await db.query(`SELECT 1 FROM challenges WHERE slug = $1`, [slug]);
  if (dup.rows.length) throw conflict(`A challenge with the short name "${slug}" already exists.`);
  const { rows } = await db.query(
    `INSERT INTO challenges (slug, name, category, status, time_zone, starts_on, ends_on, duplicated_from, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,$9) RETURNING challenge_id`,
    [slug, c.basics.name, c.basics.category, c.basics.timeZone, c.basics.startDate, c.basics.endDate, duplicatedFrom, actorUserId, now]);
  const challengeId = Number(rows[0].challenge_id);
  await db.query(
    `INSERT INTO challenge_versions (challenge_id, version_no, config, effective_from, reason, created_by, created_at, updated_at)
     VALUES ($1, 1, $2, $3, 'Initial settings', $4, $5, $5)`,
    [challengeId, JSON.stringify(c), c.basics.startDate, actorUserId, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: duplicatedFrom ? 'CHALLENGE_DUPLICATED' : 'CHALLENGE_CREATED', entity: 'CHALLENGE', entityId: challengeId,
    after: { slug, name: c.basics.name, duplicatedFrom } });
  return { challengeId, warnings: check.warnings };
}

export interface ConfigUpdate { config: unknown; effectiveFrom?: unknown; reason?: unknown }

/**
 * Saves new settings. DRAFT: replaces version 1. PUBLISHED: adds a version effective from a future day (a reason is
 * required). Financial sections need challenge.config.edit_financial (Super Admin).
 */
export async function updateConfig(db: Queryable, actorUserId: number, challengeId: number, input: ConfigUpdate, now: Date): Promise<{ versionNo: number; warnings: ConfigIssue[] }> {
  await lockChallenge(db, challengeId);
  const ch = await getChallenge(db, challengeId, true);
  const access = await accessFor(db, actorUserId, challengeId);
  requirePermission(access, 'challenge.config.edit');
  if (ch.status === 'ARCHIVED') throw conflict('An archived challenge can\'t be changed.');
  const check = validateConfig(input.config);
  if (!check.ok) invalid(check.errors);
  const next = normalizeConfig(input.config) as ChallengeConfig;
  const cur = await latestVersion(db, challengeId);
  const changed = changedSections(cur.config, next);
  if (!changed.length) return { versionNo: cur.versionNo, warnings: check.warnings };
  if (changed.some((s) => (FINANCIAL_SECTIONS as readonly string[]).includes(s))) requirePermission(access, 'challenge.config.edit_financial');

  if (ch.status === 'DRAFT') {
    await db.query(`UPDATE challenge_versions SET config = $3, effective_from = $4, updated_at = $5 WHERE challenge_id = $1 AND version_no = $2`,
      [challengeId, cur.versionNo, JSON.stringify(next), next.basics.startDate, now]);
    await mirror(db, challengeId, next, now);
    await writeAudit(db, now, { actorUserId, challengeId, action: 'CHALLENGE_CONFIG_EDITED', entity: 'CHALLENGE', entityId: challengeId,
      before: pick(cur.config, changed), after: pick(next, changed) });
    return { versionNo: cur.versionNo, warnings: check.warnings };
  }

  // PUBLISHED: a new version. Days that have begun keep their rules.
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason for changing the rules of a published challenge (at least 5 characters).');
  const today = localDay(now, cur.config.basics.timeZone);
  const started = daysBetween(cur.config.basics.startDate, today) >= 0;
  // Before the start nothing has been played: the new rules simply apply from the (possibly new) start date.
  let effectiveFrom = next.basics.startDate;
  if (started) {
    effectiveFrom = String(input.effectiveFrom ?? '');
    if (!isValidDate(effectiveFrom)) throw validation('Choose the first day the new rules apply (YYYY-MM-DD).');
    if (daysBetween(today, effectiveFrom) < 1) throw validation(`Rules can only change from tomorrow (${today} has already begun).`);
    if (daysBetween(cur.effectiveFrom, effectiveFrom) < 0) throw validation(`The latest rules apply from ${cur.effectiveFrom}; new rules must start on or after that day.`);
    if (daysBetween(effectiveFrom, next.basics.endDate) < 0) throw validation('The new rules must start on or before the end date.');
    if (next.basics.startDate !== cur.config.basics.startDate) throw validation('The start date can\'t change after the challenge has started.');
    if (next.basics.timeZone !== cur.config.basics.timeZone) throw validation('The time zone can\'t change after the challenge has started.');
    if (daysBetween(today, next.basics.endDate) < 0) throw validation('The end date can\'t be moved into the past.');
    if (next.periods.weekStartsOn !== cur.config.periods.weekStartsOn) throw validation('The week boundary can\'t change after the challenge has started.');
  }
  const versionNo = cur.versionNo + 1;
  await db.query(
    `INSERT INTO challenge_versions (challenge_id, version_no, config, effective_from, reason, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
    [challengeId, versionNo, JSON.stringify(next), effectiveFrom, reason, actorUserId, now]);
  await mirror(db, challengeId, next, now);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'CHALLENGE_RULES_VERSIONED', entity: 'CHALLENGE', entityId: challengeId, reason,
    before: { versionNo: cur.versionNo, ...pick(cur.config, changed) }, after: { versionNo, effectiveFrom, ...pick(next, changed) } });
  return { versionNo, warnings: check.warnings };
}

const pick = (c: ChallengeConfig, keys: string[]) => Object.fromEntries(keys.map((k) => [k, (c as Record<string, unknown>)[k]]));

export async function publish(db: Queryable, actorUserId: number, challengeId: number, now: Date): Promise<{ warnings: ConfigIssue[] }> {
  await lockChallenge(db, challengeId);
  const ch = await getChallenge(db, challengeId, true);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'challenge.publish');
  if (ch.status !== 'DRAFT') throw conflict('Only a draft can be published.');
  const cur = await latestVersion(db, challengeId);
  const check = validateConfig(cur.config);
  if (!check.ok) invalid(check.errors);
  await db.query(`UPDATE challenges SET status = 'PUBLISHED', published_at = $2, updated_at = $2 WHERE challenge_id = $1`, [challengeId, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'CHALLENGE_PUBLISHED', entity: 'CHALLENGE', entityId: challengeId, after: { versionNo: cur.versionNo } });
  return { warnings: check.warnings };
}

export async function archive(db: Queryable, actorUserId: number, challengeId: number, reasonRaw: unknown, now: Date): Promise<void> {
  await lockChallenge(db, challengeId);
  const ch = await getChallenge(db, challengeId, true);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'challenge.publish');
  if (ch.status === 'ARCHIVED') return;
  const reason = String(reasonRaw ?? '').trim();
  if (reason.length < 5) throw validation('Give a reason for archiving (at least 5 characters).');
  await db.query(`UPDATE challenges SET status = 'ARCHIVED', archived_at = $2, updated_at = $2 WHERE challenge_id = $1`, [challengeId, now]);
  await writeAudit(db, now, { actorUserId, challengeId, action: 'CHALLENGE_ARCHIVED', entity: 'CHALLENGE', entityId: challengeId, reason, before: { status: ch.status } });
}

/** A new DRAFT with the latest rules of another challenge (its dates usually need changing before publishing). */
export async function duplicate(db: Queryable, actorUserId: number, challengeId: number, slug: unknown, now: Date): Promise<{ challengeId: number; warnings: ConfigIssue[] }> {
  await getChallenge(db, challengeId);
  const cur = await latestVersion(db, challengeId);
  const config: ChallengeConfig = { ...cur.config, basics: { ...cur.config.basics, name: `${cur.config.basics.name} (copy)`.slice(0, 80) } };
  return createChallenge(db, actorUserId, slug, config, now, challengeId);
}

export async function setRole(db: Queryable, actorUserId: number, challengeId: number, userId: number, roleRaw: unknown, grant: boolean, now: Date): Promise<void> {
  await getChallenge(db, challengeId);
  requirePermission(await accessFor(db, actorUserId, challengeId), 'challenge.roles.manage');
  const role = String(roleRaw ?? '');
  if (role !== 'CHALLENGE_ADMIN' && role !== 'FINANCE_ADMIN') throw validation('Role must be CHALLENGE_ADMIN or FINANCE_ADMIN.');
  const u = await db.query(`SELECT status FROM users WHERE user_id = $1`, [userId]);
  if (!u.rows[0]) throw notFound('User not found.');
  if (grant) {
    const r = await db.query(`INSERT INTO challenge_roles (challenge_id, user_id, role, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [challengeId, userId, role, actorUserId, now]);
    if (!r.rowCount) return;
  } else {
    const r = await db.query(`DELETE FROM challenge_roles WHERE challenge_id = $1 AND user_id = $2 AND role = $3`, [challengeId, userId, role]);
    if (!r.rowCount) return;
  }
  await writeAudit(db, now, { actorUserId, challengeId, action: grant ? 'CHALLENGE_ROLE_GRANTED' : 'CHALLENGE_ROLE_REVOKED', entity: 'USER', entityId: userId, after: { role } });
}

export async function listRoles(db: Queryable, challengeId: number): Promise<{ userId: number; username: string; displayName: string; role: ChallengeRole }[]> {
  const { rows } = await db.query(
    `SELECT r.user_id, u.username, u.display_name, r.role FROM challenge_roles r JOIN users u USING (user_id) WHERE r.challenge_id = $1 ORDER BY u.username, r.role`, [challengeId]);
  return rows.map((r) => ({ userId: Number(r.user_id), username: r.username, displayName: r.display_name, role: r.role }));
}

export type Phase = 'DRAFT' | 'UPCOMING' | 'ACTIVE' | 'FINISHED' | 'ARCHIVED';
export function phaseOf(ch: ChallengeRow, now: Date): Phase {
  if (ch.status === 'DRAFT' || ch.status === 'ARCHIVED') return ch.status;
  const today = localDay(now, ch.timeZone);
  if (daysBetween(today, ch.startsOn) > 0) return 'UPCOMING';
  if (daysBetween(ch.endsOn, today) > 0) return 'FINISHED';
  return 'ACTIVE';
}

/**
 * The challenges a user can see in the Challenges tab, with what they are to it.
 * Super Admin: all. Others: those they administer, take part in or are invited to, plus published ALL_MEMBERS ones.
 */
export async function listForUser(db: Queryable, userId: number, now: Date): Promise<unknown[]> {
  const isSuper = (await accessFor(db, userId, null)).platformRoles.includes('SUPER_ADMIN');
  const { rows } = await db.query(
    `SELECT c.*, v.config->'basics'->>'description' AS description, v.config->'basics'->>'visibility' AS visibility,
            (SELECT array_agg(role ORDER BY role) FROM challenge_roles r WHERE r.challenge_id = c.challenge_id AND r.user_id = $1) AS roles,
            (SELECT status FROM participants p WHERE p.challenge_id = c.challenge_id AND p.user_id = $1) AS participant_status,
            (SELECT invitation_id FROM invitations i WHERE i.challenge_id = c.challenge_id AND i.user_id = $1 AND i.status = 'INVITED' AND i.expires_at > $3) AS open_invitation_id
       FROM challenges c
       JOIN LATERAL (SELECT config FROM challenge_versions WHERE challenge_id = c.challenge_id ORDER BY version_no DESC LIMIT 1) v ON true
      WHERE $2::boolean
         OR EXISTS (SELECT 1 FROM challenge_roles r WHERE r.challenge_id = c.challenge_id AND r.user_id = $1)
         OR (c.status <> 'DRAFT' AND (
              EXISTS (SELECT 1 FROM participants p WHERE p.challenge_id = c.challenge_id AND p.user_id = $1)
           OR EXISTS (SELECT 1 FROM invitations i WHERE i.challenge_id = c.challenge_id AND i.user_id = $1 AND i.status = 'INVITED' AND i.expires_at > $3)
           OR (c.status = 'PUBLISHED' AND v.config->'basics'->>'visibility' = 'ALL_MEMBERS')))
      ORDER BY c.starts_on DESC, c.challenge_id DESC`, [userId, isSuper, now]);
  return rows.map((r) => {
    const ch = rowOf(r);
    return { ...ch, phase: phaseOf(ch, now), description: r.description, myRoles: r.roles ?? [], participantStatus: r.participant_status ?? null,
      openInvitationId: r.open_invitation_id ? Number(r.open_invitation_id) : null };
  });
}

/**
 * One challenge as a user may see it. Admins (challenge.view_admin) get every version; members get the current rules.
 * A DRAFT is visible to admins only.
 */
export async function viewChallenge(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const ch = await getChallenge(db, challengeId);
  const access = await accessFor(db, userId, challengeId);
  const isAdmin = access.permissions.has('challenge.view_admin');
  if (!isAdmin) {
    if (ch.status === 'DRAFT') throw notFound('Challenge not found.');
    const { rows } = await db.query(
      `SELECT (SELECT status FROM participants WHERE challenge_id = $1 AND user_id = $2) AS p,
              EXISTS (SELECT 1 FROM invitations WHERE challenge_id = $1 AND user_id = $2 AND status = 'INVITED' AND expires_at > $3) AS inv`, [challengeId, userId, now]);
    const all = await versions(db, challengeId);
    const visibleToAll = all[all.length - 1]!.config.basics.visibility === 'ALL_MEMBERS' && ch.status === 'PUBLISHED';
    if (!rows[0].p && !rows[0].inv && !visibleToAll) throw notFound('Challenge not found.');
  }
  const all = await versions(db, challengeId);
  const today = localDay(now, ch.timeZone);
  // Before the start, the rules that matter are those of day one.
  const current = versionOn(all, daysBetween(ch.startsOn, today) >= 0 ? today : ch.startsOn);
  const latest = all[all.length - 1]!;
  return {
    ...ch, phase: phaseOf(ch, now), today,
    // The version a new participant accepts: always the latest (it may start later than today).
    acceptVersionNo: latest.versionNo,
    participantStatus: (await db.query(`SELECT status FROM participants WHERE challenge_id = $1 AND user_id = $2`, [challengeId, userId])).rows[0]?.status ?? null,
    current: { versionNo: current.versionNo, effectiveFrom: current.effectiveFrom, config: current.config },
    upcoming: latest.versionNo !== current.versionNo ? { versionNo: latest.versionNo, effectiveFrom: latest.effectiveFrom, config: latest.config } : null,
    versions: isAdmin ? all : undefined,
    myRoles: access.challengeRoles, myPermissions: [...access.permissions],
    check: isAdmin ? validateConfig(latest.config) : undefined,
  };
}

/** Throws unless the caller may administer this challenge in some way. */
export async function requireAdmin(db: Queryable, userId: number, challengeId: number): Promise<void> {
  const access = await accessFor(db, userId, challengeId);
  if (!access.permissions.has('challenge.view_admin')) throw forbidden();
}
