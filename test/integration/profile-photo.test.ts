import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, asha: Client, ben: Client, stranger: Client;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [asha, ben, stranger] = [await h.user('asha'), await h.user('ben'), await h.user('stranger')];
  const id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await h.ensureAdmins(sa, id); await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ben]) {
    const r = await sa.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
  }
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('profile photo', () => {
  let fileId: number;
  it('upload from camera/gallery; shown on the profile and in /api/me', async () => {
    const r = await asha.upload('/api/me/photo', {}, png('asha-face'));
    expect(r.status).toBe(200);
    fileId = r.body.data.photoFileId;
    expect(r.body.data.photoVisibility).toBe('CHALLENGE_MEMBERS'); // default
    expect((await asha.get('/api/me')).body.data.photoFileId).toBe(fileId);
    expect((await asha.upload('/api/me/photo', {}, Buffer.from('not an image'))).status).toBe(400);
  });

  it('default: visible to the person and their challenge members, not to strangers', async () => {
    expect((await asha.raw(`/api/files/${fileId}`)).status).toBe(200);
    expect((await ben.raw(`/api/files/${fileId}`)).status).toBe(200);
    expect((await stranger.raw(`/api/files/${fileId}`)).status).toBe(404);
  });

  it('"Only me" hides it from everyone else; "Everyone" shows it to any signed-in member', async () => {
    await asha.put('/api/me/profile', { photoVisibility: 'PRIVATE' });
    expect((await ben.raw(`/api/files/${fileId}`)).status).toBe(404);
    await asha.put('/api/me/profile', { photoVisibility: 'PUBLIC' });
    expect((await stranger.raw(`/api/files/${fileId}`)).status).toBe(200);
  });

  it('remove: the photo is no longer shown to others', async () => {
    const r = await asha.post('/api/me/photo/remove');
    expect(r.body.data.photoFileId).toBeNull();
    expect((await ben.raw(`/api/files/${fileId}`)).status).toBe(404);
  });
});
