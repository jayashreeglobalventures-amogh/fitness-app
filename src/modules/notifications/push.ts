// Phone notifications (Web Push; works for the app installed on iPhone (iOS 16.4+) and Android, and desktop browsers).
// Each person switches them on or off in Profile; each phone that agrees is a subscription. A background job sends
// every new alert (the same ones as the Alerts tab) once; tapping it opens the app on Alerts (sign-in first if needed).
// The lock screen shows only the alert's title, never its details.
import webpush from 'web-push';
import { writeAudit } from '../../core/audit.js';
import type { Queryable } from '../../core/db.js';
import { validation } from '../../core/errors.js';
import { myNotifications, type Notice } from './notifications.js';

export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

/** The key pair from the environment, or one generated once and kept in the database. */
export async function vapidKeys(db: Queryable, subject: string, env: NodeJS.ProcessEnv = process.env): Promise<VapidKeys> {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || subject };
  const { rows } = await db.query(`SELECT value FROM server_keys WHERE name = 'vapid'`);
  if (rows[0]) return { ...JSON.parse(rows[0].value), subject: env.VAPID_SUBJECT || subject };
  const k = webpush.generateVAPIDKeys();
  await db.query(`INSERT INTO server_keys (name, value, created_at) VALUES ('vapid', $1, now()) ON CONFLICT (name) DO NOTHING`, [JSON.stringify(k)]);
  const again = await db.query(`SELECT value FROM server_keys WHERE name = 'vapid'`); // another process may have won the race
  return { ...JSON.parse(again.rows[0].value), subject: env.VAPID_SUBJECT || subject };
}

export async function pushSettings(db: Queryable, userId: number, publicKey: string): Promise<unknown> {
  const { rows: [p] } = await db.query(`SELECT push_enabled FROM notification_prefs WHERE user_id = $1`, [userId]);
  const { rows } = await db.query(`SELECT endpoint, device, created_at, last_success_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return { enabled: !!p?.push_enabled, publicKey, devices: rows.map((r) => ({ endpoint: r.endpoint, device: r.device, since: r.created_at.toISOString(), lastSent: r.last_success_at?.toISOString() ?? null })) };
}

interface SubIn { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }

/** Switches phone notifications on for this person and registers this phone. Alerts that already exist are not sent. */
export async function enable(db: Queryable, userId: number, sub: SubIn, device: string, now: Date): Promise<void> {
  const endpoint = String(sub?.endpoint ?? '');
  const p256dh = String(sub?.keys?.p256dh ?? '');
  const auth = String(sub?.keys?.auth ?? '');
  if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint) || !/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) {
    throw validation('This browser gave an incomplete notification registration. Please try again.');
  }
  // An endpoint belongs to one phone: if someone else signed in on it before, it moves to this person.
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device, created_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, device = EXCLUDED.device, failures = 0`,
    [userId, endpoint, p256dh, auth, device.slice(0, 300), now]);
  const { rows: [was] } = await db.query(`SELECT push_enabled FROM notification_prefs WHERE user_id = $1`, [userId]);
  await db.query(`INSERT INTO notification_prefs (user_id, push_enabled, updated_at) VALUES ($1, true, $2)
                  ON CONFLICT (user_id) DO UPDATE SET push_enabled = true, updated_at = EXCLUDED.updated_at`, [userId, now]);
  if (!was?.push_enabled) {
    await baseline(db, userId, now);
    await writeAudit(db, now, { actorUserId: userId, action: 'PHONE_NOTIFICATIONS_ON', entity: 'USER', entityId: userId });
  }
}

/** Switches phone notifications off for this person (all their phones). */
export async function disable(db: Queryable, userId: number, now: Date): Promise<void> {
  await db.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [userId]);
  const r = await db.query(`UPDATE notification_prefs SET push_enabled = false, updated_at = $2 WHERE user_id = $1 AND push_enabled`, [userId, now]);
  if (r.rowCount) await writeAudit(db, now, { actorUserId: userId, action: 'PHONE_NOTIFICATIONS_OFF', entity: 'USER', entityId: userId });
}

/** Marks every current alert as already sent, so switching on doesn't send a burst of old ones. */
async function baseline(db: Queryable, userId: number, now: Date): Promise<void> {
  for (const n of await myNotifications(db, userId, now)) {
    await db.query(`INSERT INTO push_sent (user_id, push_key, sent_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, n.seenKey, now]);
  }
}

export interface PushMessage { title: string; body: string; url: string; tag: string }
/** Sends one message to one subscription; resolves to the HTTP status from the push service. */
export type PushSender = (sub: { endpoint: string; p256dh: string; auth: string }, msg: PushMessage) => Promise<number>;

export function webPushSender(keys: VapidKeys): PushSender {
  return async (sub, msg) => {
    try {
      const r = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(msg),
        { vapidDetails: keys, TTL: 12 * 3600, urgency: 'normal' });
      return r.statusCode;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status) return status;
      throw e;
    }
  };
}

/** "Send a test" from Profile: one message to each of the person's phones. */
export async function sendTest(db: Queryable, send: PushSender, userId: number, now: Date): Promise<{ sent: number }> {
  const { rows: subs } = await db.query(`SELECT subscription_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId]);
  if (!subs.length) throw validation('Phone notifications are not on for any of your devices yet.');
  let sent = 0;
  for (const s of subs) {
    let status = 0;
    try { status = await send(s, { title: 'Fitness: test notification', body: 'Notifications are working. Tap to open your alerts.', url: '/notifications', tag: 'test' }); } catch { /* counted as not sent */ }
    if (status === 404 || status === 410) await db.query(`DELETE FROM push_subscriptions WHERE subscription_id = $1`, [s.subscription_id]);
    else if (status >= 200 && status < 300) { sent++; await db.query(`UPDATE push_subscriptions SET last_success_at = $2, failures = 0 WHERE subscription_id = $1`, [s.subscription_id, now]); }
  }
  if (!sent) throw validation('The test could not be delivered. Switch notifications off and on again on this device.');
  return { sent };
}

