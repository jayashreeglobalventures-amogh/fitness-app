// Users, passwords, sessions and lockout - the AaryaShree IMS model (src/auth/users.ts there), adapted:
// users are global (no business), roles are per challenge (permissions.ts).
// Passwords: argon2id, min 10 chars, never logged or audited. Sessions: random 32-byte token in an HttpOnly
// cookie; only its SHA-256 is stored, so a database leak doesn't leak live sessions.
// Accounts are created by an admin with a temporary password, which must be changed at first sign-in.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type pg from 'pg';
import { writeAudit } from '../../core/audit.js';
import type { Queryable } from '../../core/db.js';
import { AppError, conflict, notFound, validation } from '../../core/errors.js';

const ARGON2ID = 2; // @node-rs/argon2 Algorithm.Argon2id
export const MIN_PASSWORD = 10;
export const SESSION_IDLE_DAYS = 14;
export const SESSION_MAX_DAYS = 60;
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;
export const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

export interface SessionUser {
  userId: number;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
}

export const hashPassword = (pw: string) => hash(pw, { algorithm: ARGON2ID });
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const normalizeUsername = (u: unknown) => String(u ?? '').trim().toLowerCase();

/** Readable temporary password: 14 chars from an unambiguous alphabet (~80 bits). */
export function generateTempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 14; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function checkPassword(pw: unknown): string | null {
  const s = String(pw ?? '');
  if (s.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (s.length > 200) return 'Password is too long.';
  return null;
}

function toSessionUser(u: Record<string, unknown>): SessionUser {
  return { userId: Number(u.user_id), username: String(u.username), displayName: String(u.display_name), mustChangePassword: !!u.must_change_password };
}

// ==================== Login / sessions ====================

export async function isLockedOut(db: Queryable, username: string, ip: string | null, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - LOCKOUT_MINUTES * 60_000);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM login_attempts WHERE username = $1 AND ip IS NOT DISTINCT FROM $2::inet AND NOT success AND at > $3
       AND at > COALESCE((SELECT max(at) FROM login_attempts WHERE username = $1 AND ip IS NOT DISTINCT FROM $2::inet AND success), '-infinity')`,
    [username, ip, since],
  );
  return rows[0].n >= LOCKOUT_FAILURES;
}

/** A new session token, or an error for bad credentials / disabled user / lockout (same message for the first two). */
export async function login(db: pg.Pool, usernameRaw: unknown, password: unknown, meta: { ip: string | null; userAgent: string }, now: Date):
  Promise<{ token: string; user: SessionUser } | { error: 'INVALID' | 'LOCKED' }> {
  const username = normalizeUsername(usernameRaw).slice(0, 64);
  const { rows } = await db.query(`SELECT * FROM users WHERE username = $1`, [username]);
  const u = rows[0];
  // Activity log: failures against a real account are recorded against it; for unknown usernames nothing typed is
  // kept (people sometimes type their password into the username box).
  const audit = (action: string, reason?: string) => writeAudit(db, now, {
    actorUserId: u ? Number(u.user_id) : null, action, entity: u ? 'USER' : 'USERNAME', entityId: u ? Number(u.user_id) : '(unknown)', reason, ip: meta.ip,
  });
  if (await isLockedOut(db, username, meta.ip, now)) {
    await audit('SIGN_IN_BLOCKED', 'Too many failed attempts (locked for a while)');
    return { error: 'LOCKED' };
  }
  let good = false;
  if (u && u.status === 'ACTIVE') good = await verify(u.password_hash, String(password ?? ''));
  else await hashPassword(String(password ?? 'x')); // equalise timing for unknown/disabled users
  await db.query(`INSERT INTO login_attempts (username, ip, success, at) VALUES ($1, $2, $3, $4)`, [username, meta.ip, good, now]);
  if (!good) {
    const locked = await isLockedOut(db, username, meta.ip, now);
    await audit(locked ? 'SIGN_IN_LOCKED' : 'SIGN_IN_FAILED', !u ? 'Unknown username' : u.status !== 'ACTIVE' ? 'Account disabled' : 'Wrong password');
    return { error: locked ? 'LOCKED' : 'INVALID' };
  }
  await audit('SIGNED_IN');

  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + SESSION_IDLE_DAYS * 86_400_000);
  await db.query(
    `INSERT INTO sessions (session_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip) VALUES ($1,$2,$3,$3,$4,$5,$6)`,
    [tokenHash(token), u.user_id, now, expires, meta.userAgent.slice(0, 300), meta.ip],
  );
  await db.query(`UPDATE users SET last_login_at = $2 WHERE user_id = $1`, [u.user_id, now]);
  return { token, user: toSessionUser(u) };
}

/** Resolves a cookie token to an active user and slides the idle expiry (capped at SESSION_MAX_DAYS from login). */
export async function resolveSession(db: Queryable, token: string | undefined, now: Date): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const { rows } = await db.query(
    `UPDATE sessions s SET last_seen_at = $2,
            expires_at = LEAST(s.created_at + interval '${SESSION_MAX_DAYS} days', $2::timestamptz + interval '${SESSION_IDLE_DAYS} days')
       FROM users u
      WHERE s.session_hash = $1 AND s.user_id = u.user_id AND s.revoked_at IS NULL AND s.expires_at > $2 AND u.status = 'ACTIVE'
      RETURNING u.*`,
    [tokenHash(token), now],
  );
  return rows[0] ? toSessionUser(rows[0]) : null;
}

export async function logout(db: Queryable, token: string | undefined, now: Date): Promise<void> {
  if (!token) return;
  const { rows } = await db.query(`UPDATE sessions SET revoked_at = $2 WHERE session_hash = $1 AND revoked_at IS NULL RETURNING user_id`, [tokenHash(token), now]);
  if (rows[0]) await writeAudit(db, now, { actorUserId: Number(rows[0].user_id), action: 'SIGNED_OUT', entity: 'USER', entityId: Number(rows[0].user_id) });
}

async function revokeAll(db: Queryable, userId: number, now: Date, exceptToken?: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL AND session_hash IS DISTINCT FROM $3`,
    [userId, now, exceptToken ? tokenHash(exceptToken) : null]);
}

