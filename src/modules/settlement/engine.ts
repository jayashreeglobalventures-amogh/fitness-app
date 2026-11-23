// Prize allocation: a PURE function from final standings + the prize pool + the prize settings to each person's prize.
// Amounts are integer paise; every split uses the largest-remainder method, so the parts always add up to the whole.
// Ties that touch a prize place are never resolved silently: they come back as decisions an admin must make.
import type { ChallengeConfig } from '../challenges/config.js';

export interface StandingIn {
  participantId: number; displayName: string; rank: number; tied: boolean; points: number; adherencePct: number | null; eligible: boolean;
  /** Days of the challenge this person took part in, and the challenge's days (for pro-rata prizes); absent = all. */
  daysIn?: number; daysTotal?: number;
}
export type TieResolution = { resolution: 'SPLIT_EQUALLY' } | { resolution: 'MANUAL_ORDER'; order: number[] };
export interface TieDecision { groupKey: string; reason: string; decision: TieResolution }

export interface Allocation { participantId: number; displayName: string; place: number | null; topThree: number; qualification: number; total: number }
export interface Issue { kind: 'TIE_NEEDS_DECISION' | 'NO_QUALIFIERS' | 'PRIZE_SETTINGS_INCOMPLETE'; message: string; groupKey?: string; participants?: number[]; places?: number[]; options?: { resolution: string; explain: string; recommended?: boolean }[] }
export interface PrizeResult { pool: number; topThreePool: number; qualificationPool: number; allocations: Allocation[]; unallocated: number; issues: Issue[]; notes: string[] }

/** Splits `total` paise by weights; integers that add up exactly (largest remainder; ties go to the earlier item). */
export function split(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let rest = total - out.reduce((a, x) => a + x, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k]!.i]! += 1;
  return out;
}

