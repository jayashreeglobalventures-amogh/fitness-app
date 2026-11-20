// The web application: JSON API under /api, /healthz, and the React app (built into dist/web).
// Security model (from AaryaShree IMS): session cookie (HttpOnly, SameSite=Lax, Secure in production); every POST/PUT/
// DELETE must be same-origin; every /api route except login requires a session; a temporary password must be changed
// before anything else; each request runs in ONE transaction; permissions are checked per challenge in the services.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { withTx } from './core/db.js';
import { AppError } from './core/errors.js';
import * as challenges from './modules/challenges/challenges.js';
import { validateConfig } from './modules/challenges/config.js';
import { accessFor, canManageAccounts } from './modules/identity/permissions.js';
import * as users from './modules/identity/users.js';
import * as profile from './modules/profile/profile.js';
import * as roster from './modules/roster/roster.js';

export const COOKIE = 'fit_session';
// Built app: dist/web. From the compiled server (dist/src) that is ../web; from the sources (src) ../dist/web.
export const WEB_DIST = path.resolve(import.meta.dirname, '..', path.basename(path.dirname(import.meta.dirname)) === 'dist' ? 'web' : 'dist/web');

export interface AppDeps {
  config: Config;
  pool: pg.Pool;
  now?: () => Date;
  logger?: boolean;
  webDir?: string;
}

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=()',
};

interface Ctx {
  tx: pg.PoolClient;
  user: users.SessionUser;
  now: Date;
  req: FastifyRequest;
}

const id = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError('NOT_FOUND', 'Not found.');
  return n;
};
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