export async function changeOwnPassword(db: Queryable, user: SessionUser, current: unknown, next: unknown, currentToken: string, now: Date): Promise<void> {
  const weak = checkPassword(next);
  if (weak) throw validation(weak);
  const { rows } = await db.query(`SELECT password_hash FROM users WHERE user_id = $1`, [user.userId]);
  if (!rows[0] || !(await verify(rows[0].password_hash, String(current ?? '')))) throw validation('Current password is incorrect.');
  if (String(next) === String(current)) throw validation('Choose a password different from the current one.');
  await db.query(`UPDATE users SET password_hash = $2, must_change_password = false, password_changed_at = $3, updated_at = $3 WHERE user_id = $1`,
    [user.userId, await hashPassword(String(next)), now]);
  await revokeAll(db, user.userId, now, currentToken); // sign out other devices
  await writeAudit(db, now, { actorUserId: user.userId, action: 'PASSWORD_CHANGED', entity: 'USER', entityId: user.userId });
}

// ==================== Account administration ====================

export interface NewUser { username: unknown; displayName: unknown; fullName?: unknown; mobile?: unknown }

/** Creates an account with a temporary password (shown once to the admin, who shares it with the person). */
export async function createUser(db: Queryable, actorUserId: number | null, input: NewUser, now: Date, password?: string): Promise<{ userId: number; username: string; tempPassword: string }> {
  const username = normalizeUsername(input.username);
  if (!USERNAME_RE.test(username)) throw validation('Username must be 3–32 characters: a–z, 0–9, dot, underscore or hyphen.');
  const displayName = String(input.displayName ?? '').trim().slice(0, 80);
  if (!displayName) throw validation('Enter a display name.');
  const mobile = input.mobile == null || input.mobile === '' ? null : String(input.mobile).replace(/[\s-]/g, '');
  if (mobile !== null && !/^\+?[0-9]{8,15}$/.test(mobile)) throw validation('Mobile number: 8–15 digits, optionally starting with +.');
  const exists = await db.query(`SELECT 1 FROM users WHERE username = $1`, [username]);
  if (exists.rows.length) throw conflict(`Username "${username}" is already taken.`);
  const temp = password ?? generateTempPassword();
  const weak = checkPassword(temp);
  if (weak) throw validation(weak);
  const { rows } = await db.query(
    `INSERT INTO users (username, display_name, password_hash, must_change_password, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,true,$4,$5,$5) RETURNING user_id`,
    [username, displayName, await hashPassword(temp), actorUserId, now],
  );
  const userId = Number(rows[0].user_id);
  const fullName = input.fullName == null ? null : String(input.fullName).trim().slice(0, 120) || null;
  await db.query(`INSERT INTO user_profiles (user_id, full_name, mobile, updated_at) VALUES ($1,$2,$3,$4)`, [userId, fullName, mobile, now]);
  await writeAudit(db, now, { actorUserId, action: 'USER_CREATED', entity: 'USER', entityId: userId, after: { username, displayName } });
  return { userId, username, tempPassword: temp };
}

