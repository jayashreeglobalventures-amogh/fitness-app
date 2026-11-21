// Challenge Settings: every rule of a challenge, edited section by section. Saves through the same validation as the
// server (errors block, warnings inform). Published challenges: a change becomes a new rules version from a chosen day.
import { useMemo, useState, type ReactNode } from 'react';
import type { ChallengeConfig, ConfigCheck } from '../../../src/modules/challenges/config';
import { api, type Issue, type Me } from '../api';
import { ErrorBox, Field, day } from '../ui';
import { navigate } from '../router';
import type { ChallengeView } from './Challenge';

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const RANKING: Record<string, string> = { POINTS: 'Total points', ADHERENCE: 'Adherence %', SUCCESSFUL_DAYS: 'Successful days', LONGEST_PERSONAL_STREAK: 'Longest personal streak', EARLIEST_FINAL_SCORE: 'Earliest to reach final score' };
const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

type Path = (string | number)[];
const get = (o: unknown, p: Path): unknown => p.reduce<unknown>((x, k) => (x as Record<string | number, unknown>)?.[k], o);
function set<T>(o: T, p: Path, value: unknown): T {
  const copy = structuredClone(o) as Record<string | number, unknown>;
  let cur = copy;
  for (const k of p.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
  cur[p[p.length - 1]!] = value;
  return copy as T;
}

export function SettingsSection({ v, me, onSaved }: { v: ChallengeView; me: Me; onSaved: () => void }) {
  const base = (v.upcoming ?? v.current).config;
  const [c, setC] = useState<ChallengeConfig>(() => structuredClone(base));
  const [reason, setReason] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<{ warnings: Issue[]; versionNo: number } | null>(null);
  const [check, setCheck] = useState<ConfigCheck | null>(v.check ?? null);
  const [busy, setBusy] = useState(false);
  const can = (p: string) => v.myPermissions.includes(p);
  const canEdit = can('challenge.config.edit') && v.status !== 'ARCHIVED';
  const canMoney = canEdit && can('challenge.config.edit_financial');
  const dirty = useMemo(() => JSON.stringify(c) !== JSON.stringify(base), [c, base]);
  const started = v.status === 'PUBLISHED' && v.phase !== 'UPCOMING';
  const errorPaths = new Set((check?.errors ?? []).map((e) => e.path));

  const upd = (p: Path) => (val: unknown) => { setC((x) => set(x, p, val)); setSaved(null); };
  const ctx: Ctx = { c, upd, errorPaths, disabled: !canEdit };
  const money: Ctx = { ...ctx, disabled: !canMoney };

  const validate = async () => setCheck(await api.post<ConfigCheck>('/api/challenges/validate', { config: c }));
  const save = async () => {
    setBusy(true); setError(null); setSaved(null);
    try {
      const body = v.status === 'PUBLISHED' ? { config: c, reason, effectiveFrom: started ? effectiveFrom : undefined } : { config: c };
      const r = await api.put<{ versionNo: number; warnings: Issue[] }>(`/api/challenges/${v.challengeId}/config`, body);
      setSaved(r); setCheck(null); setReason(''); onSaved();
    } catch (e) { setError(e); await validate().catch(() => undefined); } finally { setBusy(false); }
  };

  return (
    <>
      {saved && !dirty && <div className="alert ok">Saved{v.status === 'PUBLISHED' ? ` as rules version ${saved.versionNo}` : ''}.</div>}
      <HeadsUp count={(saved?.warnings ?? check?.warnings ?? v.check?.warnings ?? []).length} />
      {!canEdit && <div className="alert">You can view these settings but not change them.</div>}
      {canEdit && !canMoney && <div className="alert">Money and prize settings can only be changed by a Super Admin.</div>}
      {v.status === 'PUBLISHED' && <div className="alert warn">This challenge is published. Saving creates a new rules version{started ? ' that applies from the day you choose (tomorrow at the earliest)' : ' that applies from the start'}; days already played keep their rules.</div>}

      <Section title="Basics">
        <Text ctx={ctx} p={['basics', 'name']} label="Name" />
        <Area ctx={ctx} p={['basics', 'description']} label="Description" />
        <div className="grid2">
          <Text ctx={ctx} p={['basics', 'category']} label="Category" hint="e.g. WALKING, STRENGTH, TRANSFORMATION" />
          <Text ctx={{ ...ctx, disabled: ctx.disabled || started }} p={['basics', 'timeZone']} label="Time zone" hint="e.g. Asia/Kolkata" />
          <DateIn ctx={{ ...ctx, disabled: ctx.disabled || started }} p={['basics', 'startDate']} label="Start date" />
          <DateIn ctx={ctx} p={['basics', 'endDate']} label="End date" />
        </div>
        <Select ctx={ctx} p={['basics', 'visibility']} label="Who can see it" options={{ INVITED_ONLY: 'Only invited people', ALL_MEMBERS: 'Everyone with an account' }} />
      </Section>

      <Section title="Registration">
        <Select ctx={ctx} p={['registration', 'method']} label="How people join" options={{ INVITE_ONLY: 'Invitation only', OPEN: 'Open', APPROVAL: 'Request + admin approval' }} hint="Open and approval-based joining arrive in a later update; use invitations for now." />
        <div className="grid2">
          <Num ctx={ctx} p={['registration', 'invitationValidDays']} label="Invitation valid for (days)" />
          <NullableNum ctx={ctx} p={['registration', 'maxParticipants']} label="Maximum participants" hint="Empty = no limit" />
          <NullableDate ctx={ctx} p={['registration', 'deadline']} label="Registration deadline" />
        </div>
        <Check ctx={ctx} p={['registration', 'lockRosterAtStart']} label="Lock the roster when the challenge starts (late joins need an admin-approved first day)" />
      </Section>

      <Section title="Activity and daily goal">
        <div className="grid2">
          <Text ctx={ctx} p={['activity', 'label']} label="What is counted" hint="e.g. Steps, Push-ups" />
          <Text ctx={ctx} p={['activity', 'unit']} label="Unit" hint="e.g. steps, reps, km" />
          <Text ctx={ctx} p={['activity', 'metric']} label="Metric key" hint="lowercase, e.g. steps" />
          <Num ctx={ctx} p={['activity', 'dailyTarget']} label="Daily target" />
        </div>
        <Select ctx={{ ...ctx, disabled: ctx.disabled || started }} p={['periods', 'weekStartsOn']} label="Weeks start on" options={Object.fromEntries(WEEKDAYS.map((d) => [d, title(d)]))} />
      </Section>

      <Section title="Evidence and verification">
        <Area ctx={ctx} p={['submission', 'instructions']} label="Instructions shown to participants" />
        <p className="muted small">Deadline: midnight at the end of each day ({c.basics.timeZone}). Late evidence never counts for an earlier day.</p>
        <Select ctx={ctx} p={['verification', 'mode']} label="Screenshot checking" options={{ AI_ASSISTED: 'Read automatically (free on-server reader, or Claude if a key is set); unclear ones go to an admin', MANUAL: 'An admin checks every screenshot' }} />
        <Num ctx={ctx} p={['verification', 'autoApproveMinConfidence']} label="Auto-approve only when the reading is at least this sure (0.5–1)" step={0.01} />
      </Section>

      <Section title="Rest days">
        <Check ctx={ctx} p={['restDays', 'enabled']} label="Allow rest days" />
        {c.restDays.enabled && <div className="grid2">
          <Num ctx={ctx} p={['restDays', 'perPeriod']} label="Per week" />
          <Num ctx={ctx} p={['restDays', 'maxTotal']} label="Maximum in total" />
          <TimeIn ctx={ctx} p={['restDays', 'declareBefore']} label="Declare before (local time, same day)" />
        </div>}
      </Section>

      <Section title="Emergency / sick-day exemptions">
        <Check ctx={ctx} p={['exemptions', 'enabled']} label="Allow exemption requests" />
        {c.exemptions.enabled && (c.exemptions.voting === null ? (
          <div className="stack">
            <p className="muted small">Voting is not set up: every request goes to an admin.</p>
            {canEdit && <button className="btn small" onClick={() => upd(['exemptions', 'voting'])({ requesterMayVote: false, minVotes: 3, approvalThresholdPct: 51, votingHours: 24, adminOverride: true })}>Set up participant voting</button>}
          </div>
        ) : (
          <div>
            <div className="grid2">
              <Num ctx={ctx} p={['exemptions', 'voting', 'minVotes']} label="Minimum votes" />
              <Num ctx={ctx} p={['exemptions', 'voting', 'approvalThresholdPct']} label="Approval threshold (%)" />
              <Num ctx={ctx} p={['exemptions', 'voting', 'votingHours']} label="Voting window (hours)" />
            </div>
            <Check ctx={ctx} p={['exemptions', 'voting', 'requesterMayVote']} label="The requester may vote" />
            <Check ctx={ctx} p={['exemptions', 'voting', 'adminOverride']} label="Admins may override the vote" />
            <p className="muted small">A tie always goes to admin review.</p>
            {canEdit && <button className="btn small ghost" onClick={() => upd(['exemptions', 'voting'])(null)}>Remove voting (admins decide)</button>}
          </div>
        ))}
      </Section>

      <Section title="Points and penalties">
        <div className="grid2">
          <Num ctx={ctx} p={['scoring', 'dailySuccess']} label="Points for reaching the daily goal" />
          <IntList ctx={ctx} p={['scoring', 'personalStreak', 'milestones']} label="Personal streak milestones (days)" hint="e.g. 7, 14, 21" />
          <Num ctx={ctx} p={['scoring', 'personalStreak', 'points']} label="Points per streak milestone" />
        </div>
        <Check ctx={ctx} p={['scoring', 'personalStreak', 'repeatAfterBreak']} label="A new streak after a break earns the milestones again" />
        <Toggle ctx={ctx} p={['scoring', 'teamStreak', 'enabled']} label="Team streak bonus">
          <Num ctx={ctx} p={['scoring', 'teamStreak', 'everyDays']} label="Every N successful team days" />
          <Num ctx={ctx} p={['scoring', 'teamStreak', 'points']} label="Points" />
        </Toggle>
        <Toggle ctx={ctx} p={['scoring', 'comeback', 'enabled']} label="Comeback bonus">
          <Num ctx={ctx} p={['scoring', 'comeback', 'missedDays']} label="After this many missed days in a row" />
          <Select ctx={ctx} p={['scoring', 'comeback', 'missRun']} label="Missed days in a row" options={{ AT_LEAST: 'That many or more', EXACTLY: 'Exactly that many' }} />
          <Num ctx={ctx} p={['scoring', 'comeback', 'recoveryDays']} label="…then this many successful days" />
          <Num ctx={ctx} p={['scoring', 'comeback', 'points']} label="Points" />
          <Num ctx={ctx} p={['scoring', 'comeback', 'maxAwards']} label="At most (times)" />
        </Toggle>
        <Toggle ctx={ctx} p={['scoring', 'weekendBonus', 'enabled']} label="Weekend bonus activity">
          <Num ctx={ctx} p={['scoring', 'weekendBonus', 'points']} label="Points" />
          <Num ctx={ctx} p={['scoring', 'weekendBonus', 'maxPerWeekend']} label="At most per weekend" />
          <Select ctx={ctx} p={['scoring', 'weekendBonus', 'weekend']} label="A weekend is" options={{ SAT_NEXT_SUN: 'Saturday + the next Sunday', SUN_SAT_SAME_WEEK: 'Sunday + Saturday of the same week' }} />
        </Toggle>
        <Toggle ctx={ctx} p={['scoring', 'penalties', 'missedDay', 'enabled']} label="Penalty for every missed day">
          <Num ctx={ctx} p={['scoring', 'penalties', 'missedDay', 'points']} label="Points (negative)" />
        </Toggle>
        <Toggle ctx={ctx} p={['scoring', 'penalties', 'consecutiveMisses', 'enabled']} label="Penalty for missed days in a row">
          <Num ctx={ctx} p={['scoring', 'penalties', 'consecutiveMisses', 'days']} label="Missed days in a row" />
          <Select ctx={ctx} p={['scoring', 'penalties', 'consecutiveMisses', 'repeat']} label="Charged" options={{ ONCE_PER_RUN: 'Once per run', EVERY_NTH: 'Every time the run grows by that many', EVERY_MISS_FROM_NTH: 'On every miss from then on' }} />
          <Num ctx={ctx} p={['scoring', 'penalties', 'consecutiveMisses', 'points']} label="Points (negative)" />
        </Toggle>
        <Toggle ctx={ctx} p={['scoring', 'penalties', 'teamStreakBreak', 'enabled']} label="Penalty for breaking the team streak">
          <Select ctx={ctx} p={['scoring', 'penalties', 'teamStreakBreak', 'when']} label="Charged" options={{ RUNNING_STREAK_ONLY: 'Only when a running team streak ends', EVERY_MISS: 'On every miss, even at 0' }} />
          <Num ctx={ctx} p={['scoring', 'penalties', 'teamStreakBreak', 'points']} label="Points (negative)" />
        </Toggle>
        <p className="muted small">Penalties that are switched on add up on the same missed day.</p>
      </Section>

      <Section title="Money" locked={!canMoney}>
        <Check ctx={money} p={['finance', 'enabled']} label="This challenge has contributions and fines" />
        {c.finance.enabled && (<>
          <div className="grid2">
            <Rupees ctx={money} p={['finance', 'contribution', 'total']} label="Weekly contribution (₹)" />
            <Rupees ctx={money} p={['finance', 'contribution', 'mainPool']} label="…to the prize pool (₹)" />
            <Rupees ctx={money} p={['finance', 'contribution', 'finePool']} label="…to the fine pool (₹)" />
            <Rupees ctx={money} p={['finance', 'finePerMissedDay']} label="Fine per missed day (₹)" />
            <Select ctx={money} p={['finance', 'dueWeekday']} label="Due every" options={Object.fromEntries(WEEKDAYS.map((d) => [d, title(d)]))} />
            <Num ctx={money} p={['finance', 'graceDays']} label="Grace days before 'overdue'" />
            <Select ctx={money} p={['finance', 'unusedFinePool']} label="Fine-pool money left at the end of a week" options={{ CARRY_FORWARD: 'Carried to next week (they pay only the top-up)', REFUND: 'Refunded to the participant at the end', PRIZE_POOL: 'Goes to the prize pool', YEAR_END_POOL: 'Goes to a separate year-end pool' }}
              hint={get(c, ['finance', 'unusedFinePool']) === 'CARRY_FORWARD' ? 'E.g. ₹600 fine pool, 3 misses at ₹100: ₹300 carries over, so next week they pay ₹400 + ₹300 = ₹700. What is left after the last week is refunded.' : undefined} />
          </div>
          <h3 style={{ marginTop: 8 }}>Weeks with a different amount</h3>
          {c.finance.periodOverrides.map((o, i) => {
            const p = (check ?? v.check)?.periods.find((x) => x.periodNo === o.periodNo);
            return (
              <div key={i} className="card" style={{ background: 'var(--surface-2)' }}>
                <div className="spread"><b>Week {o.periodNo}{p ? ` · ${day(p.startsOn)} – ${day(p.endsOn)} (${p.days} days)` : ''}</b>
                  {canMoney && <button className="btn small ghost danger" onClick={() => upd(['finance', 'periodOverrides'])(c.finance.periodOverrides.filter((_, j) => j !== i))}>Remove</button>}</div>
                <div className="grid2">
                  <Num ctx={money} p={['finance', 'periodOverrides', i, 'periodNo']} label="Week number" />
                  <Rupees ctx={money} p={['finance', 'periodOverrides', i, 'total']} label="Contribution (₹)" />
                  <Rupees ctx={money} p={['finance', 'periodOverrides', i, 'mainPool']} label="To prize pool (₹)" />
                  <Rupees ctx={money} p={['finance', 'periodOverrides', i, 'finePool']} label="To fine pool (₹)" />
                </div>
              </div>
            );
          })}
          {canMoney && <button className="btn small" onClick={() => upd(['finance', 'periodOverrides'])([...c.finance.periodOverrides, { periodNo: 1, ...c.finance.contribution }])}>Add a week with a different amount</button>}
          <Area ctx={money} p={['finance', 'paymentInstructions']} label="Payment instructions" />
          <p className="muted small">The UPI ID and QR code are set by the Finance Admin in the challenge's Money tab.</p>
        </>)}
      </Section>

      <Section title="Prizes" locked={!canMoney}>
        <div className="grid2">
          <Num ctx={money} p={['prizes', 'qualificationAdherencePct']} label="Minimum adherence to qualify (%)" />
          <NullableNum ctx={money} p={['prizes', 'qualificationPoolPct']} label="Qualification pool (% of prize pool)" />
          <NullableNum ctx={money} p={['prizes', 'topThreePct']} label="Top-three bonus (% of prize pool)" />
          <NullableDate ctx={money} p={['prizes', 'payoutDate']} label="Payout date" />
        </div>
        <SplitIn ctx={money} />
        <Select ctx={money} p={['prizes', 'distribution']} label="Qualification pool shared" options={{ '': 'Not decided yet', EQUAL: 'Equally', PROPORTIONAL: 'In proportion to points' }} nullable />
        <Select ctx={money} p={['prizes', 'topThreeIneligible']} label="If a top-three person isn't eligible" options={{ NEXT_ELIGIBLE: 'The next eligible person moves up', TO_QUALIFICATION_POOL: 'That place\'s money joins the qualification pool' }} />
      </Section>

      <Section title="Community">
        <Check ctx={ctx} p={['community', 'enabled']} label="Community feed for this challenge (announcements, posts, comments, reactions)" />
        {c.community.enabled && (<>
          <Check ctx={ctx} p={['community', 'participantsCanPost']} label="Participants can post (otherwise only admins post; everyone can react and comment)" />
          <Check ctx={ctx} p={['community', 'photos']} label="Photos allowed in posts" />
        </>)}
      </Section>

      <Section title="Coach">
        <Check ctx={ctx} p={['coach', 'weeklySummary']} label="Weekly summary for each participant after every challenge week" />
        <Check ctx={ctx} p={['coach', 'eveningNudge']} label="Evening nudge if today's steps aren't in yet" />
        {c.coach.eveningNudge && <Text ctx={ctx} p={['coach', 'nudgeTime']} label="Nudge time (24-hour, local)" hint="e.g. 20:00. Phone notifications are never sent between 11 pm and 7 am." />}
        <Check ctx={ctx} p={['coach', 'atRiskAlerts']} label="Tell admins who might need a hand (misses in a row, below the prize line)" />
      </Section>

      <Section title="Leaderboard">
        <p className="muted small">Ranking order: ties are broken by the next item. A tie that remains is decided by an admin, with a recorded reason.</p>
        <Ranking ctx={ctx} />
      </Section>

      {canEdit && dirty && (
        // Shown only while there are unsaved changes; it sits just above the bottom tabs.
        <div className="savebar" role="region" aria-label="Unsaved changes">
          <ErrorBox error={error} />
          {check && !check.ok && !error && <ErrorBox error={{ message: 'Fix these before saving:', details: { errors: check.errors } }} />}
          {v.status === 'PUBLISHED' && (
            <div className="grid2">
              <Field label="Reason for the change"><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Shown in the audit history" /></Field>
              {started && <Field label="New rules apply from"><input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>}
            </div>
          )}
          <div className="spread">
            <span className="muted small">Unsaved changes</span>
            <div className="row">
              <button className="btn ghost small" onClick={() => { setC(structuredClone(base)); setCheck(v.check ?? null); setError(null); }}>Discard</button>
              <button className="btn primary small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button>
            </div>
          </div>
        </div>
      )}
      {v.versions && v.versions.length > 1 && (
        <details className="card"><summary>Rules history ({v.versions.length} versions)</summary>
          <div className="table-wrap"><table><thead><tr><th>Version</th><th>Applies from</th><th>Reason</th><th>Saved</th></tr></thead>
            <tbody>{v.versions.map((x) => <tr key={x.versionNo}><td>{x.versionNo}</td><td>{day(x.effectiveFrom)}</td><td>{x.reason ?? ''}</td><td>{new Date(x.createdAt).toLocaleString('en-IN')}</td></tr>)}</tbody></table></div>
        </details>
      )}
    </>
  );
}

// ---------- form pieces bound to a path in the config ----------
interface Ctx { c: ChallengeConfig; upd: (p: Path) => (v: unknown) => void; errorPaths: Set<string>; disabled: boolean }
const bad = (ctx: Ctx, p: Path) => ctx.errorPaths.has('/' + p.join('/'));
const style = (ctx: Ctx, p: Path) => (bad(ctx, p) ? { borderColor: 'var(--danger)' } : undefined);

function Section({ title: t, children, locked }: { title: string; children: ReactNode; locked?: boolean }) {
  return <details className="card" open><summary>{t}{locked ? ' 🔒' : ''}</summary>{children}</details>;
}
function Text({ ctx, p, label, hint }: { ctx: Ctx; p: Path; label: string; hint?: string }) {
  return <Field label={label} hint={hint}><input type="text" style={style(ctx, p)} disabled={ctx.disabled} value={String(get(ctx.c, p) ?? '')} onChange={(e) => ctx.upd(p)(e.target.value)} /></Field>;
}
function Area({ ctx, p, label }: { ctx: Ctx; p: Path; label: string }) {
  return <Field label={label}><textarea style={style(ctx, p)} disabled={ctx.disabled} value={String(get(ctx.c, p) ?? '')} onChange={(e) => ctx.upd(p)(e.target.value)} /></Field>;
}
function Num({ ctx, p, label, hint, step }: { ctx: Ctx; p: Path; label: string; hint?: string; step?: number }) {
  const v = get(ctx.c, p) as number;
  return <Field label={label} hint={hint}><input type="number" inputMode="decimal" step={step ?? 1} style={style(ctx, p)} disabled={ctx.disabled} value={Number.isFinite(v) ? v : ''} onChange={(e) => ctx.upd(p)(e.target.value === '' ? NaN : Number(e.target.value))} /></Field>;
}
function NullableNum({ ctx, p, label, hint }: { ctx: Ctx; p: Path; label: string; hint?: string }) {
  const v = get(ctx.c, p) as number | null;
  return <Field label={label} hint={hint ?? 'Empty = not decided yet'}><input type="number" inputMode="decimal" style={style(ctx, p)} disabled={ctx.disabled} value={v ?? ''} onChange={(e) => ctx.upd(p)(e.target.value === '' ? null : Number(e.target.value))} /></Field>;
}
function Rupees({ ctx, p, label }: { ctx: Ctx; p: Path; label: string }) {
  const paise = get(ctx.c, p) as number;
  return <Field label={label}><input type="number" inputMode="decimal" step="0.01" min="0" style={style(ctx, p)} disabled={ctx.disabled} value={Number.isFinite(paise) ? paise / 100 : ''} onChange={(e) => ctx.upd(p)(e.target.value === '' ? NaN : Math.round(Number(e.target.value) * 100))} /></Field>;
}
function DateIn({ ctx, p, label }: { ctx: Ctx; p: Path; label: string }) {
  return <Field label={label}><input type="date" style={style(ctx, p)} disabled={ctx.disabled} value={String(get(ctx.c, p) ?? '')} onChange={(e) => ctx.upd(p)(e.target.value)} /></Field>;
}
function NullableDate({ ctx, p, label }: { ctx: Ctx; p: Path; label: string }) {
  return <Field label={label} hint="Empty = none"><input type="date" style={style(ctx, p)} disabled={ctx.disabled} value={String(get(ctx.c, p) ?? '')} onChange={(e) => ctx.upd(p)(e.target.value || null)} /></Field>;
}
function TimeIn({ ctx, p, label }: { ctx: Ctx; p: Path; label: string }) {
  return <Field label={label}><input type="time" style={style(ctx, p)} disabled={ctx.disabled} value={String(get(ctx.c, p) ?? '')} onChange={(e) => ctx.upd(p)(e.target.value)} /></Field>;
}
function Select({ ctx, p, label, options, hint, nullable }: { ctx: Ctx; p: Path; label: string; options: Record<string, string>; hint?: string; nullable?: boolean }) {
  return <Field label={label} hint={hint}><select style={style(ctx, p)} disabled={ctx.disabled} value={String(get(ctx.c, p) ?? '')} onChange={(e) => ctx.upd(p)(nullable && e.target.value === '' ? null : e.target.value)}>
    {Object.entries(options).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>;
}
function Check({ ctx, p, label }: { ctx: Ctx; p: Path; label: string }) {
  return <label className="check"><input type="checkbox" disabled={ctx.disabled} checked={get(ctx.c, p) === true} onChange={(e) => ctx.upd(p)(e.target.checked)} /><span>{label}</span></label>;
}
function Toggle({ ctx, p, label, children }: { ctx: Ctx; p: Path; label: string; children: ReactNode }) {
  return <div className="section"><Check ctx={ctx} p={p} label={label} />{get(ctx.c, p) === true && <div className="grid2">{children}</div>}</div>;
}
function IntList({ ctx, p, label, hint }: { ctx: Ctx; p: Path; label: string; hint?: string }) {
  const list = get(ctx.c, p) as number[];
  const [text, setText] = useState(list.join(', '));
  return <Field label={label} hint={hint}><input type="text" style={style(ctx, p)} disabled={ctx.disabled} value={text}
    onChange={(e) => { setText(e.target.value); ctx.upd(p)(e.target.value.split(/[,\s]+/).filter(Boolean).map(Number)); }} /></Field>;
}
function SplitIn({ ctx }: { ctx: Ctx }) {
  const p: Path = ['prizes', 'topThreeSplitPct'];
  const v = get(ctx.c, p) as [number, number, number] | null;
  const setAt = (i: number, val: string) => {
    const next: [number, number, number] = v ? [...v] : [0, 0, 0];
    next[i] = Number(val);
    ctx.upd(p)(next);
  };
  return (
    <div>
      <div className="grid2">
        {['1st place (%)', '2nd place (%)', '3rd place (%)'].map((l, i) => (
          <Field key={l} label={l}><input type="number" style={style(ctx, p)} disabled={ctx.disabled} value={v ? v[i] : ''} placeholder="not decided" onChange={(e) => setAt(i, e.target.value)} /></Field>
        ))}
      </div>
      {v && !ctx.disabled && <button className="btn small ghost" onClick={() => ctx.upd(p)(null)}>Clear the 1st/2nd/3rd split</button>}
    </div>
  );
}
function Ranking({ ctx }: { ctx: Ctx }) {
  const list = ctx.c.leaderboard.ranking;
  const move = (i: number, d: number) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    ctx.upd(['leaderboard', 'ranking'])(next);
  };
  return (
    <ol style={{ paddingLeft: 20 }}>
      {list.map((k, i) => (
        <li key={k} style={{ marginBottom: 6 }}>
          <span className="spread"><span>{RANKING[k] ?? k}</span>
            {!ctx.disabled && <span className="row" style={{ gap: 4 }}>
              <button className="btn small ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
              <button className="btn small ghost" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
            </span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One quiet line instead of a floating box: the details are in Notifications. */
export function HeadsUp({ count }: { count: number }) {
  if (!count) return null;
  return (
    <p className="small muted" style={{ margin: '0 0 12px' }}>
      ⓘ {count} heads-up{count === 1 ? '' : 's'} about these settings (e.g. rules not decided yet). <a href="/notifications" onClick={(e) => { e.preventDefault(); navigate('/notifications'); }}>See notifications</a>
    </p>
  );
}
