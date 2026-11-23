// "You moved up the leaderboard": once a day, when the challenge's quiet hours end, the ranks are noted; anyone who
// is higher than at the previous note gets an alert (Settings → Notifications → "moving up the leaderboard").
import type { Queryable } from '../../core/db.js';
import { daysBetween, localDay } from '../../core/dates.js';
import { challengeContext } from '../checkin/days.js';
import { standingsOf } from '../scoring/ledger.js';
import { minutesIn } from './notifications.js';
import { addNotice } from './prefs.js';

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export async function noteRanks(db: Queryable, now: Date): Promise<number> {
  let told = 0;
  const { rows: chs } = await db.query(`SELECT challenge_id, time_zone, starts_on, ends_on FROM challenges WHERE status = 'PUBLISHED'`);
  for (const c of chs) {
    const cid = Number(c.challenge_id);
    const today = localDay(now, c.time_zone);
    // From the second day (yesterday's results are in) until the day after the end.
    if (daysBetween(c.starts_on, today) < 1 || daysBetween(today, c.ends_on) < -1) continue;
    const ctx = await challengeContext(db, cid, now);
    const cfg = ctx.cfgOn(daysBetween(today, c.ends_on) < 0 ? c.ends_on : today);
    if (minutesIn(now, c.time_zone) < toMin(cfg.notifications.quietHours.until)) continue;
    const { rows: [has] } = await db.query(`SELECT 1 FROM rank_snapshots WHERE challenge_id = $1 AND day = $2`, [cid, today]);
    if (has) continue;
    const s = await standingsOf(db, cid, now);
    const ranks: Record<string, number> = {};
    for (const r of s.standings) if (r.status === 'ACTIVE') ranks[r.participantId] = r.rank;
    await db.query(`INSERT INTO rank_snapshots (challenge_id, day, ranks, taken_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [cid, today, JSON.stringify(ranks), now]);
    if (!cfg.notifications.extras.rankUp) continue;
    const { rows: [prev] } = await db.query(`SELECT ranks FROM rank_snapshots WHERE challenge_id = $1 AND day < $2 ORDER BY day DESC LIMIT 1`, [cid, today]);
    if (!prev) continue;
    for (const r of s.standings) {
      const before = (prev.ranks as Record<string, number>)[r.participantId];
      if (r.status !== 'ACTIVE' || before === undefined || r.rank >= before) continue;
      if (!r.userId) continue;
      await addNotice(db, { userId: r.userId, challengeId: cid, key: `rank:${cid}:${today}`, category: 'milestones', kind: 'info',
        title: `${ctx.ch.name}: you moved up to #${r.rank} 🎉`, body: `From #${before}. ${r.points} points so far - keep going!`, link: `/challenges/${cid}/leaderboard` }, now);
      told++;
    }
  }
  return told;
}
