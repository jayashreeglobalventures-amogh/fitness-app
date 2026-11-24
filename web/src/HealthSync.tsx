// Profile card: send steps straight from the iPhone Health app with an Apple Shortcut. One button sets it up on the
// iPhone: it makes the person's sync key, copies it, and opens our ready-made Shortcut (built and signed by
// scripts/build-shortcut.ts) - they tap "Add Shortcut" and paste. Then a short checklist for the daily automation
// (Apple doesn't let an app or file create that). Manual steps stay available, folded away.
import { useEffect, useState } from 'react';
import { api } from './api';
import { Collapsible, day, ErrorBox } from './ui';
import { navigate } from './router';

interface Status { key: { hint: string; createdAt: string; lastUsedAt: string | null } | null; recent: { challenge: string; day: string; steps: number; syncedAt: string; doubted: boolean }[] }

/** The Shortcut built for this app's own address (production and test each have theirs; see scripts/build-shortcut.ts). */
const NAME = 'Send steps to Fitness';
const SHORTCUT = `/shortcuts/${location.host}/${encodeURIComponent(NAME)}.shortcut`;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/**
 * The file opens inside the app: iOS shows a preview with "Open in Shortcuts" (owner's choice, 24 Nov 2026 - a one-time
 * setup). That preview has no Back button, so the card says to close and reopen Fitness afterwards. Tried and dropped:
 * the Shortcuts app's import link (accepts only iCloud links) and opening in Safari (goes to the default browser,
 * e.g. Chrome, which doesn't hand the file to Shortcuts).
 */
const IMPORT = () => SHORTCUT;
const RUN = `shortcuts://run-shortcut?name=${encodeURIComponent(NAME)}`;

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="btn ghost small" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? '✓ Copied' : label}</button>;
}

/**
 * Copies a key that is still being fetched. Safari only allows copying straight from a tap, so the copy starts in
 * the tap with a promise of the text (ClipboardItem), and falls back to a normal copy elsewhere.
 */
async function copyWhenReady(key: Promise<string>): Promise<boolean> {
  try {
    if ('ClipboardItem' in window && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': key.then((k) => new Blob([k], { type: 'text/plain' })) })]);
      return true;
    }
    await navigator.clipboard.writeText(await key);
    return true;
  } catch { return false; }
}

