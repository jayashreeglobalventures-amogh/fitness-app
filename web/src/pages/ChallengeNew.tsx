// New challenge: start from a template (a copy of an existing challenge's rules) or from blank defaults,
// then fine-tune everything in Settings before publishing.
import { useState, type FormEvent } from 'react';
import type { ChallengeConfig } from '../../../src/modules/challenges/config';
import { api, type ChallengeListItem } from '../api';
import { navigate } from '../router';
import { ErrorBox, Field, useLoad } from '../ui';

/** Neutral starting rules for a new challenge (every value is editable in Settings). */
export function blankConfig(name: string, startDate: string, endDate: string): ChallengeConfig {
  return {
    schemaVersion: 1,
    basics: { name, description: '', category: 'WALKING', timeZone: 'Asia/Kolkata', startDate, endDate, visibility: 'INVITED_ONLY' },
    registration: { method: 'INVITE_ONLY', deadline: null, maxParticipants: null, invitationValidDays: 14, lockRosterAtStart: true },
    activity: { metric: 'steps', label: 'Steps', unit: 'steps', dailyTarget: 5000 },
    periods: { weekStartsOn: 'SUNDAY' },
    submission: { evidence: 'SCREENSHOT', instructions: 'Upload a screenshot that shows the date and your total for the day, before midnight.', deadline: 'END_OF_DAY', multiplePerDay: { enabled: false, combine: 'SUM' } },
    verification: { mode: 'MANUAL', autoApproveMinConfidence: 0.9 },
    restDays: { enabled: false, perPeriod: 0, maxTotal: 0, declareBefore: '10:00' },
    exemptions: { enabled: false, voting: null },
    scoring: {
      dailySuccess: 10, personalStreak: { milestones: [], points: 0, repeatAfterBreak: true }, teamStreak: { enabled: false, everyDays: 7, points: 0 },
      comeback: { enabled: false, missedDays: 2, missRun: 'AT_LEAST', recoveryDays: 3, points: 0, maxAwards: 0 },
      weekendBonus: { enabled: false, points: 0, maxPerWeekend: 0, weekend: 'SAT_NEXT_SUN' },
      penalties: {
        missedDay: { enabled: false, points: 0 },
        consecutiveMisses: { enabled: false, days: 2, repeat: 'ONCE_PER_RUN', points: 0 },
        teamStreakBreak: { enabled: false, when: 'RUNNING_STREAK_ONLY', points: 0 },
      },
    },
    finance: { enabled: false, currency: 'INR', contribution: { total: 0, mainPool: 0, finePool: 0 }, periodOverrides: [], finePerMissedDay: 0, unusedFinePool: 'REFUND', dueWeekday: 'SUNDAY', graceDays: 2, utrRequired: true, paymentInstructions: '' },
    prizes: { qualificationAdherencePct: 80, qualificationPoolPct: null, topThreePct: null, topThreeSplitPct: null, distribution: null, topThreeIneligible: 'NEXT_ELIGIBLE', proRataByDays: true, payoutDate: null },
    community: { enabled: true, participantsCanPost: true, photos: true },
    coach: { weeklySummary: true, eveningNudge: true, nudgeTime: '20:00', atRiskAlerts: true },
    notifications: {
      stepReminders: { enabled: true, times: ['20:00'] },
      adminAlerts: { reviews: true, payments: true, exemptions: true, bonuses: true, reports: true, delivery: 'IMMEDIATE', digestTimes: ['09:00', '18:00'] },
      community: { newPosts: true, comments: true },
      quietHours: { from: '23:00', until: '07:00' },
      extras: { reviewOutcome: true, streakMilestones: true, rankUp: true, paymentConfirmed: true, paymentDueReminder: true, restDayReminder: false, teamStreakAtRisk: true, teamStreakTime: '19:00' },
    },
    leaderboard: { ranking: ['POINTS', 'ADHERENCE', 'SUCCESSFUL_DAYS', 'LONGEST_PERSONAL_STREAK', 'EARLIEST_FINAL_SCORE'] },
  };
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

export function ChallengeNewPage() {
  const existing = useLoad(() => api.get<ChallengeListItem[]>('/api/challenges'), []);
  const [from, setFrom] = useState('blank');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      let id: number;
      if (from === 'blank') {
        ({ challengeId: id } = await api.post<{ challengeId: number }>('/api/challenges', { slug, config: blankConfig(name, start, end) }));
      } else {
        ({ challengeId: id } = await api.post<{ challengeId: number }>(`/api/challenges/${from}/duplicate`, { slug }));
        const view = await api.get<{ current: { config: ChallengeConfig } }>(`/api/challenges/${id}`);
        const c = view.current.config;
        // Best effort: if the copied rules don't fit the new dates (e.g. a period override), Settings shows what to fix.
        await api.put(`/api/challenges/${id}/config`, { config: { ...c, basics: { ...c.basics, name, startDate: start, endDate: end }, prizes: { ...c.prizes, payoutDate: null } } }).catch(() => undefined);
      }
      navigate(`/challenges/${id}/settings`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit}>
      <h1>New challenge</h1>
      <p className="muted">It starts as a draft. You can change every rule in Settings, then publish it and invite people.</p>
      <ErrorBox error={error} />
      <div className="card">
        <Field label="Start from">
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="blank">Blank rules</option>
            {existing.data?.map((c) => <option key={c.challengeId} value={c.challengeId}>Copy the rules of {c.name}</option>)}
          </select>
        </Field>
        <Field label="Name"><input type="text" value={name} onChange={(e) => { setName(e.target.value); setSlug(slugify(e.target.value)); }} required maxLength={80} /></Field>
        <Field label="Short name (used in links)" hint="a–z, 0–9 and hyphens"><input type="text" value={slug} onChange={(e) => setSlug(e.target.value)} required pattern="[a-z0-9][a-z0-9\-]{1,62}" /></Field>
        <div className="grid2">
          <Field label="Start date"><input type="date" value={start} onChange={(e) => setStart(e.target.value)} required /></Field>
          <Field label="End date"><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required /></Field>
        </div>
        <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</button>
      </div>
    </form>
  );
}
