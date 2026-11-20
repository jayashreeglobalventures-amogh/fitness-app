// Calendar-day arithmetic for challenges. A challenge day is a plain 'YYYY-MM-DD' in the challenge's time zone;
// instants (submission times, declarations) are Dates. Conversions go through Intl, so any IANA zone works.
const DAY_MS = 86_400_000;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
export const weekdayOf = (day: string): Weekday => WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!;

/** The calendar day an instant falls on in a time zone. */
export function localDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Offset (ms) of a time zone from UTC at an instant. */
function offsetAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(instant);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The instant at which a wall-clock time ('HH:MM') happens on a day in a time zone. */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const naive = Date.parse(`${day}T${time}:00Z`);
  let guess = naive - offsetAt(new Date(naive), timeZone);
  guess = naive - offsetAt(new Date(guess), timeZone); // second pass settles DST edges
  return new Date(guess);
}

/** The first instant of the day after `day` in the zone: the "before midnight" deadline of `day`. */
export const endOfDay = (day: string, timeZone: string): Date => zonedInstant(addDays(day, 1), '00:00', timeZone);

export interface Period { periodNo: number; startsOn: string; endsOn: string; days: number }

/** Splits [startDate, endDate] into weeks that start on `weekStartsOn`; the first and last may be partial. */
export function computePeriods(startDate: string, endDate: string, weekStartsOn: Weekday): Period[] {
  const startIdx = WEEKDAYS.indexOf(weekStartsOn);
  const out: Period[] = [];
  let cur = startDate;
  while (daysBetween(cur, endDate) >= 0) {
    const wd = WEEKDAYS.indexOf(weekdayOf(cur));
    const untilWeekEnd = (startIdx + 6 - wd + 7) % 7; // days from cur to the last day of its week
    const lastOfWeek = addDays(cur, untilWeekEnd);
    const end = daysBetween(lastOfWeek, endDate) >= 0 ? lastOfWeek : endDate;
    out.push({ periodNo: out.length + 1, startsOn: cur, endsOn: end, days: daysBetween(cur, end) + 1 });
    cur = addDays(end, 1);
  }
  return out;
}

/**
 * Parses an instant given either with an offset/Z (ISO) or as a local wall-clock time 'YYYY-MM-DDTHH:MM' that is
 * then read in `timeZone`. Returns null when invalid.
 */
export function parseInstant(raw: unknown, timeZone: string): Date | null {
  const s = String(raw ?? '').trim();
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(s);
  if (local) return isValidDate(local[1]!) && TIME_RE.test(local[2]!) ? zonedInstant(local[1]!, local[2]!, timeZone) : null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
