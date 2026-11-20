import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, makeHarness, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, ca: Client, fa: Client;
let p1: Client, p2: Client, p3: Client, late: Client;
let id: number;

beforeAll(async () => {
  db = await startPg();
  h = await makeHarness(db, '2026-11-20T06:00:00Z');
  sa = await h.user('super', { superAdmin: true });
  ca = await h.user('chadmin');
  fa = await h.user('finadmin');
  [p1, p2, p3, late] = [await h.user('priya'), await h.user('rahul'), await h.user('sita'), await h.user('latecomer')];
  id = (await sa.post('/api/challenges', { slug: 'calamari-2026', config: calamariConfig() })).body.data.challengeId;
  await sa.post(`/api/challenges/${id}/roles`, { userId: ca.userId, role: 'CHALLENGE_ADMIN' });
  await sa.post(`/api/challenges/${id}/roles`, { userId: fa.userId, role: 'FINANCE_ADMIN' });
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

const myInvite = async (c: Client) => (await c.get('/api/me/invitations')).body.data[0];
const rulesVersion = async (c: Client) => (await c.get(`/api/challenges/${id}`)).body.data.acceptVersionNo;

describe('invitations and roster (Calamari: invitation-only)', () => {
  it('no invitations before publishing; Finance Admin cannot manage the roster', async () => {
    expect((await ca.post(`/api/challenges/${id}/invitations`, { userIds: [p1.userId] })).status).toBe(409);
    await h.ensureAdmins(sa, id); await sa.post(`/api/challenges/${id}/publish`);
    expect((await fa.post(`/api/challenges/${id}/invitations`, { userIds: [p1.userId] })).status).toBe(403);
    expect((await p2.post(`/api/challenges/${id}/invitations`, { userIds: [p1.userId] })).status).toBe(403);
  });

  it('Challenge Admin invites; duplicates are refused; the invitee sees the challenge and its rules', async () => {
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [p1.userId, p2.userId, p3.userId] });
    expect(r.status).toBe(200);
    expect(r.body.data.invited).toHaveLength(3);
    expect((await ca.post(`/api/challenges/${id}/invitations`, { userIds: [p1.userId] })).status).toBe(409);
    const inv = await myInvite(p1);
    expect(inv).toMatchObject({ challengeId: id, name: 'Calamari', startsOn: '2026-11-22' });
    const view = (await p1.get(`/api/challenges/${id}`)).body.data;
    expect(view.current.config.activity.dailyTarget).toBe(7000);
    expect(view.versions).toBeUndefined(); // version history is for admins
  });

  it('accepting requires agreeing to the fitness AND financial rules of the current version', async () => {
    const inv = await myInvite(p1);
    const v = await rulesVersion(p1);
    expect((await p1.post(`/api/invitations/${inv.invitationId}/accept`, { rulesVersionNo: v, acceptFitnessRules: true })).status).toBe(400);
    expect((await p1.post(`/api/invitations/${inv.invitationId}/accept`, { rulesVersionNo: v + 1, acceptFitnessRules: true, acceptFinancialRules: true })).status).toBe(409);
    expect((await p2.post(`/api/invitations/${inv.invitationId}/accept`, { rulesVersionNo: v, acceptFitnessRules: true, acceptFinancialRules: true })).status).toBe(404); // not theirs
    const ok = await p1.post(`/api/invitations/${inv.invitationId}/accept`, { rulesVersionNo: v, acceptFitnessRules: true, acceptFinancialRules: true });
    expect(ok.status).toBe(200);
    expect(ok.body.data.joinedOn).toBe('2026-11-22'); // accepted before the start: from day one
    expect((await p1.post(`/api/invitations/${inv.invitationId}/accept`, { rulesVersionNo: v, acceptFitnessRules: true, acceptFinancialRules: true })).status).toBe(409);
    expect((await ca.post(`/api/challenges/${id}/invitations`, { userIds: [p1.userId] })).status).toBe(409); // already on the roster
  });

  it('a rules change before acceptance makes the old version unacceptable', async () => {
    const inv = await myInvite(p2);
    const old = await rulesVersion(p2);
    const c = calamariConfig(); c.submission.instructions = 'Updated instructions';
    expect((await ca.put(`/api/challenges/${id}/config`, { config: c, reason: 'Clarify screenshots' })).status).toBe(200);
    expect((await p2.post(`/api/invitations/${inv.invitationId}/accept`, { rulesVersionNo: old, acceptFitnessRules: true, acceptFinancialRules: true })).status).toBe(409);
    expect((await p2.post(`/api/invitations/${inv.invitationId}/accept`, { rulesVersionNo: old + 1, acceptFitnessRules: true, acceptFinancialRules: true })).status).toBe(200);
  });

  it('decline, revoke and resend', async () => {
    const inv = await myInvite(p3);
    expect((await p3.post(`/api/invitations/${inv.invitationId}/decline`)).status).toBe(200);
    expect((await ca.post(`/api/invitations/${inv.invitationId}/revoke`)).status).toBe(409); // already declined
    const again = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [p3.userId] });
    expect(again.status).toBe(200);
    const invId = again.body.data.invited[0];
    expect((await ca.post(`/api/invitations/${invId}/revoke`)).status).toBe(200);
    expect(await myInvite(p3)).toBeUndefined();
  });

  it('invitations expire, and can be re-sent', async () => {
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [p3.userId] });
    const invId = r.body.data.invited[0];
    const v = await rulesVersion(sa);
    const { rows: [i] } = await h.admin.query(`SELECT expires_at FROM invitations WHERE invitation_id = $1`, [invId]);
    expect(i.expires_at.getTime() - h.now().getTime()).toBe(14 * 86_400_000); // Calamari: valid 14 days
    await h.admin.query(`UPDATE invitations SET expires_at = $2 WHERE invitation_id = $1`, [invId, new Date(h.now().getTime() - 1000)]);
    const expired = await p3.post(`/api/invitations/${invId}/accept`, { rulesVersionNo: v, acceptFitnessRules: true, acceptFinancialRules: true });
    expect(expired.status).toBe(409);
    expect(expired.body.message).toContain('expired');
    const list = (await ca.get(`/api/challenges/${id}/invitations`)).body.data;
    expect(list.find((x: { invitationId: number }) => x.invitationId === invId).status).toBe('EXPIRED');
    expect((await ca.post(`/api/invitations/${invId}/resend`)).status).toBe(200);
    expect((await p3.post(`/api/invitations/${invId}/accept`, { rulesVersionNo: v, acceptFitnessRules: true, acceptFinancialRules: true })).status).toBe(200);
  });

  it('the roster locks at the start: a late join needs an approved first day and a reason; never retroactive', async () => {
    h.setNow('2026-11-24T05:00:00Z'); // 24 Nov, 10:30 IST (day 3)
    expect((await ca.post(`/api/challenges/${id}/invitations`, { userIds: [late.userId] })).status).toBe(400);
    expect((await ca.post(`/api/challenges/${id}/invitations`, { userIds: [late.userId], approvedJoinOn: '2026-11-23', reason: 'Joined late' })).status).toBe(400);
    const r = await ca.post(`/api/challenges/${id}/invitations`, { userIds: [late.userId], approvedJoinOn: '2026-11-25', reason: 'Friend of Priya, joining late' });
    expect(r.status).toBe(200);
    h.setNow('2026-11-26T05:00:00Z'); // accepts after the approved day has passed
    const v = await rulesVersion(late);
    const ok = await late.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: v, acceptFitnessRules: true, acceptFinancialRules: true });
    expect(ok.status).toBe(200);
    expect(ok.body.data.joinedOn).toBe('2026-11-26'); // today, not the 25th: no retroactive days
  });

  it('withdrawal takes an effective day (not in the past) and a reason; history is kept', async () => {
    const roster = (await ca.get(`/api/challenges/${id}/participants`)).body.data;
    const rahul = roster.find((x: { username: string }) => x.username === 'rahul');
    expect(rahul).toMatchObject({ status: 'ACTIVE', joinedOn: '2026-11-22', leftOn: null });
    const base = { toStatus: 'WITHDRAWN', reason: 'Injured knee' };
    expect((await ca.post(`/api/participants/${rahul.participantId}/status`, { ...base, effectiveOn: '2026-11-25' })).status).toBe(400); // past
    expect((await ca.post(`/api/participants/${rahul.participantId}/status`, { ...base, effectiveOn: '2026-11-27', reason: '' })).status).toBe(400);
    expect((await fa.post(`/api/participants/${rahul.participantId}/status`, { ...base, effectiveOn: '2026-11-27' })).status).toBe(403);
    expect((await ca.post(`/api/participants/${rahul.participantId}/status`, { ...base, effectiveOn: '2026-11-27', financialOutcome: 'No refund' })).status).toBe(200);
    const after = (await ca.get(`/api/challenges/${id}/participants`)).body.data.find((x: { username: string }) => x.username === 'rahul');
    expect(after).toMatchObject({ status: 'WITHDRAWN', leftOn: '2026-11-26' }); // last day taking part
    expect((await ca.post(`/api/participants/${rahul.participantId}/status`, { toStatus: 'ACTIVE', effectiveOn: '2026-11-27', reason: 'Changed mind' })).status).toBe(400);
    const { rows } = await h.admin.query(`SELECT from_status, to_status, effective_on FROM participant_status_history WHERE participant_id = $1 ORDER BY history_id`, [rahul.participantId]);
    expect(rows.map((r) => `${r.from_status}->${r.to_status}@${r.effective_on}`)).toEqual(['null->ACTIVE@2026-11-22', 'ACTIVE->WITHDRAWN@2026-11-27']);
  });

  it('an admin who also participates cannot change their own status; only a Super Admin reverses a disqualification', async () => {
    // The Challenge Admin joins as a participant too.
    const r = await sa.post(`/api/challenges/${id}/invitations`, { userIds: [ca.userId], approvedJoinOn: '2026-11-26', reason: 'Admin also walks' });
    const v = await rulesVersion(ca);
    await ca.post(`/api/invitations/${r.body.data.invited[0]}/accept`, { rulesVersionNo: v, acceptFitnessRules: true, acceptFinancialRules: true });
    const me = (await ca.get(`/api/challenges/${id}/participants`)).body.data.find((x: { username: string }) => x.username === 'chadmin');
    expect((await ca.post(`/api/participants/${me.participantId}/status`, { toStatus: 'WITHDRAWN', effectiveOn: '2026-11-27', reason: 'Too busy' })).status).toBe(403);

    const priya = (await ca.get(`/api/challenges/${id}/participants`)).body.data.find((x: { username: string }) => x.username === 'priya');
    expect((await ca.post(`/api/participants/${priya.participantId}/status`, { toStatus: 'DISQUALIFIED', effectiveOn: '2026-11-26', reason: 'Edited screenshots' })).status).toBe(200);
    expect((await ca.post(`/api/participants/${priya.participantId}/status`, { toStatus: 'ACTIVE', effectiveOn: '2026-11-27', reason: 'Appeal upheld' })).status).toBe(403);
    expect((await sa.post(`/api/participants/${priya.participantId}/status`, { toStatus: 'ACTIVE', effectiveOn: '2026-11-27', reason: 'Appeal upheld' })).status).toBe(200);
  });

  it('participants see fellow participants\' names and status only; outsiders see nothing', async () => {
    const seen = (await p3.get(`/api/challenges/${id}/participants`)).body.data;
    expect(Object.keys(seen[0]).sort()).toEqual(['displayName', 'participantId', 'status']);
    const outsider = await h.user('outsider');
    expect((await outsider.get(`/api/challenges/${id}/participants`)).status).toBe(403);
    expect((await outsider.get(`/api/challenges/${id}`)).status).toBe(404);
  });

  it('every roster action was audited', async () => {
    const { rows } = await h.admin.query(`SELECT DISTINCT action FROM audit_log WHERE challenge_id = $1 ORDER BY action`, [id]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining([
      'CHALLENGE_CREATED', 'CHALLENGE_PUBLISHED', 'CHALLENGE_ROLE_GRANTED', 'CHALLENGE_RULES_VERSIONED', 'INVITATION_ACCEPTED', 'INVITATION_DECLINED',
      'INVITATION_RESENT', 'INVITATION_REVOKED', 'LATE_JOIN_INVITED', 'PARTICIPANT_INVITED', 'PARTICIPANT_STATUS_CHANGED']));
  });
});
