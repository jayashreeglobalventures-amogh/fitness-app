import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inQuietHours, sendDue } from '../../src/modules/notifications/push.js';
import { templateWriter, write, type CoachWriter } from '../../src/modules/coach/writer.js';
import type { ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, asha: Client, ben: Client;
let id: number;
let steps = 8000;
const reader: ScreenshotReader = { async read(_i, _m, ctx) { return { readable: true, date: ctx.expectedDay, value: steps, sourceApp: 'Fake', confidence: 0.99, flags: [], notes: '', model: 'fake', provider: 'fake' }; } };
let n = 0;
const walk = async (c: Client, day: string, total = 8000) => {
  h.setNow(`${day}T06:30:00Z`); steps = total;
  const r = await c.upload(`/api/challenges/${id}/submissions`, { clientRef: `walk-${c.username}-${++n}` }, png(`${c.username}-${day}-${n}`));
  expect(r.status).toBe(200);
  await h.settle();
};
const notices = async (c: Client) => (await c.get('/api/me/notifications')).body.data as { id: string; title: string; body: string; push?: boolean }[];

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  ca = await h.user('chadmin');
  [asha, ben] = [await h.user('asha'), await h.user('ben')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await h.ensureAdmins(sa, id); await sa.post(`/api/challenges/${id}/publish`);
  for (const c of [asha, ben]) {
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
  }
  setReaderForTests(reader);
  // Week 1 (Sun 22 - Sat 28 Nov): Asha walks every day but Tuesday the 24th; Ben walks the first two days only.
  for (const [d, s] of [['2026-11-22', 8000], ['2026-11-23', 9000], ['2026-11-25', 7500], ['2026-11-26', 12000], ['2026-11-27', 8200], ['2026-11-28', 9100]] as const) await walk(asha, d, s);
  await walk(ben, '2026-11-22'); await walk(ben, '2026-11-23');
}, 180_000);
afterEach(async () => { await h.settle(); });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('weekly summary (rule-based coach)', () => {
  it('after week 1, Asha gets a personal summary built from her own days and points', async () => {
    h.setNow('2026-11-29T06:30:00Z');
    await ca.get(`/api/challenges/${id}/leaderboard`); // bring the points up to date (the scheduler does this in production)
    const c = (await asha.get(`/api/challenges/${id}/coach`)).body.data;
    expect(c.enabled).toBe(true);
    expect(c.weeks.map((w: { periodNo: number; complete: boolean }) => [w.periodNo, w.complete])).toEqual([[2, false], [1, true]]);
    const w1 = c.weeks[1];
    expect(w1.headline).toBe('Week 1: 6 of 7 days ✅');
    const text = w1.lines.join('\n');
    expect(text).toContain('averaged 8,967 steps');      // (8000+9000+7500+12000+8200+9100)/6
    expect(text).toContain('best: 12,000 on Thu, 26 Nov');
    expect(text).toContain('4 successful days in a row');
    expect(text).toContain('85.7% of your days - above the 80% prize line');
    expect(text).toMatch(/points this week/);
    expect(text).toContain('Aim for next week: no misses');
  });

  it('a person who is not in the challenge gets nothing; nor does anyone when it is switched off', async () => {
    expect((await ca.get(`/api/challenges/${id}/coach`)).status).toBe(403);
  });

  it('the summary arrives as an alert for 3 days after the week', async () => {
    const a = (await notices(asha)).find((x) => x.id === `week:${id}:1`);
    expect(a).toMatchObject({ title: 'Calamari: your week 1 summary', body: 'Week 1: 6 of 7 days ✅' });
    h.setNow('2026-12-03T06:30:00Z');
    expect((await notices(asha)).some((x) => x.id === `week:${id}:1`)).toBe(false);
  });
});

