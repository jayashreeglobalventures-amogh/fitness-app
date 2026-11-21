import { describe, expect, it } from 'vitest';
import { findDates, fixGrouping, interpretOcr, type OcrLine } from '../../src/modules/verification/ocr.js';
import { judge } from '../../src/modules/checkin/submissions.js';

const ctx = { expectedDay: '2026-11-22', timeZone: 'Asia/Kolkata', metricLabel: 'Steps', unit: 'steps' };
const L = (...rows: (string | [string, number])[]): OcrLine[] => rows.map((r) => (typeof r === 'string' ? { text: r, confidence: 95 } : { text: r[0], confidence: r[1] }));
const read = (lines: OcrLine[], day = ctx.expectedDay) => interpretOcr(lines, { ...ctx, expectedDay: day });
const approved = (lines: OcrLine[], day = ctx.expectedDay) => {
  const r = read(lines, day);
  return judge({ ...r, model: 'm', provider: 'p' }, day, 7000, 0.9, null).approve;
};

describe('dates in screenshot text', () => {
  it.each([
    ['Sun, 22 Nov', ['2026-11-22']],
    ['22 November 2026', ['2026-11-22']],
    ['Sunday, November 22', ['2026-11-22']],
    ['Nov 22, 2026', ['2026-11-22']],
    ['22/11/2026', ['2026-11-22']],
    ['22-11-26', ['2026-11-22']],
    ['2026-11-22', ['2026-11-22']],
    ['5/12/2026', ['2026-12-05']],          // day first (India)
    ['12/25/2026', ['2026-12-25']],         // month first only when day-first is impossible
    ['22nd Nov', ['2026-11-22']],
    ['16 - 22 Nov', ['2026-11-16', '2026-11-22']],
    ['Nov 16 – 22', ['2026-11-16', '2026-11-22']],
    ['Nov 8,214 steps', []],               // a step count after a month is not a day
    ['9:41  87%', []],
    ['31 Feb', []],
  ])('%s', (text, expected) => {
    expect(findDates(text, ctx.expectedDay).sort()).toEqual(expected);
  });

  it('a date without a year near New Year belongs to the closest year', () => {
    expect(findDates('31 Dec', '2027-01-01')).toEqual(['2026-12-31']);
    expect(findDates('1 Jan', '2026-12-31')).toEqual(['2027-01-01']);
  });
});

describe('reading step apps', () => {
  it('Google Fit-style: big number, "Steps" below, goal and other metrics ignored', () => {
    const lines = L('9:41 87%', 'Sun, 22 Nov', '8,214', 'Steps', 'Goal 10,000', '5.21 312 64', ['km kcal Move Min', 77]);
    expect(read(lines)).toMatchObject({ readable: true, date: '2026-11-22', value: 8214, flags: [] });
    expect(approved(lines)).toBe(true);
  });

  it('Samsung Health-style: "7,056" with "/6,000 steps" goal underneath', () => {
    expect(read(L('Steps', 'Sun, 22 November', '7,056', '/6,000 steps', '4.8 km 276 kcal'))).toMatchObject({ value: 7056, date: '2026-11-22', flags: [] });
  });

  it('single line "8214 / 10000 steps" takes the first number, not the goal', () => {
    expect(read(L('22 Nov 2026', '8214 / 10000 steps')).value).toBe(8214);
  });

  it('"Steps 12,480" on one line; label first', () => {
    expect(read(L('Sunday 22 November', 'Steps 12,480', 'Distance 9.1 km')).value).toBe(12480);
  });

  it('Apple Health-style with TOTAL label', () => {
    expect(read(L('Steps', 'TOTAL', '9,302', 'steps', '22 Nov 2026'))).toMatchObject({ value: 9302, date: '2026-11-22' });
  });

  it('numbers with units are not step counts (km, kcal, min, bpm)', () => {
    expect(read(L('22 Nov', '7,400 steps', '5,2 km', '312 kcal', '72 bpm')).value).toBe(7400);
  });
});

