// Reading a step-count screenshot. The rest of the app depends only on the ScreenshotReader interface, so the
// provider can change and tests use a fake. Which reader is used: select.ts.
// The AI only *reads*; it never decides anything negative (see pipeline.ts).
import Anthropic from '@anthropic-ai/sdk';

export interface ReadContext { expectedDay: string; timeZone: string; metricLabel: string; unit: string }
export interface Reading {
  readable: boolean;
  date: string | null;        // YYYY-MM-DD shown in the screenshot
  value: number | null;       // total for that day
  sourceApp: string | null;
  confidence: number;         // 0..1, the model's own estimate
  flags: string[];            // e.g. EDITED_LOOKING, MULTIPLE_DAYS, PARTIAL_DAY, NOT_A_TRACKER
  notes: string;
  model: string;
  provider: string;
}
export interface ScreenshotReader { read(image: Buffer, mimeType: string, ctx: ReadContext): Promise<Reading> }

/** A failure that may succeed later (rate limit, overload, network) or not (bad key, refusal). */
export class ReaderError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export const SCREENSHOT_MODEL = 'claude-opus-5-5';

const READING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readable', 'date', 'value', 'sourceApp', 'confidence', 'flags', 'notes'],
  properties: {
    readable: { type: 'boolean', description: 'false if the image is not a readable activity-tracker screen' },
    date: { type: ['string', 'null'], description: 'The calendar date the total belongs to, as YYYY-MM-DD, or null if not visible' },
    value: { type: ['integer', 'null'], description: 'The total for that single day, as an integer, or null if not visible' },
    sourceApp: { type: ['string', 'null'], description: 'The app or device shown (e.g. Google Fit, Samsung Health, Apple Health, Fitbit), or null' },
    confidence: { type: 'number', description: 'How sure you are that date AND value are read correctly, 0 to 1' },
    flags: { type: 'array', items: { type: 'string', enum: ['DATE_NOT_VISIBLE', 'VALUE_NOT_VISIBLE', 'MULTIPLE_DAYS', 'WEEKLY_OR_AVERAGE', 'PARTIAL_DAY', 'EDITED_LOOKING', 'NOT_A_TRACKER', 'LOW_QUALITY'] } },
    notes: { type: 'string', description: 'One short sentence about anything an admin should know' },
  },
} as const;

const SYSTEM = `You read screenshots from phone fitness apps and wearables (Google Fit, Samsung Health, Apple Health, Fitbit, Mi Fitness, Garmin, etc.) for a walking challenge.
Report exactly what the screenshot shows. Do not guess: if the date or the day's total is not clearly visible, return null for it and lower your confidence.
- "date": the specific calendar day the total belongs to. Resolve words like "Today" or "Yesterday" only if the screen also shows enough to know the actual date; otherwise null and DATE_NOT_VISIBLE. Dates without a year belong to the year given by the user.
- "value": the total for that one day (not a weekly total, average or goal). Ignore the goal number.
- Flag anything an admin should look at. Flagging is not an accusation; it only asks a human to check.`;

export function anthropicReader(apiKey: string): ScreenshotReader {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  return {
    async read(image, mimeType, ctx) {
      let res;
      try {
        res = await client.beta.messages.create({
          model: SCREENSHOT_MODEL,
          max_tokens: 4000,
          // A declined request is re-run on a fallback model chosen by the API (server-side fallback).
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: SYSTEM,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: READING_SCHEMA } },
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mimeType as 'image/png', data: image.toString('base64') } },
              { type: 'text', text: `The participant says this shows their ${ctx.metricLabel.toLowerCase()} (${ctx.unit}) for ${ctx.expectedDay} (time zone ${ctx.timeZone}, year ${ctx.expectedDay.slice(0, 4)}). Read the screenshot.` },
            ],
          }],
        });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new ReaderError('The Anthropic API key was refused.', false);
        if (e instanceof Anthropic.RateLimitError) throw new ReaderError('Rate limited.', true);
        if (e instanceof Anthropic.BadRequestError) throw new ReaderError(`Request refused (${e.status}).`, false);
        if (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500) throw new ReaderError(`Service unavailable (${e.status}).`, true);
        if (e instanceof Anthropic.APIConnectionError) throw new ReaderError('Network error.', true);
        throw new ReaderError('Screenshot reading failed.', true);
      }
      if (res.stop_reason === 'refusal') throw new ReaderError('The model declined to read this image.', false);
      if (res.stop_reason === 'max_tokens') throw new ReaderError('The reading was cut short.', true);
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      let j: Record<string, unknown>;
      try { j = JSON.parse(text); } catch { throw new ReaderError('The reading could not be parsed.', true); }
      return parseReading(j, res.model, 'anthropic');
    },
  };
}

export function parseReading(j: Record<string, unknown>, model: string, provider: string): Reading {
  const date = typeof j.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : null;
  const value = Number.isSafeInteger(j.value) && (j.value as number) >= 0 ? (j.value as number) : null;
  const confidence = typeof j.confidence === 'number' ? Math.max(0, Math.min(1, j.confidence)) : 0;
  return {
    readable: j.readable === true, date, value, confidence,
    sourceApp: typeof j.sourceApp === 'string' ? j.sourceApp.slice(0, 60) : null,
    flags: Array.isArray(j.flags) ? j.flags.filter((f): f is string => typeof f === 'string').slice(0, 10) : [],
    notes: typeof j.notes === 'string' ? j.notes.slice(0, 300) : '',
    model, provider,
  };
}
