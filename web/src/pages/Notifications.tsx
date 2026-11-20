// Notifications: what needs your attention, worked out live by the server, each with a link to act on it.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { goBack, navigate, previousPath } from '../router';
import { ErrorBox, Loading, useLoad } from '../ui';

export interface Notice { id: string; kind: 'action' | 'info' | 'warning'; title: string; body: string; link: string; challengeId: number | null; count?: number; seenKey: string; seen: boolean }
const ICON = { action: '●', warning: '▲', info: 'ⓘ' } as const;
const TONE = { action: 'ok', warning: 'warn', info: '' } as const;

/** How many notifications are new (unseen), for the tab badge; refreshed on navigation, every minute, and when seen. */
export function useNoticeCount(path: string, enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setN(0); return; }
    let live = true;
    const load = () => api.get<Notice[]>('/api/me/notifications').then((l) => live && setN(l.filter((x) => !x.seen).length), () => undefined);
    void load();
    const t = setInterval(load, 60_000);
    window.addEventListener('fit:notices-seen', load);
    return () => { live = false; clearInterval(t); window.removeEventListener('fit:notices-seen', load); };
  }, [path, enabled]);
  return n;
}

export function NotificationsPage() {
  const l = useLoad(() => api.get<Notice[]>('/api/me/notifications'), []);
  // A notification counts as read when you open it (or with "Mark all as read").
  const markSeen = async (keys: string[]) => {
    if (!keys.length) return;
    await api.post('/api/me/notifications/seen', { keys }).catch(() => undefined);
    window.dispatchEvent(new Event('fit:notices-seen'));
  };
  const open = async (n: Notice) => { if (!n.seen) await markSeen([n.seenKey]); navigate(n.link); };
  const unseen = (l.data ?? []).filter((n) => !n.seen);
  if (l.loading && !l.data) return <Loading />;
  return (
    <>
      <button className="btn ghost small" onClick={() => goBack('/')}>← {previousPath()?.includes('/settings') ? 'Back to settings' : 'Back'}</button>
      <div className="spread" style={{ marginTop: 8 }}>
        <h1>Notifications</h1>
        {unseen.length > 0 && <button className="btn small ghost" onClick={() => void markSeen(unseen.map((n) => n.seenKey)).then(l.reload)}>Mark all as read ({unseen.length})</button>}
      </div>
      <ErrorBox error={l.error} />
      {l.data?.length === 0 && <div className="card empty">You're all caught up. ✅</div>}
      {(l.data?.length ?? 0) > 0 && <p className="muted small">Opening a notification marks it as read. Items stay here until they're dealt with; the badge counts unread ones.</p>}
      {l.data?.map((n) => (
        <div key={n.id} className="card clickable" style={n.seen ? { opacity: 0.8 } : { borderColor: 'var(--info)' }} onClick={() => void open(n)}>
          <div className="spread">
            <b><span className={`badge ${TONE[n.kind]}`} style={{ marginRight: 8 }}>{ICON[n.kind]}</span>{n.title}</b>
            <span className="row" style={{ gap: 6 }}>{!n.seen && <span className="badge info">New</span>}{n.count ? <span className="badge warn">{n.count}</span> : null}</span>
          </div>
          <p className="muted small" style={{ margin: '6px 0 0' }}>{n.body}</p>
        </div>
      ))}
    </>
  );
}
