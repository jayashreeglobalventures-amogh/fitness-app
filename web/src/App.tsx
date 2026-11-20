// App shell: sign-in gate, forced password change, top bar, bottom tabs. TABS is the one place to add a new tab.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Me } from './api';
import { AccountsPage } from './pages/Accounts';
import { ChallengeNewPage } from './pages/ChallengeNew';
import { ChallengePage } from './pages/Challenge';
import { ChallengesPage } from './pages/Challenges';
import { HomePage } from './pages/Home';
import { ChangePasswordPage, LoginPage } from './pages/Login';
import { ProfilePage } from './pages/Profile';
import { navigate, usePath } from './router';

const icon = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

interface Tab { path: string; label: string; icon: ReactNode; show?: (me: Me) => boolean }
// Add future tabs (Progress, Community, Notifications, ...) here.
const TABS: Tab[] = [
  { path: '/', label: 'Home', icon: icon('M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10') },
  { path: '/challenges', label: 'Challenges', icon: icon('M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4zM17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3') },
  { path: '/profile', label: 'Profile', icon: icon('M20 21a8 8 0 10-16 0M12 13a5 5 0 100-10 5 5 0 000 10z') },
  { path: '/admin/users', label: 'People', icon: icon('M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75'), show: (me) => me.canManageAccounts },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const path = usePath();
  const refresh = useCallback(() => api.get<Me>('/api/me').then(setMe, () => setMe(null)), []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const out = () => setMe(null);
    const pw = () => setMe((m) => (m ? { ...m, mustChangePassword: true } : m));
    window.addEventListener('fit:signed-out', out);
    window.addEventListener('fit:password-change', pw);
    return () => { window.removeEventListener('fit:signed-out', out); window.removeEventListener('fit:password-change', pw); };
  }, []);

  if (me === undefined) return <div className="login"><p className="muted">Loading…</p></div>;
  if (me === null) return <LoginPage onSignedIn={refresh} />;
  if (me.mustChangePassword) return <ChangePasswordPage forced onDone={refresh} />;

  const tabs = TABS.filter((t) => !t.show || t.show(me));
  const active = tabs.reduce<Tab | undefined>((best, t) => (path === t.path || (t.path !== '/' && path.startsWith(t.path)) ? (!best || t.path.length > best.path.length ? t : best) : best), undefined);
  const signOut = async () => { await api.post('/api/auth/logout').catch(() => undefined); setMe(null); navigate('/'); };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-dot" aria-hidden="true" />Fitness</div>
        <button className="btn ghost small" onClick={signOut}>Sign out</button>
      </header>
      <main>{route(path, me, refresh)}</main>
      <nav className="tabbar" aria-label="Main">
        {tabs.map((t) => (
          <button key={t.path} className="tab" aria-current={active?.path === t.path ? 'page' : undefined} onClick={() => navigate(t.path)}>
            {t.icon}<span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function route(path: string, me: Me, refresh: () => void): ReactNode {
  if (path === '/') return <HomePage me={me} />;
  if (path === '/challenges') return <ChallengesPage me={me} />;
  if (path === '/challenges/new' && me.canCreateChallenges) return <ChallengeNewPage />;
  const m = /^\/challenges\/(\d+)(?:\/(\w+))?$/.exec(path);
  if (m) return <ChallengePage me={me} id={Number(m[1])} section={m[2] ?? 'default'} />;
  if (path === '/profile') return <ProfilePage onChanged={refresh} />;
  if (path === '/profile/password') return <ChangePasswordPage onDone={() => navigate('/profile')} />;
  if (path === '/admin/users' && me.canManageAccounts) return <AccountsPage me={me} />;
  return <div className="empty"><h1>Not found</h1><button className="btn" onClick={() => navigate('/')}>Go home</button></div>;
}
