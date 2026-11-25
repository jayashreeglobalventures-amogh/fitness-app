import { describe, expect, it } from 'vitest';
import { judge } from '../../src/modules/checkin/submissions.js';
import { parseReading, type Reading } from '../../src/modules/verification/reader.js';

const reading = (over: Partial<Reading> = {}): Reading => ({ readable: true, date: '2026-11-22', value: 8200, sourceApp: 'Google Fit', confidence: 0.97, flags: [], notes: '', model: 'm', provider: 'p', ...over });

describe('AI reading -> decision (the AI may only approve)', () => {
  it('approves a clear, confident, on-target reading of the right day', () => {
    expect(judge(reading(), '2026-11-22', 7000, 0.9, null)).toMatchObject({ approve: true });
    expect(judge(reading({ value: 7000 }), '2026-11-22', 7000, 0.9, null).approve).toBe(true); // exactly the target
  });
  it.each([
    ['below target', { value: 6999 }, 'BELOW_TARGET'],
    ['wrong day', { date: '2026-11-21' }, 'DATE_MISMATCH'],
    ['no date', { date: null }, 'DATE_NOT_VISIBLE'],
    ['no value', { value: null }, 'VALUE_NOT_VISIBLE'],
    ['unsure', { confidence: 0.6 }, 'LOW_CONFIDENCE'],
    ['unreadable', { readable: false }, 'UNREADABLE'],
    ['model flag', { flags: ['EDITED_LOOKING'] }, 'EDITED_LOOKING'],
  ] as const)('%s -> admin review, never a rejection', (_n, over, flag) => {
    const v = judge(reading(over as Partial<Reading>), '2026-11-22', 7000, 0.9, null);
    expect(v.approve).toBe(false);
    expect(v.flags).toContain(flag);
  });
  it('a claimed total that disagrees with the reading goes to review', () => {
    expect(judge(reading(), '2026-11-22', 7000, 0.9, 12000).flags).toContain('CLAIM_MISMATCH');
    expect(judge(reading(), '2026-11-22', 7000, 0.9, 8210).approve).toBe(true); // small difference is fine
  });
  it('parseReading sanitises model output', () => {
    const r = parseReading({ readable: true, date: '22/11/2026', value: -5, confidence: 7, flags: ['X', 3], sourceApp: 'a'.repeat(100), notes: 'n' }, 'm', 'p');
    expect(r).toMatchObject({ date: null, value: null, confidence: 1, flags: ['X'] });
    expect(r.sourceApp).toHaveLength(60);
  });
});

describe('"Don\'t require a date" setting', () => {
  it('a screenshot without a date (e.g. "Today") is approved; one showing another date still is not', () => {
    expect(judge(reading({ date: null }), '2026-11-22', 7000, 0.9, null, { ignoreDate: true })).toMatchObject({ approve: true, reason: 'Read automatically: 8200 on 2026-11-22 (no date shown).' });
    expect(judge(reading({ date: '2026-11-21' }), '2026-11-22', 7000, 0.9, null, { ignoreDate: true }).flags).toContain('DATE_MISMATCH');
  });
  it('the same steps as an earlier screenshot go to an admin, with the note', () => {
    const v = judge(reading({ date: null }), '2026-11-22', 7000, 0.9, null, { ignoreDate: true, sameAsEarlier: 'Same steps (8,200) as the screenshot for 20 Nov.' });
    expect(v).toMatchObject({ approve: false, flags: ['SAME_STEPS_AS_EARLIER'] });
    expect(v.reason).toContain('20 Nov');
  });
});
