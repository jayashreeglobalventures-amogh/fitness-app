// The AI coach writer (COACH_WRITER=omniroute): rewrites the template messages in a warmer, more personal voice
// through the OmniRoute gateway (OMNIROUTE_TEXT_MODEL, default the "Amogh-Ai-Combo" combo).
//
// - It receives only the facts and the template's draft: no names, no health-profile data, no money details.
// - It never makes anyone wait: a message not yet written is answered from the templates right away while the AI
//   version is written in the background; later requests for the same facts get the AI version from the cache.
// - Every number in the AI's text must appear in the facts or the draft, otherwise the template is used.
// - Admin "might need a hand" reasons stay template-only (short, precise, and they'd need a name).
import { chatJson, type OmniRouteConfig } from '../../core/omniroute.js';
import type { NudgeFacts, WeekFacts } from './facts.js';
import { templateWriter, type CoachMessage, type CoachWriter } from './writer.js';

export const DEFAULT_TEXT_MODEL = 'Amogh-Ai-Combo';

/** Thrown when the AI text isn't ready (yet); write() then uses the templates. */
export class NotReady extends Error {}

export interface AiWriterOptions {
  model?: string;
  now?: () => number;
  ttlMs?: number;          // how long a written message is kept (default 7 days)
  failureTtlMs?: number;   // after a failure, how long before trying the same facts again (default 15 minutes)
  maxEntries?: number;     // cache size (default 5000)
  maxInFlight?: number;    // concurrent AI calls (default 3); beyond that the template is used and tried next time
  timeoutMs?: number;      // per AI call (default 30 s; it runs in the background)
  log?: (msg: string) => void;
}

const SYSTEM = `You are a warm, encouraging walking coach in a step-challenge app used by friends and families in India.
Rewrite the DRAFT so it sounds friendly, personal and motivating, like a supportive coach - not a report.
Rules:
- Use only what the FACTS and DRAFT say. Keep every number exactly as it appears there. Never invent numbers, dates, names, places or achievements.
- Keep the meaning of every draft sentence: what is still possible stays in the future ("would get you there", not "would have"), comparisons stay comparisons, and "in a row" stays "in a row".
- Keep the draft's goal for next week or for today if it has one, as its own sentence.
- No medical, diet or injury advice. No guilt or shaming; a bad week is a fresh start.
- Simple, natural English. Short sentences. At most two emojis in total.`;

const WEEKLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'lines'],
  properties: {
    headline: { type: 'string', description: 'One short, upbeat sentence summing up the week (max 100 characters)' },
    lines: { type: 'array', items: { type: 'string' }, description: '2 to 6 short sentences' },
  },
} as const;

const NUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'body'],
  properties: {
    title: { type: 'string', description: 'Push-notification title, max 60 characters' },
    body: { type: 'string', description: 'Push-notification body, max 140 characters; mention the step target and the time left' },
  },
} as const;

/** Every number written in a text (thousands separators ignored): "8,214 steps on 22 Nov" -> 8214, 22. */
export function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, '').replace(/\.0+$/, '')).filter(Boolean);
}

function allowedNumbers(...sources: unknown[]): Set<string> {
  return new Set(sources.flatMap((s) => numbersIn(typeof s === 'string' ? s : JSON.stringify(s))));
}

function str(v: unknown, max: number): string {
  if (typeof v !== 'string') throw new Error('not text');
  const t = v.trim();
  if (!t || t.length > max) throw new Error('bad length');
  return t;
}

function checkNumbers(text: string, allowed: Set<string>): void {
  const bad = numbersIn(text).filter((n) => !allowed.has(n));
  if (bad.length) throw new Error(`invented number(s): ${bad.slice(0, 3).join(', ')}`);
}

export function omnirouteWriter(cfg: OmniRouteConfig, opts: AiWriterOptions = {}): CoachWriter & { readonly pending: number } {
  const model = opts.model || DEFAULT_TEXT_MODEL;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? 7 * 24 * 3600_000;
  const failureTtl = opts.failureTtlMs ?? 15 * 60_000;
  const maxEntries = opts.maxEntries ?? 5000;
  const maxInFlight = opts.maxInFlight ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const log = opts.log ?? ((m: string) => console.warn(`[coach-ai] ${m}`));

  const cache = new Map<string, { at: number; ok: boolean; value?: unknown }>();
  const inFlight = new Map<string, Promise<void>>();

  function remember(key: string, entry: { at: number; ok: boolean; value?: unknown }): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
  }

  /** The cached AI text for key, or NotReady (after starting it in the background if allowed). */
  function cached<T>(key: string, compute: () => Promise<T>): T {
    const hit = cache.get(key);
    const t = now();
    if (hit && t - hit.at < (hit.ok ? ttl : failureTtl) && hit.at <= t) {
      if (hit.ok) return hit.value as T;
      throw new NotReady('recently failed');
    }
    if (!inFlight.has(key) && inFlight.size < maxInFlight) {
      const job = compute()
        .then((value) => remember(key, { at: now(), ok: true, value }))
        .catch((e) => { remember(key, { at: now(), ok: false }); log(`${key.split(':')[0]}: ${(e as Error).message ?? e}`); })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    throw new NotReady('writing in the background');
  }

  async function weeklyText(f: WeekFacts, draft: CoachMessage): Promise<CoachMessage> {
    const { json } = await chatJson(cfg, {
      model, system: SYSTEM, maxTokens: 2000, timeoutMs,
      schema: { name: 'weekly_summary', schema: WEEKLY_SCHEMA },
      user: `Weekly summary for one participant.\nFACTS: ${JSON.stringify(f)}\nDRAFT: ${JSON.stringify(draft)}`,
    });
    const headline = str(json.headline, 120);
    if (!Array.isArray(json.lines) || json.lines.length < 1 || json.lines.length > 8) throw new Error('bad lines');
    const lines = json.lines.map((l) => str(l, 240));
    const allowed = allowedNumbers(f, draft);
    for (const t of [headline, ...lines]) checkNumbers(t, allowed);
    return { headline, lines };
  }

  async function nudgeText(f: NudgeFacts, draft: { title: string; body: string }): Promise<{ title: string; body: string }> {
    const { json } = await chatJson(cfg, {
      model, system: SYSTEM, maxTokens: 1500, timeoutMs,
      schema: { name: 'nudge', schema: NUDGE_SCHEMA },
      user: `An evening push notification: today's steps aren't in yet.\nFACTS: ${JSON.stringify(f)}\nDRAFT: ${JSON.stringify(draft)}`,
    });
    const title = str(json.title, 80), body = str(json.body, 180);
    const allowed = allowedNumbers(f, draft);
    checkNumbers(title, allowed); checkNumbers(body, allowed);
    return { title, body };
  }

  return {
    name: 'omniroute',
    get pending() { return inFlight.size; },
    async weekly(f) {
      const draft = await templateWriter.weekly(f);
      return cached(`weekly:${JSON.stringify(f)}`, () => weeklyText(f, draft));
    },
    async nudge(f) {
      const draft = await templateWriter.nudge(f);
      return cached(`nudge:${JSON.stringify(f)}`, () => nudgeText(f, draft));
    },
    risk: (f) => templateWriter.risk(f),
  };
}
