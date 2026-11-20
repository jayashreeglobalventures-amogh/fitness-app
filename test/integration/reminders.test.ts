import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, makeHarness, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, admin: Client, fm: Client, asha: Client, ravi: Client;
let id: number;
const overview = async (c: Client) => (await c.get(`/api/challenges/${id}/overview`)).body.data;
const person = (o: { people: { displayName: string }[] }, name: string) => o.people.find((p) => p.displayName === name) as Record<string, unknown>;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-23T08:00:00Z'); // day 2 of Calamari, 1:30 pm in India
  sa = await h.user('super', { superAdmin: true });
  [admin, fm, asha, ravi] = [await h.user('admin1'), await h.user('fmone'), await h.user('asha'), await h.user('ravi')];
  await h.admin.query(`UPDATE user_profiles SET mobile = '9876543210' WHERE user_id = $1`, [asha.userId]);
  h.setNow('2026-11-20T06:00:00Z');
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: admin.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/roles`, { userId: fm.userId, role: 'FINANCE_ADMIN' });
  await h.ensureAdmins(sa, id);
  await sa.post(`/api/challenges/${id}/publish`);
  const inv = await admin.post(`/api/challenges/${id}/invitations`, { userIds: [asha.userId, ravi.userId] });
  for (const [c, i] of [[asha, 0], [ravi, 1]] as const) await c.post(`/api/invitations/${inv.body.data.invited[i]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
  h.setNow('2026-11-23T08:00:00Z');
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('WhatsApp reminders (sent by an admin from their own WhatsApp)', () => {
  it('admins who manage the roster see mobile numbers for reminders; the finance manager does not', async () => {
    const o = await overview(admin);
    expect(o.canRemind).toBe(true);
    expect(person(o, 'asha')).toMatchObject({ mobile: '9876543210', reminded: null, day: { status: 'NOT_SUBMITTED' } });
    expect(person(o, 'ravi')).toMatchObject({ mobile: null });
    const f = await overview(fm);
    expect(f.canRemind).toBe(false);
    expect(person(f, 'asha')).not.toHaveProperty('mobile');
  });

  it('a reminder is recorded (who, to whom, which day) and shown so another admin doesn\'t repeat it', async () => {
    const pid = person(await overview(admin), 'asha').participantId;
    expect((await fm.post(`/api/challenges/${id}/reminders`, { day: '2026-11-23', participantId: pid })).status).toBe(403);
    expect((await asha.post(`/api/challenges/${id}/reminders`, { day: '2026-11-23', participantId: pid })).status).toBe(403);
    expect((await admin.post(`/api/challenges/${id}/reminders`, { day: 'today', participantId: pid })).status).toBe(400);
    expect((await admin.post(`/api/challenges/${id}/reminders`, { day: '2026-11-23', participantId: pid })).status).toBe(200);
    expect(person(await overview(sa), 'asha').reminded).toMatchObject({ by: 'admin1' });
    expect(person(await overview(sa), 'ravi').reminded).toBeNull();
    expect((await admin.post(`/api/challenges/${id}/reminders`, { day: '2026-11-23', group: true, names: ['asha', 'ravi'] })).status).toBe(200);
    const log = (await sa.get('/api/admin/activity?action=WHATSAPP_REMINDER,WHATSAPP_GROUP_REMINDER')).body.data.items;
    expect(log.map((i: { action: string; after: unknown }) => [i.action, i.after])).toEqual([
      ['WHATSAPP_GROUP_REMINDER', { day: '2026-11-23', names: ['asha', 'ravi'] }],
      ['WHATSAPP_REMINDER', { day: '2026-11-23', to: 'asha' }],
    ]);
  });
});
