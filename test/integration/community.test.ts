import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calamariConfig, makeHarness, png, type Client, type Harness } from '../helpers/app.js';
import { startPg, type TestPg } from '../helpers/pg.js';

let db: TestPg;
let h: Harness;
let sa: Client, admin: Client, fm: Client, asha: Client, ravi: Client, outsider: Client;
let id: number;
const feed = async (c: Client) => (await c.get(`/api/challenges/${id}/feed`)).body.data;
const ids = async (c: Client) => (await c.get('/api/me/notifications')).body.data.map((n: { id: string }) => n.id.split(':')[0]);

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
  const inv = await admin.post(`/api/challenges/${id}/invitations`, { userIds: [asha.userId, ravi.userId] });
  for (const [c, i] of [[asha, 0], [ravi, 1]] as const) await c.post(`/api/invitations/${inv.body.data.invited[i]}/accept`, { rulesVersionNo: 1, acceptFitnessRules: true, acceptFinancialRules: true });
}, 120_000);
afterAll(async () => { await h?.close(); await db?.stop(); });

describe('community feed', () => {
  it('only the challenge\'s participants and admins can see it', async () => {
    expect((await outsider.get(`/api/challenges/${id}/feed`)).status).toBe(403);
    expect((await outsider.post(`/api/challenges/${id}/posts`, { body: 'hi' })).status).toBe(403);
    expect(await feed(asha)).toMatchObject({ posts: [], pinned: [], can: { post: true, comment: true, announce: false, moderate: false } });
    expect((await feed(admin)).can).toMatchObject({ announce: true, moderate: true });
    expect((await feed(fm)).can.moderate).toBe(false); // the finance manager is not a moderator
  });

  it('participants post (with a photo), announcements are admin-only and pinned', async () => {
    expect((await asha.post(`/api/challenges/${id}/posts`, { kind: 'ANNOUNCEMENT', body: 'I am the boss' })).status).toBe(403);
    expect((await asha.post(`/api/challenges/${id}/posts`, { body: '   ' })).status).toBe(400);
    const p = await asha.upload(`/api/challenges/${id}/posts`, { body: 'Morning walk done 🌅' }, png('walk'));
    expect(p.status).toBe(200);
    expect((await admin.post(`/api/challenges/${id}/posts`, { kind: 'ANNOUNCEMENT', body: 'Welcome to Calamari! Submit by 10 pm.' })).status).toBe(200);
    const f = await feed(ravi);
    expect(f.pinned.map((x: { kind: string }) => x.kind)).toEqual(['ANNOUNCEMENT']);
    expect(f.posts[0]).toMatchObject({ body: 'Morning walk done 🌅', author: { displayName: 'asha' }, mine: false });
    const photo = f.posts[0].photoFileId;
    expect((await ravi.raw(`/api/files/${photo}`)).status).toBe(200);
    expect((await outsider.raw(`/api/files/${photo}`)).status).toBe(404);
    expect(await ids(ravi)).toContain('ann');
    expect(await ids(admin)).not.toContain('ann'); // not for its own author
  });

  it('reactions toggle; comments have one level of replies; the author is told', async () => {
    const pid = (await feed(ravi)).posts[0].postId;
    expect((await ravi.post(`/api/posts/${pid}/react`, { emoji: '🔥' })).body.data).toEqual([{ emoji: '🔥', count: 1, mine: true }]);
    await asha.post(`/api/posts/${pid}/react`, { emoji: '🔥' });
    expect((await ravi.post(`/api/posts/${pid}/react`, { emoji: '🔥' })).body.data).toEqual([{ emoji: '🔥', count: 1, mine: false }]);
    expect((await ravi.post(`/api/posts/${pid}/react`, { emoji: '💩' })).status).toBe(400);
    const c1 = (await ravi.post(`/api/posts/${pid}/comments`, { body: 'Nice one!' })).body.data.commentId;
    const r1 = (await asha.post(`/api/posts/${pid}/comments`, { body: 'Thanks!', parentId: c1 })).body.data.commentId;
    await ravi.post(`/api/posts/${pid}/comments`, { body: 'Reply to a reply', parentId: r1 });
    const cs = (await asha.get(`/api/posts/${pid}/comments`)).body.data;
    expect(cs.map((c: { parentId: number | null }) => c.parentId)).toEqual([null, c1, c1]); // flattened to one level
    expect((await feed(ravi)).posts[0].comments).toBe(3);
    expect(await ids(asha)).toContain('comments');
  });

  it('people delete their own posts and comments only', async () => {
    const pid = (await asha.post(`/api/challenges/${id}/posts`, { body: 'Oops, wrong photo' })).body.data.postId;
    expect((await ravi.post(`/api/posts/${pid}/delete`)).status).toBe(403);
    expect((await asha.post(`/api/posts/${pid}/delete`)).status).toBe(200);
    expect((await feed(ravi)).posts.some((p: { postId: number }) => p.postId === pid)).toBe(false);
  });

  it('reports go to moderators; removal needs a reason, is audited and closes the report', async () => {
    const pid = (await ravi.post(`/api/challenges/${id}/posts`, { body: 'Buy cheap step counters at my shop!' })).body.data.postId;
    expect((await asha.post(`/api/posts/${pid}/report`, { reason: 'x' })).status).toBe(400);
    expect((await asha.post(`/api/posts/${pid}/report`, { reason: 'Spam / advertising' })).status).toBe(200);
    expect((await asha.get(`/api/challenges/${id}/community-reports`)).status).toBe(403);
    expect(await ids(admin)).toContain('reports');
    const reps = (await admin.get(`/api/challenges/${id}/community-reports`)).body.data;
    expect(reps).toMatchObject([{ postId: pid, reason: 'Spam / advertising', author: 'ravi' }]);
    expect((await asha.post(`/api/posts/${pid}/remove`, { reason: 'Spam post' })).status).toBe(403);
    expect((await admin.post(`/api/posts/${pid}/remove`, { reason: '' })).status).toBe(400);
    expect((await admin.post(`/api/posts/${pid}/remove`, { reason: 'Advertising is not allowed' })).status).toBe(200);
    expect((await feed(asha)).posts.some((p: { postId: number }) => p.postId === pid)).toBe(false);
    expect((await feed(admin)).posts.find((p: { postId: number }) => p.postId === pid)).toMatchObject({ status: 'REMOVED', removedReason: 'Advertising is not allowed' });
    expect((await admin.get(`/api/challenges/${id}/community-reports`)).body.data).toEqual([]);
    const { rows } = await h.admin.query(`SELECT action, reason FROM audit_log WHERE entity = 'POST' AND action = 'POST_REMOVED'`);
    expect(rows).toEqual([{ action: 'POST_REMOVED', reason: 'Advertising is not allowed' }]);
  });

  it('a muted person can read and react but not post or comment, until the mute ends or is lifted', async () => {
    expect((await admin.post(`/api/challenges/${id}/community-mutes`, { userId: ravi.userId, days: 3, reason: '' })).status).toBe(400);
    expect((await admin.post(`/api/challenges/${id}/community-mutes`, { userId: ravi.userId, days: 3, reason: 'Repeated advertising' })).status).toBe(200);
    const f = await feed(ravi);
    expect(f).toMatchObject({ can: { post: false, comment: false }, muted: { reason: 'Repeated advertising' } });
    const r = await ravi.post(`/api/challenges/${id}/posts`, { body: 'Still here' });
    expect(r.status).toBe(403);
    expect(r.body.message).toContain('Repeated advertising');
    expect((await ravi.post(`/api/posts/${f.pinned[0].postId}/comments`, { body: 'hi' })).status).toBe(403);
    expect((await ravi.post(`/api/posts/${f.pinned[0].postId}/react`, { emoji: '👍' })).status).toBe(200);
    await admin.post(`/api/challenges/${id}/community-mutes`, { userId: ravi.userId, days: 0 });
    expect((await ravi.post(`/api/challenges/${id}/posts`, { body: 'Sorry, back to walking' })).status).toBe(200);
  });

  it('achievement shares are built from the person\'s own points - never someone else\'s, never health data', async () => {
    const { rows: [p] } = await h.admin.query(`SELECT participant_id FROM participants WHERE user_id = $1`, [asha.userId]);
    const { rows: [e] } = await h.admin.query(
      `INSERT INTO scoring_events (challenge_id, participant_id, base_key, idem_key, rule, kind, day, points, rules_version_no, details, created_at)
       VALUES ($1,$2,'pstreak:x','pstreak:x#1','PERSONAL_STREAK','AWARD','2026-11-28',10,1,'{"streak":7,"steps":8123}',now()) RETURNING event_id`, [id, p.participant_id]);
    expect((await asha.get(`/api/challenges/${id}/my-achievements`)).body.data).toMatchObject([{ eventId: Number(e.event_id), rule: 'PERSONAL_STREAK', streak: 7 }]);
    expect((await ravi.post(`/api/challenges/${id}/posts`, { kind: 'ACHIEVEMENT', eventId: e.event_id })).status).toBe(400); // not his
    const r = await asha.post(`/api/challenges/${id}/posts`, { kind: 'ACHIEVEMENT', eventId: e.event_id, body: 'Feeling great' });
    expect(r.status).toBe(200);
    const post = (await feed(ravi)).posts.find((x: { postId: number }) => x.postId === r.body.data.postId);
    expect(post.body).toBe('🔥 Reached a 7-day streak!\nFeeling great');
    expect(JSON.stringify(post)).not.toContain('8123');
  });

  it('settings: admins-only posting, photos off, or the whole feed off', async () => {
    const cfg = { ...calamariConfig(), community: { enabled: true, participantsCanPost: false, photos: false } };
    expect((await admin.put(`/api/challenges/${id}/config`, { config: cfg, reason: 'Keep the feed to announcements' })).status).toBe(200);
    expect((await asha.post(`/api/challenges/${id}/posts`, { body: 'hello' })).status).toBe(403);
    expect((await admin.upload(`/api/challenges/${id}/posts`, { kind: 'ANNOUNCEMENT', body: 'with photo' }, png('a'))).status).toBe(403);
    const pinned = (await feed(asha)).pinned[0].postId;
    expect((await asha.post(`/api/posts/${pinned}/comments`, { body: 'Still can comment' })).status).toBe(200);
    expect((await admin.put(`/api/challenges/${id}/config`, { config: { ...cfg, community: { enabled: false, participantsCanPost: false, photos: false } }, reason: 'No feed at all' })).status).toBe(200);
    expect((await asha.get(`/api/challenges/${id}/feed`)).status).toBe(403);
  });
});
