// Turns the coach's facts into words. The template writer below is the default (free, instant, private,
// predictable). COACH_WRITER=omniroute selects the AI writer (ai-writer.ts), which receives only the facts and the
// template's draft (no names, no health data, no money details).
// If an AI writer ever fails or isn't ready, callers fall back to the template writer, so messages never stop.
import { omniRouteConfig } from '../../core/omniroute.js';
import { omnirouteWriter } from './ai-writer.js';
import type { NudgeFacts, RiskFacts, WeekFacts } from './facts.js';

export interface CoachMessage { headline: string; lines: string[] }

export interface CoachWriter {
  readonly name: string;
  weekly(f: WeekFacts): Promise<CoachMessage>;
  nudge(f: NudgeFacts): Promise<{ title: string; body: string }>;
  risk(f: RiskFacts): Promise<string>;
}

const n = (x: number) => x.toLocaleString('en-IN');
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export const templateWriter: CoachWriter = {
  name: 'templates',

  async weekly(f) {
    const counted = f.achieved + f.missed;
    const label = f.complete ? `Week ${f.periodNo}` : `Week ${f.periodNo} so far`;
    const headline = counted === 0
      ? `${label}: ${f.pending ? 'waiting for your results' : 'nothing counted yet'}`
      : f.achieved === 0 ? `${label}: 0 of ${counted} ${counted === 1 ? 'day' : 'days'} - a fresh start is one walk away`
        : `${label}: ${f.achieved} of ${counted} ${counted === 1 ? 'day' : 'days'} ✅${f.missed === 0 && f.complete ? ' - a perfect week!' : ''}`;
    const lines: string[] = [];

    if (f.previous && f.previous.eligible > 0 && counted > 0 && f.complete) {
      const d = f.achieved - f.previous.achieved;
      lines.push(d > 0 ? `That's ${plural(d, 'more successful day')} than week ${f.previous.periodNo}. 📈`
        : d < 0 ? `That's ${plural(-d, 'fewer successful day')} than week ${f.previous.periodNo} - a new week is a fresh start.`
          : `Same as week ${f.previous.periodNo} - steady.`);
    }
    if (f.rest || f.excused) lines.push([f.rest ? plural(f.rest, 'rest day') : '', f.excused ? plural(f.excused, 'excused day') : ''].filter(Boolean).join(' and ') + ' this week (they don\'t count against you).');
    if (f.pending) lines.push(`${plural(f.pending, 'day')} still being checked.`);
    if (f.stepsAverage !== null) lines.push(`You averaged ${n(f.stepsAverage)} steps on your successful days${f.bestDay ? `; best: ${n(f.bestDay.steps)} on ${day(f.bestDay.day)}` : ''}.`);
    if (f.streak >= 2) lines.push(`🔥 ${f.streak} successful days in a row${f.bestStreak > f.streak ? ` (your best: ${f.bestStreak})` : ' - your best yet'}.`);
    if (f.adherencePct !== null) {
      if (f.adherencePct >= f.qualificationPct) lines.push(`Overall you've hit ${f.adherencePct}% of your days - above the ${f.qualificationPct}% prize line.`);
      else if (f.daysToQualify !== null) {
        const close = f.qualificationPct - f.adherencePct <= 10;
        lines.push(`Overall ${f.adherencePct}% - ${close ? 'just under' : 'below'} the ${f.qualificationPct}% prize line. ${plural(f.daysToQualify, 'successful day')} in a row would get you to it.`);
      }
      else lines.push(`Overall ${f.adherencePct}% of your days. Every day you walk still adds points and helps the team.`);
    }
    if (f.points) lines.push(`${f.points > 0 ? '+' : ''}${f.points} points this week (${n(f.pointsTotal)} in total).`);
    if (f.weakestWeekday) lines.push(`Most of your misses fall on ${f.weakestWeekday}s - try planning that day's walk the evening before.`);

    // One realistic aim.
    if (f.complete && f.daysLeft > 0) {
      // A realistic step up from this week, not perfection after a hard week.
      const aim = f.missed === 1 ? 'no misses' : f.missed <= 3 ? 'one miss at most' : `${plural(Math.min(7, f.achieved + 3), 'successful day')}, starting tomorrow`;
      if (f.missed === 0 && counted > 0) lines.push(`🎯 Aim for next week: keep it going - ${n(f.target)} steps every day.`);
      else if (f.missed > 0) lines.push(`🎯 Aim for next week: ${aim}. Set a daily walk time and send your screenshot as soon as you hit ${n(f.target)}.`);
    } else if (!f.complete && f.daysLeft > 0) {
      lines.push(f.todayDone ? `🎯 Today: done ✅ - see you tomorrow.` : `🎯 Today: ${n(f.target)} steps, in before midnight.`);
    }
    return { headline, lines };
  },

  async nudge(f) {
    const title = f.streak >= 2 ? `${f.challengeName}: keep your ${f.streak}-day streak going 🔥`
      : f.missedYesterday ? `${f.challengeName}: today's a fresh start 💪`
        : `${f.challengeName}: today's steps aren't in yet`;
    const body = `${n(f.target)} steps, then send your screenshot - about ${plural(f.hoursLeft, 'hour')} left before midnight.`;
    return { title, body };
  },

  async risk(f) {
    const parts: string[] = [];
    if (f.missesInARow >= 2) parts.push(`missed the last ${f.missesInARow} days`);
    if (f.adherencePct !== null && f.adherencePct < f.qualificationPct) parts.push(`at ${f.adherencePct}%, below the ${f.qualificationPct}% prize line`);
    return parts.join('; ');
  },
};

// One AI writer per configuration, so its cache of written messages lives as long as the process.
let aiWriter: { key: string; writer: CoachWriter } | null = null;

/**
 * The writer chosen with COACH_WRITER: "templates" (default) or "omniroute" (AI through the OmniRoute gateway, see
 * ai-writer.ts; needs OMNIROUTE_API_KEY). Anything else, or omniroute without a key, uses the templates.
 */
export function selectWriter(env: NodeJS.ProcessEnv = process.env): CoachWriter {
  switch (env.COACH_WRITER ?? 'templates') {
    case 'omniroute': {
      const cfg = omniRouteConfig(env);
      if (!cfg) return templateWriter;
      const model = env.OMNIROUTE_TEXT_MODEL?.trim() || undefined;
      const key = `${cfg.baseUrl}|${cfg.apiKey}|${model ?? ''}`;
      if (aiWriter?.key !== key) aiWriter = { key, writer: omnirouteWriter(cfg, { model }) };
      return aiWriter.writer;
    }
    default: return templateWriter;
  }
}

/** Uses the chosen writer, falling back to the templates if it fails, so the coach never goes quiet. */
export async function write<T>(fn: (w: CoachWriter) => Promise<T>, writer: CoachWriter = selectWriter()): Promise<T> {
  try { return await fn(writer); } catch (e) { if (writer === templateWriter) throw e; return fn(templateWriter); }
}
