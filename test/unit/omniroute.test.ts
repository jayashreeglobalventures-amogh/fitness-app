import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatJson, OmniRouteError, omniRouteConfig, type OmniRouteConfig } from '../../src/core/omniroute.js';
import { NotReady, numbersIn, omnirouteWriter } from '../../src/modules/coach/ai-writer.js';
import type { NudgeFacts, WeekFacts } from '../../src/modules/coach/facts.js';
import { selectWriter, templateWriter, write } from '../../src/modules/coach/writer.js';
import { omnirouteReader, withBackup } from '../../src/modules/verification/omniroute-reader.js';
import { ReaderError, type Reading, type ScreenshotReader } from '../../src/modules/verification/reader.js';
import { readerName } from '../../src/modules/verification/select.js';

const ctx = { expectedDay: '2026-11-22', timeZone: 'Asia/Kolkata', metricLabel: 'Steps', unit: 'steps' };

/** A fake gateway: each call gets the next answer (a JSON content string, an HTTP status, or an Error). */
function gateway(...answers: (string | number | Error)[]) {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') });
    const a = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (a instanceof Error) throw a;
    if (typeof a === 'number') return new Response('{"error":{}}', { status: a });
    return new Response(JSON.stringify({ model: 'served-model', choices: [{ message: { content: a }, finish_reason: 'stop' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const cfg: OmniRouteConfig = { apiKey: 'sk-test', baseUrl: 'http://gw/v1', fetch: f };
  return { cfg, calls };
}

const req = { model: 'm', system: 's', user: 'u', schema: { name: 'x', schema: {} }, maxTokens: 10, timeoutMs: 1000 };

describe('OmniRoute client', () => {
  it('reads configuration from the environment', () => {
    expect(omniRouteConfig({})).toBeNull();
    expect(omniRouteConfig({ OMNIROUTE_API_KEY: ' k ' })).toEqual({ apiKey: 'k', baseUrl: 'http://omniroute-app:20128/v1' });
    expect(omniRouteConfig({ OMNIROUTE_API_KEY: 'k', OMNIROUTE_BASE_URL: 'https://ai.example/v1/' })?.baseUrl).toBe('https://ai.example/v1');
  });

  it('sends a JSON-schema chat request with the key and parses the answer (even inside a code fence)', async () => {
    const g = gateway('```json\n{"a":1}\n```');
    const r = await chatJson(g.cfg, req);
    expect(r).toEqual({ json: { a: 1 }, model: 'served-model' });
    expect(g.calls[0]).toMatchObject({ url: 'http://gw/v1/chat/completions', auth: 'Bearer sk-test' });
    expect(g.calls[0]!.body).toMatchObject({ model: 'm', response_format: { type: 'json_schema' }, messages: [{ role: 'system' }, { role: 'user' }] });
  });

  it.each([
    [401, false], [403, false], [400, false], [404, false], [429, true], [500, true], [503, true],
  ])('HTTP %i -> retryable %s', async (status, retryable) => {
    const e = await chatJson(gateway(status).cfg, req).catch((x) => x);
    expect(e).toBeInstanceOf(OmniRouteError);
    expect(e.retryable).toBe(retryable);
  });

  it('network errors, timeouts, cut-short and unparseable answers are retryable', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    for (const a of [new Error('ECONNREFUSED'), timeout, 'no json here']) {
      expect(await chatJson(gateway(a).cfg, req).catch((x) => x.retryable)).toBe(true);
    }
    const cut = { ...gateway('x').cfg, fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"a"' }, finish_reason: 'length' }] }))) as unknown as typeof fetch };
    expect(await chatJson(cut, req).catch((x) => x.message)).toMatch(/cut short/);
  });
});

describe('OmniRoute screenshot reader', () => {
  const answer = JSON.stringify({ readable: true, date: '2026-11-22', value: 8214, sourceApp: 'Google Fit', confidence: 95, flags: [], notes: '' });

  it('sends the image as a data URL to the vision model and returns a sanitised reading', async () => {
    const g = gateway(answer);
    const r = await omnirouteReader(g.cfg, 'vision-model').read(Buffer.from('png'), 'image/png', ctx);
    expect(r).toMatchObject({ readable: true, date: '2026-11-22', value: 8214, confidence: 0.95, provider: 'omniroute', model: 'served-model' });
    const body = g.calls[0]!.body;
    expect(body.model).toBe('vision-model');
    expect(body.messages[1].content[0].image_url.url).toBe(`data:image/png;base64,${Buffer.from('png').toString('base64')}`);
    expect(body.messages[1].content[1].text).toContain('2026-11-22');
  });

  it('turns gateway failures into ReaderErrors with the same retry decision', async () => {
    const e = await omnirouteReader(gateway(401).cfg).read(Buffer.from('x'), 'image/png', ctx).catch((x) => x);
    expect(e).toBeInstanceOf(ReaderError);
    expect(e.retryable).toBe(false);
    expect((await omnirouteReader(gateway(503).cfg).read(Buffer.from('x'), 'image/png', ctx).catch((x) => x)).retryable).toBe(true);
  });
});

describe('reader with a backup', () => {
  const reading: Reading = { readable: true, date: '2026-11-22', value: 8214, sourceApp: null, confidence: 0.9, flags: [], notes: 'ocr note', model: 'tess', provider: 'tesseract' };
  const ok: ScreenshotReader = { read: async () => reading };
  const fail = (retryable: boolean): ScreenshotReader => ({ read: async () => { throw new ReaderError('down', retryable); } });

  it('uses the primary when it works', async () => {
    const primary: ScreenshotReader = { read: async () => ({ ...reading, provider: 'omniroute' }) };
    expect((await withBackup(primary, fail(false)).read(Buffer.from(''), 'image/png', ctx)).provider).toBe('omniroute');
  });
  it('falls back to the backup and says so in the notes', async () => {
    const r = await withBackup(fail(false), ok).read(Buffer.from(''), 'image/png', ctx);
    expect(r.provider).toBe('tesseract');
    expect(r.notes).toMatch(/^AI reader unavailable \(down\); read by the backup reader\. ocr note$/);
  });
  it('if both fail, retries later when either might recover', async () => {
    expect((await withBackup(fail(true), fail(false)).read(Buffer.from(''), 'image/png', ctx).catch((x) => x)).retryable).toBe(true);
    expect((await withBackup(fail(false), fail(false)).read(Buffer.from(''), 'image/png', ctx).catch((x) => x)).retryable).toBe(false);
  });
});

describe('reader selection', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('Claude key wins, then OmniRoute, then Tesseract', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ''); vi.stubEnv('OMNIROUTE_API_KEY', ''); vi.stubEnv('SCREENSHOT_OCR', 'on');
    expect(readerName()).toBe('tesseract');
    vi.stubEnv('OMNIROUTE_API_KEY', 'k');
    expect(readerName()).toBe('omniroute');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-x');
    expect(readerName()).toBe('claude');
  });
});

const week: WeekFacts = {
  challengeName: 'Calamari', periodNo: 3, startsOn: '2026-11-16', endsOn: '2026-11-22', complete: true, daysInWeek: 7,
  achieved: 5, missed: 2, rest: 0, excused: 0, pending: 0, previous: { periodNo: 2, achieved: 4, eligible: 7 },
  stepsAverage: 8214, bestDay: { day: '2026-11-20', steps: 11050 }, streak: 3, bestStreak: 4, adherencePct: 78,
  qualificationPct: 80, daysToQualify: 2, points: 50, pointsTotal: 1250, weakestWeekday: 'Monday', daysLeft: 14, target: 7000,
};
const nudge: NudgeFacts = { challengeName: 'Calamari', streak: 3, hoursLeft: 4, target: 7000, missedYesterday: false };
const settle = async (w: { pending: number }) => { for (let i = 0; i < 50 && w.pending; i++) await new Promise((r) => setTimeout(r, 1)); };

describe('AI coach writer', () => {
  it('numbersIn ignores thousands separators', () => {
    expect(numbersIn('8,214 steps, 1,00,000 total, week 3, 78%')).toEqual(['8214', '100000', '3', '78']);
  });

  it('answers from the templates at once, writes the AI version in the background, then serves it from the cache', async () => {
    const g = gateway(JSON.stringify({ headline: 'Week 3: 5 great days 💪', lines: ['You averaged 8,214 steps.', 'Aim for 7,000 every day next week.'] }));
    const w = omnirouteWriter(g.cfg, { log: () => {} });
    const template = await templateWriter.weekly(week);
    expect(await write((x) => x.weekly(week), w)).toEqual(template);
    await settle(w);
    expect(await write((x) => x.weekly(week), w)).toEqual({ headline: 'Week 3: 5 great days 💪', lines: ['You averaged 8,214 steps.', 'Aim for 7,000 every day next week.'] });
    expect(g.calls).toHaveLength(1); // cached: no second call
    expect(g.calls[0]!.body.model).toBe('Amogh-Ai-Combo');
    expect(g.calls[0]!.body.messages[1].content).toContain('DRAFT');
  });

  it('rejects AI text with a number that is not in the facts, and does not retry it straight away', async () => {
    const g = gateway(JSON.stringify({ headline: 'Week 3: you walked 99,999 steps!', lines: ['Great.'] }));
    const logs: string[] = [];
    const w = omnirouteWriter(g.cfg, { log: (m) => logs.push(m) });
    await expect(w.weekly(week)).rejects.toBeInstanceOf(NotReady);
    await settle(w);
    await expect(w.weekly(week)).rejects.toBeInstanceOf(NotReady);
    expect(g.calls).toHaveLength(1);
    expect(logs[0]).toMatch(/invented number\(s\): 99999/);
    expect(await write((x) => x.weekly(week), w)).toEqual(await templateWriter.weekly(week));
  });

  it('tries again after the failure pause', async () => {
    let t = 1_000_000;
    const g = gateway(500, JSON.stringify({ title: 'Keep your 3-day streak 🔥', body: '7,000 steps, 4 hours left - you can do it!' }));
    const w = omnirouteWriter(g.cfg, { now: () => t, log: () => {} });
    await expect(w.nudge(nudge)).rejects.toBeInstanceOf(NotReady);
    await settle(w);
    t += 16 * 60_000;
    await expect(w.nudge(nudge)).rejects.toBeInstanceOf(NotReady);
    await settle(w);
    expect(await w.nudge(nudge)).toEqual({ title: 'Keep your 3-day streak 🔥', body: '7,000 steps, 4 hours left - you can do it!' });
  });

  it('limits concurrent AI calls; the rest use templates for now', async () => {
    const g = gateway(JSON.stringify({ headline: 'h', lines: ['l'] }));
    const w = omnirouteWriter(g.cfg, { maxInFlight: 2, log: () => {} });
    for (let i = 1; i <= 5; i++) await w.weekly({ ...week, periodNo: i }).catch(() => {});
    expect(w.pending).toBe(2);
    await settle(w);
  });

  it('admin risk reasons stay template-only', async () => {
    const g = gateway('{}');
    const w = omnirouteWriter(g.cfg);
    const f = { participantId: 1, userId: 1, displayName: 'A', missesInARow: 3, adherencePct: 60, qualificationPct: 80, daysSinceLastSuccess: 3 };
    expect(await w.risk(f)).toBe(await templateWriter.risk(f));
    expect(g.calls).toHaveLength(0);
  });

  it('COACH_WRITER=omniroute needs a key, and keeps one writer (one cache)', () => {
    expect(selectWriter({ COACH_WRITER: 'omniroute' })).toBe(templateWriter);
    const a = selectWriter({ COACH_WRITER: 'omniroute', OMNIROUTE_API_KEY: 'k' });
    expect(a.name).toBe('omniroute');
    expect(selectWriter({ COACH_WRITER: 'omniroute', OMNIROUTE_API_KEY: 'k' })).toBe(a);
    expect(selectWriter({})).toBe(templateWriter);
  });
});