describe('what must go to an admin', () => {
  it('weekly totals or averages', () => {
    const r = read(L('16 - 22 Nov', 'Daily average 7,412 steps', 'Total this week 51,884 steps'));
    expect(r.flags).toEqual(expect.arrayContaining(['WEEKLY_OR_AVERAGE', 'MULTIPLE_DAYS']));
    expect(approved(L('16 - 22 Nov', 'Daily average 7,412 steps'))).toBe(false);
  });

  it('two different step counts', () => {
    const lines = L('22 Nov', '8,214 steps', 'Yesterday 6,100 steps');
    expect(read(lines).flags).toContain('MULTIPLE_VALUES');
    expect(approved(lines)).toBe(false);
  });

  it('"Today" without a date', () => {
    const lines = L('Today', '8,214', 'Steps');
    expect(read(lines)).toMatchObject({ date: null, value: 8214 });
    expect(read(lines).notes).toContain('Today');
    expect(approved(lines)).toBe(false);
  });

  it('a different day', () => {
    expect(approved(L('Sat, 21 Nov', '8,214', 'Steps'))).toBe(false);
  });

  it('below the target', () => {
    expect(approved(L('22 Nov', '6,980', 'Steps'))).toBe(false);
  });

  it('blurry text (low recognition confidence)', () => {
    expect(approved(L(['22 Nov', 62], ['8,214', 70], 'Steps'))).toBe(false);
  });

  it('almost no text', () => {
    expect(read(L('8214'))).toMatchObject({ readable: false });
  });

  it('a number with no "steps" label near it', () => {
    expect(read(L('22 Nov', '8,214', 'Calories burned')).value).toBeNull();
  });
});

// Apple Fitness "Step Count" (week view, a day tapped): the total is labelled TOTAL, not "steps" (owner's report, 21 Nov
// 2026 - a real screenshot read as nothing). Lines exactly as Tesseract read that screenshot.
describe('Apple Fitness "Step Count" screen', () => {
  const apple = (total: string, date: string, label = 'TOTAL') => L(['14:55 wo! ITE GB)', 48], ['<', 91], ['Step Count', 96], [label, 96], [total, 96], [date, 96],
    ['5,000', 96], ['2,500', 93], ['0', 89], ['Mon Tue Wed Thu Fri Sat Sun', 96], ['© © 6 aa', 59], ['Summary Fitness+ Workout Sharing', 94], ['rr 2', 24]);

  it('reads the total next to TOTAL and its date, ignoring the chart axis (5,000 / 2,500)', () => {
    expect(read(apple('4,660', '17 Nov 2026'), '2026-11-17')).toMatchObject({ value: 4660, date: '2026-11-17', sourceApp: 'Apple Fitness', flags: [] });
  });

  it('another day\'s screenshot is not approved (date mismatch -> admin); the right day on target is', () => {
    expect(approved(apple('8,120', '17 Nov 2026'), '2026-11-22')).toBe(false);
    expect(approved(apple('8,120', '22 Nov 2026'), '2026-11-22')).toBe(true);
    expect(approved(apple('4,660', '22 Nov 2026'), '2026-11-22')).toBe(false); // below target -> admin / missed
  });

  it('the week view before a bar is tapped shows DAILY AVERAGE: never taken as a day\'s total', () => {
    const r = read(apple('6,850', '16-22 Nov 2026', 'DAILY AVERAGE'));
    expect(r.value).toBeNull();
    expect(r.flags).toContain('WEEKLY_OR_AVERAGE');
  });
});

// Apple Health "Summary" (owner's report, 21 Nov 2026): the total was read as 505 because OCR split "24,505" into
// "24 . 505". Lines exactly as Tesseract read that screenshot.
describe('Apple Health Summary card', () => {
  const summary = L(['Summary sM.', 51], ['Pinned Edit', 65], ['O Activity Yesterday', 75], ['Move Exercise Stand ©', 96], ['539 cal | 9 min 15 hr', 75], ['O Steps 21:54', 62], ['24 . 505 steps', 84]);

  it('reads 24,505 (not 505) and names the app', () => {
    expect(read(summary)).toMatchObject({ value: 24505, sourceApp: 'Apple Health' });
  });

  it('no date on the card -> an admin checks it (with the number filled in), and the note explains why', () => {
    const r = read(summary);
    expect(r.date).toBeNull();
    expect(r.notes).toContain('only a time (21:54)');
    expect(approved(summary)).toBe(false);
  });

  it('split thousands are joined; decimals and times are left alone', () => {
    expect(fixGrouping('24 . 505 steps')).toBe('24,505 steps');
    expect(fixGrouping('8 , 214')).toBe('8,214');
    expect(fixGrouping('5.21 km')).toBe('5.21 km');
    expect(fixGrouping('Steps 21:54')).toBe('Steps 21:54');
    expect(fixGrouping('12. 3456')).toBe('12. 3456'); // four digits after: not a thousands group
  });
});
