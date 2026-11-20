import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendDue } from '../../src/modules/notifications/push.js';
import { calamariConfig, makeHarness, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, admin: Client, asha: Client, ravi: Client;
let id: number;
const sub = (name: string) => ({ endpoint: `https://push.example.com/${name}-0123456789`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
const round = () => sendDue(h.pool, h.pushSender, h.now());

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [admin, asha, ravi] = [await h.user('admin1'), await h.user('asha'), await h.user('ravi')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: admin.userId, role: 'CHALLENGE_ADMIN' });
  await h.ensureAdmins(sa, id);
  await sa.post(`/api/challenges/${id}/publish`);
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('phone notifications', () => {
  it('are off until the person switches them on; a key is provided for the phone', async () => {
    const s = (await asha.get('/api/me/push')).body.data;
    expect(s).toMatchObject({ enabled: false, devices: [] });
    expect(s.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect((await asha.get('/api/me/push')).body.data.publicKey).toBe(s.publicKey); // generated once, then reused
    expect((await asha.post('/api/me/push/enable', { subscription: { endpoint: 'http://insecure', keys: {} } })).status).toBe(400);
  });

  it('switching on does not send old alerts; a new alert is sent once; tapping opens Alerts', async () => {
    const inv = await admin.post(`/api/challenges/${id}/invitations`, { userIds: [asha.userId] }); // an alert before switching on
    expect((await asha.post('/api/me/push/enable', { subscription: sub('asha-phone') })).status).toBe(200);
    expect((await asha.get('/api/me/push')).body.data).toMatchObject({ enabled: true, devices: [{ endpoint: sub('asha-phone').endpoint }] });
    await round();
    expect(h.pushes).toEqual([]); // the invitation existed before: not sent

    // She joins (that brings its own alerts, e.g. the contribution due); then an announcement arrives.
    await asha.post(`/api/invitations/${inv.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
    await round();
    h.pushes.length = 0;

    await admin.post(`/api/challenges/${id}/posts`, { kind: 'ANNOUNCEMENT', body: 'Walk together on Saturday 7 am!' });
    await round();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({ endpoint: sub('asha-phone').endpoint, url: '/notifications', title: expect.stringContaining('announcement') });
    expect(JSON.stringify(h.pushes[0])).not.toContain('Walk together'); // the lock screen shows only the title
    await round();
    expect(h.pushes).toHaveLength(1); // not again
  });

  it('an alert already read in the app is not sent', async () => {
    h.pushes.length = 0;
    await admin.post(`/api/challenges/${id}/posts`, { kind: 'ANNOUNCEMENT', body: 'Second note' });
    const n = (await asha.get('/api/me/notifications')).body.data.find((x: { id: string; seen: boolean }) => x.id.startsWith('ann:') && !x.seen);
    await asha.post('/api/me/notifications/seen', { keys: [n.seenKey] });
    await round();
    expect(h.pushes).toEqual([]);
  });

  it('"Send a test" reaches each phone; a phone that removed the app is forgotten', async () => {
    h.pushes.length = 0;
    await asha.post('/api/me/push/enable', { subscription: sub('asha-old-gone') });
    const r = await asha.post('/api/me/push/test');
    expect(r.status).toBe(200);
    expect(r.body.data.sent).toBe(1);
    expect(h.pushes.map((p) => p.title)).toEqual(['Fitness: test notification', 'Fitness: test notification']);
    expect((await asha.get('/api/me/push')).body.data.devices).toHaveLength(1);
    expect((await ravi.post('/api/me/push/test')).status).toBe(400); // not switched on
  });

  it('turning off stops them on every phone', async () => {
    h.pushes.length = 0;
    expect((await asha.post('/api/me/push/disable')).status).toBe(200);
    expect((await asha.get('/api/me/push')).body.data).toMatchObject({ enabled: false, devices: [] });
    await admin.post(`/api/challenges/${id}/posts`, { kind: 'ANNOUNCEMENT', body: 'Third' });
    await round();
    expect(h.pushes).toEqual([]);
  });
});

describe('activity log (Super Admin)', () => {
  it('records sign-ins, failures and sign-outs with IP and device', async () => {
    await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://fitness.test', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' },
      payload: { username: 'ravi', password: 'wrong-password-1' } });
    await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://fitness.test' }, payload: { username: 'nobody-here', password: 'my-secret-pw' } });
    const items = (await sa.get(`/api/admin/activity?action=SIGN_IN_FAILED`)).body.data.items;
    expect(items.map((i: { entity: string; reason: string }) => `${i.entity}:${i.reason}`)).toEqual(['USERNAME:Unknown username', 'USER:Wrong password']);
    expect(JSON.stringify(items)).not.toContain('nobody-here'); // nothing typed is kept for unknown usernames
    expect(JSON.stringify(items)).not.toContain('my-secret-pw');
    expect(items[1]).toMatchObject({ actor: { username: 'ravi' }, ip: '127.0.0.1', device: expect.stringContaining('iPhone') });
    const signIns = (await sa.get(`/api/admin/activity?action=SIGNED_IN&user=${asha.userId}`)).body.data.items;
    expect(signIns.length).toBeGreaterThan(0);
  });

  it('shows who did what, where, with filters, search, paging and CSV; only for Super Admins', async () => {
    expect((await admin.get('/api/admin/activity')).status).toBe(403);
    expect((await asha.get('/api/admin/errors')).status).toBe(403);
    const all = (await sa.get(`/api/admin/activity?challenge=${id}`)).body.data.items;
    const posted = all.find((i: { action: string }) => i.action === 'ANNOUNCEMENT_POSTED');
    expect(posted).toMatchObject({ actor: { username: 'admin1' }, challenge: { name: 'Calamari' } });
    const roles = (await sa.get(`/api/admin/activity?action=CHALLENGE_ROLE_GRANTED`)).body.data.items;
    expect(roles.some((i: { targetName: string }) => i.targetName === 'admin1')).toBe(true);
    expect((await sa.get(`/api/admin/activity?q=PHONE_NOTIFICATIONS`)).body.data.items.map((i: { action: string }) => i.action))
      .toEqual(['PHONE_NOTIFICATIONS_OFF', 'PHONE_NOTIFICATIONS_ON']);
    expect((await sa.get(`/api/admin/activity?from=2026-11-21`)).body.data.items).toEqual([]);
    expect((await sa.get(`/api/admin/activity?from=2026-11-20&to=2026-11-20`)).body.data.items.length).toBeGreaterThan(10);
    expect((await sa.get(`/api/admin/activity?from=yesterday`)).status).toBe(400);
    const p1 = (await sa.get('/api/admin/activity')).body.data;
    if (p1.nextBefore) expect((await sa.get(`/api/admin/activity?before=${p1.nextBefore}`)).body.data.items[0].id).toBeLessThan(p1.nextBefore);
    const facets = (await sa.get('/api/admin/activity/facets')).body.data;
    expect(facets.actions.map((a: { action: string }) => a.action)).toContain('SIGNED_IN');
    const csv = await sa.raw(`/api/admin/activity.csv?challenge=${id}`);
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.body.toString().split('\r\n')[0]).toBe('id,time_ist,who,username,action,challenge,entity,entity_id,target,reason,before,after,ip,device');
    expect((await admin.raw('/api/admin/activity.csv')).status).toBe(403);
  });

  it('unexpected server errors are recorded for the Super Admin', async () => {
    await h.admin.query(`INSERT INTO error_log (at, source, user_id, method, path, message) VALUES (now(), 'REQUEST', $1, 'GET', '/api/x', 'boom')`, [asha.userId]);
    const e = (await sa.get('/api/admin/errors')).body.data.items;
    expect(e[0]).toMatchObject({ message: 'boom', path: '/api/x', user: { name: 'asha' } });
  });
});
