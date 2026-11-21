// In-app notifications, worked out from the live data each time they are read (nothing to go stale):
// what needs the person's attention, with a link to where they act on it. Admin items only for what they may do.
import type { Queryable } from '../../core/db.js';
import { daysBetween, endOfDay, localDay } from '../../core/dates.js';
import { latestVersion } from '../challenges/challenges.js';
import { validateConfig } from '../challenges/config.js';
import { accessFor } from '../identity/permissions.js';
import { addDays, computePeriods } from '../../core/dates.js';
import { contributionFor } from '../challenges/config.js';
import { carriedInto, dueOn } from '../finance/finance.js';
import { coachNotices } from '../coach/coach.js';

export interface Notice {
  id: string;                    // stable, for "seen" state in the app
  kind: 'action' | 'info' | 'warning';
  title: string;
  body: string;
  link: string;
  challengeId: number | null;
  count?: number;
  /** Identifies this notification as it is now (a new count makes it new again). */
  seenKey?: string;
  /** Already seen by this person (opening Notifications marks everything listed as seen). */
  seen?: boolean;
  /** false: in the app only, never sent to the phone (e.g. the plain daily check-in reminder that appears at midnight). */
  push?: boolean;
}

export async function myNotifications(db: Queryable, userId: number, now: Date): Promise<Notice[]> {
  const out: Notice[] = [];
  const isSuper = (await accessFor(db, userId, null)).platformRoles.includes('SUPER_ADMIN');

  // Invitations.
  const inv = await db.query(
    `SELECT i.invitation_id, c.challenge_id, c.name FROM invitations i JOIN challenges c USING (challenge_id)
      WHERE i.user_id = $1 AND i.status = 'INVITED' AND i.expires_at > $2 AND c.status = 'PUBLISHED'`, [userId, now]);
  for (const r of inv.rows) out.push({ id: `inv:${r.invitation_id}`, kind: 'action', title: `You're invited to ${r.name}`, body: 'Read the rules and accept to join.', link: `/challenges/${r.challenge_id}/overview`, challengeId: Number(r.challenge_id) });

  // A finance-manager handover waiting for me to accept.
  const ho = await db.query(`SELECT h.handover_id, c.name, c.challenge_id FROM finance_handovers h JOIN challenges c USING (challenge_id) WHERE h.to_user_id = $1 AND h.status = 'PENDING'`, [userId]);
  for (const r of ho.rows) out.push({ id: `handover:${r.handover_id}`, kind: 'action', title: `${r.name}: you're being made finance manager`, body: 'Confirm the amount you received and that the accounts are settled.', link: `/finance-handover/${r.handover_id}`, challengeId: Number(r.challenge_id) });

  // Challenges I take part in or administer.
  const { rows: chs } = await db.query(
    `SELECT c.*, p.participant_id, p.status AS p_status, p.joined_on, p.left_on
       FROM challenges c LEFT JOIN participants p ON p.challenge_id = c.challenge_id AND p.user_id = $1
      WHERE c.status <> 'ARCHIVED' AND (p.participant_id IS NOT NULL OR $2::boolean OR EXISTS (SELECT 1 FROM challenge_roles r WHERE r.challenge_id = c.challenge_id AND r.user_id = $1))
      ORDER BY c.starts_on`, [userId, isSuper]);
  for (const c of chs) {
    const cid = Number(c.challenge_id);
    const today = localDay(now, c.time_zone);
    const live = c.status === 'PUBLISHED' && daysBetween(c.starts_on, today) >= 0 && daysBetween(today, c.ends_on) >= 0;

    let notSubmittedToday = false;
    let todayNotice: Notice | null = null;
    // As a participant: today's check-in, votes waiting for me.
    if (c.participant_id && c.p_status === 'ACTIVE' && live && daysBetween(c.joined_on, today) >= 0 && (!c.left_on || daysBetween(today, c.left_on) >= 0)) {
      const { rows: [t] } = await db.query(
        `SELECT coalesce((SELECT status FROM submissions WHERE participant_id = $1 AND day = $2 AND status NOT IN ('SUPERSEDED','WITHDRAWN') AND NOT part),
                         (SELECT 'PARTS' FROM submissions WHERE participant_id = $1 AND day = $2 AND part AND status NOT IN ('REJECTED','WITHDRAWN') LIMIT 1)) AS sub,
                EXISTS (SELECT 1 FROM rest_days WHERE participant_id = $1 AND day = $2 AND cancelled_at IS NULL) AS rest,
                EXISTS (SELECT 1 FROM exemption_requests WHERE participant_id = $1 AND status = 'APPROVED' AND $2::date BETWEEN start_day AND end_day) AS excused`,
        [c.participant_id, today]);
      if (!t.sub && !t.rest && !t.excused) {
        notSubmittedToday = true;
        const left = Math.max(0, Math.round((endOfDay(today, c.time_zone).getTime() - now.getTime()) / 3_600_000));
        // In the app only: it appears at midnight. The coach's evening nudge (below) is what goes to the phone.
        todayNotice = { id: `today:${cid}:${today}`, kind: 'action', title: `${c.name}: today's check-in`, body: `Upload today's screenshot before midnight (about ${left} h left).`, link: `/challenges/${cid}/today`, challengeId: cid, push: false };
      } else if (t.sub === 'BELOW_TARGET' || t.sub === 'REJECTED') {
        out.push({ id: `todaybad:${cid}:${today}`, kind: 'warning', title: `${c.name}: today's evidence wasn't accepted`, body: 'You can upload new evidence until midnight.', link: `/challenges/${cid}/today`, challengeId: cid });
      }
      const votes = await db.query(
        `SELECT r.request_id, u.display_name FROM exemption_requests r JOIN participants p USING (participant_id) JOIN users u ON u.user_id = p.user_id
          WHERE r.challenge_id = $1 AND r.status = 'VOTING' AND r.voting_closes_at > $3 AND $2 = ANY (r.eligible_voters)
            AND NOT EXISTS (SELECT 1 FROM exemption_votes v WHERE v.request_id = r.request_id AND v.voter_participant_id = $2)`, [cid, c.participant_id, now]);
      for (const v of votes.rows) out.push({ id: `vote:${v.request_id}`, kind: 'action', title: `${c.name}: vote on ${v.display_name}'s exemption`, body: 'Your vote is needed before voting closes.', link: `/challenges/${cid}/exemptions`, challengeId: cid });
    }

    // Community: new announcements (last 7 days) and comments on my posts (last 7 days), for members.
    if (c.participant_id || isSuper) {
      const ann = await db.query(
        `SELECT p.post_id, left(p.body, 120) AS body, u.display_name FROM posts p JOIN users u ON u.user_id = p.author_user_id
          WHERE p.challenge_id = $1 AND p.kind = 'ANNOUNCEMENT' AND p.status = 'VISIBLE' AND p.created_at > $2::timestamptz - interval '7 days' AND p.author_user_id <> $3
          ORDER BY p.post_id DESC LIMIT 5`, [cid, now, userId]);
      for (const a of ann.rows) out.push({ id: `ann:${a.post_id}`, kind: 'info', title: `${c.name}: announcement from ${a.display_name}`, body: a.body, link: `/community/${cid}`, challengeId: cid });
    }
    {
      const { rows: [cm] } = await db.query(
        `SELECT count(*)::int AS n FROM comments k JOIN posts p USING (post_id)
          WHERE p.challenge_id = $1 AND p.author_user_id = $2 AND k.author_user_id <> $2 AND k.status = 'VISIBLE' AND k.created_at > $3::timestamptz - interval '7 days'`, [cid, userId, now]);
      if (cm.n) out.push({ id: `comments:${cid}`, kind: 'info', title: `${c.name}: comments on your posts`, body: `${cm.n} in the last week.`, link: `/community/${cid}`, challengeId: cid, count: cm.n });
    }

    // As a participant: contributions due or overdue (money only; it never affects points).
    if (c.participant_id && c.status === 'PUBLISHED') {
      const cfg = (await latestVersion(db, cid)).config;
      if (cfg.finance.enabled) {
        const periods = computePeriods(c.starts_on, c.ends_on, cfg.periods.weekStartsOn);
        const { rows: pays } = await db.query(`SELECT period_no, status, amount_paise FROM payments WHERE participant_id = $1 AND status IN ('SUBMITTED','CONFIRMED')`, [c.participant_id]);
        const carried = await carriedInto(db, cid, Number(c.participant_id));
        let credit = 0; // reported beyond what earlier weeks needed (e.g. paid in full before a carry-over)
        for (const per of periods) {
          if (daysBetween(c.joined_on, per.endsOn) < 0 || (c.left_on && daysBetween(per.startsOn, c.left_on) < 0)) continue;
          // Owed: the contribution less fine-pool money carried over from the week before (CARRY_FORWARD).
          const amount = Math.max(0, contributionFor(cfg, per.periodNo).total - (carried.into.get(per.periodNo) ?? 0));
          const here = pays.filter((x) => x.period_no === per.periodNo).reduce((a, x) => a + Number(x.amount_paise), 0);
          const used = Math.min(credit, amount);
          const reported = here + used;
          credit = credit - used + Math.max(0, here - (amount - used));
          const due = dueOn(per, cfg.finance.dueWeekday);
          if (daysBetween(due, today) < 0) continue;
          if (reported >= amount) continue;
          const overdue = daysBetween(addDays(due, cfg.finance.graceDays + 1), today) >= 0;
          out.push({ id: `pay:${cid}:${per.periodNo}`, kind: overdue ? 'warning' : 'action', title: `${c.name}: week ${per.periodNo} contribution ${overdue ? 'overdue' : 'due'}`,
            body: `₹${((amount - reported) / 100).toLocaleString('en-IN')} — pay by UPI, then enter the UTR in the app.`, link: `/challenges/${cid}/money`, challengeId: cid });
        }
      }
    }

    // As an admin: what waits for me (only what my role may do).
    const access = await accessFor(db, userId, cid);
    const can = (p: string) => access.permissions.has(p as never);

    // The coach: evening nudge (replaces the plain check-in reminder), weekly summary, who might need a hand.
    if (c.status === 'PUBLISHED' && (c.participant_id || can('roster.manage'))) {
      const coach = await coachNotices(db, userId, cid, { participantId: c.participant_id && c.p_status === 'ACTIVE' ? Number(c.participant_id) : null,
        canManageRoster: can('roster.manage'), notSubmittedToday }, now);
      out.push(...coach.notices);
      if (todayNotice && !coach.nudged) out.push(todayNotice);
    } else if (todayNotice) out.push(todayNotice);

    if (!can('challenge.view_admin')) continue;
    if (can('challenge.config.edit')) {
      const check = validateConfig((await latestVersion(db, cid)).config);
      for (const e of check.errors) out.push({ id: `cfgerr:${cid}:${e.path}`, kind: 'warning', title: `${c.name} settings: needs fixing`, body: e.message, link: `/challenges/${cid}/settings`, challengeId: cid });
      for (const w of check.warnings) out.push({ id: `cfgwarn:${cid}:${w.path}`, kind: 'info', title: `${c.name} settings: heads-up`, body: w.message, link: `/challenges/${cid}/settings`, challengeId: cid });
    }
    if (can('challenge.roles.manage')) {
      const n = Number((await db.query(`SELECT count(*)::int AS n FROM challenge_roles WHERE challenge_id = $1 AND role = 'CHALLENGE_ADMIN'`, [cid])).rows[0].n);
      if (n < 2) out.push({ id: `admins:${cid}`, kind: 'warning', title: `${c.name}: needs at least 2 admins`, body: `It has ${n}. Add admins so nothing depends on one person${c.status === 'DRAFT' ? ' (needed before publishing)' : ''}.`, link: `/challenges/${cid}/admins`, challengeId: cid });
      const cfgF = (await latestVersion(db, cid)).config.finance.enabled;
      const fm = await db.query(`SELECT 1 FROM challenge_roles WHERE challenge_id = $1 AND role = 'FINANCE_ADMIN'`, [cid]);
      if (cfgF && !fm.rows[0]) out.push({ id: `nofm:${cid}`, kind: 'warning', title: `${c.name}: no finance manager`, body: 'Appoint one in the Admins tab.', link: `/challenges/${cid}/admins`, challengeId: cid });
    }
    if (can('finance.settings')) {
      const ps = await db.query(`SELECT needs_update FROM payment_settings WHERE challenge_id = $1`, [cid]);
      if (ps.rows[0]?.needs_update) out.push({ id: `paydetails:${cid}`, kind: 'action', title: `${c.name}: add your payment details`, body: 'You are the new finance manager: enter your UPI ID and QR code so participants can pay you.', link: `/challenges/${cid}/money`, challengeId: cid });
    }
    if (c.status === 'DRAFT' && can('challenge.publish')) out.push({ id: `draft:${cid}`, kind: 'info', title: `${c.name} is a draft`, body: 'Check the settings, then publish it to start inviting people.', link: `/challenges/${cid}/overview`, challengeId: cid });
    if (c.status !== 'PUBLISHED') continue;
    const { rows: [w] } = await db.query(
      `SELECT (SELECT count(*) FROM submissions s JOIN participants p USING (participant_id) WHERE s.challenge_id = $1 AND p.user_id <> $2
                 AND (s.status = 'PENDING_REVIEW' OR (s.status = 'PENDING_AI' AND s.created_at < $3::timestamptz - interval '5 minutes')))::int AS reviews,
              (SELECT count(*) FROM exemption_requests r JOIN participants p USING (participant_id) WHERE r.challenge_id = $1 AND r.status = 'ADMIN_REVIEW' AND p.user_id <> $2)::int AS exemptions,
              (SELECT count(*) FROM bonus_submissions s JOIN bonus_activities a USING (activity_id) JOIN participants p ON p.participant_id = s.participant_id
                 WHERE a.challenge_id = $1 AND s.status = 'PENDING' AND p.user_id <> $2)::int AS bonuses`, [cid, userId, now]);
    if (w.reviews && can('submissions.review')) out.push({ id: `reviews:${cid}`, kind: 'action', title: `${c.name}: screenshots to review`, body: `${w.reviews} waiting for a decision.`, link: `/challenges/${cid}/review`, challengeId: cid, count: w.reviews });
    if (can('submissions.review')) {
      const { rows: [er] } = await db.query(`SELECT count(*)::int AS n FROM evidence_requests WHERE challenge_id = $1 AND status = 'PENDING'`, [cid]);
      if (er.n) out.push({ id: `evreq:${cid}`, kind: 'action', title: `${c.name}: requests to remove screenshots`, body: `${er.n} waiting.`, link: `/challenges/${cid}/review`, challengeId: cid, count: er.n });
    }
    if (w.exemptions && can('exemptions.review')) out.push({ id: `exadmin:${cid}`, kind: 'action', title: `${c.name}: exemption requests need an admin`, body: `${w.exemptions} waiting.`, link: `/challenges/${cid}/exemptions`, challengeId: cid, count: w.exemptions });
    if (can('payments.verify') || can('refunds.approve') || can('payments.countersign')) {
      const { rows: [m] } = await db.query(
        `SELECT (SELECT count(*) FROM payments x JOIN participants p USING (participant_id) WHERE x.challenge_id = $1 AND x.status = 'SUBMITTED' AND p.user_id <> $2)::int AS payments,
                (SELECT count(*) FROM refund_proposals r JOIN participants p USING (participant_id) WHERE r.challenge_id = $1 AND r.status = 'PROPOSED' AND r.proposed_by <> $2 AND p.user_id <> $2)::int AS refunds,
                (SELECT count(*) FROM payments x JOIN participants p USING (participant_id) WHERE x.challenge_id = $1 AND x.status = 'SUBMITTED' AND x.submitted_by <> p.user_id AND x.submitted_by <> $2 AND p.user_id <> $2)::int AS countersign`, [cid, userId]);
      if (m.payments && can('payments.verify')) out.push({ id: `payments:${cid}`, kind: 'action', title: `${c.name}: payments to confirm`, body: `${m.payments} UTR${m.payments === 1 ? '' : 's'} waiting.`, link: `/challenges/${cid}/money`, challengeId: cid, count: m.payments });
      if (m.countersign && can('payments.countersign') && !can('payments.verify')) out.push({ id: `countersign:${cid}`, kind: 'action', title: `${c.name}: payments recorded by another admin`, body: `${m.countersign} to confirm (two-person rule).`, link: `/challenges/${cid}/money`, challengeId: cid, count: m.countersign });
      if (m.refunds && can('refunds.approve')) out.push({ id: `refunds:${cid}`, kind: 'action', title: `${c.name}: refunds to approve`, body: `${m.refunds} waiting.`, link: `/challenges/${cid}/money`, challengeId: cid, count: m.refunds });
    }
    if (can('settlement.approve')) {
      const { rows: [d] } = await db.query(`SELECT settlement_id FROM settlements WHERE challenge_id = $1 AND status = 'DRAFT'`, [cid]);
      if (d) out.push({ id: `settle:${d.settlement_id}`, kind: 'action', title: `${c.name}: final results waiting for approval`, body: 'Check the recommendation and approve it.', link: `/challenges/${cid}/results`, challengeId: cid });
    }
    if (can('community.moderate')) {
      const { rows: [r] } = await db.query(`SELECT count(*)::int AS n FROM community_reports WHERE challenge_id = $1 AND status = 'OPEN'`, [cid]);
      if (r.n) out.push({ id: `reports:${cid}`, kind: 'action', title: `${c.name}: community reports to look at`, body: `${r.n} open.`, link: `/community/${cid}`, challengeId: cid, count: r.n });
    }
    if (w.bonuses && can('bonus.manage')) out.push({ id: `bonus:${cid}`, kind: 'action', title: `${c.name}: weekend bonuses to approve`, body: `${w.bonuses} waiting.`, link: `/challenges/${cid}/bonus`, challengeId: cid, count: w.bonuses });
  }
  const order = { action: 0, warning: 1, info: 2 } as const;
  for (const n of out) n.seenKey = `${n.id}|${n.count ?? ''}`.slice(0, 200);
  const seen = new Set((await db.query(`SELECT seen_key FROM notification_seen WHERE user_id = $1`, [userId])).rows.map((r) => r.seen_key as string));
  for (const n of out) n.seen = seen.has(n.seenKey!);
  return out.sort((a, b) => Number(a.seen) - Number(b.seen) || order[a.kind] - order[b.kind]);
}

/** Marks notifications as seen (the Alerts badge counts only the unseen ones). */
export async function markSeen(db: Queryable, userId: number, keysRaw: unknown, now: Date): Promise<void> {
  const keys = Array.isArray(keysRaw) ? [...new Set(keysRaw.map(String).filter((k) => k.length > 0 && k.length <= 200))].slice(0, 200) : [];
  for (const k of keys) {
    await db.query(`INSERT INTO notification_seen (user_id, seen_key, seen_at) VALUES ($1,$2,$3) ON CONFLICT (user_id, seen_key) DO UPDATE SET seen_at = EXCLUDED.seen_at`, [userId, k, now]);
  }
  // Forget very old ones (their notifications are long gone).
  await db.query(`DELETE FROM notification_seen WHERE user_id = $1 AND seen_at < $2::timestamptz - interval '90 days'`, [userId, now]);
}