describe('evening nudge and quiet hours', () => {
  it('before the nudge time: the plain check-in alert, in the app only; after it: a personal nudge instead', async () => {
    h.setNow('2026-11-29T06:30:00Z'); // 12:00 IST
    const noon = await notices(ben);
    expect(noon.find((x) => x.id.startsWith('today:'))).toMatchObject({ push: false });
    expect(noon.some((x) => x.id.startsWith('nudge:'))).toBe(false);
    h.setNow('2026-11-29T15:00:00Z'); // 20:30 IST
    const eve = await notices(ben);
    expect(eve.some((x) => x.id.startsWith('today:'))).toBe(false);
    expect(eve.find((x) => x.id.startsWith('nudge:'))).toMatchObject({ title: 'Calamari: today\'s a fresh start 💪' });
  });

  it('nothing goes to phones between 11 pm and 7 am; the check-in alert never does; the nudge does', async () => {
    expect([inQuietHours(new Date('2026-11-29T17:30:00Z')), inQuietHours(new Date('2026-11-29T01:29:00Z')), inQuietHours(new Date('2026-11-29T01:31:00Z'))]).toEqual([true, true, false]);
    h.setNow('2026-11-30T01:31:00Z'); // 07:01 IST
    await ben.post('/api/me/push/enable', { subscription: { endpoint: 'https://push.example.com/ben-phone-0123456789', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } } });
    h.setNow('2026-12-01T00:30:00Z'); // 06:00 IST on 1 Dec: quiet
    h.pushes.length = 0;
    await sendDue(h.pool, h.pushSender, h.now());
    expect(h.pushes).toEqual([]);
    h.setNow('2026-12-01T03:00:00Z'); // 08:30 IST: the new "today's check-in" alert stays in the app
    await sendDue(h.pool, h.pushSender, h.now());
    expect(h.pushes.map((p) => p.title)).toEqual([]);
    h.setNow('2026-12-01T15:00:00Z'); // 20:30 IST: the nudge goes out
    await sendDue(h.pool, h.pushSender, h.now());
    expect(h.pushes.map((p) => p.title)).toEqual(['Calamari: today\'s a fresh start 💪']);
  });

  it('a streak shows in the nudge - the same number as the Streak on the Today tab', async () => {
    h.setNow('2026-11-29T15:00:00Z');
    expect((await notices(asha)).find((x) => x.id.startsWith('nudge:'))?.title).toBe('Calamari: keep your 4-day streak going 🔥');
    const pid = (await asha.get(`/api/challenges/${id}/me`)).body.data.participant.participantId;
    expect((await asha.get(`/api/participants/${pid}/points`)).body.data.currentStreak).toBe(4);
  });
});

describe('who might need a hand (admins)', () => {
  it('lists people with misses in a row, with the reason; participants can\'t see it', async () => {
    h.setNow('2026-11-29T06:30:00Z');
    const r = (await ca.get(`/api/challenges/${id}/coach/at-risk`)).body.data;
    expect(r.people).toMatchObject([{ displayName: 'ben', missesInARow: 5, reason: 'missed the last 5 days; at 28.6%, below the 80% prize line' }]);
    expect((await asha.get(`/api/challenges/${id}/coach/at-risk`)).status).toBe(403);
    expect((await notices(ca)).find((x) => x.id === `atrisk:${id}:2026-11-29`)).toMatchObject({ title: 'Calamari: 1 person might need a hand', body: 'ben' });
  });

  it('each part can be switched off in Settings', async () => {
    const cfg = { ...calamariConfig(), coach: { weeklySummary: false, eveningNudge: false, nudgeTime: '20:00', atRiskAlerts: false } };
    h.setNow('2026-11-29T06:30:00Z');
    expect((await sa.put(`/api/challenges/${id}/config`, { config: cfg, reason: 'Coach off for now', effectiveFrom: '2026-11-30' })).status).toBe(200);
    h.setNow('2026-11-30T15:00:00Z');
    expect((await asha.get(`/api/challenges/${id}/coach`)).body.data).toEqual({ enabled: false, weeks: [] });
    expect((await notices(ben)).some((x) => x.id.startsWith('nudge:'))).toBe(false);
    expect((await ca.get(`/api/challenges/${id}/coach/at-risk`)).body.data.enabled).toBe(false);
  });
});

describe('the AI plug-in slot', () => {
  it('a failing writer falls back to the templates, so the coach never goes quiet', async () => {
    const broken: CoachWriter = { name: 'broken', weekly: async () => { throw new Error('AI down'); }, nudge: async () => { throw new Error('AI down'); }, risk: async () => { throw new Error('AI down'); } };
    const f = { challengeName: 'Calamari', streak: 3, hoursLeft: 2, target: 7000, missedYesterday: false };
    expect(await write((w) => w.nudge(f), broken)).toEqual(await templateWriter.nudge(f));
  });
});
