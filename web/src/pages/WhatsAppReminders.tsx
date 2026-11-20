// Team tab, today: WhatsApp reminders sent by an admin from their own WhatsApp (no paid service). "Remind" opens
// WhatsApp with a ready, editable message to that person; "Message the group" opens it with one message naming
// everyone still pending, to send to the challenge group. Each one is recorded in the activity log.
import { useState } from 'react';
import { api } from '../api';
import { ErrorBox } from '../ui';

export interface Remindable {
  participantId: number; displayName: string; mobile?: string | null;
  reminded?: { at: string; by: string } | null; day: { status: string } | null; status: string;
}

/** wa.me wants the full international number, digits only. A 10-digit number is taken as Indian (+91). */
export function waNumber(mobile: string | null | undefined): string | null {
  if (!mobile) return null;
  let d = mobile.replace(/\D/g, '');
  if (!mobile.trim().startsWith('+')) {
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    if (d.length === 10) d = `91${d}`;
  }
  return d.length >= 11 && d.length <= 15 ? d : null;
}

const waLink = (number: string | null, text: string) => `https://wa.me/${number ?? ''}?text=${encodeURIComponent(text)}`;
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const time = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit' });

/** Who to nudge today: no screenshot yet, or one that was rejected (they can send another). */
export const needsReminder = (p: Remindable) => p.status === 'ACTIVE' && (p.day?.status === 'NOT_SUBMITTED' || p.day?.status === 'REJECTED');

export function WhatsAppReminders({ challengeId, name, day, people, timeZone, onSent }: {
  challengeId: number; name: string; day: string; people: Remindable[]; timeZone: string; onSent: () => void;
}) {
  const pending = people.filter(needsReminder);
  const [editing, setEditing] = useState<number | 'group' | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<unknown>(null);
  const appLink = `${location.origin}/`;

  const personal = (p: Remindable) => p.day?.status === 'REJECTED'
    ? `Hi ${first(p.displayName)} 👋 Your ${name} step screenshot for today couldn't be accepted. Please send a clearer one in the app before midnight so today counts: ${appLink}`
    : `Hi ${first(p.displayName)} 👋 Friendly reminder: your ${name} steps for today aren't in yet. Please submit your screenshot in the app before midnight: ${appLink}`;
  const group = () => `⏰ ${name} reminder: still waiting for today's steps from ${pending.map((p) => first(p.displayName)).join(', ')}. Submit your screenshot before midnight 👉 ${appLink}`;

  const open = (who: number | 'group') => {
    setError(null);
    setEditing(who);
    setText(who === 'group' ? group() : personal(pending.find((p) => p.participantId === who)!));
  };
  const record = (who: number | 'group') => {
    const payload = who === 'group' ? { day, group: true, names: pending.map((p) => p.displayName) } : { day, participantId: who };
    api.post(`/api/challenges/${challengeId}/reminders`, payload).then(onSent, setError);
    setEditing(null);
  };

  if (!pending.length) return <div className="alert ok small">Everyone has sent today's steps (or has a rest day / exemption). Nobody to remind. 🎉</div>;
  const person = typeof editing === 'number' ? pending.find((p) => p.participantId === editing) : null;
  const number = person ? waNumber(person.mobile) : null;

  return (
    <div className="card">
      <div className="spread">
        <h3 style={{ margin: 0 }}>WhatsApp reminders</h3>
        <button className="btn small primary" onClick={() => open('group')}>Message the group</button>
      </div>
      <p className="muted small">{pending.length} {pending.length === 1 ? 'person hasn\'t' : 'people haven\'t'} sent today's steps. Messages go from your own WhatsApp - you check the text and press send.</p>
      <ErrorBox error={error} />
      {pending.map((p) => {
        const n = waNumber(p.mobile);
        return (
          <div key={p.participantId} className="spread" style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
            <span>
              <b>{p.displayName}</b>{p.day?.status === 'REJECTED' && <span className="muted small"> · screenshot rejected</span>}
              {p.reminded && <span className="muted small" style={{ display: 'block' }}>Reminded {time(p.reminded.at, timeZone)} by {p.reminded.by}</span>}
              {!n && <span className="muted small" style={{ display: 'block' }}>No mobile number - add one in People</span>}
            </span>
            <button className="btn small ghost" disabled={!n} onClick={() => open(p.participantId)}>📲 Remind</button>
          </div>
        );
      })}
      {editing !== null && (
        <div className="section">
          <b className="small">{editing === 'group' ? 'Message for the group' : `Message to ${person?.displayName} (+${number})`}</b>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%', marginTop: 6 }} maxLength={1000} />
          {editing === 'group' && <p className="muted small" style={{ margin: '4px 0' }}>WhatsApp will ask which chat to send it to - pick your {name} group.</p>}
          <div className="row" style={{ marginTop: 6 }}>
            <a className="btn primary" href={waLink(editing === 'group' ? null : number, text)} target="_blank" rel="noopener noreferrer" onClick={() => record(editing)}>Open WhatsApp</a>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
