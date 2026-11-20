import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, makeHarness, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, fa: Client, member: Client;
let id: number;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z'); // 11:30 IST, two days before Calamari starts
  sa = await h.user('super', { superAdmin: true });
  ca = await h.user('chadmin');
  fa = await h.user('finadmin');
  member = await h.user('member');
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('challenge lifecycle (Calamari created through configuration, not code)', () => {
  it('only a Super Admin can create; Calamari is created as a DRAFT from its settings file', async () => {
    expect((await ca.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).status).toBe(403);
    const r = await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() });
    expect(r.status).toBe(200);
    id = r.body.data.challengeId;
    expect(r.body.data.warnings.map((w: { path: string }) => w.path)).toEqual(['/exemptions/voting']);
    expect((await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).status).toBe(409);
    const bad = calamariConfig(); bad.finance.contribution.mainPool = 1;
    const rb = await sa.post('/api/challenges', { slug: 'bad', config: bad });
    expect(rb.status).toBe(400);
    expect(rb.body.details.errors[0].path).toBe('/finance/contribution');
  });

  it('a DRAFT is invisible to non-admins', async () => {
    expect((await member.get(`/api/challenges/${id}`)).status).toBe(404);
    expect((await member.get('/api/challenges')).body.data).toEqual([]);
    const list = (await sa.get('/api/challenges')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Calamari', phase: 'DRAFT', startsOn: '2026-11-22', endsOn: '2026-12-31', timeZone: 'Asia/Kolkata' });
  });

  it('roles are per challenge and granted by a Super Admin only', async () => {
    expect((await ca.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' })).status).toBe(403);
    expect((await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' })).status).toBe(200);
    expect((await sa.post(`/api/challenges/${id}/roles`, { userId: fa.userId, role: 'FINANCE_ADMIN' })).status).toBe(200);
    expect((await sa.post(`/api/challenges/${id}/roles`, { userId: fa.userId, role: 'OWNER' })).status).toBe(400);
    const roles = (await ca.get(`/api/challenges/${id}/roles`)).body.data;
    expect(roles.map((r: { username: string; role: string }) => `${r.username}:${r.role}`)).toEqual(['chadmin:CHALLENGE_ADMIN', 'finadmin:FINANCE_ADMIN']);
    expect((await member.get(`/api/challenges/${id}/roles`)).status).toBe(403);
  });

  it('Challenge Admin edits non-financial rules; financial changes need a Super Admin; Finance Admin edits no rules', async () => {
    const desc = calamariConfig(); desc.basics.description = 'Updated description';
    expect((await ca.put(`/api/challenges/${id}/config`, { config: desc })).status).toBe(200);
    const money = calamariConfig(); money.basics.description = 'Updated description'; money.finance.finePerMissedDay = 5000;
    const r = await ca.put(`/api/challenges/${id}/config`, { config: money });
    expect(r.status).toBe(403);
    expect((await fa.put(`/api/challenges/${id}/config`, { config: desc })).status).toBe(403);
    // Still version 1 while a draft (edited in place), and the audit shows what changed.
    const v = (await sa.get(`/api/challenges/${id}`)).body.data;
    expect(v.versions).toHaveLength(1);
    expect(v.current.config.basics.description).toBe('Updated description');
    const { rows } = await h.admin.query(`SELECT action, before, after FROM audit_log WHERE action = 'CHALLENGE_CONFIG_EDITED'`);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].after)).toEqual(['basics']);
  });

  it('only a Super Admin publishes', async () => {
    expect((await ca.post(`/api/challenges/${id}/publish`)).status).toBe(403);
    expect((await sa.post(`/api/challenges/${id}/publish`)).status).toBe(200);
    expect((await sa.post(`/api/challenges/${id}/publish`)).status).toBe(409);
  });

  it('before the start, a rule change on a published challenge is a new version effective from the start (reason required)', async () => {
    const c = calamariConfig(); c.basics.description = 'Updated description'; c.submission.instructions = 'Show date + total steps.';
    expect((await ca.put(`/api/challenges/${id}/config`, { config: c })).status).toBe(400); // no reason
    const r = await ca.put(`/api/challenges/${id}/config`, { config: c, reason: 'Clearer screenshot instructions' });
    expect(r.status).toBe(200);
    expect(r.body.data.versionNo).toBe(2);
    const v = (await sa.get(`/api/challenges/${id}`)).body.data;
    expect(v.versions.map((x: { versionNo: number; effectiveFrom: string }) => [x.versionNo, x.effectiveFrom])).toEqual([[1, '2026-11-22'], [2, '2026-11-22']]);
    // Before the start the "current" rules are those of day one, i.e. the new version (regression).
    expect(v.current.versionNo).toBe(2);
    expect(v.acceptVersionNo).toBe(2);
  });

  it('after the start: changes apply from tomorrow at the earliest; start date, time zone and week boundary are frozen', async () => {
    h.setNow('2026-11-25T08:00:00Z'); // 25 Nov, 13:30 IST
    const c = calamariConfig(); c.basics.description = 'Updated description'; c.submission.instructions = 'Show date + total steps.';
    c.activity.dailyTarget = 8000;
    const today = await sa.put(`/api/challenges/${id}/config`, { config: c, reason: 'Raise target', effectiveFrom: '2026-11-25' });
    expect(today.status).toBe(400);
    expect(today.body.message).toContain('from tomorrow');
    const past = await sa.put(`/api/challenges/${id}/config`, { config: c, reason: 'Raise target', effectiveFrom: '2026-11-22' });
    expect(past.status).toBe(400);
    const moved = { ...c, basics: { ...c.basics, startDate: '2026-11-23' } };
    expect((await sa.put(`/api/challenges/${id}/config`, { config: moved, reason: 'Move start', effectiveFrom: '2026-11-29' })).status).toBe(400);
    const ok = await sa.put(`/api/challenges/${id}/config`, { config: c, reason: 'Raise target from week 2', effectiveFrom: '2026-11-29' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.versionNo).toBe(3);
    // Today's rules are still 7,000; 8,000 is shown as upcoming.
    const v = (await sa.get(`/api/challenges/${id}`)).body.data;
    expect(v.phase).toBe('ACTIVE');
    expect(v.today).toBe('2026-11-25');
    expect(v.current.config.activity.dailyTarget).toBe(7000);
    expect(v.upcoming).toMatchObject({ versionNo: 3, effectiveFrom: '2026-11-29' });
    h.setNow('2026-11-29T00:30:00Z'); // 06:00 IST on the 29th
    expect((await sa.get(`/api/challenges/${id}`)).body.data.current.config.activity.dailyTarget).toBe(8000);
  });

  it('duplicate makes a new DRAFT with the same rules; a different challenge type needs no code', async () => {
    const d = await sa.post(`/api/challenges/${id}/duplicate`, { slug: 'pushups-2027' });
    expect(d.status).toBe(200);
    const dupId = d.body.data.challengeId;
    const c = (await sa.get(`/api/challenges/${dupId}`)).body.data.current.config;
    expect(c.basics.name).toBe('Calamari (copy)');
    Object.assign(c.basics, { name: '1,000 Push-ups', category: 'STRENGTH', startDate: '2027-01-04', endDate: '2027-02-02' });
    c.activity = { metric: 'pushups', label: 'Push-ups', unit: 'reps', dailyTarget: 50 };
    c.periods.weekStartsOn = 'MONDAY';
    c.finance.enabled = false;
    c.prizes.payoutDate = null;
    const r = await sa.put(`/api/challenges/${dupId}/config`, { config: c });
    expect(r.status).toBe(200);
    const list = (await sa.get('/api/challenges')).body.data;
    expect(list.map((x: { name: string; phase: string }) => `${x.name}:${x.phase}`)).toEqual(['1,000 Push-ups:DRAFT', 'Calamari:ACTIVE']);
  });

  it('archive needs a reason and freezes the rules', async () => {
    const list = (await sa.get('/api/challenges')).body.data;
    const dupId = list[0].challengeId;
    expect((await sa.post(`/api/challenges/${dupId}/archive`, { reason: '' })).status).toBe(400);
    expect((await sa.post(`/api/challenges/${dupId}/archive`, { reason: 'Not running this one' })).status).toBe(200);
    const c = (await sa.get(`/api/challenges/${dupId}`)).body.data.current.config;
    expect((await sa.put(`/api/challenges/${dupId}/config`, { config: { ...c, basics: { ...c.basics, name: 'Again' } } })).status).toBe(409);
  });
});
