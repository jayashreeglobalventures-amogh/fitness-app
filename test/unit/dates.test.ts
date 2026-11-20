import { describe, expect, it } from 'vitest';
import { addDays, computePeriods, endOfDay, localDay, weekdayOf, zonedInstant } from '../../src/core/dates.js';

describe('calendar days in a time zone', () => {
  it('22 Nov 2026 is a Sunday and 31 Dec 2026 a Thursday (PRD 6)', () => {
    expect(weekdayOf('2026-11-22')).toBe('SUNDAY');
    expect(weekdayOf('2026-12-31')).toBe('THURSDAY');
  });

  it('the local day of an instant near midnight IST', () => {
    // 18:29:59 UTC = 23:59:59 IST on the same day; 18:30 UTC = 00:00 IST the next day.
    expect(localDay(new Date('2026-11-22T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-11-22');
    expect(localDay(new Date('2026-11-22T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-23');
  });

  it('deadline of a day is the next local midnight; 10:00 IST cut-off', () => {
    expect(endOfDay('2026-11-22', 'Asia/Kolkata').toISOString()).toBe('2026-11-22T18:30:00.000Z');
    expect(zonedInstant('2026-11-22', '10:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-22T04:30:00.000Z');
    expect(endOfDay('2026-12-31', 'Asia/Kolkata').toISOString()).toBe('2026-12-31T18:30:00.000Z');
  });

  it('handles a daylight-saving zone', () => {
    // New York switches to EDT on 8 Mar 2026: midnight that day is still EST (UTC-5), 10:00 is EDT (UTC-4).
    expect(zonedInstant('2026-03-08', '00:00', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedInstant('2026-03-08', '10:00', 'America/New_York').toISOString()).toBe('2026-03-08T14:00:00.000Z');
  });

  it('addDays crosses months and years', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('weekly periods', () => {
  it('Calamari: six Sunday–Saturday periods, the last of 5 days (PRD 6 table)', () => {
    const p = computePeriods('2026-11-22', '2026-12-31', 'SUNDAY');
    expect(p.map((x) => [x.startsOn, x.endsOn, x.days])).toEqual([
      ['2026-11-22', '2026-11-28', 7],
      ['2026-11-29', '2026-12-05', 7],
      ['2026-12-06', '2026-12-12', 7],
      ['2026-12-13', '2026-12-19', 7],
      ['2026-12-20', '2026-12-26', 7],
      ['2026-12-27', '2026-12-31', 5],
    ]);
    expect(p.reduce((a, x) => a + x.days, 0)).toBe(40);
  });

  it('a challenge starting mid-week gets a partial first period', () => {
    const p = computePeriods('2026-11-25', '2026-12-02', 'MONDAY');
    expect(p.map((x) => [x.startsOn, x.endsOn])).toEqual([['2026-11-25', '2026-11-29'], ['2026-11-30', '2026-12-02']]);
  });

  it('a one-day challenge has one period', () => {
    expect(computePeriods('2026-11-25', '2026-11-25', 'SUNDAY')).toEqual([{ periodNo: 1, startsOn: '2026-11-25', endsOn: '2026-11-25', days: 1 }]);
  });
});
