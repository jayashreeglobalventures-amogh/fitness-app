import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

// Removing a screenshot (owner, 21 Nov 2026): yourself until that day's midnight; afterwards ask an admin, who may also
// erase the image. Removed = hidden and kept; erased = the file is gone.
let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, ca2: Client, asha: Client;
let id: number;
let value = 8000;
let otherDate: string | null = null;
const reader: ScreenshotReader = { async read(_i, _m, ctx) { return { readable: true, date: otherDate ?? ctx.expectedDay, value, sourceApp: 'Fake', confidence: 0.99, flags: [], notes: '', model: 'fake', provider: 'fake' }; } };
let n = 0;
const shot = async (c: Client, v = 8000) => {
  value = v;
  const r = await c.upload(`/api/challenges/${id}/submissions`, { clientRef: `rm-${c.username}-${++n}` }, png(`${c.username}-${n}`));
  await h.settle();
  return r.body.data.submissionId as number;
};
const dayStatus = async (d: string) => (await asha.get(`/api/challenges/${id}/me`)).body.data.days.find((x: { day: string }) => x.day === d).status;
const points = async () => (await ca.get(`/api/challenges/${id}/leaderboard`)).body.data.standings.find((s: { displayName: string }) => s.displayName === 'asha').points;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  [ca, ca2, asha] = [await h.user('chadmin'), await h.user('chadmin2'), await h.user('asha')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  for (const c of [ca, ca2]) await sa.post(`/api/challenges/${id}/roles`, { userId: c.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/publish`);
  const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [asha.userId] });
  await asha.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
  setReaderForTests(reader);
}, 120_000);
afterEach(async () => { await h.settle(); });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('until midnight: remove your own screenshot', () => {
  it('the day goes back to "not sent"; a new one can be uploaded; only the owner can do it', async () => {
    h.setNow('2026-11-22T06:30:00Z');
    const sid = await shot(asha);
    expect(await dayStatus('2026-11-22')).toBe('ACHIEVED');
    expect((await ca.post(`/api/submissions/${sid}/withdraw`, {})).status).toBe(404);
    expect((await asha.post(`/api/submissions/${sid}/withdraw`, {})).status).toBe(200);
    expect(await dayStatus('2026-11-22')).toBe('NOT_SUBMITTED');
    await shot(asha);
    expect(await dayStatus('2026-11-22')).toBe('ACHIEVED');
    const { rows } = await h.admin.query(`SELECT action FROM audit_log WHERE action = 'EVIDENCE_WITHDRAWN'`);
    expect(rows).toHaveLength(1);
  });

  it('after midnight it can\'t be removed directly', async () => {
    h.setNow('2026-11-23T06:30:00Z');
    const sid = (await asha.get(`/api/challenges/${id}/me`)).body.data.days.find((x: { day: string }) => x.day === '2026-11-22').submission.submissionId;
    const r = await asha.post(`/api/submissions/${sid}/withdraw`, {});
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('ask an admin');
  });
});

describe('after midnight: ask an admin', () => {
  it('the request goes to admins; approving removes it and points follow; the owner can\'t decide their own', async () => {
    const sid = (await asha.get(`/api/challenges/${id}/me`)).body.data.days.find((x: { day: string }) => x.day === '2026-11-22').submission.submissionId;
    expect(await points()).toBe(10);
    expect((await asha.post(`/api/submissions/${sid}/removal-request`, { reason: 'x' })).status).toBe(400);
    const r = await asha.post(`/api/submissions/${sid}/removal-request`, { reason: 'Wrong photo - it is my friend\'s phone', eraseImage: true });
    expect(r.status).toBe(200);
    expect((await asha.post(`/api/submissions/${sid}/removal-request`, { reason: 'Again please' })).status).toBe(409);
    expect((await ca.get('/api/me/notifications')).body.data.some((x: { id: string }) => x.id === `evreq:${id}`)).toBe(true);
    const q = (await ca.get(`/api/challenges/${id}/evidence-requests`)).body.data;
    expect(q).toMatchObject([{ submissionId: sid, kind: 'REMOVE', eraseImage: true, displayName: 'asha' }]);
    expect((await asha.get(`/api/challenges/${id}/evidence-requests`)).status).toBe(403);
    const fileId = q[0].fileId;
    const key = (await h.admin.query(`SELECT storage_key FROM files WHERE file_id = $1`, [fileId])).rows[0].storage_key;
    expect(existsSync(path.join(h.mediaDir, key))).toBe(true);

    expect((await ca.post(`/api/evidence-requests/${q[0].requestId}/decide`, { approve: true, erase: true })).status).toBe(200);
    await h.settle();
    expect(await dayStatus('2026-11-22')).toBe('MISSED_DEADLINE');
    expect(await points()).toBe(-15);           // the day is now a miss: +10 reversed, −15
    expect(existsSync(path.join(h.mediaDir, key))).toBe(false); // erased from storage
    expect((await ca.raw(`/api/files/${fileId}`)).status).toBe(404);
    expect((await asha.raw(`/api/files/${fileId}`)).status).toBe(404);
  });

  it('declining needs a reason and changes nothing', async () => {
    h.setNow('2026-11-23T08:00:00Z');
    const sid = await shot(asha);
    h.setNow('2026-11-24T06:30:00Z');
    await asha.post(`/api/submissions/${sid}/removal-request`, { reason: 'Changed my mind' });
    const req = (await ca2.get(`/api/challenges/${id}/evidence-requests`)).body.data[0];
    expect((await ca2.post(`/api/evidence-requests/${req.requestId}/decide`, { approve: false })).status).toBe(400);
    expect((await ca2.post(`/api/evidence-requests/${req.requestId}/decide`, { approve: false, note: 'The screenshot is correct' })).status).toBe(200);
    expect(await dayStatus('2026-11-23')).toBe('ACHIEVED');
  });

  it('a screenshot removed before midnight can still have its image erased on request', async () => {
    h.setNow('2026-11-24T08:00:00Z');
    const sid = await shot(asha);
    expect((await asha.post(`/api/submissions/${sid}/withdraw`, { eraseImage: true, reason: 'Private photo by mistake' })).status).toBe(200);
    const q = (await ca.get(`/api/challenges/${id}/evidence-requests`)).body.data;
    expect(q).toMatchObject([{ submissionId: sid, kind: 'ERASE', status: 'WITHDRAWN' }]);
    expect((await ca.post(`/api/evidence-requests/${q[0].requestId}/decide`, { approve: true })).status).toBe(200);
    const { rows } = await h.admin.query(`SELECT action FROM audit_log WHERE action = 'EVIDENCE_IMAGE_ERASED'`);
    expect(rows).toHaveLength(1);
  });
});

describe('admins approve or decline - the app decides met or missed (one screenshot a day)', () => {
  it('approving a number below the target: the day is missed; above it: met; decline needs a reason', async () => {
    h.setNow('2026-11-25T06:30:00Z');
    otherDate = '2026-11-17'; // another day's date -> goes to an admin
    const low = await shot(asha, 4660);
    otherDate = null;
    expect(await dayStatus('2026-11-25')).toBe('PENDING_VERIFICATION');
    expect((await ca.post(`/api/submissions/${low}/review`, { outcome: 'APPROVED', value: 4660 })).status).toBe(200);
    expect(await dayStatus('2026-11-25')).toBe('TARGET_MISSED');
    h.setNow('2026-11-26T06:30:00Z');
    otherDate = '2026-11-17';
    const high = await shot(asha, 8200);
    otherDate = null;
    expect((await ca.post(`/api/submissions/${high}/review`, { outcome: 'REJECTED' })).status).toBe(400);
    expect((await ca.post(`/api/submissions/${high}/review`, { outcome: 'APPROVED', value: 8200 })).status).toBe(200);
    expect(await dayStatus('2026-11-26')).toBe('ACHIEVED');
  });
});
