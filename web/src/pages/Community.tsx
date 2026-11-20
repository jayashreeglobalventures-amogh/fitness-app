// Community tab: one feed per challenge - announcements (pinned), posts with an optional photo, achievement shares,
// reactions, comments with replies, reports and moderation.
import { useEffect, useRef, useState } from 'react';
import { api, type ChallengeListItem, type Me } from '../api';
import { navigate } from '../router';
import { Avatar, ErrorBox, Loading, time, upload, useLoad } from '../ui';

interface Reaction { emoji: string; count: number; mine: boolean }
interface Post {
  postId: number; kind: 'ANNOUNCEMENT' | 'POST' | 'ACHIEVEMENT'; body: string; photoFileId: number | null; status: string; removedReason: string | null;
  pinned: boolean; createdAt: string; author: { userId: number; displayName: string; photoFileId: number | null }; mine: boolean; comments: number;
  reactions: Reaction[]; canDelete: boolean; canModerate: boolean;
}
interface Feed {
  pinned: Post[]; posts: Post[]; nextBefore: number | null; emojis: string[];
  can: { post: boolean; comment: boolean; announce: boolean; moderate: boolean; photos: boolean };
  muted: { until: string; reason: string } | null;
}
interface Comment { commentId: number; parentId: number | null; body: string; status: string; removedReason: string | null; createdAt: string; author: { userId: number; displayName: string; photoFileId: number | null }; mine: boolean }
interface Report { reportId: number; postId: number | null; commentId: number | null; reporter: string; reason: string; body: string; author: string; authorUserId: number; targetStatus: string; createdAt: string }
interface Achievement { eventId: number; rule: string; day: string; points: number; streak: number | null }

const ACH_LABEL: Record<string, (a: Achievement) => string> = {
  PERSONAL_STREAK: (a) => `🔥 ${a.streak}-day streak`, TEAM_STREAK: (a) => `🤝 Team ${a.streak}-day streak`, COMEBACK: () => '💪 Comeback', WEEKEND_BONUS: () => '🏅 Weekend bonus',
};

