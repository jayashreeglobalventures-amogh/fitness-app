// Kinds of alerts, each person's choices about them, and alerts that come from something happening (kept a week).
// A challenge decides what may be sent (Settings → Notifications); within that, each person switches kinds off (or,
// for new community posts, on) in Profile → Notifications. Essentials (invitations, votes, announcements, money due,
// settings problems) can't be switched off.
import type { Queryable } from '../../core/db.js';
import { validation } from '../../core/errors.js';

export const CATEGORIES = {
  stepReminders: { label: 'Reminders to upload my steps', group: 'participant', default: true },
  restDayReminder: { label: 'Morning reminder to declare a rest day (before the cut-off)', group: 'participant', default: true },
  reviewOutcome: { label: 'When an admin approves or declines my screenshot', group: 'participant', default: true },
  milestones: { label: 'Streak milestones and moving up the leaderboard', group: 'participant', default: true },
  teamStreak: { label: 'Evening: how many still need to upload to keep the team streak', group: 'participant', default: true },
  weeklySummary: { label: 'My weekly summary', group: 'participant', default: true },
  payments: { label: 'Contribution due tomorrow and payment confirmed', group: 'participant', default: true },
  communityPosts: { label: 'New community posts (grouped)', group: 'community', default: false },
  communityComments: { label: 'Comments on my posts', group: 'community', default: true },
  adminTasks: { label: 'Admin tasks: screenshots to review, payments, exemptions, bonuses, reports', group: 'admin', default: true },
  atRisk: { label: 'Admins: who might need a hand', group: 'admin', default: true },
} as const;
export type Category = keyof typeof CATEGORIES | 'essential';

export type Prefs = Record<keyof typeof CATEGORIES, boolean>;

export async function prefsOf(db: Queryable, userId: number): Promise<Prefs> {
  const { rows: [r] } = await db.query(`SELECT prefs FROM notification_prefs WHERE user_id = $1`, [userId]);
  const saved = (r?.prefs ?? {}) as Record<string, unknown>;
  const out = {} as Prefs;
  for (const [k, c] of Object.entries(CATEGORIES)) out[k as keyof Prefs] = typeof saved[k] === 'boolean' ? (saved[k] as boolean) : c.default;
  return out;
}

export async function myPrefs(db: Queryable, userId: number): Promise<unknown> {
  const prefs = await prefsOf(db, userId);
  // The admin kinds are shown only to people who are an admin somewhere.
  const { rows: [a] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM challenge_roles WHERE user_id = $1) OR EXISTS (SELECT 1 FROM platform_roles WHERE user_id = $1) AS admin`, [userId]);
  return { prefs, isAdmin: !!a.admin, kinds: Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label, group: c.group, on: prefs[key as keyof Prefs] })) };
}

export async function setPrefs(db: Queryable, userId: number, input: unknown, now: Date): Promise<unknown> {
  if (!input || typeof input !== 'object') throw validation('Nothing to save.');
  const current = await prefsOf(db, userId);
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(k in CATEGORIES)) throw validation(`Unknown kind of notification: ${k}.`);
    if (typeof v !== 'boolean') throw validation('Each choice is on or off.');
    current[k as keyof Prefs] = v;
  }
  await db.query(
    `INSERT INTO notification_prefs (user_id, push_enabled, prefs, updated_at) VALUES ($1, false, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = EXCLUDED.updated_at`, [userId, JSON.stringify(current), now]);
  return myPrefs(db, userId);
}

/** Records an alert that comes from something happening (shown for a week; the same key never twice). */
export async function addNotice(db: Queryable, n: { userId: number; challengeId: number | null; key: string; category: Category; kind: 'action' | 'info' | 'warning'; title: string; body: string; link: string }, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO user_notices (user_id, challenge_id, notice_key, category, kind, title, body, link, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, notice_key) DO NOTHING`,
    [n.userId, n.challengeId, n.key.slice(0, 150), n.category, n.kind, n.title.slice(0, 200), n.body.slice(0, 500), n.link, now]);
}
