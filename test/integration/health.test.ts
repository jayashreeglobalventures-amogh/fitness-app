import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../../src/core/db.js';
import { calamariConfig, makeHarness, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, admin: Client, fm: Client, asha: Client, ravi: Client, outsider: Client;
let id: number;
const me = async (c: Client) => (await c.get('/api/me/health')).body.data;
const card = async (viewer: Client, owner: Client) => (await viewer.get(`/api/people/${owner.userId}`)).body.data;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [admin, fm, asha, ravi, outsider] = [await h.user('admin1'), await h.user('fmone'), await h.user('asha'), await h.user('ravi'), await h.user('outsider')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: admin.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/roles`, { userId: fm.userId, role: 'FINANCE_ADMIN' });
  await h.ensureAdmins(sa, id);
  await sa.post(`/api/challenges/${id}/publish`);
  const inv = await admin.post(`/api/challenges/${id}/invitations`, { userIds: [asha.userId, ravi.userId, fm.userId] });
  for (const [c, i] of [[asha, 0], [ravi, 1], [fm, 2]] as const) await c.post(`/api/invitations/${inv.body.data.invited[i]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('consent comes first', () => {
  it('nothing can be recorded without explicit consent', async () => {
    expect(await me(asha)).toMatchObject({ consent: null, records: [] });
    expect((await asha.post('/api/me/health/records', { measuredOn: '2026-11-20', weightKg: 70 })).status).toBe(403);
    expect((await asha.post('/api/me/health/consent', { agree: false, version: 1 })).status).toBe(400);
    expect((await asha.post('/api/me/health/consent', { agree: true, version: 1 })).status).toBe(200);
    expect((await me(asha)).consent).toMatchObject({ version: 1 });
  });
});

describe('measurements are dated history', () => {
  it('new entries never overwrite earlier ones; BMI uses the latest height', async () => {
    await asha.post('/api/me/health/records', { measuredOn: '2026-11-01', heightCm: 165, weightKg: 72.4 });
    await asha.post('/api/me/health/records', { measuredOn: '2026-11-20', weightKg: 70, waistCm: 82, restingHr: 64 });
    const r = (await me(asha)).records;
    expect(r.map((x: { on: string; weightKg: number; bmi: number }) => [x.on, x.weightKg, x.bmi])).toEqual([['2026-11-01', 72.4, 26.6], ['2026-11-20', 70, 25.7]]);
  });

  it('validates values and dates', async () => {
    for (const bad of [{ measuredOn: '2026-11-21', weightKg: 70 }, { measuredOn: '2026-11-20', weightKg: 900 }, { measuredOn: '2026-11-20' }, { measuredOn: '2026-11-20', restingHr: 61.5 }]) {
      expect((await asha.post('/api/me/health/records', bad)).status).toBe(400);
    }
  });

  it('a mistaken entry can be corrected or deleted - only by its owner', async () => {
    const rid = (await me(asha)).records[1].id;
    expect((await ravi.put(`/api/me/health/records/${rid}`, { measuredOn: '2026-11-20', weightKg: 99 })).status).toBe(403); // no consent
    await ravi.post('/api/me/health/consent', { agree: true, version: 1 });
    expect((await ravi.put(`/api/me/health/records/${rid}`, { measuredOn: '2026-11-20', weightKg: 99 })).status).toBe(404); // invisible to him
    expect((await ravi.post(`/api/me/health/records/${rid}/delete`)).status).toBe(404);
    expect((await asha.put(`/api/me/health/records/${rid}`, { measuredOn: '2026-11-20', weightKg: 69.5, waistCm: 82, restingHr: 64 })).status).toBe(200);
    expect((await me(asha)).records[1].weightKg).toBe(69.5);
  });
});

describe('privacy: private by default, field by field, enforced by the database', () => {
  it('by default nobody else sees anything - not members, admins, the finance manager or a Super Admin', async () => {
    for (const viewer of [ravi, admin, fm, sa, outsider]) expect((await card(viewer, asha)).health).toBeNull();
  });

  it('the database itself refuses other people\'s rows, even to raw SQL on the app connection', async () => {
    const rows = await withTx(h.pool, async (tx) => {
      await tx.query(`SELECT set_config('app.user_id', $1, true)`, [String(ravi.userId)]);
      return (await tx.query(`SELECT * FROM health_measurements`)).rows;
    });
    expect(rows).toEqual([]);
    const none = (await h.pool.query(`SELECT count(*)::int AS n FROM health_measurements`)).rows[0].n; // no signed-in user at all
    expect(none).toBe(0);
    await expect(withTx(h.pool, async (tx) => {
      await tx.query(`SELECT set_config('app.user_id', $1, true)`, [String(ravi.userId)]);
      return tx.query(`SELECT health_shared_with($1, $2, now())`, [admin.userId, asha.userId]); // asking as someone else
    })).rejects.toThrow(/viewer must be the signed-in user/);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM health_measurements`)).rows[0].n).toBe(2); // the data is there
  });

  it('each field reaches exactly who it is shared with', async () => {
    await asha.put('/api/me/health/profile', { fitnessLevel: 'BEGINNER', goals: ['FAT_LOSS', 'STEPS'], considerations: 'Knee pain on stairs',
      visibility: { weight: 'ADMINS', bmi: 'MEMBERS', goals: 'PUBLIC', considerations: 'ADMINS' } });
    expect((await card(outsider, asha)).health.values).toEqual({ goals: ['FAT_LOSS', 'STEPS'] });
    expect((await card(ravi, asha)).health.values).toEqual({ goals: ['FAT_LOSS', 'STEPS'], bmi: { value: 25.5, on: '2026-11-20' } });
    // The finance manager is also a participant here: as a member they see what members see - the role adds nothing.
    expect((await card(fm, asha)).health.values).toEqual((await card(ravi, asha)).health.values);
    expect((await card(admin, asha)).health.values).toEqual({
      weightKg: { value: 69.5, on: '2026-11-20' }, bmi: { value: 25.5, on: '2026-11-20' }, goals: ['FAT_LOSS', 'STEPS'], considerations: 'Knee pain on stairs' });
    // Super Admin role alone: only what is public.
    expect((await card(sa, asha)).health.values).toEqual({ goals: ['FAT_LOSS', 'STEPS'] });
  });

  it('health considerations can never go wider than challenge admins', async () => {
    expect((await asha.put('/api/me/health/profile', { visibility: { considerations: 'PUBLIC' } })).status).toBe(400);
  });

  it('sharing changes are logged without any values', async () => {
    const log = (await sa.get(`/api/admin/activity?user=${asha.userId}`)).body.data.items;
    const text = JSON.stringify(log);
    expect(log.map((i: { action: string }) => i.action)).toEqual(expect.arrayContaining(['HEALTH_CONSENT_GIVEN', 'HEALTH_SHARING_CHANGED']));
    for (const secret of ['69.5', '72.4', 'Knee', '165']) expect(text).not.toContain(secret);
  });

  it('nothing leaks through the leaderboard, notifications or the general profile', async () => {
    const out = JSON.stringify([
      (await admin.get(`/api/challenges/${id}/leaderboard`)).body, (await admin.get('/api/me/notifications')).body,
      (await admin.get(`/api/challenges/${id}/overview`)).body, (await admin.get('/api/me/profile')).body,
    ]);
    for (const secret of ['69.5', 'Knee', 'FAT_LOSS']) expect(out).not.toContain(secret);
  });
});

describe('exceptional support access', () => {
  it('only the person can grant it, only to a Super Admin, for a limited time; every view is logged', async () => {
    expect((await asha.post('/api/me/health/support', { granteeUserId: admin.userId, hours: 4 })).status).toBe(400); // not a Super Admin
    expect((await asha.post('/api/me/health/support', { granteeUserId: sa.userId, hours: 500 })).status).toBe(400);
    const g = await asha.post('/api/me/health/support', { granteeUserId: sa.userId, hours: 4, reason: 'Help me fix my records' });
    expect(g.status).toBe(200);
    expect((await sa.get('/api/me/health/support-to-me')).body.data).toMatchObject([{ name: 'asha' }]);
    const v = (await card(sa, asha)).health;
    expect(v.support).toBe(true);
    expect(v.values.considerations).toBe('Knee pain on stairs');
    expect(v.history).toHaveLength(2);
    expect((await sa.get(`/api/admin/activity?action=HEALTH_SUPPORT_VIEWED`)).body.data.items).toHaveLength(1);

    h.setNow('2026-11-20T10:00:01Z'); // 4 hours later: over
    expect((await card(sa, asha)).health.support).toBe(false);
    h.setNow('2026-11-20T06:00:00Z');
    const grantId = (await me(asha)).supportGrants[0].grantId;
    expect((await asha.post(`/api/me/health/support/${grantId}/revoke`)).status).toBe(200);
    expect((await card(sa, asha)).health.support).toBe(false);
  });
});

describe('withdrawing consent and deleting', () => {
  it('withdrawing stops all sharing at once; records stay hidden unless deleted', async () => {
    await asha.post('/api/me/health/withdraw', { deleteData: false });
    expect((await card(admin, asha)).health).toBeNull();
    expect((await card(outsider, asha)).health).toBeNull();
    const m = await me(asha);
    expect(m).toMatchObject({ consent: null });
    expect(m.records).toHaveLength(2);
    expect((await asha.post('/api/me/health/records', { measuredOn: '2026-11-20', weightKg: 70 })).status).toBe(403);
  });

  it('"delete all" erases every record permanently', async () => {
    expect((await asha.post('/api/me/health/delete-all')).status).toBe(200);
    expect((await me(asha)).records).toEqual([]);
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM health_measurements WHERE user_id = $1`, [asha.userId])).rows[0].n).toBe(0);
  });
});
