import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, client, login, makeHarness, PASSWORD, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ad: Client, asha: Client, ravi: Client;
let id: number;
const pid: Record<string, number> = {};
/** Sessions expire after a few weeks: sign everyone in again after moving the clock. */
const relog = async () => { for (const c of [ad, asha, ravi]) Object.assign(c, client(h.app, c.username, c.userId, await login(h.app, c.username, PASSWORD))); };

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [ad, asha, ravi] = [await h.user('admin1'), await h.user('asha'), await h.user('ravi')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ad.userId, role: 'CHALLENGE_ADMIN' });
  await h.ensureAdmins(sa, id);
  await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ravi]) {
    const r = await sa.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    pid[c.username] = (await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true })).body.data.participantId;
  }
  h.setNow('2026-12-10T06:00:00Z');
  await relog();
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('participation certificates', () => {
  it('before the end: admins can preview anyone\'s, but can\'t give them; participants can\'t download', async () => {
    const list = (await ad.get(`/api/challenges/${id}/certificates`)).body.data;
    expect(list).toMatchObject({ ended: false, endsOn: '2026-12-31' });
    expect(list.people.map((p: { displayName: string }) => p.displayName)).toEqual(['asha', 'ravi']);
    const preview = await ad.raw(`/api/participants/${pid.asha}/certificate.pdf`);
    expect(preview.status).toBe(200);
    expect(preview.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await ad.post(`/api/challenges/${id}/certificates`)).status).toBe(409);
    expect((await asha.raw(`/api/participants/${pid.asha}/certificate.pdf`)).status).toBe(403);
    expect((await asha.get(`/api/challenges/${id}/my-certificate`)).body.data).toBeNull();
  });

  it('after the end an admin gives them to everyone; each person gets an alert and can download only their own', async () => {
    h.setNow('2027-01-01T06:00:00Z');
    await relog();
    expect((await asha.post(`/api/challenges/${id}/certificates`)).status).toBe(403); // participants can't give them
    expect((await ad.post(`/api/challenges/${id}/certificates`)).body.data).toEqual({ issued: 2 });
    expect((await ad.post(`/api/challenges/${id}/certificates`)).body.data).toEqual({ issued: 0 }); // not twice
    expect((await asha.get(`/api/challenges/${id}/my-certificate`)).body.data).toMatchObject({ participantId: pid.asha });
    const alert = (await asha.get('/api/me/notifications')).body.data.find((n: { id: string }) => n.id.startsWith('n:cert:'));
    expect(alert).toMatchObject({ title: expect.stringContaining('certificate is ready') });
    const mine = await asha.raw(`/api/participants/${pid.asha}/certificate.pdf`);
    expect(mine.status).toBe(200);
    expect(String(mine.headers['content-disposition'])).toContain('Calamari-certificate-asha.pdf');
    expect((await ravi.raw(`/api/participants/${pid.asha}/certificate.pdf`)).status).toBe(403);
    expect((await ad.get(`/api/challenges/${id}/certificates`)).body.data.people.every((p: { issuedAt: string | null }) => p.issuedAt)).toBe(true);
  });
});
