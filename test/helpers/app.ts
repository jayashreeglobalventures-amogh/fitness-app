// A running app on a fresh database with a controllable clock, plus small HTTP helpers that keep a cookie per user.
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp, COOKIE } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { createPool, withTx } from '../../src/core/db.js';
import type { ChallengeConfig } from '../../src/modules/challenges/config.js';
import { createSuperAdmin, createUser, hashPassword } from '../../src/modules/identity/users.js';
import type { TestPg } from './pg.js';

export const ORIGIN = 'https://fitness.test';
export const PASSWORD = 'correct-horse-battery';

export interface Harness {
  app: FastifyInstance;
  pool: pg.Pool;   // fit_app (as production)
  admin: pg.Pool;  // superuser, for checking stored data
  setNow(iso: string): void;
  now(): Date;
  /** Creates a user whose password is already set (no forced change); returns a signed-in client. */
  user(username: string, opts?: { superAdmin?: boolean }): Promise<Client>;
  close(): Promise<void>;
}

export interface Client {
  userId: number;
  username: string;
  get(url: string): Promise<{ status: number; body: any }>;
  post(url: string, payload?: unknown): Promise<{ status: number; body: any }>;
  put(url: string, payload?: unknown): Promise<{ status: number; body: any }>;
}

export const calamariConfig = (): ChallengeConfig => JSON.parse(readFileSync(new URL('../../config/challenges/calamari-2026.json', import.meta.url), 'utf8'));

export async function makeHarness(db: TestPg, startIso = '2026-11-20T06:00:00Z'): Promise<Harness> {
  const { adminUrl, appUrl } = await db.freshDb();
  const pool = createPool(appUrl);
  const admin = createPool(adminUrl);
  let current = new Date(startIso);
  const config: Config = { databaseUrl: appUrl, host: '127.0.0.1', port: 0, publicOrigin: ORIGIN, mediaDir: '/tmp', cookieSecure: true, trustProxy: false, logLevel: 'silent' };
  const app = await buildApp({ config, pool, now: () => current, logger: false, webDir: '/nonexistent' });
  const h: Harness = {
    app, pool, admin,
    setNow(iso) { current = new Date(iso); },
    now: () => current,
    async user(username, opts = {}) {
      const u = await withTx(pool, async (tx) => {
        const created = opts.superAdmin ? await createSuperAdmin(tx, username, username, current) : await createUser(tx, null, { username, displayName: username }, current);
        await tx.query(`UPDATE users SET must_change_password = false WHERE user_id = $1`, [created.userId]);
        return created;
      });
      // Set a known password through the real code path.
      await pool.query(`UPDATE users SET password_hash = $2 WHERE user_id = $1`, [u.userId, await hashPassword(PASSWORD)]);
      return client(app, username, u.userId, await login(app, username, PASSWORD));
    },
    async close() { await app.close(); await pool.end(); await admin.end(); },
  };
  return h;
}

export async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username, password } });
  if (r.statusCode !== 200) throw new Error(`login failed for ${username}: ${r.body}`);
  const c = r.cookies.find((x) => x.name === COOKIE);
  return c!.value;
}

export function client(app: FastifyInstance, username: string, userId: number, token: string): Client {
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { origin: ORIGIN }, cookies: { [COOKIE]: token }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return { userId, username, get: (u) => call('GET', u), post: (u, p) => call('POST', u, p ?? {}), put: (u, p) => call('PUT', u, p ?? {}) };
}
