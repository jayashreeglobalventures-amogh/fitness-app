// A running app on a fresh database with a controllable clock, plus small HTTP helpers that keep a cookie per user.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp, COOKIE } from '../../src/app.js';
import type { PushMessage, PushSender } from '../../src/modules/notifications/push.js';
import type { Config } from '../../src/config.js';
import { createPool, withTx } from '../../src/core/db.js';
import type { ChallengeConfig } from '../../src/modules/challenges/config.js';
import { createSuperAdmin, createUser, hashPassword } from '../../src/modules/identity/users.js';
import type { TestPg } from './pg.js';

export const ORIGIN = 'https://fitness.test';
export const PASSWORD = 'correct-horse-battery';

export interface Harness {
  /** Waits for background work (AI verification) started by requests so far. */
  settle(): Promise<void>;
  /** Phone notifications "sent" through the fake sender. */
  pushes: ({ endpoint: string } & PushMessage)[];
  pushSender: PushSender;
  mediaDir: string;
  app: FastifyInstance;
  pool: pg.Pool;   // fit_app (as production)
  admin: pg.Pool;  // superuser, for checking stored data
  setNow(iso: string): void;
  now(): Date;
  /** Creates a user whose password is already set (no forced change); returns a signed-in client. */
  user(username: string, opts?: { superAdmin?: boolean }): Promise<Client>;
  /** Adds challenge admins until the challenge has `n` (needed before publishing: at least 2). */
  ensureAdmins(by: Client, challengeId: number, n?: number): Promise<Client[]>;
  close(): Promise<void>;
}

export interface Client {
  userId: number;
  username: string;
  get(url: string): Promise<{ status: number; body: any }>;
  post(url: string, payload?: unknown): Promise<{ status: number; body: any }>;
  put(url: string, payload?: unknown): Promise<{ status: number; body: any }>;
  /** multipart/form-data POST with text fields and an optional file. */
  upload(url: string, fields: Record<string, string>, file?: Buffer): Promise<{ status: number; body: any }>;
  raw(url: string): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>;
}

/** A small valid-looking PNG; `seed` makes the bytes (and so the SHA-256) unique. */
export function png(seed: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`fake-image-${seed}`)]);
}

function multipartBody(fields: Record<string, string>, file?: Buffer) {
  const boundary = '----fitness-test-boundary';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`), file, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const calamariConfig = (): ChallengeConfig => JSON.parse(readFileSync(new URL('../../config/challenges/calamari-2026.json', import.meta.url), 'utf8'));

export async function makeHarness(db: TestPg, startIso = '2026-11-20T06:00:00Z'): Promise<Harness> {
  const { adminUrl, appUrl } = await db.freshDb();
  const pool = createPool(appUrl);
  const admin = createPool(adminUrl);
  let current = new Date(startIso);
  const mediaDir = mkdtempSync(path.join(os.tmpdir(), 'fit-media-'));
  const config: Config = { databaseUrl: appUrl, host: '127.0.0.1', port: 0, publicOrigin: ORIGIN, mediaDir, cookieSecure: true, trustProxy: false, logLevel: 'silent' };
  const background: Promise<unknown>[] = [];
  const pushes: Harness['pushes'] = [];
  // Fake Web Push: records what would be sent; an endpoint containing "gone" answers 410 (the phone removed the app).
  const pushSender: PushSender = async (sub, msg) => { pushes.push({ endpoint: sub.endpoint, ...msg }); return sub.endpoint.includes('gone') ? 410 : 201; };
  const app = await buildApp({ config, pool, now: () => current, logger: false, webDir: '/nonexistent', onBackground: (p) => background.push(p), pushSender });
  const h: Harness = {
    pushes, pushSender,
    async settle() { while (background.length) await background.shift(); },
    mediaDir,
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
    async ensureAdmins(by, challengeId, n = 2) {
      const { rows } = await admin.query(`SELECT count(*)::int AS k FROM challenge_roles WHERE challenge_id = $1 AND role = 'CHALLENGE_ADMIN'`, [challengeId]);
      const made: Client[] = [];
      for (let i = rows[0].k; i < n; i++) {
        const c = await h.user(`helper-admin-${challengeId}-${i}-${Math.random().toString(36).slice(2, 7)}`);
        const r = await by.post(`/api/challenges/${challengeId}/roles`, { userId: c.userId, role: 'CHALLENGE_ADMIN' });
        if (r.status !== 200) throw new Error(`could not add admin: ${JSON.stringify(r.body)}`);
        made.push(c);
      }
      return made;
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
  return {
    userId, username, get: (u) => call('GET', u), post: (u, p) => call('POST', u, p ?? {}), put: (u, p) => call('PUT', u, p ?? {}),
    async upload(url, fields, file) {
      const { payload, contentType } = multipartBody(fields, file);
      const r = await app.inject({ method: 'POST', url, headers: { origin: ORIGIN, 'content-type': contentType }, cookies: { [COOKIE]: token }, payload });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
    },
    async raw(url) {
      const r = await app.inject({ method: 'GET', url, cookies: { [COOKIE]: token } });
      return { status: r.statusCode, headers: r.headers as Record<string, unknown>, body: r.rawPayload };
    },
  };
}