export function HealthSyncCard() {
  const [s, setS] = useState<Status | null>(null);
  const [fresh, setFresh] = useState<{ key: string; copied: boolean } | null>(null);
  const [ready, setReady] = useState<boolean | null>(null); // is our ready-made Shortcut on the server?
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const load = () => api.get<Status>('/api/me/sync-key').then(setS, setError);
  useEffect(() => {
    void load();
    fetch(SHORTCUT, { method: 'HEAD' }).then((r) => setReady(r.ok && !(r.headers.get('content-type') ?? '').includes('text/html')), () => setReady(false));
    // Back from the Shortcuts app: show the latest (e.g. the sync that just ran).
    const back = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);

  /** "Sync now": runs the Shortcut in the Shortcuts app, then checks for the new sync for a little while. */
  const syncNow = () => {
    setError(null); setSyncing(true);
    const before = s?.key?.lastUsedAt ?? null;
    location.href = RUN;
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      const st = await api.get<Status>('/api/me/sync-key').catch(() => null);
      if (st) setS(st);
      if ((st && st.key?.lastUsedAt !== before) || tries >= 20) { clearInterval(t); setSyncing(false); }
    }, 3000);
  };

  /** One tap: a new key, copied, then the Shortcut opens to be added (it asks for the key - just paste). */
  const setUp = async () => {
    setBusy(true); setError(null);
    const keyP = api.post<{ key: string }>('/api/me/sync-key').then((r) => r.key);
    const copiedP = copyWhenReady(keyP);
    try {
      const key = await keyP;
      const copied = await copiedP;
      setFresh({ key, copied });
      await load();
      if (ready && isIOS()) setTimeout(() => { location.href = IMPORT(); }, copied ? 600 : 2500);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const newKeyOnly = async () => {
    setBusy(true); setError(null);
    try { setFresh({ key: (await api.post<{ key: string }>('/api/me/sync-key')).key, copied: false }); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const revoke = async () => {
    setBusy(true); setError(null);
    try { await api.post('/api/me/sync-key/revoke'); setFresh(null); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const url = `${location.origin}/api/health-sync`;
  const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  return (
    <Collapsible id="health-sync" title="📱 Steps from Apple Health" defaultOpen={false}>
      <p className="muted small" style={{ marginTop: 0 }}>On iPhone, your steps can go from the Health app to Fitness by themselves every night - no screenshot needed. Screenshots still work too.</p>
      <ErrorBox error={error} />
      {!s ? null : (<>
        {s.key && !fresh && <p className="small">✅ Set up · key ending <b>…{s.key.hint}</b> · {s.key.lastUsedAt ? `last sync ${when(s.key.lastUsedAt)}` : 'no sync yet'}</p>}

        {s.key && isIOS() && (
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn primary" disabled={syncing} onClick={syncNow}>{syncing ? 'Syncing…' : '🔄 Sync now'}</button>
            {syncing && <span className="muted small">Shortcuts runs it, then tap <b>◀ Fitness</b> at the top-left to come back.</span>}
          </div>
        )}

        {ready && (
          <div className="stack">
            <div><b className="small">1. Add the Shortcut</b>{!isIOS() && <span className="muted small"> - do this on your iPhone</span>}
              <div className="row" style={{ marginTop: 6 }}>
                <button className={`btn ${s.key ? 'ghost' : 'primary'}`} disabled={busy} onClick={setUp}>{s.key ? 'Set up again on this iPhone' : 'Set up on this iPhone'}</button>
              </div>
              <p className="muted small" style={{ marginTop: 6 }}>Your key is copied and the Shortcut opens: tap <b>Open in Shortcuts</b> → <b>Set Up Shortcut</b>, paste the key (tap the box → <b>Paste</b>), then <b>Add Shortcut</b>. The black page it leaves behind has no Back button: <b>close Fitness</b> (swipe it away) and open it again, then tap <b>Sync now</b> once and <b>Allow</b> for Steps.</p>
            </div>
            <div><b className="small">2. Make it run every night</b> <span className="muted small">(Apple asks you to do this part yourself - about a minute)</span>
              <p className="small" style={{ margin: '4px 0 0' }}><a href="/help#apple-health" onClick={(e) => { e.preventDefault(); navigate('/help#apple-health'); }}>📖 Step-by-step guide (iOS 17 and newer, and iOS 16)</a></p>
            </div>
          </div>
        )}

        {fresh && (
          <div className="alert ok small" style={{ marginTop: 10 }}>
            {fresh.copied ? '✓ Your new sync key is copied.' : 'Your new sync key - copy it now; it won\'t be shown again.'}
            <div className="row" style={{ marginTop: 6 }}><code style={{ wordBreak: 'break-all', flex: 1 }}>{fresh.key}</code><Copy text={fresh.key} label="Copy key" /></div>
            {ready && isIOS() && <div style={{ marginTop: 4 }}>Opening the Shortcut… tap <b>Open in Shortcuts</b>. Afterwards close Fitness and open it again. Nothing opened? <a href={SHORTCUT}>Tap here</a>.</div>}
          </div>
        )}

        <div className="row" style={{ marginTop: 10 }}>
          {!ready && <button className="btn primary small" disabled={busy} onClick={newKeyOnly}>{s.key ? 'Make a new key' : 'Get my sync key'}</button>}
          {s.key && <button className="btn ghost small" disabled={busy} onClick={revoke}>Stop syncing</button>}
        </div>

        <details style={{ marginTop: 12 }}>
          <summary className="small">{ready ? 'Build the Shortcut yourself instead' : <b>Set up the Shortcut (about 2 minutes, once)</b>}</summary>
          <ol className="small" style={{ paddingLeft: 18 }}>
            <li>Shortcuts app → <b>+</b> → name it <b>Send steps to Fitness</b>.</li>
            <li><b>Find Health Samples</b>: Type <b>Steps</b>, filter <b>Start Date is Today</b>, <b>Group By: Day</b>.</li>
            <li><b>Calculate Statistics</b>: <b>Sum</b>.</li>
            <li><b>Get Contents of URL</b>: <code style={{ wordBreak: 'break-all' }}>{url}</code> <Copy text={url} label="Copy" /> · POST · Header <b>Authorization</b> = <code>Bearer </code> + your key · JSON body <b>steps</b> = Statistics.</li>
            <li><b>Show Notification</b> with Contents of URL. Then add the nightly automation as above.</li>
          </ol>
          {!ready && <p className="muted small">Tip: once one person has it working, Share → Copy iCloud Link lets others add it and just paste their own key.</p>}
        </details>

        {s.recent.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.5px' }}>Latest</div>
            {s.recent.map((r) => (
              <div key={`${r.challenge}-${r.day}`} className="spread small" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                <span>{r.challenge} · {day(r.day)}</span>
                <span>{r.steps.toLocaleString('en-IN')} steps{r.doubted ? ' · ⚠️ admin asked for a screenshot' : ''} <span className="muted">· {when(r.syncedAt)}</span></span>
              </div>
            ))}
          </div>
        )}
      </>)}
    </Collapsible>
  );
}
