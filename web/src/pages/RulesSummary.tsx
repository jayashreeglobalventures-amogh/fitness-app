// The rules in plain language, generated from the challenge's settings (so every challenge explains itself).
import type { ChallengeConfig } from '../../../src/modules/challenges/config';
import { day, rupees } from '../ui';

const pts = (n: number) => `${n > 0 ? '+' : ''}${n} point${Math.abs(n) === 1 ? '' : 's'}`;
const wd = (d: string) => d.charAt(0) + d.slice(1).toLowerCase();

export function RulesSummary({ c, periods }: { c: ChallengeConfig; periods?: { periodNo: number; startsOn: string; endsOn: string; days: number }[] }) {
  const s = c.scoring;
  const f = c.finance;
  const target = `${c.activity.dailyTarget.toLocaleString('en-IN')} ${c.activity.unit}`;
  return (
    <div className="rules">
      <h3>Daily goal</h3>
      <ul>
        <li>Reach <b>{target}</b> every day from {day(c.basics.startDate)} to {day(c.basics.endDate)} ({c.basics.timeZone}).</li>
        <li>{c.submission.instructions}</li>
        <li>Evidence must be submitted in this app before midnight. Late evidence never counts for an earlier day; no evidence means a missed day.</li>
      </ul>
      {c.restDays.enabled && (<>
        <h3>Rest days</h3>
        <ul>
          <li>{c.restDays.perPeriod} rest day per week (weeks start on {wd(c.periods.weekStartsOn)}), at most {c.restDays.maxTotal} in total.</li>
          <li>Declare it in the app before {c.restDays.declareBefore} on the day. No evidence, fine or points; your streak pauses.</li>
        </ul>
      </>)}
      {c.exemptions.enabled && (<>
        <h3>Emergency or sick days</h3>
        <ul>
          <li>Request an exemption in the app with a reason. {c.exemptions.voting ? `Participants vote (approval needs ${c.exemptions.voting.approvalThresholdPct}% within ${c.exemptions.voting.votingHours} hours); a tie goes to the admins.` : 'An admin reviews each request.'}</li>
          <li>An approved exemption has no fine and no points, pauses your streak and does not use your rest day.</li>
        </ul>
      </>)}
      <h3>Points</h3>
      <ul>
        <li>Daily goal reached: {pts(s.dailySuccess)}.</li>
        {s.personalStreak.milestones.length > 0 && <li>Personal streak of {s.personalStreak.milestones.join(', ')} days: {pts(s.personalStreak.points)} each.</li>}
        {s.teamStreak.enabled && <li>Every {s.teamStreak.everyDays}th day in a row that everyone succeeds: {pts(s.teamStreak.points)}.</li>}
        {s.personalStreak.milestones.length > 0 && s.personalStreak.repeatAfterBreak && <li>A new streak after a break earns the milestones again.</li>}
        {s.comeback.enabled && <li>Comeback ({s.comeback.missRun === 'AT_LEAST' ? `${s.comeback.missedDays} or more` : `exactly ${s.comeback.missedDays}`} missed days in a row, then {s.comeback.recoveryDays} successful days): {pts(s.comeback.points)}, at most {s.comeback.maxAwards} times.</li>}
        {s.weekendBonus.enabled && <li>Optional weekend bonus activity ({s.weekendBonus.weekend === 'SAT_NEXT_SUN' ? 'Saturday + Sunday' : 'Sunday or Saturday of the week'}): {pts(s.weekendBonus.points)}, at most {s.weekendBonus.maxPerWeekend} per weekend. It does not replace the daily goal.</li>}
        {s.penalties.missedDay.enabled && <li>Every missed day (no evidence, below target or rejected): {pts(s.penalties.missedDay.points)}.</li>}
        {s.penalties.consecutiveMisses.enabled && <li>{s.penalties.consecutiveMisses.days} missed days in a row: {pts(s.penalties.consecutiveMisses.points)} ({s.penalties.consecutiveMisses.repeat === 'ONCE_PER_RUN' ? 'once per run' : s.penalties.consecutiveMisses.repeat === 'EVERY_NTH' ? `every ${s.penalties.consecutiveMisses.days} misses` : 'on every further miss'}).</li>}
        {s.penalties.teamStreakBreak.enabled && <li>Breaking the team streak: {pts(s.penalties.teamStreakBreak.points)} (only for whoever missed{s.penalties.teamStreakBreak.when === 'EVERY_MISS' ? ', on every miss' : ''}).</li>}
        {s.teamStreak.enabled && <li>Rest days and approved exemptions count as successful team days.</li>}
      </ul>
      {f.enabled && (<>
        <h3>Money</h3>
        <ul>
          <li>Weekly contribution {rupees(f.contribution.total)}, due every {wd(f.dueWeekday)}: {rupees(f.contribution.mainPool)} to the prize pool and {rupees(f.contribution.finePool)} to your fine pool.</li>
          {f.periodOverrides.map((o) => {
            const p = periods?.find((x) => x.periodNo === o.periodNo);
            return <li key={o.periodNo}>Week {o.periodNo}{p ? ` (${day(p.startsOn)} – ${day(p.endsOn)})` : ''}: {rupees(o.total)} ({rupees(o.mainPool)} + {rupees(o.finePool)}).</li>;
          })}
          <li>Each missed day takes {rupees(f.finePerMissedDay)} from your fine pool (never more than what's in it) and moves it to the prize pool. Rest days and approved exemptions cost nothing.</li>
          <li>Money left in your fine pool at the end of each week {f.unusedFinePool === 'REFUND' ? 'is refunded to you (paid out at the end of the challenge)' : f.unusedFinePool === 'PRIZE_POOL' ? 'goes to the prize pool' : 'goes to a separate year-end pool'}.</li>
          <li>A contribution not paid within {f.graceDays} day{f.graceDays === 1 ? '' : 's'} of the due day is shown as overdue. Payments never affect your points.</li>
          {f.paymentInstructions && <li>{f.paymentInstructions}</li>}
        </ul>
      </>)}
      <h3>Prizes</h3>
      <ul>
        <li>To qualify for prizes you need at least {c.prizes.qualificationAdherencePct}% of your eligible days successful (rest and approved exemption days don't count against you).</li>
        {c.prizes.payoutDate && <li>Planned payout: {day(c.prizes.payoutDate)}, after an admin approves the final results.</li>}
      </ul>
    </div>
  );
}
