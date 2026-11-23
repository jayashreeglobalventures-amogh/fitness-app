// Profile card: phone notifications on/off. On asks the phone for permission and registers it with the server;
// off stops them on all of the person's phones. iPhones only allow this for the app added to the Home Screen.
import { useEffect, useState } from 'react';
import { api } from './api';
import { ErrorBox } from './ui';

interface PushState { enabled: boolean; publicKey: string; devices: { endpoint: string; device: string | null; since: string; lastSent: string | null }[] }

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A short name for a device from its browser description, e.g. "iPhone", "Android phone", "Mac (Chrome)". */
export function deviceName(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? `Android phone (${browser})` : `Android tablet (${browser})`;
  if (/Macintosh/.test(ua)) return `Mac (${browser})`;
  if (/Windows/.test(ua)) return `Windows (${browser})`;
  if (/Linux/.test(ua)) return `Linux (${browser})`;
  return browser;
}

export function PhoneNotifications() {
  const [state, setState] = useState<PushState | null>(null);
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    try {
      setState(await api.get<PushState>('/api/me/push'));
      if (supported()) {
        const reg = await navigator.serviceWorker.getRegistration();
        setThisDevice((await reg?.pushManager.getSubscription())?.endpoint ?? null);
      }
    } catch (e) { setError(e); }
  };
  useEffect(() => { void load(); }, []);

  const turnOn = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const permission = await Notification.requestPermission(); // must come straight from the tap (iPhone requirement)
      if (permission !== 'granted') { setNote('denied'); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      const key = keyBytes(state!.publicKey);
      if (sub) { // registered earlier with a different server key: start again
        const old = sub.options.applicationServerKey;
        const same = old && new Uint8Array(old).every((b, i) => b === key[i]);
        if (!same) { await sub.unsubscribe(); sub = null; }
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api.post('/api/me/push/enable', { subscription: sub.toJSON() });
      await load();
      setNote('on');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const turnOff = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      await api.post('/api/me/push/disable');
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
      await load();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setError(null); setNote(null);
    try { await api.post('/api/me/push/test'); setNote('test'); } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (!state) return <div className="card"><h3>Phone notifications</h3><ErrorBox error={error} /></div>;
  const here = !!thisDevice && state.devices.some((d) => d.endpoint === thisDevice);

  let blocker: string | null = null;
  if (isIOS() && !installed()) blocker = 'On iPhone, notifications work only for the installed app: tap the Share button in Safari, choose "Add to Home Screen", then open Fitness from your Home Screen and switch them on there.';
  else if (!supported()) blocker = 'This browser can\'t receive notifications. Use Chrome on Android, or the app installed on your iPhone\'s Home Screen.';
  else if (Notification.permission === 'denied') blocker = isIOS()
    ? 'Notifications are blocked for this app. Allow them in the iPhone Settings → Notifications → Fitness, then come back here.'
    : 'Notifications are blocked for this site. Allow them in the browser\'s site settings (tap the icon next to the address), then come back here.';

  return (
    <div className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Phone notifications</h3>
        <span className={`badge ${state.enabled ? 'ok' : ''}`}>{state.enabled ? 'On' : 'Off'}</span>
      </div>
      <p className="muted small">Get your alerts on your phone: reminders, approvals, payments, announcements. Tap one to open the app. The lock screen shows only a short title, never your details.</p>
      <ErrorBox error={error} />
      {note === 'denied' && <div className="alert warn small">You chose not to allow notifications. To change that, allow them for this app in your phone's settings.</div>}
      {note === 'on' && <div className="alert ok small">Done - this device will now get your alerts.</div>}
      {note === 'test' && <div className="alert ok small">Test sent. It should arrive in a few seconds.</div>}
      {blocker && !here ? <div className="alert warn small">{blocker}</div> : null}
      <div className="row">
        {!here && !blocker && <button className="btn primary" disabled={busy} onClick={turnOn}>{state.enabled ? 'Also turn on for this device' : 'Turn on'}</button>}
        {state.enabled && <button className="btn ghost" disabled={busy} onClick={turnOff}>Turn off</button>}
        {state.enabled && state.devices.length > 0 && <button className="btn ghost" disabled={busy} onClick={test}>Send a test</button>}
      </div>
      {state.enabled && state.devices.length > 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          On for: {state.devices.map((d) => `${deviceName(d.device)}${d.endpoint === thisDevice ? ' (this one)' : ''}`).join(', ')}. "Turn off" stops them on all of these.
        </p>
      )}
      <NotificationKinds />
    </div>
  );
}

interface Kind { key: string; label: string; group: 'participant' | 'community' | 'admin'; on: boolean }
const GROUP_LABEL = { participant: 'My challenge', community: 'Community', admin: 'If you are an admin' } as const;

/** Which kinds of alerts I want (within what each challenge sends). Saved as soon as a switch is flipped. */
function NotificationKinds() {
  const [kinds, setKinds] = useState<Kind[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { api.get<{ kinds: Kind[]; isAdmin: boolean }>('/api/me/notification-prefs').then((r) => { setKinds(r.kinds); setIsAdmin(r.isAdmin); }, setError); }, []);
  const flip = async (k: Kind) => {
    setError(null);
    setKinds((ks) => ks!.map((x) => (x.key === k.key ? { ...x, on: !k.on } : x)));
    try { setKinds((await api.put<{ kinds: Kind[] }>('/api/me/notification-prefs', { [k.key]: !k.on })).kinds); }
    catch (e) { setError(e); setKinds((ks) => ks!.map((x) => (x.key === k.key ? k : x))); }
  };
  if (!kinds) return error ? <ErrorBox error={error} /> : null;
  return (
    <details style={{ marginTop: 12 }}>
      <summary className="small"><b>Choose what you get</b></summary>
      <p className="muted small">Switched-off kinds don't reach your phone (tasks still show under Alerts). Invitations, votes, announcements and payments due always come.</p>
      <ErrorBox error={error} />
      {(isAdmin ? ['participant', 'community', 'admin'] as const : ['participant', 'community'] as const).map((g) => (
        <div key={g} style={{ marginTop: 8 }}>
          <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.5px' }}>{GROUP_LABEL[g]}</div>
          {kinds.filter((k) => k.group === g).map((k) => (
            <label key={k.key} className="switch" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', gap: 12, whiteSpace: 'normal' }}>
              <span className="small">{k.label}</span>
              <span className="row" style={{ gap: 0 }}>
                <input type="checkbox" role="switch" checked={k.on} onChange={() => void flip(k)} aria-label={k.label} />
                <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
              </span>
            </label>
          ))}
        </div>
      ))}
    </details>
  );
}
