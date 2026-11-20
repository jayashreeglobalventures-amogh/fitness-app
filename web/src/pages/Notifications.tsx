// Notifications: what needs your attention, worked out live by the server, each with a link to act on it.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { goBack, navigate, previousPath } from '../router';
import { ErrorBox, Loading, useLoad } from '../ui';

export interface Notice { id: string; kind: 'action' | 'info' | 'warning'; title: string; body: string; link: string; challengeId: number | null; count?: number }
const ICON = { action: '●', warning: '▲', info: 'ⓘ' } as const;
const TONE = { action: 'ok', warning: 'warn', info: '' } as const;

/** How many items need action (for the tab badge); refreshed on navigation and every minute. */
export function useNoticeCount(path: string, enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) { setN(0); return; }
    let live = true;
    const load = () => api.get<Notice[]>('/api/me/notifications').then((l) => live && setN(l.filter((x) => x.kind !== 'info').length), () => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [path, enabled]);
  return n;
}

export function NotificationsPage() {
  const l = useLoad(() => api.get<Notice[]>('/api/me/notifications'), []);
  if (l.loading && !l.data) return <Loading />;
  return (
    <>
      <button className="btn ghost small" onClick={() => goBack('/')}>← {previousPath()?.includes('/settings') ? 'Back to settings' : 'Back'}</button>
      <h1 style={{ marginTop: 8 }}>Notifications</h1>
      <ErrorBox error={l.error} />
      {l.data?.length === 0 && <div className="card empty">You're all caught up. ✅</div>}
      {l.data?.map((n) => (
        <div key={n.id} className="card clickable" onClick={() => navigate(n.link)}>
          <div className="spread">
            <b><span className={`badge ${TONE[n.kind]}`} style={{ marginRight: 8 }}>{ICON[n.kind]}</span>{n.title}</b>
            {n.count ? <span className="badge warn">{n.count}</span> : null}
          </div>
          <p className="muted small" style={{ margin: '6px 0 0' }}>{n.body}</p>
        </div>
      ))}
    </>
  );
}