export function CommunityPage({ me, challengeId }: { me: Me; challengeId: number | null }) {
  const list = useLoad(() => api.get<ChallengeListItem[]>('/api/challenges'), []);
  const mine = (list.data ?? []).filter((c) => me.superAdmin || c.participantStatus || c.myRoles.length);
  useEffect(() => {
    if (challengeId == null && mine.length) navigate(`/community/${(mine.find((c) => c.phase === 'ACTIVE') ?? mine[0])!.challengeId}`);
  }, [challengeId, mine.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (list.loading) return <Loading />;
  if (!mine.length) return <div className="empty"><h1>Community</h1><p className="muted">Join a challenge to see its community.</p></div>;
  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Community</h1>
        {mine.length > 1 && (
          <select value={challengeId ?? ''} onChange={(e) => navigate(`/community/${e.target.value}`)} aria-label="Challenge" style={{ maxWidth: 220 }}>
            {mine.map((c) => <option key={c.challengeId} value={c.challengeId}>{c.name}</option>)}
          </select>
        )}
      </div>
      {challengeId != null && <FeedView key={challengeId} challengeId={challengeId} name={mine.find((c) => c.challengeId === challengeId)?.name ?? ''} />}
    </>
  );
}

function FeedView({ challengeId, name }: { challengeId: number; name: string }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [more, setMore] = useState<Post[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = async () => {
    try { setFeed(await api.get<Feed>(`/api/challenges/${challengeId}/feed`)); setMore([]); setError(null); } catch (e) { setError(e); }
  };
  useEffect(() => { void load(); }, [challengeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadMore = async () => {
    const before = (more.length ? more : feed!.posts).at(-1)?.postId;
    try {
      const f = await api.get<Feed>(`/api/challenges/${challengeId}/feed?before=${before}`);
      setMore((m) => [...m, ...f.posts]);
      setFeed((x) => (x ? { ...x, nextBefore: f.nextBefore } : x));
    } catch (e) { setError(e); }
  };
  if (error && !feed) return <ErrorBox error={error} />;
  if (!feed) return <Loading />;
  const posts = [...feed.posts, ...more];
  return (
    <>
      <ErrorBox error={error} />
      {feed.can.moderate && <Reports challengeId={challengeId} onChanged={load} />}
      {feed.muted && <div className="alert warn">You can read and react, but can't post or comment until {new Date(feed.muted.until).toLocaleDateString('en-IN')} ({feed.muted.reason}).</div>}
      {(feed.can.post || feed.can.announce) && <Composer challengeId={challengeId} feed={feed} onPosted={load} />}
      {!feed.can.post && !feed.can.announce && !feed.muted && <p className="muted small">In {name} only admins post. You can react and comment.</p>}
      {feed.pinned.map((p) => <PostCard key={p.postId} p={p} feed={feed} challengeId={challengeId} onChanged={load} />)}
      {posts.map((p) => <PostCard key={p.postId} p={p} feed={feed} challengeId={challengeId} onChanged={load} />)}
      {!posts.length && !feed.pinned.length && <div className="empty"><p className="muted">Nothing here yet. Be the first to post!</p></div>}
      {feed.nextBefore && <button className="btn ghost" style={{ width: '100%' }} onClick={loadMore}>Show older posts</button>}
    </>
  );
}

function Composer({ challengeId, feed, onPosted }: { challengeId: number; feed: Feed; onPosted: () => void }) {
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [kind, setKind] = useState<'POST' | 'ANNOUNCEMENT' | 'ACHIEVEMENT'>(feed.can.post ? 'POST' : 'ANNOUNCEMENT');
  const [eventId, setEventId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const input = useRef<HTMLInputElement>(null);
  const ach = useLoad(() => (kind === 'ACHIEVEMENT' ? api.get<Achievement[]>(`/api/challenges/${challengeId}/my-achievements`) : Promise.resolve([])), [kind, challengeId]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const pick = (f: File | null) => { setFile(f); setPreview(f ? URL.createObjectURL(f) : null); };
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await upload(`/api/challenges/${challengeId}/posts`, { kind, body, ...(kind === 'ACHIEVEMENT' ? { eventId } : {}) }, kind === 'ACHIEVEMENT' ? null : file);
      setBody(''); pick(null); setEventId(''); setKind(feed.can.post ? 'POST' : 'ANNOUNCEMENT'); onPosted();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const ready = kind === 'ACHIEVEMENT' ? !!eventId : !!body.trim() || !!file;
  return (
    <div className="card">
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        {feed.can.post && <button className={`btn small ${kind === 'POST' ? 'primary' : 'ghost'}`} onClick={() => setKind('POST')}>Post</button>}
        {feed.can.announce && <button className={`btn small ${kind === 'ANNOUNCEMENT' ? 'primary' : 'ghost'}`} onClick={() => setKind('ANNOUNCEMENT')}>📣 Announcement</button>}
        {feed.can.post && <button className={`btn small ${kind === 'ACHIEVEMENT' ? 'primary' : 'ghost'}`} onClick={() => setKind('ACHIEVEMENT')}>🏆 Share an achievement</button>}
      </div>
      <ErrorBox error={error} />
      {kind === 'ACHIEVEMENT' && (
        ach.data && !ach.data.length
          ? <p className="muted small">No achievements to share yet - streaks, comebacks and weekend bonuses appear here once you earn them.</p>
          : <select value={eventId} onChange={(e) => setEventId(e.target.value)} style={{ width: '100%', marginBottom: 8 }}>
              <option value="">Choose an achievement…</option>
              {(ach.data ?? []).map((a) => <option key={a.eventId} value={a.eventId}>{ACH_LABEL[a.rule]?.(a) ?? a.rule} · {a.day} · +{a.points} pts</option>)}
            </select>
      )}
      <textarea rows={kind === 'ACHIEVEMENT' ? 2 : 3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} style={{ width: '100%' }}
        placeholder={kind === 'ANNOUNCEMENT' ? 'Announcement to everyone in this challenge (it is pinned to the top)…' : kind === 'ACHIEVEMENT' ? 'Add a few words (optional)' : 'Share your walk, a tip or some encouragement…'} />
      {preview && <div style={{ position: 'relative', marginTop: 8 }}><img src={preview} alt="" className="post-photo" /><button className="btn small ghost" style={{ position: 'absolute', top: 6, right: 6 }} onClick={() => pick(null)}>Remove</button></div>}
      <div className="spread" style={{ marginTop: 8 }}>
        {feed.can.photos && kind !== 'ACHIEVEMENT'
          ? <><input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0] ?? null)} /><button className="btn small ghost" onClick={() => input.current?.click()}>📷 Photo</button></>
          : <span />}
        <button className="btn primary" disabled={!ready || busy} onClick={submit}>{busy ? 'Posting…' : 'Post'}</button>
      </div>
      <p className="muted small" style={{ marginTop: 6 }}>Only people in this challenge see it. Don't share health details or payment information.</p>
    </div>
  );
}

function PostCard({ p, feed, challengeId, onChanged }: { p: Post; feed: Feed; challengeId: number; onChanged: () => void }) {
  const [reactions, setReactions] = useState(p.reactions);
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(p.comments);
  const [action, setAction] = useState<null | 'report' | 'remove' | 'mute'>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { setReactions(p.reactions); setCount(p.comments); }, [p]);
  const react = async (emoji: string) => {
    try { setReactions(await api.post<Reaction[]>(`/api/posts/${p.postId}/react`, { emoji })); } catch (e) { setError(e); }
  };
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); setAction(null); onChanged(); } catch (e) { setError(e); } };
  const removed = p.status === 'REMOVED';
  return (
    <article className={`card post${p.kind === 'ANNOUNCEMENT' ? ' announcement' : ''}${removed ? ' removed' : ''}`}>
      <header className="row" style={{ gap: 10, flexWrap: 'nowrap', alignItems: 'center' }}>
        <Avatar fileId={p.author.photoFileId} name={p.author.displayName} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <button className="person-link" onClick={() => navigate(p.mine ? '/profile' : `/people/${p.author.userId}`)}><b>{p.author.displayName}</b></button>{p.mine && <span className="muted small"> (you)</span>}
          <div className="muted small">{time(p.createdAt)}{p.kind === 'ANNOUNCEMENT' && ' · 📣 Announcement'}{p.pinned && ' · 📌 Pinned'}</div>
        </div>
        <Menu p={p} feed={feed} onAction={setAction} onDelete={() => run(() => api.post(`/api/posts/${p.postId}/delete`))} onPin={() => run(() => api.post(`/api/posts/${p.postId}/pin`, { pinned: !p.pinned }))} />
      </header>
      {removed && <div className="alert warn small" style={{ marginTop: 8 }}>Removed by a moderator: {p.removedReason}. Only moderators see this.</div>}
      {p.body && <p className="post-body">{p.body}</p>}
      {p.photoFileId && <img src={`/api/files/${p.photoFileId}`} alt="" className="post-photo" loading="lazy" />}
      <ErrorBox error={error} />
      {action && <ActionForm kind={action} target={p} challengeId={challengeId} onCancel={() => setAction(null)} onDone={() => { setAction(null); onChanged(); }} />}
      {!removed && (
        <footer className="row" style={{ gap: 6, marginTop: 10 }}>
          {feed.emojis.map((e) => {
            const r = reactions.find((x) => x.emoji === e);
            return <button key={e} className={`react${r?.mine ? ' mine' : ''}`} onClick={() => react(e)} aria-pressed={!!r?.mine} aria-label={`React ${e}`}>{e}{r ? <span>{r.count}</span> : null}</button>;
          })}
          <button className="btn small ghost" style={{ marginLeft: 'auto' }} onClick={() => setOpen((o) => !o)}>💬 {count ? `${count} ${count === 1 ? 'comment' : 'comments'}` : 'Comment'}</button>
        </footer>
      )}
      {open && <Comments postId={p.postId} feed={feed} challengeId={challengeId} onCount={setCount} />}
    </article>
  );
}

