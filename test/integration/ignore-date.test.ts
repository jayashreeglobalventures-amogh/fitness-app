import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Reading, ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, asha: Client;
let id: number;
let next: Partial<Reading> = {};
const fake: ScreenshotReader = { async read() { return { readable: true, date: null, value: 8200, sourceApp: 'Health', confidence: 0.97, flags: [], notes: 'Shows "Today" but no date.', model: 'fake', provider: 'fake', ...next }; } };
let ref = 0;
const upload = (seed: string) => asha.upload(`/api/challenges/${id}/submissions`, { clientRef: `ref-${seed}-${++ref}` }, png(seed));
const ist = (d: string, t: string) => new Date(Date.parse(`${d}T${t}:00+05:30`)).toISOString();
const status = async (d: string) => (await asha.get(`/api/challenges/${id}/me`)).body.data.days.find((x: { day: string }) => x.day === d).status;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  asha = await h.user('asha');
  const cfg = calamariConfig();
  cfg.verification.ignoreDate = true;
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: cfg })).body.data.challengeId;
  await h.ensureAdmins(sa, id);
  await sa.post(`/api/challenges/${id}/publish`);
  const r = await sa.post(`/api/challenges/${id}/invitations`, { userIds: [asha.userId] });
  await asha.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
  setReaderForTests(fake);
}, 120_000);
afterEach(async () => { await h.settle(); next = {}; });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('"Don\'t require a date on the screenshot"', () => {
  it('a "Today" screenshot without a date is approved automatically', async () => {
    h.setNow(ist('2026-11-22', '20:00'));
    expect((await upload('d22')).status).toBe(200);
    await h.settle();
    expect(await status('2026-11-22')).toBe('ACHIEVED');
  });

  it('the next day, a different count is fine; the same count as an earlier day goes to an admin', async () => {
    h.setNow(ist('2026-11-23', '20:00'));
    next = { value: 9050 };
    await upload('d23');
    await h.settle();
    expect(await status('2026-11-23')).toBe('ACHIEVED');

    h.setNow(ist('2026-11-24', '20:00'));
    next = { value: 8200 }; // exactly 22 Nov's count: probably the same screenshot again
    const up = await upload('d24-retaken');
    await h.settle();
    expect(await status('2026-11-24')).toBe('PENDING_VERIFICATION');
    const q = (await sa.get(`/api/challenges/${id}/review-queue`)).body.data.find((x: { submissionId: number }) => x.submissionId === up.body.data.submissionId);
    expect(JSON.stringify(q)).toContain('SAME_STEPS_AS_EARLIER');
    expect(JSON.stringify(q)).toContain('22 Nov');
  });

  it('a screenshot that shows a different date still goes to an admin', async () => {
    h.setNow(ist('2026-11-25', '20:00'));
    next = { date: '2026-11-24', value: 7777 };
    await upload('d25');
    await h.settle();
    expect(await status('2026-11-25')).toBe('PENDING_VERIFICATION');
  });
});
