// Free, on-server screenshot reading: Tesseract (tesseract.js, WebAssembly) reads the text, then interpretOcr() finds
// the day's total and the date. No account, no key, and the image never leaves the server. The English language
// data ships with the app (@tesseract.js-data/eng), so nothing is downloaded at run time.
//
// The reading is deliberately conservative: anything unusual becomes a flag, and judge() (submissions.ts) only
// approves a clean, confident, on-target reading of the right day - everything else goes to an admin.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createWorker, type Worker } from 'tesseract.js';
import { addDays, daysBetween, isValidDate } from '../../core/dates.js';
import { ReaderError, type ReadContext, type Reading, type ScreenshotReader } from './reader.js';

const require = createRequire(import.meta.url);
const ENG = require('@tesseract.js-data/eng') as { langPath: string; gzip: boolean };
const TESS_VERSION = (require('tesseract.js/package.json') as { version: string }).version;
export const OCR_MODEL = `tesseract.js-${TESS_VERSION}-eng`;

export interface OcrLine { text: string; confidence: number } // confidence 0..100, as Tesseract reports it

// ---------- interpretation (pure; unit-tested on text from many app layouts) ----------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
// A thousands-grouped number (8,214 / 8.214 / 8 214) or a plain 3-6 digit number.
const NUM_RE = /(?<![\d.,:/])(\d{1,3}(?:[,.   ]\d{3})+|\d{3,6})(?![\d:]|[.,]\d)/g;
const STEPS_RE = /\bsteps?\b/i;
// A whole screen about steps (e.g. Apple Fitness / Health "Step Count"), where the number is labelled "TOTAL" instead.
const STEP_SCREEN_RE = /\bstep\s*count\b|^\W*steps?\W*$/im;
const TOTAL_LABEL_RE = /^\W*(total|daily total|today'?s? total)\W*$/i;
const AVERAGE_LABEL_RE = /^\W*(daily\s+)?(avg|average)\W*$/i;
const SUMMARY_RE = /\b(avg|average|daily average|weekly|this week|last week|per day|total this|month|monthly|week)\b/i;
const GOAL_BEFORE_RE = /(goal|target|of|\/)\s*$/i;
const UNIT_AFTER_RE = /^\s*(k?cal|kj|km|mi|miles?|m\b|min|mins|minutes|hrs?|hours?|bpm|%|floors?|ft|kg|lbs?)/i;

const pad = (n: number) => String(n).padStart(2, '0');
const mkDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Every calendar date mentioned in the text (year defaults to the expected one). */
export function findDates(text: string, expectedDay: string): string[] {
  const year = Number(expectedDay.slice(0, 4));
  const out = new Set<string>();
  const add = (y: number, m: number, d: number) => {
    let s = mkDate(y, m, d);
    if (!isValidDate(s)) return;
    // No year shown: pick the year that puts the date closest to the expected day (Dec 31 vs Jan 1 edges).
    if (y === year) {
      for (const alt of [mkDate(y - 1, m, d), mkDate(y + 1, m, d)]) if (isValidDate(alt) && Math.abs(daysBetween(alt, expectedDay)) < Math.abs(daysBetween(s, expectedDay))) s = alt;
    }
    out.add(s);
  };
  // One line at a time: a month at the end of a line and a number on the next are not a date.
  for (const line of text.toLowerCase().split('\n')) scanLine(line, year, add);
  return [...out];
}

function scanLine(t: string, year: number, add: (y: number, m: number, d: number) => void): void {
  // A day range ("16 - 22 Nov", "Nov 16 - 22"): both ends, so a week view is seen as several days.
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})\\s+${MONTH_RE}`, 'g'))) {
    add(year, MONTHS[m[3]!.slice(0, 3)]!, +m[1]!); add(year, MONTHS[m[3]!.slice(0, 3)]!, +m[2]!);
  }
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})\\s*[-–]\\s*(\\d{1,2})\\b`, 'g'))) {
    add(year, MONTHS[m[1]!.slice(0, 3)]!, +m[2]!); add(year, MONTHS[m[1]!.slice(0, 3)]!, +m[3]!);
  }
  for (const m of t.matchAll(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/g)) add(+m[1]!, +m[2]!, +m[3]!);
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](20\d{2}|\d{2})\b/g)) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    const a = +m[1]!, b = +m[2]!;
    // Day first (India); month first only when day-first is impossible.
    if (b <= 12) add(y, b, a); else if (a <= 12) add(y, a, b);
  }
  for (const m of t.matchAll(new RegExp(`(?<![\\d,.])\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}(?:,?\\s+(20\\d{2}))?`, 'g'))) {
    add(m[3] ? +m[3] : year, MONTHS[m[2]!.slice(0, 3)]!, +m[1]!);
  }
  // "Nov 22", "November 22, 2026" - but not "Nov 8,214" (a number after the month is not always a day).
  for (const m of t.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d,.]\\d)\\b(?:,?\\s+(20\\d{2}))?`, 'g'))) {
    add(m[3] ? +m[3] : year, MONTHS[m[1]!.slice(0, 3)]!, +m[2]!);
  }
}

interface Candidate { value: number; confidence: number; how: 'same-line' | 'next-to-label' }

/** Step-count candidates: numbers on a line that says "steps", or a number alone next to a "steps" line. */
export function findTotals(lines: OcrLine[]): { candidates: Candidate[]; summary: boolean } {
  const candidates: Candidate[] = [];
  let summary = false;
  const numbersIn = (text: string) => {
    const found: { value: number; index: number; raw: string }[] = [];
    for (const m of text.matchAll(NUM_RE)) {
      const before = text.slice(0, m.index);
      const after = text.slice(m.index! + m[0].length);
      if (GOAL_BEFORE_RE.test(before)) continue;      // "/ 10,000", "goal 10,000", "of 10,000"
      if (UNIT_AFTER_RE.test(after)) continue;        // "5.2 km", "320 kcal", "45 min"
      if (/^\s*[ap]\.?m\b/i.test(after)) continue;    // times
      found.push({ value: Number(m[0].replace(/[^\d]/g, '')), index: m.index!, raw: m[0] });
    }
    return found;
  };
  const isLabelOnly = (text: string) => /^\W*steps?\W*$/i.test(text.trim());
  const isNumberOnly = (text: string) => numbersIn(text).length === 1 && text.replace(NUM_RE, '').replace(/[\s,.:|]/g, '').length <= 2;
  const stepScreen = lines.some((l) => STEP_SCREEN_RE.test(l.text.trim()));

  lines.forEach((line, i) => {
    // On a steps screen: a number right next to "TOTAL" is the day's total; next to "AVERAGE" it's a summary.
    if (stepScreen && isNumberOnly(line.text.trim())) {
      const near = [lines[i - 1]?.text ?? '', lines[i + 1]?.text ?? ''];
      if (near.some((x) => AVERAGE_LABEL_RE.test(x))) summary = true;
      else if (near.some((x) => TOTAL_LABEL_RE.test(x))) candidates.push({ value: numbersIn(line.text)[0]!.value, confidence: line.confidence, how: 'next-to-label' });
    }
    const text = line.text.trim();
    if (!text) return;
    if (STEPS_RE.test(text) && SUMMARY_RE.test(text)) { summary = true; return; }
    if (STEPS_RE.test(text)) {
      // "8,214 steps" or "Steps 8,214" (the first number that isn't a goal).
      const nums = numbersIn(text);
      if (nums.length) candidates.push({ value: nums[0]!.value, confidence: line.confidence, how: 'same-line' });
    }
    if (isNumberOnly(text)) {
      const prev = lines[i - 1]?.text ?? '', next = lines[i + 1]?.text ?? '';
      const neighbour = [prev, next].find((x) => isLabelOnly(x) || (STEPS_RE.test(x) && numbersIn(x).length === 0));
      if (neighbour !== undefined) {
        if (SUMMARY_RE.test(neighbour)) summary = true;
        else candidates.push({ value: numbersIn(text)[0]!.value, confidence: line.confidence, how: 'next-to-label' });
      }
    }
  });
  return { candidates, summary };
}

export function interpretOcr(lines: OcrLine[], ctx: ReadContext): Omit<Reading, 'model' | 'provider'> {
  const text = lines.map((l) => l.text).join('\n');
  const words = text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;
  const flags: string[] = [];
  const notes: string[] = [];
  if (words < 3) return { readable: false, date: null, value: null, sourceApp: null, confidence: 0, flags: ['LOW_QUALITY'], notes: 'Almost no text could be read.' };

  // Total for the day.
  const { candidates, summary } = findTotals(lines);
  if (summary) flags.push('WEEKLY_OR_AVERAGE');
  const values = [...new Set(candidates.map((c) => c.value))];
  let value: number | null = null;
  let valueConf = 0;
  if (values.length === 1) {
    value = values[0]!;
    valueConf = Math.max(...candidates.map((c) => c.confidence));
  } else if (values.length > 1) {
    flags.push('MULTIPLE_VALUES');
    notes.push(`Several step counts: ${values.join(', ')}.`);
    const best = [...candidates].sort((a, b) => b.confidence - a.confidence)[0]!;
    value = best.value;
    valueConf = best.confidence * 0.5;
  }

  // Date.
  const dates = findDates(text, ctx.expectedDay);
  let date: string | null = null;
  let dateConf = 0;
  if (dates.length === 1) {
    date = dates[0]!;
    const line = lines.find((l) => findDates(l.text, ctx.expectedDay).includes(date!));
    dateConf = line?.confidence ?? 0;
  } else if (dates.length > 1) {
    flags.push('MULTIPLE_DAYS');
    notes.push(`Several dates: ${dates.join(', ')}.`);
    date = dates.includes(ctx.expectedDay) ? ctx.expectedDay : dates[0]!;
    dateConf = 0;
  } else if (/\btoday\b/i.test(text)) {
    notes.push('Shows "Today" but no date.');
  } else if (/\byesterday\b/i.test(text)) {
    notes.push(`Shows "Yesterday" but no date (expected ${ctx.expectedDay}; yesterday was ${addDays(ctx.expectedDay, -1)}).`);
  }

  const confidence = value !== null && date !== null ? Math.min(valueConf, dateConf) / 100 : Math.max(valueConf, dateConf) / 200;
  const app = /fitness\+|\bstep\s*count\b/i.test(text) && !/google|samsung|fitbit/i.test(text) ? 'Apple Fitness' : /google\s*fit/i.test(text) ? 'Google Fit' : /samsung\s*health/i.test(text) ? 'Samsung Health' : /fitbit/i.test(text) ? 'Fitbit'
    : /\bhealth\b/i.test(text) && /\bsteps\b/i.test(text) ? 'Health' : /mi\s*fit|zepp/i.test(text) ? 'Mi Fitness / Zepp' : /garmin/i.test(text) ? 'Garmin' : null;
  return { readable: true, date, value, sourceApp: app, confidence: Math.round(confidence * 1000) / 1000, flags, notes: notes.join(' ') };
}

// ---------- the Tesseract worker (one, reused, jobs queued) ----------

let worker: Promise<Worker> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getWorker(): Promise<Worker> {
  if (!worker) {
    const cachePath = path.join(os.tmpdir(), 'fitness-tesseract');
    mkdirSync(cachePath, { recursive: true });
    worker = createWorker('eng', 1 /* LSTM only */, { langPath: ENG.langPath, gzip: ENG.gzip, cachePath, logger: () => undefined, errorHandler: () => undefined })
      .catch((e) => { worker = null; throw e; });
  }
  return worker;
}

/** Stops the worker (server shutdown, tests). */
export async function shutdownOcr(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await (await w.catch(() => null))?.terminate();
}

export async function ocrLines(image: Buffer): Promise<OcrLine[]> {
  const run = async () => {
    const w = await getWorker();
    const { data } = await w.recognize(image, {}, { text: true, blocks: true });
    const out: OcrLine[] = [];
    for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) out.push({ text: l.text.trim(), confidence: l.confidence });
    return out;
  };
  const job = queue.then(run, run);
  queue = job.catch(() => undefined);
  return job;
}

export function ocrReader(): ScreenshotReader {
  return {
    async read(image, _mimeType, ctx) {
      let lines: OcrLine[];
      try {
        lines = await ocrLines(image);
      } catch (e) {
        throw new ReaderError(`Text recognition failed: ${(e as Error).message ?? 'unknown error'}`.slice(0, 200), false);
      }
      return { ...interpretOcr(lines, ctx), model: OCR_MODEL, provider: 'tesseract' };
    },
  };
}