/**
 * One round of sending: for each person with phone notifications on, every unread alert not sent before goes out
 * (up to 3 separately; more become one summary). Phones that are gone (404/410) or keep failing are removed.
 * Quiet hours: nothing is sent between 23:00 and 07:00 India time; alerts wait in the app and go out at 7 if still
 * unread. Alerts marked push: false (the plain check-in reminder that appears at midnight) stay in the app only.
 */
export const QUIET_FROM = 23, QUIET_UNTIL = 7;
export function inQuietHours(now: Date): boolean {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(now));
  return h >= QUIET_FROM || h < QUIET_UNTIL;
}

const hhmm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function localMinutes(now: Date, timeZone: string): { min: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = (k: string) => parts.find((p) => p.type === k)!.value;
  return { min: Number(g('hour')) * 60 + Number(g('minute')), day: `${g('year')}-${g('month')}-${g('day')}` };
}
/** The phone key for an alert now, or null if it must wait (quiet hours, or an admin task between round-ups). */
export function pushKeyNow(n: Notice, now: Date): string | null {
  const r = n.pushRules;
  if (!r) return inQuietHours(now) ? null : n.seenKey!;
  const { min, day } = localMinutes(now, r.timeZone);
  const [a, b] = [hhmm(r.quietFrom), hhmm(r.quietUntil)];
  if (a !== b && (a < b ? min >= a && min < b : min >= a || min < b)) return null;
  if (!r.digestTimes) return n.seenKey!;
  // Round-up: only within the hour after a round-up time, once per round-up for as long as it is waiting.
  const slot = r.digestTimes.find((t) => min >= hhmm(t) && min < hhmm(t) + 60);
  return slot ? `${n.seenKey}@${day}T${slot}`.slice(0, 250) : null;
}

export async function sendDue(db: Queryable, send: PushSender, now: Date): Promise<{ sent: number; removed: number }> {
  let sent = 0, removed = 0;
  const { rows: people } = await db.query(
    `SELECT p.user_id FROM notification_prefs p JOIN users u USING (user_id)
      WHERE p.push_enabled AND u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = p.user_id)`);
  for (const { user_id } of people) {
    const userId = Number(user_id);
    const notices = (await myNotifications(db, userId, now)).filter((n) => !n.seen && n.push !== false);
    const { rows: done } = await db.query(`SELECT push_key FROM push_sent WHERE user_id = $1`, [userId]);
    const already = new Set(done.map((r) => r.push_key as string));
    const fresh = notices.map((n) => ({ ...n, pushKey: pushKeyNow(n, now) }))
      .filter((n): n is Notice & { pushKey: string } => n.pushKey !== null && !already.has(n.pushKey));
    if (!fresh.length) continue;
    const msgs: PushMessage[] = fresh.length <= 3
      ? fresh.map((n) => ({ title: n.title, body: 'Tap to open your alerts.', url: '/notifications', tag: n.id }))
      : [{ title: `${fresh.length} new alerts`, body: fresh.slice(0, 3).map((n) => n.title).join(' · '), url: '/notifications', tag: 'summary' }];
    const { rows: subs } = await db.query(`SELECT subscription_id, endpoint, p256dh, auth, failures FROM push_subscriptions WHERE user_id = $1`, [userId]);
    for (const s of subs) {
      let ok = false;
      for (const m of msgs) {
        let status: number;
        try { status = await send(s, m); } catch { status = 0; }
        if (status === 404 || status === 410) { // the phone unsubscribed or the app was removed
          await db.query(`DELETE FROM push_subscriptions WHERE subscription_id = $1`, [s.subscription_id]); removed++; ok = false; break;
        }
        if (status >= 200 && status < 300) { ok = true; sent++; }
      }
      if (ok) await db.query(`UPDATE push_subscriptions SET last_success_at = $2, failures = 0 WHERE subscription_id = $1`, [s.subscription_id, now]);
      else {
        const r = await db.query(`UPDATE push_subscriptions SET failures = failures + 1 WHERE subscription_id = $1 RETURNING failures`, [s.subscription_id]);
        if (r.rows[0]?.failures >= 20) { await db.query(`DELETE FROM push_subscriptions WHERE subscription_id = $1`, [s.subscription_id]); removed++; }
      }
    }
    // Recorded as sent even if a phone was unreachable: the alert is still in the app, and nobody wants it twice later.
    for (const n of fresh) await db.query(`INSERT INTO push_sent (user_id, push_key, sent_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, n.pushKey, now]);
    await db.query(`DELETE FROM push_sent WHERE user_id = $1 AND sent_at < $2::timestamptz - interval '120 days'`, [userId, now]);
  }
  return { sent, removed };
}
