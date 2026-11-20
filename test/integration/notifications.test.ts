import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, fa: Client, asha: Client, ben: Client, other: Client;
let id: number;
const ids = async (c: Client) => (await c.get('/api/me/notifications')).body.data.map((n: { id: string }) => n.id.split(':')[0]);

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [ca, fa, asha, ben, other] = [await h.user('chadmin'), await h.user('finadmin'), await h.user('asha'), await h.user('ben'), await h.user('other')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/roles`, { userId: fa.userId, role: 'FINANCE_ADMIN' });
  setReaderForTests(null); // everything goes to review
}, 120_000);
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('notifications', () => {
  it('settings heads-ups go to whoever can edit the settings, not to the Finance Admin or participants', async () => {
    expect(await ids(sa)).toEqual(expect.arrayContaining(['cfgwarn', 'draft']));
    expect(await ids(ca)).toEqual(expect.arrayContaining(['cfgwarn']));
    expect(await ids(fa)).not.toContain('cfgwarn');
    expect(await ids(other)).toEqual([]);
  });

  it('participants get invitations, then today\'s check-in until they upload', async () => {
    await sa.post(`/api/challenges/${id}/publish`);
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [asha.userId, ben.userId] });
    expect(await ids(asha)).toEqual(['inv']);
    await asha.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
    await ben.post(`/api/invitations/${r.body.data.invited[1]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
    expect(await ids(asha)).toEqual([]); // before the start: nothing to do
    h.setNow('2026-11-22T06:30:00Z');
    expect(await ids(asha)).toEqual(['today']);
    await asha.upload(`/api/challenges/${id}/submissions`, { clientRef: 'asha-day-one' }, png('asha-1'));
    expect(await ids(asha)).toEqual([]);
  });

  it('admins see screenshots waiting for review (not their own); the Finance Admin does not', async () => {
    const n = (await ca.get('/api/me/notifications')).body.data.find((x: { id: string }) => x.id.startsWith('reviews:'));
    expect(n).toMatchObject({ count: 1, link: `/challenges/${id}/review` });
    expect(await ids(fa)).not.toContain('reviews');
    expect(await ids(asha)).not.toContain('reviews');
  });
});
