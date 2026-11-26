import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, makeHarness, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ad: Client, asha: Client, ravi: Client;
let id: number;
const pid: Record<string, number> = {};
const ist = (d: string, t: string) => new Date(Date.parse(`${d}T${t}:00+05:30`)).toISOString();

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
  // Asha's steps on the 22nd from Apple Health.
  const key = (await asha.post('/api/me/sync-key')).body.data.key;
  h.setNow(ist('2026-11-22', '21:00'));
  await h.app.inject({ method: 'POST', url: '/api/health-sync', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, payload: '{"steps":8214}' });
  h.setNow(ist('2026-11-24', '10:00'));
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('admin calendar', () => {
  it('everyone, from the start to today, with what counted each day', async () => {
    const r = (await ad.get(`/api/challenges/${id}/calendar`)).body.data;
    expect(r).toMatchObject({ from: '2026-11-22', to: '2026-11-24', target: 7000 });
    expect(r.people.map((p: { displayName: string }) => p.displayName)).toEqual(['asha', 'ravi']);
    const asha22 = r.people[0].days.find((d: { day: string }) => d.day === '2026-11-22');
    expect(asha22).toMatchObject({ status: 'ACHIEVED', value: 8214, source: 'APPLE_HEALTH' });
    expect(r.people[1].days.find((d: { day: string }) => d.day === '2026-11-22')).toMatchObject({ status: 'MISSED_DEADLINE', value: null });
  });

  it('filters by participant and dates; dates outside the challenge are trimmed', async () => {
    const r = (await ad.get(`/api/challenges/${id}/calendar?participantId=${pid.ravi}&from=2026-11-01&to=2026-11-23`)).body.data;
    expect(r.from).toBe('2026-11-22');
    expect(r.people).toHaveLength(1);
    expect(r.people[0].days.map((d: { day: string }) => d.day)).toEqual(['2026-11-22', '2026-11-23']);
    expect((await ad.get(`/api/challenges/${id}/calendar?from=2026-11-24&to=2026-11-22`)).status).toBe(400);
  });

  it('participants can\'t see it', async () => {
    expect((await asha.get(`/api/challenges/${id}/calendar`)).status).toBe(403);
  });
});

describe('participant report (PDF)', () => {
  it('an admin downloads it; the person can too; another participant can\'t', async () => {
    const r = await ad.raw(`/api/participants/${pid.asha}/report.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename="Calamari-asha-2026-11-24\.pdf"$/);
    expect(r.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.body.length).toBeGreaterThan(1500);
    expect((await asha.raw(`/api/participants/${pid.asha}/report.pdf`)).status).toBe(200);
    expect((await ravi.raw(`/api/participants/${pid.asha}/report.pdf`)).status).toBe(403);
    const { rows } = await h.admin.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'PARTICIPANT_REPORT_DOWNLOADED'`);
    expect(rows[0].n).toBe(2);
  });
});
