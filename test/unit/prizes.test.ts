import { describe, expect, it } from 'vitest';
import type { ChallengeConfig } from '../../src/modules/challenges/config.js';
import { allocatePrizes, split, type StandingIn } from '../../src/modules/settlement/engine.js';

// Calamari (owner, 20 Nov 2026): 70% to qualifiers equally, 30% to the top three 50/30/20, next eligible moves up.
const prizes: ChallengeConfig['prizes'] = { qualificationAdherencePct: 80, qualificationPoolPct: 70, topThreePct: 30, topThreeSplitPct: [50, 30, 20], distribution: 'EQUAL', topThreeIneligible: 'NEXT_ELIGIBLE', payoutDate: '2027-01-01' };
const rs = (n: number) => Math.round(n * 100);
let id = 0;
const S = (name: string, rank: number, eligible = true, points = 300, tied = false): StandingIn => ({ participantId: ++id, displayName: name, rank, tied, points, adherencePct: eligible ? 90 : 70, eligible });
const by = (r: ReturnType<typeof allocatePrizes>, name: string) => r.allocations.find((a) => a.displayName === name)!;
const sum = (r: ReturnType<typeof allocatePrizes>) => r.allocations.reduce((a, x) => a + x.total, 0) + r.unallocated;

describe('split', () => {
  it('parts always add up to the whole, to the paisa', () => {
    expect(split(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(split(rs(3000), [50, 30, 20])).toEqual([rs(1500), rs(900), rs(600)]);
    expect(split(7, [70, 30])).toEqual([5, 2]);
    expect(split(0, [1, 2])).toEqual([0, 0]);
  });
});

describe('prizes (Calamari settings)', () => {
  it('₹10,000 pool, five qualifiers: top three get ₹1,500 / ₹900 / ₹600 + everyone ₹1,400 from the 70%', () => {
    const r = allocatePrizes([S('A', 1), S('B', 2), S('C', 3), S('D', 4), S('E', 5)], rs(10000), prizes);
    expect(r.issues).toEqual([]);
    expect([r.topThreePool, r.qualificationPool]).toEqual([rs(3000), rs(7000)]);
    expect(['A', 'B', 'C', 'D', 'E'].map((n) => by(r, n).total)).toEqual([rs(2900), rs(2300), rs(2000), rs(1400), rs(1400)]);
    expect(sum(r)).toBe(rs(10000));
  });

  it('an ineligible person ranked 2nd is skipped: the next eligible person moves up; they get nothing', () => {
    const r = allocatePrizes([S('A', 1), S('B', 2, false), S('C', 3), S('D', 4)], rs(10000), prizes);
    expect(by(r, 'B').total).toBe(0);
    expect([by(r, 'A').place, by(r, 'C').place, by(r, 'D').place]).toEqual([1, 2, 3]);
    expect(by(r, 'C').topThree).toBe(rs(900));
    expect(by(r, 'A').qualification).toBe(Math.floor(rs(7000) / 3) + 1);
    expect(sum(r)).toBe(rs(10000));
  });

  it('other setting: an ineligible place\'s money joins the qualification pool instead', () => {
    const r = allocatePrizes([S('A', 1), S('B', 2, false), S('C', 3), S('D', 4)], rs(10000), { ...prizes, topThreeIneligible: 'TO_QUALIFICATION_POOL' });
    expect(by(r, 'C').place).toBe(3);
    expect(r.qualificationPool).toBe(rs(7000) + rs(900));
    expect(r.notes.some((n) => n.includes('B (place 2) is not eligible'))).toBe(true);
  });

  it('fewer than three eligible people: the empty places\' money goes to the qualifiers', () => {
    const r = allocatePrizes([S('A', 1), S('B', 2), S('C', 3, false)], rs(10000), prizes);
    expect(r.qualificationPool).toBe(rs(7000) + rs(600));
    expect(by(r, 'A').total + by(r, 'B').total).toBe(rs(10000));
  });

  it('a tie for 1st is never decided silently: it is held back with options (split recommended)', () => {
    const a = S('A', 1, true, 400, true), b = S('B', 1, true, 400, true);
    const r = allocatePrizes([a, b, S('C', 3), S('D', 4)], rs(10000), prizes);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ kind: 'TIE_NEEDS_DECISION', places: [1, 2] });
    expect(r.issues[0]!.options!.find((o) => o.recommended)!.resolution).toBe('SPLIT_EQUALLY');
    expect(r.unallocated).toBe(rs(1500) + rs(900));
    expect(by(r, 'C').place).toBe(3); // C keeps 3rd
    const key = r.issues[0]!.groupKey!;
    const s = allocatePrizes([a, b, S('C', 3), S('D', 4)], rs(10000), prizes, [{ groupKey: key, reason: 'Identical on every rule', decision: { resolution: 'SPLIT_EQUALLY' } }]);
    expect(s.issues).toEqual([]);
    expect(by(s, 'A').topThree).toBe(rs(1200));
    expect(by(s, 'B').topThree).toBe(rs(1200));
    const m = allocatePrizes([a, b, S('C', 3), S('D', 4)], rs(10000), prizes, [{ groupKey: key, reason: 'B reached the score first per evidence', decision: { resolution: 'MANUAL_ORDER', order: [b.participantId, a.participantId] } }]);
    expect([by(m, 'B').topThree, by(m, 'A').topThree]).toEqual([rs(1500), rs(900)]);
  });

  it('a tie at 3rd that spills past the prizes shares only the 3rd-place money', () => {
    const c = S('C', 3, true, 300, true), d = S('D', 3, true, 300, true);
    const r = allocatePrizes([S('A', 1), S('B', 2), c, d], rs(10000), prizes);
    const key = r.issues[0]!.groupKey!;
    const s = allocatePrizes([S('A', 1), S('B', 2), c, d], rs(10000), prizes, [{ groupKey: key, reason: 'Fair', decision: { resolution: 'SPLIT_EQUALLY' } }]);
    expect(by(s, 'C').topThree + by(s, 'D').topThree).toBe(rs(600));
  });

  it('nobody qualifies: nothing is invented - the money stays unallocated for an admin decision', () => {
    const r = allocatePrizes([S('A', 1, false), S('B', 2, false)], rs(5000), prizes);
    expect(r.issues.map((i) => i.kind)).toEqual(['NO_QUALIFIERS']);
    expect(r.unallocated).toBe(rs(5000));
  });

  it('proportional sharing by points (other setting); rounding still exact', () => {
    const r = allocatePrizes([S('A', 1, true, 300), S('B', 2, true, 200), S('C', 3, true, 100), S('D', 4, true, 0)], rs(1000.01), { ...prizes, distribution: 'PROPORTIONAL' });
    expect(by(r, 'D').qualification).toBe(0);
    expect(by(r, 'A').qualification).toBeGreaterThan(by(r, 'B').qualification);
    expect(sum(r)).toBe(rs(1000.01));
  });

  it('incomplete prize settings stop the allocation', () => {
    const r = allocatePrizes([S('A', 1)], rs(100), { ...prizes, topThreeSplitPct: null });
    expect(r.issues[0]!.kind).toBe('PRIZE_SETTINGS_INCOMPLETE');
  });
});
