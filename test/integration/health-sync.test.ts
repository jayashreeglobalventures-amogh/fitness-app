import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ad: Client, asha: Client, ravi: Client;
let id: number;
const pid: Record<string, number> = {};
const ist = (d: string, t: string) => new Date(Date.parse(`${d}T${t}:00+05:30`)).toISOString();
/** What the Apple Shortcut sends: no cookie, no Origin, the key in the Authorization header. */
const sync = (key: string | null, payload: unknown, extra: Record<string, string> = {}) =>
  h.app.inject({ method: 'POST', url: '/api/health-sync', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', 'user-agent': 'Shortcuts/1', ...extra }, payload: JSON.stringify(payload) });
const day = async (c: Client, d: string) => (await c.get(`/api/challenges/${id}/me`)).body.data.days.find((x: { day: string }) => x.day === d);
let ashaKey = '';

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [ad, asha, ravi] = [await h.user('admin1'), await h.user('asha'), await h.user('ravi')];
  const cfg = calamariConfig();
  cfg.verification.mode = 'MANUAL';
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: cfg })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ad.userId, role: 'CHALLENGE_ADMIN' });
  await h.ensureAdmins(sa, id);
  await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ravi]) {
    const r = await sa.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    pid[c.username] = (await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true })).body.data.participantId;
  }
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('sync key', () => {
  it('is shown once; afterwards only its last characters', async () => {
    expect((await asha.get('/api/me/sync-key')).body.data.key).toBeNull();
    const k = (await asha.post('/api/me/sync-key')).body.data;
    expect(k.key).toMatch(/^fit_[A-Za-z0-9_-]{32}$/);
    ashaKey = k.key;
    const s = (await asha.get('/api/me/sync-key')).body.data;
    expect(s.key).toMatchObject({ hint: ashaKey.slice(-4), lastUsedAt: null });
    expect(JSON.stringify(s)).not.toContain(ashaKey);
  });

  it('a wrong or missing key is refused', async () => {
    expect((await sync(null, { steps: 8000 })).statusCode).toBe(401);
    expect((await sync('fit_' + 'x'.repeat(32), { steps: 8000 })).statusCode).toBe(401);
  });

  it('the iPhone may send cookies too: the sync key is what counts; without a key it is a cross-site request', async () => {
    h.setNow(ist('2026-11-21', '12:00')); // before the start: nothing to save, but accepted
    const r = await sync(ashaKey, { steps: 8000 }, { cookie: 'fit_session=whatever; __cf_bm=x' });
    expect(r.statusCode).toBe(200);
    const noKey = await h.app.inject({ method: 'POST', url: '/api/health-sync', headers: { cookie: 'fit_session=whatever', 'content-type': 'application/json' }, payload: '{"steps":1}' });
    expect(noKey.statusCode).toBe(403);
    expect(await h.app.inject({ method: 'OPTIONS', url: '/api/health-sync', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } })
      .then((x) => x.headers['access-control-allow-origin'])).toBeUndefined(); // no CORS approval for other sites
  });
});

