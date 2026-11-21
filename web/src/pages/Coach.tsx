// The coach's cards: "Your coach" (weekly summaries) on the Today tab, "Who might need a hand" on the Team tab.
import { useState } from 'react';
import { api } from '../api';
import { useLoad } from '../ui';
import { waNumber } from './WhatsAppReminders';

interface Week { periodNo: number; startsOn: string; endsOn: string; complete: boolean; headline: string; lines: string[] }

export function CoachCard({ challengeId }: { challengeId: number }) {
  const c = useLoad(() => api.get<{ enabled: boolean; weeks: Week[] }>(`/api/challenges/${challengeId}/coach`), [challengeId]);
  const [i, setI] = useState(0);
  if (!c.data?.enabled || !c.data.weeks.length) return null;
  const weeks = c.data.weeks;
  const w = weeks[Math.min(i, weeks.length - 1)]!;
  return (
    <div className="card coach">
      <div className="spread">
        <h3 style={{ margin: 0 }}>🧭 Your coach</h3>
        {weeks.length > 1 && (
          <select value={i} onChange={(e) => setI(Number(e.target.value))} aria-label="Week" style={{ maxWidth: 170 }}>
            {weeks.map((x, k) => <option key={x.periodNo} value={k}>Week {x.periodNo}{x.complete ? '' : ' (so far)'}</option>)}
          </select>
        )}
      </div>
      <p className="coach-headline">{w.headline}</p>
      <ul className="coach-lines">{w.lines.map((l, k) => <li key={k}>{l}</li>)}</ul>
    </div>
  );
}

interface Risk { participantId: number; userId: number; displayName: string; reason: string }

export function AtRiskCard({ challengeId, name, mobiles }: { challengeId: number; name: string; mobiles: Map<number, string | null> }) {
  const r = useLoad(() => api.get<{ enabled: boolean; people: Risk[] }>(`/api/challenges/${challengeId}/coach/at-risk`), [challengeId]);
  if (!r.data?.enabled || !r.data.people.length) return null;
  const first = (s: string) => s.trim().split(/\s+/)[0];
  return (
    <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--warn) 50%, var(--border))' }}>
      <h3>🤝 Who might need a hand</h3>
      <p className="muted small">A friendly personal check-in often helps more than a reminder.</p>
      {r.data.people.map((p) => {
        const n = waNumber(mobiles.get(p.participantId));
        const text = `Hi ${first(p.displayName)} 👋 Just checking in on how ${name} is going for you. Anything making it hard to walk at the moment? Every day counts - even a short walk today gets you back on track: ${location.origin}/`;
        return (
          <div key={p.participantId} className="spread" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
            <span><b>{p.displayName}</b><span className="muted small" style={{ display: 'block' }}>{p.reason}</span></span>
            {n && <a className="btn small ghost" href={`https://wa.me/${n}?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer"
              onClick={() => { void api.post(`/api/challenges/${challengeId}/reminders`, { day: new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10), participantId: p.participantId }).catch(() => undefined); }}>📲 Check in</a>}
          </div>
        );
      })}
    </div>
  );
}
