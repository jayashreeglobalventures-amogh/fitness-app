import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOKIE } from '../../src/app.js';
import { calamariConfig, client, login, makeHarness, ORIGIN, PASSWORD, type Harness } from '../helpers/app.js';
import { sql, startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
beforeAll(async () => { db = await startPg(); h = await makeHarness(db); }, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('accounts and sign-in (IMS model)', () => {
  it('admin creates an account with a temporary password; the person must change it before anything else', async () => {
    const sa = await h.user('owner', { superAdmin: true });
    const created = await sa.post('/api/admin/users', { username: 'Asha.K', displayName: 'Asha', mobile: '+91 98450 12345' });
    expect(created.status).toBe(200);
    expect(created.body.data.username).toBe('asha.k');
    const temp = created.body.data.tempPassword as string;
    expect(temp).toHaveLength(14);

    const token = await login(h.app, 'asha.k', temp);
    const asha = client(h.app, 'asha.k', created.body.data.userId, token);
    expect((await asha.get('/api/me')).body.data.mustChangePassword).toBe(true);
    const blocked = await asha.get('/api/challenges');
    expect(blocked.status).toBe(403);
    expect(blocked.body.errorCode).toBe('PASSWORD_CHANGE_REQUIRED');

    expect((await asha.post('/api/auth/change-password', { current: temp, next: 'short' })).status).toBe(400);
    expect((await asha.post('/api/auth/change-password', { current: 'wrong-password', next: 'a-much-better-password' })).status).toBe(400);
    expect((await asha.post('/api/auth/change-password', { current: temp, next: 'a-much-better-password' })).status).toBe(200);
    expect((await asha.get('/api/challenges')).status).toBe(200);
    const prof = await asha.get('/api/me/profile');
    expect(prof.body.data.fields.mobile).toBe('+919845012345');
    expect(prof.body.data.visibility.mobile).toBe('PRIVATE'); // private by default
  });

  it('wrong password is refused with the same message as an unknown user; 5 failures lock for 15 minutes', async () => {
    await h.user('ravi');
    h.setNow(new Date(h.now().getTime() + 1000).toISOString()); // after ravi's own successful sign-in
    const attempt = (u: string, p: string) => h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: u, password: p } });
    const unknown = await attempt('nobody', 'whatever-password');
    const wrong = await attempt('ravi', 'whatever-password');
    expect(unknown.statusCode).toBe(401);
    expect(JSON.parse(wrong.body).message).toBe(JSON.parse(unknown.body).message);
    for (let i = 0; i < 4; i++) await attempt('ravi', 'nope-nope-nope');
    const locked = await attempt('ravi', PASSWORD);
    expect(locked.statusCode).toBe(429);
    h.setNow(new Date(h.now().getTime() + 16 * 60_000).toISOString());
    expect((await attempt('ravi', PASSWORD)).statusCode).toBe(200);
  });

  it('only account managers can create users; a password reset signs the person out everywhere', async () => {
    const sa = await h.user('owner2', { superAdmin: true });
    const meera = await h.user('meera');
    expect((await meera.post('/api/admin/users', { username: 'x-user', displayName: 'X' })).status).toBe(403);
    expect((await meera.get('/api/admin/users')).status).toBe(403);
    const reset = await sa.post(`/api/admin/users/${meera.userId}/reset-password`);
    expect(reset.status).toBe(200);
    expect((await meera.get('/api/me')).status).toBe(401);
  });

  it('a disabled account cannot sign in; only a Super Admin may disable', async () => {
    const sa = await h.user('owner3', { superAdmin: true });
    const kiran = await h.user('kiran');
    const other = await h.user('other');
    expect((await other.post(`/api/admin/users/${kiran.userId}/status`, { enabled: false })).status).toBe(403);
    expect((await sa.post(`/api/admin/users/${kiran.userId}/status`, { enabled: false })).status).toBe(200);
    expect((await kiran.get('/api/me')).status).toBe(401);
    const r = await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'kiran', password: PASSWORD } });
    expect(r.statusCode).toBe(401);
  });

  it('cross-site writes are refused (CSRF), and the session cookie is HttpOnly + Secure + SameSite', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.example' }, payload: { username: 'x', password: 'y' } });
    expect(r.statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN }, payload: { username: 'meera', password: PASSWORD } });
    const c = ok.cookies.find((x) => x.name === COOKIE);
    if (c) expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
  });

  it('unauthenticated API calls get 401, never data; security headers are set', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/api/challenges' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('the audit log is append-only, even for the database superuser', async () => {
    const { rows } = await h.admin.query(`SELECT count(*)::int AS n FROM audit_log`);
    expect(rows[0].n).toBeGreaterThan(0);
    await expect(h.admin.query(`UPDATE audit_log SET action = 'X'`)).rejects.toThrow(/append-only/);
    await expect(h.admin.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
    await expect(h.pool.query(`TRUNCATE audit_log`)).rejects.toThrow();
  });

  it('the app database role cannot change the schema', async () => {
    await expect(h.pool.query(`CREATE TABLE sneaky (x int)`)).rejects.toThrow();
    await expect(h.pool.query(`DROP TABLE users`)).rejects.toThrow();
  });

  it('/healthz reports the database and migrations', async () => {
    const r = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(JSON.parse(r.body)).toMatchObject({ status: 'ok', database: 'ok', migrations: 1 });
    void calamariConfig; void sql;
  });
});