export async function buildApp({ config, pool, now, logger, webDir }: AppDeps): Promise<FastifyInstance> {
  const clock = now ?? (() => new Date());
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    logger: logger === false ? false : {
      level: config.logLevel,
      // Never log credentials or personal data.
      redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    },
  });
  await app.register(cookie);

  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  // CSRF: a state-changing request must come from our own origin (browsers send Origin / Sec-Fetch-Site).
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin !== config.publicOrigin && site !== 'same-origin') {
      return reply.code(403).send({ success: false, errorCode: 'FORBIDDEN', message: 'Cross-site request refused.' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.status).send({ success: false, errorCode: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) {
      return reply.code(e.statusCode ?? 400).send({ success: false, errorCode: 'VALIDATION', message: e.message ?? 'Invalid request.' });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ success: false, errorCode: 'SERVER_ERROR', message: 'An unexpected error occurred. Please try again.' });
  });

  const cookieOpts = { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' as const, maxAge: users.SESSION_MAX_DAYS * 86_400 };
  const sessionUser = (req: FastifyRequest) => users.resolveSession(pool, req.cookies[COOKIE], clock());

  /** Wraps a handler: session required, temp password must be changed first, one transaction, {success,data} reply. */
  const authed = (fn: (c: Ctx) => Promise<unknown>, opts: { allowTempPassword?: boolean } = {}) => async (req: FastifyRequest) => {
    const user = await sessionUser(req);
    if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in.');
    if (user.mustChangePassword && !opts.allowTempPassword) throw new users.PasswordChangeRequired();
    const t = clock();
    const data = await withTx(pool, (tx) => fn({ tx, user, now: t, req }));
    return { success: true, data: data ?? null };
  };

  // ---------- Health ----------
  app.get('/healthz', async (_req, reply) => {
    try { await pool.query('SELECT 1'); } catch { return reply.code(503).send({ status: 'error', database: 'unreachable' }); }
    const one = async (sql: string) => { try { return (await pool.query(sql)).rows[0] ?? null; } catch { return null; } };
    const mig = await one(`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    let backup: { status: string; at?: string } = { status: 'unknown' };
    if (config.backupStatusFile) {
      try { const [status, at] = readFileSync(config.backupStatusFile, 'utf8').trim().split(/\s+/); backup = { status: status ?? 'unknown', at }; } catch { backup = { status: 'none' }; }
    }
    return { status: 'ok', database: 'ok', migrations: mig ? mig.n : null, backup };
  });

  // ---------- Auth ----------
  app.post('/api/auth/login', async (req, reply) => {
    const b = body(req);
    const res = await users.login(pool, b.username, b.password, { ip: req.ip || null, userAgent: String(req.headers['user-agent'] ?? '') }, clock());
    if ('error' in res) {
      return reply.code(res.error === 'LOCKED' ? 429 : 401).send({ success: false, errorCode: res.error === 'LOCKED' ? 'LOCKED' : 'UNAUTHENTICATED',
        message: res.error === 'LOCKED' ? `Too many failed attempts. Try again in ${users.LOCKOUT_MINUTES} minutes.` : 'Incorrect username or password.' });
    }
    reply.setCookie(COOKIE, res.token, cookieOpts);
    return { success: true, data: { mustChangePassword: res.user.mustChangePassword } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await users.logout(pool, req.cookies[COOKIE], clock());
    reply.clearCookie(COOKIE, { path: '/' });
    return { success: true, data: null };
  });

  app.post('/api/auth/change-password', authed(async ({ tx, user, now, req }) => {
    const b = body(req);
    await users.changeOwnPassword(tx, user, b.current, b.next, req.cookies[COOKIE]!, now);
  }, { allowTempPassword: true }));

  // Who am I: enough for the app shell (name, whether a password change is due, which admin areas to show).
  app.get('/api/me', authed(async ({ tx, user }) => {
    const access = await accessFor(tx, user.userId, null);
    return { ...user, superAdmin: access.platformRoles.includes('SUPER_ADMIN'), canManageAccounts: await canManageAccounts(tx, user.userId),
      canCreateChallenges: access.permissions.has('challenge.create') };
  }, { allowTempPassword: true }));

  // ---------- Profile ----------
  app.get('/api/me/profile', authed(({ tx, user }) => profile.getOwnProfile(tx, user.userId)));
  app.put('/api/me/profile', authed(({ tx, user, now, req }) => profile.updateOwnProfile(tx, user.userId, body(req) as never, now)));

  // ---------- Accounts (admin) ----------
  const requireAccounts = async (c: Ctx) => { if (!(await canManageAccounts(c.tx, c.user.userId))) throw new AppError('FORBIDDEN', 'You do not have permission to manage accounts.'); };
  app.get('/api/admin/users', authed(async (c) => { await requireAccounts(c); return users.listUsers(c.tx); }));
  app.post('/api/admin/users', authed(async (c) => { await requireAccounts(c); return users.createUser(c.tx, c.user.userId, body(c.req) as never, c.now); }));
  app.post<{ Params: { userId: string } }>('/api/admin/users/:userId/reset-password', authed(async (c) => {
    await requireAccounts(c); return users.resetPassword(c.tx, c.user.userId, id((c.req.params as { userId: string }).userId), c.now);
  }));
  app.post<{ Params: { userId: string } }>('/api/admin/users/:userId/status', authed(async (c) => {
    // Disabling accounts is a Super Admin action (it signs the person out of everything).
    const access = await accessFor(c.tx, c.user.userId, null);
    if (!access.platformRoles.includes('SUPER_ADMIN')) throw new AppError('FORBIDDEN', 'Only a Super Admin can enable or disable accounts.');
    await users.setStatus(c.tx, c.user.userId, id((c.req.params as { userId: string }).userId), body(c.req).enabled === true, c.now);
  }));

  // ---------- Challenges ----------
  const cid = (c: Ctx) => id((c.req.params as { challengeId: string }).challengeId);
  app.get('/api/challenges', authed(({ tx, user, now }) => challenges.listForUser(tx, user.userId, now)));
  app.post('/api/challenges/validate', authed(async ({ req }) => validateConfig(body(req).config)));
  app.post('/api/challenges', authed(({ tx, user, now, req }) => challenges.createChallenge(tx, user.userId, body(req).slug, body(req).config, now)));
  app.get('/api/challenges/:challengeId', authed((c) => challenges.viewChallenge(c.tx, c.user.userId, cid(c), c.now)));
  app.put('/api/challenges/:challengeId/config', authed((c) => challenges.updateConfig(c.tx, c.user.userId, cid(c), body(c.req) as never, c.now)));
  app.post('/api/challenges/:challengeId/publish', authed((c) => challenges.publish(c.tx, c.user.userId, cid(c), c.now)));
  app.post('/api/challenges/:challengeId/archive', authed((c) => challenges.archive(c.tx, c.user.userId, cid(c), body(c.req).reason, c.now)));
  app.post('/api/challenges/:challengeId/duplicate', authed((c) => challenges.duplicate(c.tx, c.user.userId, cid(c), body(c.req).slug, c.now)));
  app.get('/api/challenges/:challengeId/roles', authed(async (c) => { await challenges.requireAdmin(c.tx, c.user.userId, cid(c)); return challenges.listRoles(c.tx, cid(c)); }));
  app.post('/api/challenges/:challengeId/roles', authed((c) => {
    const b = body(c.req);
    return challenges.setRole(c.tx, c.user.userId, cid(c), id(b.userId), b.role, b.grant !== false, c.now);
  }));

  // ---------- Roster ----------
  app.get('/api/challenges/:challengeId/invitations', authed((c) => roster.listInvitations(c.tx, c.user.userId, cid(c), c.now)));
  app.post('/api/challenges/:challengeId/invitations', authed((c) => roster.invite(c.tx, c.user.userId, cid(c), body(c.req) as never, c.now)));
  app.get('/api/challenges/:challengeId/participants', authed((c) => roster.listParticipants(c.tx, c.user.userId, cid(c))));
  app.post('/api/participants/:participantId/status', authed((c) => roster.changeStatus(c.tx, c.user.userId, id((c.req.params as { participantId: string }).participantId), body(c.req) as never, c.now)));
  const iid = (c: Ctx) => id((c.req.params as { invitationId: string }).invitationId);
  app.get('/api/me/invitations', authed(({ tx, user, now }) => roster.myInvitations(tx, user.userId, now)));
  app.post('/api/invitations/:invitationId/accept', authed((c) => roster.accept(c.tx, c.user.userId, iid(c), body(c.req) as never, c.now)));
  app.post('/api/invitations/:invitationId/decline', authed((c) => roster.decline(c.tx, c.user.userId, iid(c), c.now)));
  app.post('/api/invitations/:invitationId/revoke', authed((c) => roster.revokeInvitation(c.tx, c.user.userId, iid(c), c.now)));
  app.post('/api/invitations/:invitationId/resend', authed((c) => roster.resendInvitation(c.tx, c.user.userId, iid(c), c.now)));

  // ---------- The React app ----------
  const dir = webDir ?? WEB_DIST;
  const index = path.join(dir, 'index.html');
  if (existsSync(index)) {
    await app.register(fastifyStatic, { root: dir, index: false, wildcard: false, cacheControl: false,
      setHeaders: (res, file) => { res.header('cache-control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'); } });
    const html = readFileSync(index);
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(html);
      return reply.code(404).send({ success: false, errorCode: 'NOT_FOUND', message: 'Not found.' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ success: false, errorCode: 'NOT_FOUND', message: 'Not found.' }));
  }

  return app;
}