function Menu({ p, feed, onAction, onDelete, onPin }: { p: Post; feed: Feed; onAction: (a: 'report' | 'remove' | 'mute') => void; onDelete: () => void; onPin: () => void }) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const items: [string, () => void][] = [];
  if (p.canDelete) items.push([sure ? 'Tap again to delete' : 'Delete my post', () => (sure ? onDelete() : setSure(true))]);
  if (!p.mine && p.status === 'VISIBLE') items.push(['Report', () => onAction('report')]);
  if (feed.can.moderate && p.status === 'VISIBLE') {
    items.push([p.pinned ? 'Unpin' : 'Pin to top', onPin]);
    items.push(['Remove post', () => onAction('remove')]);
    if (!p.mine) items.push([`Mute ${p.author.displayName}`, () => onAction('mute')]);
  }
  if (!items.length) return null;
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn small ghost" aria-label="More" aria-expanded={open} onClick={() => { setOpen((o) => !o); setSure(false); }}>⋯</button>
      {open && (
        <div className="menu" role="menu">
          {items.map(([label, fn]) => <button key={label} role="menuitem" onClick={() => { fn(); if (!label.startsWith('Delete')) setOpen(false); }}>{label}</button>)}
        </div>
      )}
    </div>
  );
}

function ActionForm({ kind, target, challengeId, onCancel, onDone }: { kind: 'report' | 'remove' | 'mute'; target: { postId?: number; commentId?: number; author: { userId: number; displayName: string } }; challengeId: number; onCancel: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('3');
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const path = target.commentId ? `/api/comments/${target.commentId}` : `/api/posts/${target.postId}`;
  const submit = async () => {
    setError(null);
    try {
      if (kind === 'report') { await api.post(`${path}/report`, { reason }); setDone(true); return; }
      if (kind === 'remove') await api.post(`${path}/remove`, { reason });
      if (kind === 'mute') await api.post(`/api/challenges/${challengeId}/community-mutes`, { userId: target.author.userId, days: Number(days), reason });
      onDone();
    } catch (e) { setError(e); }
  };
  if (done) return <div className="alert ok small" style={{ marginTop: 8 }}>Thanks - the challenge admins will look at it. <button className="btn small ghost" onClick={onCancel}>Close</button></div>;
  const min = kind === 'report' ? 3 : 5;
  return (
    <div className="section" style={{ marginTop: 8 }}>
      <ErrorBox error={error} />
      {kind === 'mute' && (
        <label className="small">Stop {target.author.displayName} posting and commenting for{' '}
          <select value={days} onChange={(e) => setDays(e.target.value)}>{[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}</select>
          <span className="muted"> (they can still read and react)</span>
        </label>
      )}
      <input type="text" style={{ width: '100%', marginTop: 6 }} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
        placeholder={kind === 'report' ? 'What is wrong? (e.g. spam, rude, private information)' : kind === 'remove' ? 'Reason for removing (recorded)' : 'Reason (recorded)'} />
      <div className="row" style={{ marginTop: 6 }}>
        <button className={`btn small ${kind === 'report' ? 'primary' : 'danger'}`} disabled={reason.trim().length < min} onClick={submit}>{kind === 'report' ? 'Send report' : kind === 'remove' ? 'Remove' : 'Mute'}</button>
        <button className="btn small ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Comments({ postId, feed, challengeId, onCount }: { postId: number; feed: Feed; challengeId: number; onCount: (n: number) => void }) {
  const list = useLoad(() => api.get<Comment[]>(`/api/posts/${postId}/comments`), [postId]);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [action, setAction] = useState<{ kind: 'report' | 'remove'; c: Comment } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (list.data) onCount(list.data.filter((c) => c.status === 'VISIBLE').length); }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const send = async () => {
    setError(null);
    try { await api.post(`/api/posts/${postId}/comments`, { body, parentId: replyTo?.commentId ?? null }); setBody(''); setReplyTo(null); list.reload(); } catch (e) { setError(e); }
  };
  const del = async (c: Comment) => { try { await api.post(`/api/comments/${c.commentId}/delete`); list.reload(); } catch (e) { setError(e); } };
  const top = (list.data ?? []).filter((c) => !c.parentId);
  const replies = (id: number) => (list.data ?? []).filter((c) => c.parentId === id);
  const row = (c: Comment, reply = false) => (
    <div key={c.commentId} className={`comment${reply ? ' reply' : ''}${c.status === 'REMOVED' ? ' removed' : ''}`}>
      <Avatar fileId={c.author.photoFileId} name={c.author.displayName} size={reply ? 24 : 28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bubble"><button className="person-link small" onClick={() => navigate(c.mine ? '/profile' : `/people/${c.author.userId}`)}><b>{c.author.displayName}</b></button><div className="post-body small" style={{ margin: 0 }}>{c.body}</div></div>
        {c.status === 'REMOVED' && <div className="muted small">Removed: {c.removedReason}</div>}
        {c.status === 'VISIBLE' && (
          <div className="row small muted" style={{ gap: 12 }}>
            <span>{time(c.createdAt)}</span>
            {feed.can.comment && <button className="link" onClick={() => setReplyTo(c)}>Reply</button>}
            {c.mine && <button className="link" onClick={() => del(c)}>Delete</button>}
            {!c.mine && <button className="link" onClick={() => setAction({ kind: 'report', c })}>Report</button>}
            {feed.can.moderate && <button className="link" onClick={() => setAction({ kind: 'remove', c })}>Remove</button>}
          </div>
        )}
        {action?.c.commentId === c.commentId && <ActionForm kind={action.kind} target={{ commentId: c.commentId, author: c.author }} challengeId={challengeId} onCancel={() => setAction(null)} onDone={() => { setAction(null); list.reload(); }} />}
      </div>
    </div>
  );
  return (
    <div className="comments">
      <ErrorBox error={error ?? list.error} />
      {list.loading && !list.data && <Loading />}
      {top.map((c) => <div key={c.commentId}>{row(c)}{replies(c.commentId).map((r) => row(r, true))}</div>)}
      {feed.can.comment && (
        <div style={{ marginTop: 8 }}>
          {replyTo && <div className="muted small">Replying to {replyTo.author.displayName} <button className="link" onClick={() => setReplyTo(null)}>cancel</button></div>}
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input type="text" value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && body.trim()) void send(); }} placeholder="Write a comment…" style={{ flex: 1, minWidth: 0 }} />
            <button className="btn small primary" disabled={!body.trim()} onClick={send}>Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Reports({ challengeId, onChanged }: { challengeId: number; onChanged: () => void }) {
  const list = useLoad(() => api.get<Report[]>(`/api/challenges/${challengeId}/community-reports`), [challengeId]);
  const [reason, setReason] = useState<Record<number, string>>({});
  const [error, setError] = useState<unknown>(null);
  if (!list.data?.length) return null;
  const act = async (r: Report, remove: boolean) => {
    setError(null);
    try {
      if (remove) await api.post(`${r.commentId ? `/api/comments/${r.commentId}` : `/api/posts/${r.postId}`}/remove`, { reason: reason[r.reportId] ?? '' });
      else await api.post(`/api/community-reports/${r.reportId}/dismiss`, { note: reason[r.reportId] ?? '' });
      list.reload(); onChanged();
    } catch (e) { setError(e); }
  };
  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <h3>Reports to look at ({list.data.length})</h3>
      <ErrorBox error={error} />
      {list.data.map((r) => (
        <div key={r.reportId} className="section">
          <p className="small"><b>{r.reporter}</b> reported a {r.commentId ? 'comment' : 'post'} by <b>{r.author}</b>: “{r.reason}”</p>
          <blockquote className="post-body small muted" style={{ borderLeft: '3px solid var(--border)', paddingLeft: 8, margin: '6px 0' }}>{r.body || '(photo only)'}</blockquote>
          <input type="text" style={{ width: '100%' }} placeholder="Reason / note (recorded)" value={reason[r.reportId] ?? ''} onChange={(e) => setReason({ ...reason, [r.reportId]: e.target.value })} />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn small danger" disabled={(reason[r.reportId] ?? '').trim().length < 5} onClick={() => act(r, true)}>Remove it</button>
            <button className="btn small ghost" onClick={() => act(r, false)}>Dismiss - it's fine</button>
          </div>
        </div>
      ))}
    </div>
  );
}