describe('steps from Apple Health', () => {
  it('below the target: in progress today, with a friendly reply for the Shortcut', async () => {
    h.setNow(ist('2026-11-22', '13:00'));
    const r = await sync(ashaKey, { steps: '3,100' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toBe('Calamari: 3,100 of 7,000 steps so far today - 3,900 to go 💪');
    expect(await day(asha, '2026-11-22')).toMatchObject({ status: 'IN_PROGRESS', sync: { steps: 3100, doubted: false } });
    expect((await asha.get('/api/me/notifications')).body.data.some((n: { id: string }) => n.id.startsWith('teamstreak:'))).toBe(false);
  });

  it('a later sync replaces it; reaching the target meets the day', async () => {
    h.setNow(ist('2026-11-22', '23:30'));
    const r = await sync(ashaKey, { steps: 8214 });
    expect(r.body).toBe('Calamari: 8,214 steps saved for 22 Nov - target met ✅');
    expect(await day(asha, '2026-11-22')).toMatchObject({ status: 'ACHIEVED', sync: { steps: 8214 } });
    expect((await asha.get('/api/me/sync-key')).body.data.recent[0]).toMatchObject({ steps: 8214, day: '2026-11-22' });
    expect((await asha.get('/api/me/notifications')).body.data.some((n: { id: string }) => n.id.startsWith('nudge:'))).toBe(false); // no reminder
  });

  it('a number that is not a step count is refused', async () => {
    expect((await sync(ashaKey, { steps: 'lots' })).statusCode).toBe(400);
    expect((await sync(ashaKey, { steps: 999999 })).statusCode).toBe(400);
  });

  it('below the target and the day is over: missed', async () => {
    const k = (await ravi.post('/api/me/sync-key')).body.data.key;
    h.setNow(ist('2026-11-22', '23:40'));
    await sync(k, { steps: 5000 });
    h.setNow(ist('2026-11-23', '00:10'));
    expect(await day(ravi, '2026-11-22')).toMatchObject({ status: 'TARGET_MISSED' });
  });

  it('synced steps that reach the target count even if a screenshot was declined', async () => {
    h.setNow(ist('2026-11-23', '10:00'));
    const up = await ravi.upload(`/api/challenges/${id}/submissions`, { clientRef: 'ravi-23-aaaa' }, png('ravi-23'));
    await ad.post(`/api/submissions/${up.body.data.submissionId}/review`, { outcome: 'REJECTED', reason: 'Date not visible' });
    expect((await day(ravi, '2026-11-23')).status).toBe('REJECTED');
    const k = (await ravi.post('/api/me/sync-key')).body.data.key; // a new key: the old one stops working
    h.setNow(ist('2026-11-23', '20:00'));
    expect((await sync(k, { steps: 9000 })).statusCode).toBe(200);
    expect((await day(ravi, '2026-11-23')).status).toBe('ACHIEVED');
  });

  it('a revoked key stops working', async () => {
    await asha.post('/api/me/sync-key/revoke');
    expect((await sync(ashaKey, { steps: 100 })).statusCode).toBe(401);
    ashaKey = (await asha.post('/api/me/sync-key')).body.data.key;
  });

  it('on a rest day nothing is saved', async () => {
    h.setNow(ist('2026-11-24', '08:00'));
    await asha.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-24' });
    expect((await sync(ashaKey, { steps: 1200 })).body).toContain('rest day');
    expect((await day(asha, '2026-11-24')).sync).toBeNull();
  });
});

describe('an admin doubts a synced number', () => {
  it('it stops counting and the person is asked for a screenshot; it can be accepted again', async () => {
    h.setNow(ist('2026-11-24', '12:00'));
    const url = `/api/participants/${pid.asha}/health-sync/doubt`;
    expect((await asha.post(url, { day: '2026-11-22' })).status).toBe(403);
    expect((await ad.post(url, { day: '2026-11-22', reason: 'Much higher than usual' })).status).toBe(200);
    expect(await day(asha, '2026-11-22')).toMatchObject({ status: 'MISSED_DEADLINE', sync: { doubted: true, doubtReason: 'Much higher than usual' } });
    const n = (await asha.get('/api/me/notifications')).body.data.find((x: { id: string }) => x.id.startsWith('n:syncdoubt:'));
    expect(n).toMatchObject({ title: expect.stringContaining('please send a screenshot'), body: expect.stringContaining('Send it to an admin') });
    expect((await ad.post(url, { day: '2026-11-22', doubt: false })).status).toBe(200);
    expect((await day(asha, '2026-11-22')).status).toBe('ACHIEVED');
  });

  it('a challenge can switch syncing off', async () => {
    const cfg = calamariConfig();
    cfg.verification.mode = 'MANUAL';
    cfg.submission.healthSync.enabled = false;
    expect((await sa.put(`/api/challenges/${id}/config`, { config: cfg, reason: 'Screenshots only for now', effectiveFrom: '2026-11-25' })).status).toBe(200);
    h.setNow(ist('2026-11-25', '20:00'));
    expect((await sync(ashaKey, { steps: 9000 })).body).toContain('please upload a screenshot');
    expect((await day(asha, '2026-11-25')).sync).toBeNull();
  });
});

describe('what the Shortcut sends', () => {
  it('a count from an earlier day is ignored; "8,214 steps" and iPhone-written dates are understood', async () => {
    const k = (await ravi.post('/api/me/sync-key')).body.data.key;
    h.setNow(ist('2026-11-26', '09:00'));
    const cfg = calamariConfig(); cfg.verification.mode = 'MANUAL'; // syncing back on
    expect((await sa.put(`/api/challenges/${id}/config`, { config: cfg, reason: 'Syncing back on', effectiveFrom: '2026-11-27' })).status).toBe(200);
    h.setNow(ist('2026-11-27', '07:30'));
    const stale = await sync(k, { steps: '5,000', date: 'Nov 26, 2026 at 12:00 AM' });
    expect(stale.body).toBe('Calamari: no steps in your Health app for today yet (the latest are from 26 Nov) - nothing saved.');
    expect((await day(ravi, '2026-11-27')).sync).toBeNull();
    h.setNow(ist('2026-11-27', '21:00'));
    expect((await sync(k, { steps: '8,214 steps', date: '27 Nov 2026 at 00:00' })).body).toContain('8,214 steps saved for 27 Nov');
    expect((await sync(k, { steps: 8300, date: '2026-11-27T00:00:00+05:30' })).body).toContain('8,300');
  });
});
