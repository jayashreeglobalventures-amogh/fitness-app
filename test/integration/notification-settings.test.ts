import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pushKeyNow, sendDue } from '../../src/modules/notifications/push.js';
import { noteRanks } from '../../src/modules/notifications/rankup.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ad: Client, asha: Client, ravi: Client, meera: Client;
let id: number;
const sub = (name: string) => ({ endpoint: `https://push.example.com/${name}-0123456789`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
const round = () => sendDue(h.pool, h.pushSender, h.now());
const pushesTo = (c: Client) => h.pushes.filter((p) => p.endpoint === sub(c.username).endpoint);
const alerts = async (c: Client) => (await c.get('/api/me/notifications')).body.data as { id: string; title: string; body: string; category: string }[];
const ist = (d: string, t: string) => new Date(Date.parse(`${d}T${t}:00+05:30`)).toISOString();

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [ad, asha, ravi, meera] = [await h.user('admin1'), await h.user('asha'), await h.user('ravi'), await h.user('meera')];
  const cfg = calamariConfig();
  cfg.verification.mode = 'MANUAL';
  cfg.notifications.stepReminders.times = ['12:00', '18:00'];
  cfg.notifications.adminAlerts.delivery = 'DIGEST';
  cfg.notifications.adminAlerts.digestTimes = ['18:00'];
  cfg.notifications.extras.restDayReminder = true;
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: cfg })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ad.userId, role: 'CHALLENGE_ADMIN' });
  await h.ensureAdmins(sa, id);
  await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ravi, meera]) {
    const r = await sa.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
  }
  for (const c of [ad, asha, ravi, meera]) await c.post('/api/me/push/enable', { subscription: sub(c.username) });
  await round(); h.pushes.length = 0; // whatever existed before the test starts
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('my notification choices', () => {
  it('every kind starts on except new community posts (opt-in); unknown kinds are refused', async () => {
    const p = (await asha.get('/api/me/notification-prefs')).body.data;
    expect(p.prefs).toMatchObject({ stepReminders: true, communityPosts: false, adminTasks: true });
    expect(p.kinds.length).toBeGreaterThan(5);
    expect((await asha.put('/api/me/notification-prefs', { nonsense: true })).status).toBe(400);
    expect((await asha.put('/api/me/notification-prefs', { weeklySummary: 'yes' })).status).toBe(400);
    expect((await meera.put('/api/me/notification-prefs', { communityPosts: true })).body.data.prefs.communityPosts).toBe(true);
    expect((await ravi.put('/api/me/notification-prefs', { stepReminders: false })).status).toBe(200);
  });
});

describe('reminders', () => {
  it('morning: a rest-day reminder before the cut-off', async () => {
    h.setNow(ist('2026-11-22', '08:30'));
    expect((await alerts(asha)).find((n) => n.id.startsWith('restremind:'))).toMatchObject({ title: expect.stringContaining('rest day'), body: expect.stringContaining('10:00') });
    h.setNow(ist('2026-11-22', '10:30'));
    expect((await alerts(asha)).some((n) => n.id.startsWith('restremind:'))).toBe(false);
  });

  it('step reminders go out at every reminder time while steps are not in; switched off = no phone alert', async () => {
    h.pushes.length = 0;
    h.setNow(ist('2026-11-22', '11:30'));
    await round();
    expect(pushesTo(meera).some((p) => p.tag?.startsWith('nudge:'))).toBe(false); // before the first time
    h.setNow(ist('2026-11-22', '12:30'));
    await round();
    expect(pushesTo(meera).filter((p) => p.tag?.startsWith('nudge:')).map((p) => p.tag)).toEqual([`nudge:${id}:2026-11-22:1200`]);
    expect(pushesTo(ravi).some((p) => p.tag?.startsWith('nudge:'))).toBe(false); // Ravi switched reminders off...
    expect((await alerts(ravi)).some((n) => n.id.startsWith('nudge:'))).toBe(true); // ...but it is still in his app
  });
});

describe('admin alerts as a round-up', () => {
  it('a screenshot to review reaches the admin\'s phone only at the round-up time', async () => {
    h.setNow(ist('2026-11-22', '13:00'));
    expect((await asha.upload(`/api/challenges/${id}/submissions`, { clientRef: 'asha-22-aaaa' }, png('asha-22'))).status).toBe(200);
    await h.settle();
    h.pushes.length = 0;
    await round();
    expect((await alerts(ad)).some((n) => n.id.startsWith('reviews:'))).toBe(true); // in the app straight away
    expect(pushesTo(ad).some((p) => p.tag?.startsWith('reviews:'))).toBe(false);  // not on the phone yet
    h.setNow(ist('2026-11-22', '18:10'));
    await round();
    expect(pushesTo(ad).some((p) => p.tag?.startsWith('reviews:'))).toBe(true);
    expect(pushesTo(meera).filter((p) => p.tag?.startsWith('nudge:')).map((p) => p.tag)).toContain(`nudge:${id}:2026-11-22:1800`); // the second reminder
    const before = pushesTo(ad).length;
    h.setNow(ist('2026-11-22', '18:40'));
    await round();
    expect(pushesTo(ad).length).toBe(before); // once per round-up
  });
});

