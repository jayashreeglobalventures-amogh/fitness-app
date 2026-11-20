import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReaderError, type Reading, type ScreenshotReader } from '../../src/modules/verification/reader.js';
import { setReaderForTests } from '../../src/modules/verification/select.js';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, fa: Client, priya: Client, rahul: Client, sita: Client, meera: Client;
let id: number;
const pids: Record<string, number> = {};

/** A fake reader: returns what the next test wants, and counts calls. */
let nextReading: (() => Promise<Reading>) | null = null;
let calls = 0;
const fake: ScreenshotReader = { async read() { calls++; if (!nextReading) throw new Error('no reading set'); return nextReading(); } };
const reads = (over: Partial<Reading>) => () => Promise.resolve({ readable: true, date: '2026-11-22', value: 8200, sourceApp: 'Google Fit', confidence: 0.97, flags: [], notes: '', model: 'fake', provider: 'fake', ...over });
let ref = 0;
const upload = (c: Client, seed: string, extra: Record<string, string> = {}) => c.upload(`/api/challenges/${id}/submissions`, { clientRef: `ref-${seed}-${++ref}`, ...extra }, png(seed));
const day = async (c: Client, d: string) => (await c.get(`/api/challenges/${id}/me`)).body.data.days.find((x: { day: string }) => x.day === d);

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  ca = await h.user('chadmin');
  fa = await h.user('finadmin');
  [priya, rahul, sita, meera] = [await h.user('priya'), await h.user('rahul'), await h.user('sita'), await h.user('meera')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/roles`, { userId: fa.userId, role: 'FINANCE_ADMIN' });
  await h.ensureAdmins(sa, id); await sa.post(`/api/challenges/${id}/publish`);
  // Everyone joins before the start, including the Challenge Admin (an admin may also take part).
  for (const c of [priya, rahul, sita, meera, ca]) {
    const r = await sa.post(`/api/challenges/${id}/invitations`, { userIds: [c.userId] });
    const acc = await c.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
    pids[c.username] = acc.body.data.participantId;
  }
  setReaderForTests(fake);
}, 120_000);
afterEach(async () => { await h.settle(); nextReading = null; });
afterAll(async () => { setReaderForTests(undefined); await h?.close(); await db?.stop(); });

describe('daily evidence', () => {
  it('no evidence before the challenge starts', async () => {
    const r = await upload(priya, 'early');
    expect(r.status).toBe(409);
  });

  it('a clear on-target screenshot is approved automatically; repeating the same upload changes nothing', async () => {
    h.setNow('2026-11-22T06:30:00Z'); // 12:00 IST, day 1
    nextReading = reads({});
    const r = await priya.upload(`/api/challenges/${id}/submissions`, { clientRef: 'priya-day1-abc', claimedValue: '8,200' }, png('priya-1'));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ day: '2026-11-22', status: 'PENDING_AI' });
    await h.settle();
    expect(await day(priya, '2026-11-22')).toMatchObject({ status: 'ACHIEVED', submission: { finalValue: 8200 } });
    const again = await priya.upload(`/api/challenges/${id}/submissions`, { clientRef: 'priya-day1-abc' }, png('priya-1'));
    expect(again.body.data.submissionId).toBe(r.body.data.submissionId);
    const { rows } = await h.admin.query(`SELECT count(*)::int AS n FROM submissions WHERE participant_id = $1`, [pids.priya]);
    expect(rows[0].n).toBe(1);
    expect((await upload(priya, 'priya-1b')).status).toBe(409); // already verified
  });

  it('below target is NOT rejected by the AI: it goes to an admin, who decides; the participant may appeal once', async () => {
    nextReading = reads({ value: 6500 });
    const r = await upload(rahul, 'rahul-1');
    await h.settle();
    expect(await day(rahul, '2026-11-22')).toMatchObject({ status: 'PENDING_VERIFICATION' });
    const q = (await ca.get(`/api/challenges/${id}/review-queue`)).body.data;
    const item = q.find((x: { submissionId: number }) => x.submissionId === r.body.data.submissionId);
    expect(item.results.at(-1)).toMatchObject({ method: 'AI', extractedValue: 6500, outcome: 'NEEDS_REVIEW' });
    expect(item.results.at(-1).flags).toContain('BELOW_TARGET');
    // Reviewing rules: value must match the outcome; Finance Admin and participants can't review.
    const sid = r.body.data.submissionId;
    expect((await ca.post(`/api/submissions/${sid}/review`, { outcome: 'ACHIEVED', value: 6500 })).status).toBe(400);
    expect((await fa.post(`/api/submissions/${sid}/review`, { outcome: 'BELOW_TARGET', value: 6500 })).status).toBe(403);
    expect((await sita.post(`/api/submissions/${sid}/review`, { outcome: 'ACHIEVED', value: 9000 })).status).toBe(403);
    expect((await ca.post(`/api/submissions/${sid}/review`, { outcome: 'BELOW_TARGET', value: 6500 })).status).toBe(200);
    expect(await day(rahul, '2026-11-22')).toMatchObject({ status: 'TARGET_MISSED' });
    expect((await rahul.post(`/api/submissions/${sid}/appeal`, { note: 'Watch synced late, real total 7,400' })).status).toBe(200);
    expect(await day(rahul, '2026-11-22')).toMatchObject({ status: 'PENDING_VERIFICATION' });
    expect((await sa.post(`/api/submissions/${sid}/review`, { outcome: 'ACHIEVED', value: 7400 })).status).toBe(400); // deciding an appeal needs a reason
    const fresh = (await h.admin.query(`SELECT status FROM submissions WHERE submission_id = $1`, [sid])).rows[0].status;
    expect(fresh).toBe('PENDING_REVIEW');
    expect((await sa.post(`/api/submissions/${sid}/review`, { outcome: 'ACHIEVED', value: 7400, reason: 'Second screenshot shows 7,400' })).status).toBe(200);
    expect((await rahul.post(`/api/submissions/${sid}/appeal`, { note: 'again please' })).status).toBe(409);
    const detail = (await rahul.get(`/api/submissions/${sid}`)).body.data;
    expect(detail.results.map((x: { outcome: string }) => x.outcome)).toEqual(['NEEDS_REVIEW', 'BELOW_TARGET', 'APPEALED', 'ACHIEVED']);
  });

  it('an admin who participates cannot review their own evidence', async () => {
    nextReading = reads({ value: 5000 });
    const r = await upload(ca, 'chadmin-1');
    await h.settle();
    expect((await ca.post(`/api/submissions/${r.body.data.submissionId}/review`, { outcome: 'BELOW_TARGET', value: 5000 })).status).toBe(403);
    expect((await sa.post(`/api/submissions/${r.body.data.submissionId}/review`, { outcome: 'BELOW_TARGET', value: 5000 })).status).toBe(200);
  });

  it('the same image used by someone else is never auto-approved (and the AI is not even asked)', async () => {
    const before = calls;
    const r = await sita.upload(`/api/challenges/${id}/submissions`, { clientRef: 'sita-copy-1' }, png('priya-1'));
    expect(r.body.data).toMatchObject({ status: 'PENDING_REVIEW', duplicate: true });
    await h.settle();
    expect(calls).toBe(before);
    const q = (await ca.get(`/api/challenges/${id}/review-queue`)).body.data.find((x: { submissionId: number }) => x.submissionId === r.body.data.submissionId);
    expect(q.results[0].flags).toEqual(['DUPLICATE_IMAGE']);
  });

  it('a new upload before a decision replaces the old one (kept as SUPERSEDED)', async () => {
    nextReading = reads({});
    const r = await upload(sita, 'sita-real');
    await h.settle();
    expect(await day(sita, '2026-11-22')).toMatchObject({ status: 'ACHIEVED' });
    const { rows } = await h.admin.query(`SELECT status FROM submissions WHERE participant_id = $1 ORDER BY submission_id`, [pids.sita]);
    expect(rows.map((x) => x.status)).toEqual(['SUPERSEDED', 'ACHIEVED']);
    void r;
  });

  it('AI unavailable: a permanent error goes straight to review; a temporary one is retried, then reviewed', async () => {
    nextReading = () => Promise.reject(new ReaderError('key refused', false));
    const a = await upload(meera, 'meera-1');
    await h.settle();
    expect(await day(meera, '2026-11-22')).toMatchObject({ status: 'PENDING_VERIFICATION' });
    // temporary: stays waiting for the AI after attempt 1 and 2, then review after 3
    const { verifySubmission } = await import('../../src/modules/checkin/submissions.js');
    nextReading = () => Promise.reject(new ReaderError('overloaded', true));
    const b = await upload(meera, 'meera-2');
    await h.settle();
    const sid = b.body.data.submissionId;
    expect((await h.admin.query(`SELECT status, ai_attempts FROM submissions WHERE submission_id = $1`, [sid])).rows[0]).toEqual({ status: 'PENDING_AI', ai_attempts: 1 });
    await verifySubmission(h.pool, h.mediaDir, sid, () => h.now(), fake);
    expect(await verifySubmission(h.pool, h.mediaDir, sid, () => h.now(), fake)).toBe('PENDING_REVIEW');
    void a;
  });

  it('evidence counts for the day it arrives: 23:59:59 IST is still that day, 00:00 is the next', async () => {
    const { verifySubmission } = await import('../../src/modules/checkin/submissions.js');
    void verifySubmission;
    setReaderForTests(null); // AI off -> manual review
    h.setNow('2026-11-22T18:29:59Z'); // 23:59:59 IST on the 22nd
    const late = await upload(rahul, 'rahul-late'); // Rahul's 22nd is already decided (achieved)
    expect(late.status).toBe(409);
    h.setNow('2026-11-22T18:30:00Z'); // 00:00 IST on the 23rd
    const r = await upload(rahul, 'rahul-23');
    expect(r.body.data).toMatchObject({ day: '2026-11-23', status: 'PENDING_REVIEW' });
    setReaderForTests(fake);
  });

  it('after midnight, a day without evidence is a missed deadline', async () => {
    h.setNow('2026-11-23T03:00:00Z'); // 08:30 IST on the 23rd
    // Meera has evidence pending; the Challenge Admin's was decided; nobody may submit for the 22nd any more.
    const p = (await priya.get(`/api/challenges/${id}/me`)).body.data;
    expect(p.today).toMatchObject({ day: '2026-11-23', status: 'NOT_SUBMITTED', target: 7000 });
    h.setNow('2026-11-23T18:30:00Z'); // midnight passed: the 23rd is over
    expect(await day(priya, '2026-11-23')).toMatchObject({ status: 'MISSED_DEADLINE' });
  });

  it('an admin can record evidence sent outside the app, with its original time; it must be before that day\'s midnight', async () => {
    h.setNow('2026-11-24T06:00:00Z');
    const url = `/api/participants/${pids.priya}/submissions`;
    const late = await ca.upload(url, { clientRef: 'corr-priya-23-a', day: '2026-11-23', receivedAt: '2026-11-24T00:10:00+05:30', reason: 'Sent on WhatsApp' }, png('priya-23'));
    expect(late.status).toBe(400);
    expect((await priya.upload(url, { clientRef: 'corr-self-1', day: '2026-11-23', receivedAt: '2026-11-23T21:00:00+05:30', reason: 'Sent on WhatsApp' }, png('x'))).status).toBe(403);
    nextReading = reads({ date: '2026-11-23', value: 9100 });
    const ok = await ca.upload(url, { clientRef: 'corr-priya-23-b', day: '2026-11-23', receivedAt: '2026-11-23T21:00', reason: 'Sent on WhatsApp before the app was live' }, png('priya-23'));
    expect(ok.status).toBe(200);
    await h.settle();
    expect(await day(priya, '2026-11-23')).toMatchObject({ status: 'ACHIEVED', submission: { receivedAt: '2026-11-23T15:30:00.000Z' } });
    const { rows } = await h.admin.query(`SELECT source, recorded_by, correction_reason FROM submissions WHERE submission_id = $1`, [ok.body.data.submissionId]);
    expect(rows[0]).toMatchObject({ source: 'ADMIN_CORRECTION', recorded_by: ca.userId });
  });

  it('evidence images: the owner and reviewers can see them; other participants and the Finance Admin cannot', async () => {
    const d = await day(priya, '2026-11-22');
    const detail = (await priya.get(`/api/submissions/${d.submission.submissionId}`)).body.data;
    const url = `/api/files/${detail.fileId}`;
    const mine = await priya.raw(url);
    expect(mine.status).toBe(200);
    expect(mine.headers['content-type']).toBe('image/png');
    expect((await ca.raw(url)).status).toBe(200);
    expect((await rahul.raw(url)).status).toBe(404);
    expect((await fa.raw(url)).status).toBe(404);
    expect((await rahul.get(`/api/submissions/${d.submission.submissionId}`)).status).toBe(404);
  });

  it('a file that is not an image is refused', async () => {
    const r = await rahul.upload(`/api/challenges/${id}/submissions`, { clientRef: 'not-an-image-1' }, Buffer.from('%PDF-1.7 hello'));
    expect(r.status).toBe(400);
  });
});

describe('rest days', () => {
  it('declared before 10:00 on the day (or earlier); one per week; no evidence that day; cancel only before 10:00', async () => {
    h.setNow('2026-11-24T04:29:00Z'); // 09:59 IST on the 24th (week 1)
    const r = await sita.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-24' });
    expect(r.status).toBe(200);
    expect(await day(sita, '2026-11-24')).toMatchObject({ status: 'REST' });
    expect((await upload(sita, 'sita-24')).status).toBe(409); // no evidence on a rest day
    expect((await sita.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-26' })).status).toBe(409); // second in week 1
    expect((await sita.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-30' })).status).toBe(200); // week 2, in advance
    h.setNow('2026-11-24T04:30:00Z'); // 10:00 IST
    expect((await rahul.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-24' })).status).toBe(409); // too late
    expect((await sita.post(`/api/rest-days/${r.body.data.restDayId}/cancel`)).status).toBe(409); // too late to cancel
    expect((await rahul.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-23' })).status).toBe(409); // no retroactive
  });

  it('a day with evidence cannot become a rest day', async () => {
    h.setNow('2026-11-25T02:00:00Z');
    nextReading = reads({ date: '2026-11-25' });
    await upload(rahul, 'rahul-25');
    await h.settle();
    expect((await rahul.post(`/api/challenges/${id}/rest-days`, { day: '2026-11-25' })).status).toBe(409);
  });

  it('admin correction records a past rest day with its original time (flagged if after the cut-off); not for themselves', async () => {
    const url = `/api/participants/${pids.meera}/rest-days`;
    expect((await ca.post(url, { day: '2026-11-23', reason: '' })).status).toBe(400);
    expect((await fa.post(url, { day: '2026-11-23', reason: 'Declared on WhatsApp' })).status).toBe(403);
    expect((await ca.post(`/api/participants/${pids.chadmin}/rest-days`, { day: '2026-11-23', reason: 'Declared on WhatsApp' })).status).toBe(403);
    const ok = await ca.post(url, { day: '2026-11-23', declaredAt: '2026-11-23T08:15:00+05:30', reason: 'Declared on WhatsApp before the app was live' });
    expect(ok.body.data).toMatchObject({ afterCutoff: false });
    expect(await day(meera, '2026-11-23')).toMatchObject({ status: 'REST', restDay: { source: 'ADMIN_CORRECTION' } });
  });
});

describe('exemptions', () => {
  it('without voting configured, a request goes to admin review; approved days are EXCUSED', async () => {
    h.setNow('2026-11-26T06:00:00Z');
    const r = await priya.post(`/api/challenges/${id}/exemptions`, { startDay: '2026-11-26', endDay: '2026-11-27', reason: 'Fever, doctor advised rest' });
    expect(r.body.data).toMatchObject({ status: 'ADMIN_REVIEW' });
    const rid = r.body.data.requestId;
    expect((await priya.post(`/api/challenges/${id}/exemptions`, { startDay: '2026-11-27', endDay: '2026-11-28', reason: 'Overlapping' })).status).toBe(409);
    expect((await rahul.post(`/api/exemptions/${rid}/decide`, { approve: true, reason: 'ok ok ok' })).status).toBe(403);
    expect((await ca.post(`/api/exemptions/${rid}/decide`, { approve: true, reason: '' })).status).toBe(400);
    expect((await ca.post(`/api/exemptions/${rid}/decide`, { approve: true, reason: 'Doctor\'s note seen' })).status).toBe(200);
    expect(await day(priya, '2026-11-26')).toMatchObject({ status: 'EXCUSED' });
    expect((await upload(priya, 'priya-26')).status).toBe(409); // no evidence needed on an excused day
    // Admins can't decide their own request.
    const own = await ca.post(`/api/challenges/${id}/exemptions`, { startDay: '2026-11-26', endDay: '2026-11-26', reason: 'Family emergency' });
    expect((await ca.post(`/api/exemptions/${own.body.data.requestId}/decide`, { approve: true, reason: 'Approving myself' })).status).toBe(403);
  });

  it('participant voting from the settings: requester can\'t vote; majority approves; a tie or too few votes go to an admin', async () => {
    const c = calamariConfig();
    c.exemptions.voting = { requesterMayVote: false, minVotes: 2, approvalThresholdPct: 51, votingHours: 24, adminOverride: true };
    expect((await ca.put(`/api/challenges/${id}/config`, { config: c, reason: 'Enable exemption voting', effectiveFrom: '2026-11-27' })).status).toBe(200);
    h.setNow('2026-11-27T06:00:00Z');
    const r = await rahul.post(`/api/challenges/${id}/exemptions`, { startDay: '2026-11-27', endDay: '2026-11-27', reason: 'Travelling for a funeral' });
    expect(r.body.data.status).toBe('VOTING');
    const rid = r.body.data.requestId;
    expect((await rahul.post(`/api/exemptions/${rid}/vote`, { vote: 'APPROVE' })).status).toBe(403);
    const list = (await sita.get(`/api/challenges/${id}/exemptions`)).body.data.find((x: { requestId: number }) => x.requestId === rid);
    expect(list).toMatchObject({ canVote: true, tally: null, reason: 'Travelling for a funeral' }); // tallies hidden while voting
    await sita.post(`/api/exemptions/${rid}/vote`, { vote: 'APPROVE' });
    await priya.post(`/api/exemptions/${rid}/vote`, { vote: 'APPROVE' });
    await meera.post(`/api/exemptions/${rid}/vote`, { vote: 'REJECT' });
    h.setNow('2026-11-28T06:00:01Z'); // window closed
    const after = (await sita.get(`/api/challenges/${id}/exemptions`)).body.data.find((x: { requestId: number }) => x.requestId === rid);
    expect(after).toMatchObject({ status: 'APPROVED', decisionMethod: 'VOTE', tally: { approve: 2, reject: 1 } });
    expect(await day(rahul, '2026-11-27')).toMatchObject({ status: 'EXCUSED' });

    // A tie -> admin review.
    const t = await sita.post(`/api/challenges/${id}/exemptions`, { startDay: '2026-11-28', endDay: '2026-11-28', reason: 'Sprained ankle' });
    await priya.post(`/api/exemptions/${t.body.data.requestId}/vote`, { vote: 'APPROVE' });
    await meera.post(`/api/exemptions/${t.body.data.requestId}/vote`, { vote: 'REJECT' });
    h.setNow('2026-11-29T07:00:00Z');
    const tie = (await sita.get(`/api/challenges/${id}/exemptions`)).body.data.find((x: { requestId: number }) => x.requestId === t.body.data.requestId);
    expect(tie).toMatchObject({ status: 'ADMIN_REVIEW' });
    expect(tie.reviewReason).toContain('Tie');

    // Too few votes -> admin review.
    const f = await meera.post(`/api/challenges/${id}/exemptions`, { startDay: '2026-11-29', endDay: '2026-11-29', reason: 'Migraine' });
    await priya.post(`/api/exemptions/${f.body.data.requestId}/vote`, { vote: 'APPROVE' });
    h.setNow('2026-11-30T08:00:00Z');
    const few = (await meera.get(`/api/challenges/${id}/exemptions`)).body.data.find((x: { requestId: number }) => x.requestId === f.body.data.requestId);
    expect(few).toMatchObject({ status: 'ADMIN_REVIEW' });
    expect(few.reviewReason).toContain('Only 1 vote');
  });
});

describe('dashboards', () => {
  it('adherence leaves out rest and excused days; the admin overview shows everyone\'s day', async () => {
    h.setNow('2026-11-30T08:00:00Z');
    const me = (await priya.get(`/api/challenges/${id}/me`)).body.data;
    // Priya: 22 achieved, 23 achieved (correction), 24 & 25 missed, 26-27 excused, 28 & 29 missed.
    expect(me.summary).toMatchObject({ achieved: 2, excused: 2, missed: 4, adherencePct: 33.33 });
    const sitaMe = (await sita.get(`/api/challenges/${id}/me`)).body.data;
    expect(sitaMe.summary).toMatchObject({ rest: 2, restDaysUsed: 2 }); // the 24th, and today (the 30th)
    expect((await priya.get(`/api/challenges/${id}/overview`)).status).toBe(403);
    const o = (await ca.get(`/api/challenges/${id}/overview?day=2026-11-22`)).body.data;
    expect(o.counts).toEqual({ ACHIEVED: 3, TARGET_MISSED: 1, PENDING_VERIFICATION: 1 }); // priya, rahul (appeal), sita; the admin; meera
    expect(o.people).toHaveLength(5);
    expect((await fa.get(`/api/challenges/${id}/overview`)).status).toBe(200); // finance admin sees participation, not health
  });
});
