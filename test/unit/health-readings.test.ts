import { describe, expect, it } from 'vitest';
import { sampleDay, sumReadings } from '../../src/modules/checkin/healthsync.js';

describe('adding up Apple Health readings', () => {
  it('only today\'s readings count; yesterday\'s are left out', () => {
    const r = sumReadings({ readings: '36\n4,000\n5000\n900', dates: '24 Nov 2026 at 11:20 PM\n24 Nov 2026 at 6:10 PM\n24 Nov 2026 at 8:05 AM\n23 Nov 2026 at 9:00 PM', sources: 'iPhone\niPhone\niPhone\niPhone' }, '2026-11-24');
    expect(r).toEqual({ total: 9036, counted: 3 });
  });

  it('phone and watch overlap: the device with the most counts (never both)', () => {
    const r = sumReadings({ readings: '3000\n2800\n6000\n5900', dates: 'Nov 24, 2026 at 10:00 AM\nNov 24, 2026 at 10:00 AM\nNov 24, 2026 at 6:00 PM\nNov 24, 2026 at 6:00 PM', sources: "Amogh's iPhone\nAmogh's Apple Watch\nAmogh's iPhone\nAmogh's Apple Watch" }, '2026-11-24');
    expect(r).toEqual({ total: 9000, counted: 4 });
  });

  it('values written as "36 steps", ISO dates, and no device names all work', () => {
    expect(sumReadings({ readings: ['36 steps', '100 count'], dates: ['2026-11-24T23:20:00+05:30', '2026-11-24T08:00:00+05:30'] }, '2026-11-24')).toEqual({ total: 136, counted: 2 });
  });

  it('nothing from today: zero counted; unreadable dates give a clear message', () => {
    expect(sumReadings({ readings: '50', dates: '23 Nov 2026 at 11:00 PM' }, '2026-11-24')).toEqual({ total: 0, counted: 0 });
    expect(sumReadings({ readings: '50', dates: 'yesterday-ish' }, '2026-11-24')).toEqual({ error: expect.stringContaining('couldn\'t read the dates') });
    expect(sumReadings({ readings: '50\n60', dates: '24 Nov 2026' }, '2026-11-24')).toEqual({ error: expect.stringContaining('2 readings, 1 dates') });
    // Nothing at all (Shortcuts not allowed to read Steps): say how to fix it.
    expect(sumReadings({ readings: '', dates: '', sources: '' }, '2026-11-24')).toEqual({ error: expect.stringContaining('Health → Shortcuts → turn on Steps') });
  });

  it('reads the date formats iPhones write', () => {
    expect(sampleDay('24 Nov 2026 at 11:20 PM')).toBe('2026-11-24');
    expect(sampleDay('Nov 24, 2026 at 6:10 PM')).toBe('2026-11-24');
    expect(sampleDay('2026-11-24T00:00:00Z')).toBe('2026-11-24');
  });
});
