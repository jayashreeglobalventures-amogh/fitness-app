// Profile card: send steps straight from the iPhone Health app with an Apple Shortcut. Creates the personal sync key
// (shown once), shows how to set up the Shortcut and the daily automation, and the latest syncs.
import { useEffect, useState } from 'react';
import { api } from './api';
import { Collapsible, day, ErrorBox } from './ui';

interface Status { key: { hint: string; createdAt: string; lastUsedAt: string | null } | null; recent: { challenge: string; day: string; steps: number; syncedAt: string; doubted: boolean }[] }

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="btn ghost small" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>{done ? '✓ Copied' : label}</button>;
}

export function HealthSyncCard() {
  const [s, setS] = useState<Status | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<Status>('/api/me/sync-key').then(setS, setError);
  useEffect(() => { void load(); }, []);
  const make = async () => {
    setBusy(true); setError(null);
    try { setFresh((await api.post<{ key: string }>('/api/me/sync-key')).key); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const revoke = async () => {
    setBusy(true); setError(null);
    try { await api.post('/api/me/sync-key/revoke'); setFresh(null); await load(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const url = `${location.origin}/api/health-sync`;
  const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  return (
    <Collapsible id="health-sync" title="📱 Steps from Apple Health" defaultOpen={false}>
      <p className="muted small" style={{ marginTop: 0 }}>On iPhone, an Apple Shortcut can send today's steps from the Health app straight to Fitness - no screenshot needed. Screenshots still work too.</p>
      <ErrorBox error={error} />
      {!s ? null : (<>
        {fresh ? (
          <div className="alert ok">
            <b>Your sync key</b> - copy it now; it won't be shown again.
            <div className="row" style={{ marginTop: 6 }}><code style={{ wordBreak: 'break-all', flex: 1 }}>{fresh}</code><Copy text={fresh} label="Copy key" /></div>
          </div>
        ) : s.key ? (
          <p className="small">Sync key ending <b>…{s.key.hint}</b> · {s.key.lastUsedAt ? `last used ${when(s.key.lastUsedAt)}` : 'not used yet'}</p>
        ) : null}
        <div className="row">
          <button className="btn primary small" disabled={busy} onClick={make}>{s.key ? 'Make a new key' : 'Get my sync key'}</button>
          {s.key && <button className="btn ghost small" disabled={busy} onClick={revoke}>Stop syncing</button>}
        </div>
        {s.key && <p className="muted small" style={{ marginTop: 6 }}>A new key replaces the old one (paste it into your Shortcut). "Stop syncing" turns the key off.</p>}

        <details style={{ marginTop: 12 }}>
          <summary className="small"><b>Set up the Shortcut (about 2 minutes, once)</b></summary>
          <ol className="small" style={{ paddingLeft: 18 }}>
            <li>Open the <b>Shortcuts</b> app → <b>+</b> → name it <b>Send steps to Fitness</b>.</li>
            <li>Add <b>Find Health Samples</b>: Type <b>Steps</b>, add a filter <b>Start Date is Today</b>, and set <b>Group By: Day</b>.</li>
            <li>Add <b>Calculate Statistics</b>: <b>Sum</b> of the Health Samples.</li>
            <li>Add <b>Get Contents of URL</b>:
              <div className="row" style={{ margin: '4px 0' }}><code style={{ wordBreak: 'break-all' }}>{url}</code><Copy text={url} label="Copy URL" /></div>
              Method <b>POST</b> · Headers: <b>Authorization</b> = <code>Bearer </code> followed by your key · Request Body <b>JSON</b>: key <b>steps</b> = the <b>Statistics</b> result.</li>
            <li>Add <b>Show Notification</b> with <b>Contents of URL</b> (so you see "target met ✅").</li>
            <li>Tap ▶ once and allow it to read Steps. Check the number matches your Health app.</li>
            <li><b>Automation</b> tab → <b>+</b> → <b>Time of Day</b>, e.g. <b>23:30</b>, Daily → <b>Run Immediately</b> → choose <b>Send steps to Fitness</b>. Add a second time (e.g. 20:00) if you like.</li>
          </ol>
          <p className="muted small">If someone in your group already made it, ask them for the iCloud link: you only need to paste your own key.</p>
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