describe('alerts from things happening', () => {
  it('an admin\'s decision on my screenshot', async () => {
    const q = (await ad.get(`/api/challenges/${id}/review-queue`)).body.data as { submissionId: number }[];
    expect((await ad.post(`/api/submissions/${q[0]!.submissionId}/review`, { outcome: 'APPROVED', value: 8214 })).status).toBe(200);
    expect((await alerts(asha)).find((n) => n.id.startsWith('n:decided:'))).toMatchObject({ title: expect.stringContaining('target met'), body: '8,214 steps counted.', category: 'reviewOutcome' });
  });

  it('evening: once my steps are in, how many still need to upload for the team streak', async () => {
    h.setNow(ist('2026-11-22', '18:50'));
    expect((await alerts(asha)).some((n) => n.id.startsWith('teamstreak:'))).toBe(false); // before 19:00
    h.setNow(ist('2026-11-22', '19:30'));
    expect((await alerts(asha)).find((n) => n.id.startsWith('teamstreak:'))).toMatchObject({ body: expect.stringContaining('2 people still need') });
    expect((await alerts(ravi)).some((n) => n.id.startsWith('teamstreak:'))).toBe(false); // he hasn't uploaded himself
  });

  it('my payment confirmed', async () => {
    const r = await asha.post(`/api/challenges/${id}/payments`, { periodNo: 1, amount: 1000, utr: '777788889999', paidOn: '2026-11-22' });
    expect(r.status).toBe(200);
    expect((await sa.post(`/api/payments/${r.body.data.paymentId}/decide`, { confirm: true })).status).toBe(200);
    expect((await alerts(asha)).find((n) => n.id === `n:paid:${r.body.data.paymentId}`)).toMatchObject({ title: expect.stringContaining('payment confirmed'), body: expect.stringContaining('₹1,000') });
  });

  it('new community posts: grouped, only for people who opted in', async () => {
    await ravi.post(`/api/challenges/${id}/posts`, { kind: 'POST', body: 'Evening walk done!' });
    expect((await alerts(meera)).find((n) => n.id.startsWith('posts:'))).toMatchObject({ title: expect.stringContaining('a new post'), body: 'From ravi.' });
    expect((await alerts(asha)).some((n) => n.id.startsWith('posts:'))).toBe(false);
  });

  it('moving up the leaderboard (noted once a day after the quiet hours)', async () => {
    h.setNow(ist('2026-11-23', '06:30'));
    expect(await noteRanks(h.pool, h.now())).toBe(0); // still quiet hours: nothing noted yet
    h.setNow(ist('2026-11-23', '07:30'));
    await noteRanks(h.pool, h.now());
    // Pretend yesterday Asha was last: today she is first.
    const { rows: [pa] } = await h.admin.query('SELECT participant_id FROM participants WHERE challenge_id = $1 AND user_id = $2', [id, asha.userId]);
    await h.admin.query(`UPDATE rank_snapshots SET day = '2026-11-22', ranks = jsonb_set(ranks, $2, '99') WHERE challenge_id = $1`, [id, `{${pa.participant_id}}`]);
    expect(await noteRanks(h.pool, h.now())).toBe(1);
    expect((await alerts(asha)).find((n) => n.id.startsWith('n:rank:'))).toMatchObject({ title: expect.stringContaining('you moved up to #1'), body: expect.stringContaining('From #99') });
    expect(await noteRanks(h.pool, h.now())).toBe(0); // once a day
  });
});

describe('quiet hours', () => {
  it('follow the challenge\'s own times and time zone', () => {
    const n = { id: 'x', kind: 'info' as const, title: 't', body: 'b', link: '/', challengeId: 1, seenKey: 'x|', pushRules: { timeZone: 'Asia/Kolkata', quietFrom: '22:00', quietUntil: '06:00' } };
    expect(pushKeyNow(n, new Date(ist('2026-11-22', '22:30')))).toBeNull();
    expect(pushKeyNow(n, new Date(ist('2026-11-22', '05:59')))).toBeNull();
    expect(pushKeyNow(n, new Date(ist('2026-11-22', '06:00')))).toBe('x|');
  });
});
