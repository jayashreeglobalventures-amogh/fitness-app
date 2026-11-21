// The coach (rule-based today; see writer.ts for the AI plug-in slot): weekly summaries for participants, an evening
// nudge if today's steps aren't in, and "who might need a hand" for admins. Everything is worked out live from the
// same day records and points the rest of the app uses; nothing here touches health data or money.
import { daysBetween, endOfDay } from '../../core/dates.js';
import type { Queryable } from '../../core/db.js';
import { forbidden } from '../../core/errors.js';
import { challengeContext, participantDays, participantOf, type ChallengeContext } from '../checkin/days.js';
import { accessFor } from '../identity/permissions.js';
import { nudgeFacts, pointsByPeriod, riskFacts, weekFacts, type RiskFacts } from './facts.js';
import { write, type CoachMessage } from './writer.js';

const started = (ctx: ChallengeContext) => daysBetween(ctx.ch.startsOn, ctx.today) >= 0;

/** A participant's coach page: one summary per challenge week so far, newest first. */
export async function myCoach(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const ctx = await challengeContext(db, challengeId, now);
  const p = await participantOf(db, challengeId, userId);
  if (!p) throw forbidden('You are not taking part in this challenge.');
  const cfg = ctx.cfgOn(started(ctx) ? (daysBetween(ctx.today, ctx.ch.endsOn) >= 0 ? ctx.today : ctx.ch.endsOn) : ctx.ch.startsOn);
  if (!cfg.coach.weeklySummary || !started(ctx)) return { enabled: cfg.coach.weeklySummary, weeks: [] };
  const days = await participantDays(db, ctx, p, now);
  const points = await pointsByPeriod(db, p.participantId, ctx.periods);
  const weeks: (CoachMessage & { periodNo: number; startsOn: string; endsOn: string; complete: boolean })[] = [];
  for (const per of ctx.periods) {
    if (daysBetween(per.startsOn, ctx.today) < 0) break;
    if (!days.some((d) => d.periodNo === per.periodNo && d.status !== 'NOT_PARTICIPATING')) continue;
    const f = weekFacts(ctx, days, per, points);
    weeks.push({ periodNo: per.periodNo, startsOn: per.startsOn, endsOn: per.endsOn, complete: f.complete, ...(await write((w) => w.weekly(f))) });
  }
  return { enabled: true, weeks: weeks.reverse() };
}

// "Who might need a hand", per challenge and day, kept for 5 minutes (alerts are read often; the answer changes slowly).
const riskCache = new Map<string, { at: number; list: (RiskFacts & { reason: string })[] }>();

async function riskList(db: Queryable, ctx: ChallengeContext, now: Date): Promise<(RiskFacts & { reason: string })[]> {
  const key = `${ctx.ch.challengeId}:${ctx.today}`;
  const hit = riskCache.get(key);
  if (hit && now.getTime() - hit.at < 5 * 60_000 && hit.at <= now.getTime()) return hit.list;
  const { rows } = await db.query(
    `SELECT p.participant_id, p.user_id, u.display_name FROM participants p JOIN users u USING (user_id) WHERE p.challenge_id = $1 AND p.status = 'ACTIVE' ORDER BY u.display_name`,
    [ctx.ch.challengeId]);
  const list: (RiskFacts & { reason: string })[] = [];
  for (const r of rows) {
    const p = await participantOf(db, ctx.ch.challengeId, Number(r.user_id));
    if (!p) continue;
    const f = riskFacts(ctx, await participantDays(db, ctx, p, now), { participantId: Number(r.participant_id), userId: Number(r.user_id), displayName: r.display_name });
    if (f) list.push({ ...f, reason: await write((w) => w.risk(f)) });
  }
  riskCache.set(key, { at: now.getTime(), list });
  return list;
}