export async function resetPassword(db: Queryable, actorUserId: number, userId: number, now: Date): Promise<{ username: string; tempPassword: string }> {
  const { rows } = await db.query(`SELECT user_id, username FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
  if (!rows[0]) throw notFound('User not found.');
  if (userId === actorUserId) throw validation('Use "Change password" for your own account.');
  const temp = generateTempPassword();
  await db.query(`UPDATE users SET password_hash = $2, must_change_password = true, password_changed_at = $3, updated_at = $3 WHERE user_id = $1`,
    [userId, await hashPassword(temp), now]);
  await revokeAll(db, userId, now);
  await writeAudit(db, now, { actorUserId, action: 'PASSWORD_RESET', entity: 'USER', entityId: userId });
  return { username: String(rows[0].username), tempPassword: temp };
}

export async function setStatus(db: Queryable, actorUserId: number, userId: number, enable: boolean, now: Date): Promise<void> {
  const { rows } = await db.query(`SELECT status FROM users WHERE user_id = $1 FOR UPDATE`, [userId]);
  if (!rows[0]) throw notFound('User not found.');
  if (!enable && userId === actorUserId) throw validation('You can\'t disable yourself.');
  const status = enable ? 'ACTIVE' : 'DISABLED';
  if (rows[0].status === status) return;
  if (!enable) {
    const { rows: sa } = await db.query(
      `SELECT count(*)::int AS n FROM platform_roles r JOIN users u USING (user_id) WHERE r.role = 'SUPER_ADMIN' AND u.status = 'ACTIVE' AND u.user_id <> $1`, [userId]);
    const isSuper = await db.query(`SELECT 1 FROM platform_roles WHERE user_id = $1 AND role = 'SUPER_ADMIN'`, [userId]);
    if (isSuper.rows.length && sa[0].n === 0) throw validation('At least one active Super Admin is required.');
  }
  await db.query(`UPDATE users SET status = $2, updated_at = $3 WHERE user_id = $1`, [userId, status, now]);
  if (!enable) await revokeAll(db, userId, now);
  await writeAudit(db, now, { actorUserId, action: enable ? 'USER_ENABLED' : 'USER_DISABLED', entity: 'USER', entityId: userId, before: { status: rows[0].status }, after: { status } });
}

export async function listUsers(db: Queryable): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT u.user_id, u.username, u.display_name, u.status, u.must_change_password, u.created_at, u.last_login_at,
            p.full_name, p.mobile, EXISTS (SELECT 1 FROM platform_roles r WHERE r.user_id = u.user_id AND r.role = 'SUPER_ADMIN') AS super_admin
       FROM users u LEFT JOIN user_profiles p USING (user_id) ORDER BY u.username`);
  return rows.map((r) => ({
    userId: Number(r.user_id), username: r.username, displayName: r.display_name, status: r.status, mustChangePassword: r.must_change_password,
    fullName: r.full_name, mobile: r.mobile, superAdmin: r.super_admin, createdAt: r.created_at.toISOString(), lastLoginAt: r.last_login_at?.toISOString() ?? null,
  }));
}

/** Server CLI only: the first Super Admin (there is no screen that can grant this). */
export async function createSuperAdmin(db: Queryable, username: string, displayName: string, now: Date): Promise<{ userId: number; username: string; tempPassword: string }> {
  const u = await createUser(db, null, { username, displayName }, now);
  await db.query(`INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES ($1, 'SUPER_ADMIN', NULL, $2)`, [u.userId, now]);
  await writeAudit(db, now, { actorUserId: null, action: 'PLATFORM_ROLE_GRANTED', entity: 'USER', entityId: u.userId, after: { role: 'SUPER_ADMIN' }, reason: 'server CLI' });
  return u;
}

export class PasswordChangeRequired extends AppError {
  constructor() { super('PASSWORD_CHANGE_REQUIRED', 'Please change your temporary password first.'); }
}