export function allocatePrizes(standings: StandingIn[], pool: number, prizes: ChallengeConfig['prizes'], decisions: TieDecision[] = []): PrizeResult {
  const issues: Issue[] = [];
  const notes: string[] = [];
  const alloc = new Map<number, Allocation>(standings.map((s) => [s.participantId, { participantId: s.participantId, displayName: s.displayName, place: null, topThree: 0, qualification: 0, total: 0 }]));
  if (prizes.qualificationPoolPct === null || prizes.topThreePct === null || prizes.topThreeSplitPct === null || prizes.distribution === null) {
    issues.push({ kind: 'PRIZE_SETTINGS_INCOMPLETE', message: 'The prize split is not fully set in Settings → Prizes.' });
    return { pool, topThreePool: 0, qualificationPool: 0, allocations: [...alloc.values()], unallocated: pool, issues, notes };
  }
  const [topThreePool, qualBase] = split(pool, [prizes.topThreePct, prizes.qualificationPoolPct]) as [number, number];
  let qualificationPool = qualBase;
  const placeMoney = split(topThreePool, prizes.topThreeSplitPct); // [1st, 2nd, 3rd]

  // Who competes for places: only eligible people (NEXT_ELIGIBLE), or everyone (ineligible places' money -> qualifiers).
  const ranked = [...standings].sort((a, b) => a.rank - b.rank || a.participantId - b.participantId);
  const candidates = prizes.topThreeIneligible === 'NEXT_ELIGIBLE' ? ranked.filter((s) => s.eligible) : ranked;
  // Groups of people with the same rank among the candidates, in order.
  const groups: StandingIn[][] = [];
  for (const s of candidates) {
    const g = groups[groups.length - 1];
    if (g && g[0]!.rank === s.rank) g.push(s); else groups.push([s]);
  }
  let place = 1;
  for (const g of groups) {
    if (place > 3) break;
    const places = g.map((_, i) => place + i);
    const prizePlaces = places.filter((p) => p <= 3);
    const money = prizePlaces.reduce((a, p) => a + placeMoney[p - 1]!, 0);
    const give = (s: StandingIn, amount: number, at: number) => {
      if (!s.eligible) { qualificationPool += amount; notes.push(`${s.displayName} (place ${at}) is not eligible: that place's ${rs(amount)} joins the qualification pool.`); return; }
      let paid = amount;
      if (prizes.proRataByDays && s.daysIn !== undefined && s.daysTotal && s.daysIn < s.daysTotal) {
        // Late joiner: the place's money in proportion to the days they took part; the rest joins the qualifiers' pool.
        paid = Math.floor((amount * s.daysIn) / s.daysTotal);
        qualificationPool += amount - paid;
        notes.push(`${s.displayName} took part ${s.daysIn} of ${s.daysTotal} days: place ${at} pays ${rs(paid)} of ${rs(amount)}; ${rs(amount - paid)} joins the qualification pool.`);
      }
      const a = alloc.get(s.participantId)!; a.topThree += paid; a.place = at;
    };
    if (g.length === 1) give(g[0]!, money, place);
    else {
      const key = `tie:${g.map((s) => s.participantId).sort((a, b) => a - b).join('-')}`;
      const d = decisions.find((x) => x.groupKey === key);
      if (!d) {
        issues.push({
          kind: 'TIE_NEEDS_DECISION', groupKey: key, participants: g.map((s) => s.participantId), places: prizePlaces,
          message: `${names(g)} are tied on every ranking rule for place${prizePlaces.length > 1 ? 's' : ''} ${prizePlaces.join(' & ')} (${rs(money)} in total).`,
          options: [
            { resolution: 'SPLIT_EQUALLY', recommended: true, explain: `Share ${rs(money)} equally (${rs(Math.floor(money / g.length))} each): nobody is ranked above the others on any rule, so equal treatment is the fairest default.` },
            { resolution: 'MANUAL_ORDER', explain: 'An admin sets the order (e.g. after a review of evidence); each gets the money of the place they are put in. Record why.' },
          ],
        });
        place += g.length;
        continue;
      }
      if (d.decision.resolution === 'SPLIT_EQUALLY') {
        split(money, g.map(() => 1)).forEach((amt, i) => give(g[i]!, amt, place));
        notes.push(`Tie for place${prizePlaces.length > 1 ? 's' : ''} ${prizePlaces.join(' & ')} shared equally (admin decision: ${d.reason}).`);
      } else {
        const order = d.decision.order.filter((id) => g.some((s) => s.participantId === id));
        if (order.length !== g.length) issues.push({ kind: 'TIE_NEEDS_DECISION', groupKey: key, participants: g.map((s) => s.participantId), places: prizePlaces, message: `The order chosen for ${names(g)} must list each of them once.` });
        else order.forEach((id, i) => { const p = place + i; if (p <= 3) give(g.find((s) => s.participantId === id)!, placeMoney[p - 1]!, p); });
        notes.push(`Tie for places ${prizePlaces.join(' & ')} ordered by an admin (${d.reason}).`);
      }
    }
    place += g.length;
  }
  // Places nobody could take (fewer than three candidates): their money goes to the qualifiers.
  for (let p = place; p <= 3; p++) { qualificationPool += placeMoney[p - 1]!; notes.push(`Place ${p} has no eligible person: its ${rs(placeMoney[p - 1]!)} joins the qualification pool.`); }

  // Qualification pool: everyone eligible, equally or by points.
  const qualifiers = ranked.filter((s) => s.eligible);
  let unallocated = 0;
  if (!qualifiers.length) {
    unallocated = qualificationPool;
    issues.push({ kind: 'NO_QUALIFIERS', message: `Nobody reached ${prizes.qualificationAdherencePct}% adherence: ${rs(qualificationPool)} is not allocated. An admin decides what happens to it (record a reason).` });
  } else {
    const byPoints = prizes.distribution === 'PROPORTIONAL' && qualifiers.some((s) => s.points > 0);
    if (prizes.distribution === 'PROPORTIONAL' && !byPoints) notes.push('No qualifier has positive points, so the qualification pool is shared equally.');
    // Pro-rata: each share is also weighted by the days the person took part (a full-challenge person = a full share).
    const days = (s: StandingIn) => (prizes.proRataByDays && s.daysIn !== undefined && s.daysTotal ? s.daysIn : 1);
    if (prizes.proRataByDays && qualifiers.some((s) => s.daysIn !== undefined && s.daysTotal && s.daysIn < s.daysTotal)) {
      notes.push(`Late joiners share the qualification pool in proportion to the days they took part: ${qualifiers.filter((s) => s.daysIn !== undefined && s.daysTotal && s.daysIn < s.daysTotal).map((s) => `${s.displayName} ${s.daysIn}/${s.daysTotal} days`).join(', ')}.`);
    }
    split(qualificationPool, qualifiers.map((s) => (byPoints ? Math.max(0, s.points) : 1) * days(s))).forEach((amt, i) => { alloc.get(qualifiers[i]!.participantId)!.qualification += amt; });
  }
  // Unresolved ties: their places' money is held back until decided.
  for (const i of issues) if (i.kind === 'TIE_NEEDS_DECISION' && i.places) unallocated += i.places.reduce((a, p) => a + placeMoney[p - 1]!, 0);
  for (const a of alloc.values()) a.total = a.topThree + a.qualification;
  return { pool, topThreePool, qualificationPool, allocations: [...alloc.values()], unallocated, issues, notes };
}

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const names = (g: StandingIn[]) => g.map((s) => s.displayName).join(', ').replace(/, ([^,]*)$/, ' and $1');