/** Admins: participants who might need a hand, with the reason. */
export async function atRisk(db: Queryable, userId: number, challengeId: number, now: Date): Promise<unknown> {
  const access = await accessFor(db, userId, challengeId);
  if (!access.permissions.has('challenge.view_admin')) throw forbidden();
  const ctx = await challengeContext(db, challengeId, now);
  const cfg = ctx.cfgOn(started(ctx) ? (daysBetween(ctx.today, ctx.ch.endsOn) >= 0 ? ctx.today : ctx.ch.endsOn) : ctx.ch.startsOn);
  if (!cfg.coach.atRiskAlerts || !started(ctx)) return { enabled: cfg.coach.atRiskAlerts, people: [] };
  return { enabled: true, people: (await riskList(db, ctx, now)).map((r) => ({ participantId: r.participantId, userId: r.userId, displayName: r.displayName, reason: r.reason, missesInARow: r.missesInARow, adherencePct: r.adherencePct })) };
}

// ---------- alerts (used by notifications.ts) ----------

export interface CoachNotice { id: string; kind: 'action' | 'info' | 'warning'; title: string; body: string; link: string; challengeId: number; count?: number; push?: boolean }

/**
 * The coach's alerts for one person in one live challenge: the evening nudge (replaces the plain "today's check-in"
 * alert after the nudge time), the weekly summary for 3 days after each week, and the at-risk list for admins.
 */
export async function coachNotices(db: Queryable, userId: number, challengeId: number, opts: { participantId: number | null; canManageRoster: boolean; notSubmittedToday: boolean }, now: Date): Promise<{ notices: CoachNotice[]; nudged: boolean }> {
  const ctx = await challengeContext(db, challengeId, now);
  if (!started(ctx) || daysBetween(ctx.today, addDaysSafe(ctx.ch.endsOn, 3)) < 0) return { notices: [], nudged: false };
  const live = daysBetween(ctx.today, ctx.ch.endsOn) >= 0;
  const cfg = ctx.cfgOn(live ? ctx.today : ctx.ch.endsOn);
  const out: CoachNotice[] = [];
  let nudged = false;
  const link = `/challenges/${challengeId}/today`;

  if (opts.participantId) {
    const p = await participantOf(db, challengeId, userId);
    if (p) {
      const days = await participantDays(db, ctx, p, now);
      // Evening nudge.
      if (live && opts.notSubmittedToday && cfg.coach.eveningNudge) {
        const [h, m] = cfg.coach.nudgeTime.split(':').map(Number) as [number, number];
        const local = new Date(now.toLocaleString('en-US', { timeZone: ctx.ch.timeZone }));
        if (local.getHours() * 60 + local.getMinutes() >= h * 60 + m) {
          const t = await write((w) => w.nudge(nudgeFacts(ctx, days, now, endOfDay(ctx.today, ctx.ch.timeZone))));
          out.push({ id: `nudge:${challengeId}:${ctx.today}`, kind: 'action', title: t.title, body: t.body, link, challengeId });
          nudged = true;
        }
      }
      // Weekly summary: the most recent finished week, for 3 days.
      if (cfg.coach.weeklySummary) {
        const per = [...ctx.periods].reverse().find((x) => daysBetween(x.endsOn, ctx.today) > 0);
        if (per && daysBetween(per.endsOn, ctx.today) <= 3 && days.some((d) => d.periodNo === per.periodNo && d.status !== 'NOT_PARTICIPATING')) {
          const f = weekFacts(ctx, days, per, await pointsByPeriod(db, p.participantId, ctx.periods));
          const msg = await write((w) => w.weekly(f));
          out.push({ id: `week:${challengeId}:${per.periodNo}`, kind: 'info', title: `${ctx.ch.name}: your week ${per.periodNo} summary`, body: msg.headline, link, challengeId });
        }
      }
    }
  }
  // Admins: who might need a hand (once a day while anyone is on the list).
  if (live && opts.canManageRoster && cfg.coach.atRiskAlerts) {
    const list = await riskList(db, ctx, now);
    if (list.length) {
      const names = list.slice(0, 3).map((r) => r.displayName).join(', ') + (list.length > 3 ? ` and ${list.length - 3} more` : '');
      out.push({ id: `atrisk:${challengeId}:${ctx.today}`, kind: 'info', title: `${ctx.ch.name}: ${list.length === 1 ? '1 person' : `${list.length} people`} might need a hand`,
        body: names, link: `/challenges/${challengeId}/team`, challengeId, count: list.length });
    }
  }
  return { notices: out, nudged };
}

function addDaysSafe(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
