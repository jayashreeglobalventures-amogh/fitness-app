// A participant's report as a PDF (Team tab → 📄 PDF, or the person's own): summary, points, money and every day of
// the challenge. Admins of the challenge, or the person themselves. Uses the PDF standard fonts (no emoji, "Rs."
// instead of the rupee sign, which those fonts don't have).
import PDFDocument from 'pdfkit';
import type { Queryable } from '../../core/db.js';
import { daysBetween } from '../../core/dates.js';
import { forbidden } from '../../core/errors.js';
import { accessFor } from '../identity/permissions.js';
import { challengeContext, participantById, participantDays, summarize } from '../checkin/days.js';
import { reconcileMoney, statementOf } from '../finance/finance.js';
import { reconcile } from '../scoring/ledger.js';

const STATUS: Record<string, string> = {
  NOT_PARTICIPATING: 'Not taking part', UPCOMING: 'Upcoming', NOT_SUBMITTED: 'Not submitted', IN_PROGRESS: 'In progress', SUBMITTED: 'Being read',
  PENDING_VERIFICATION: 'Waiting for an admin', ACHIEVED: 'Target met', TARGET_MISSED: 'Target missed', REJECTED: 'Declined',
  MISSED_DEADLINE: 'Missed (no evidence)', EXCUSED: 'Excused', REST: 'Rest day',
};
const RULE: Record<string, string> = {
  DAILY_SUCCESS: 'Daily target', PERSONAL_STREAK: 'Personal streak', TEAM_STREAK: 'Team streak', COMEBACK: 'Comeback', WEEKEND_BONUS: 'Weekend bonus',
  MISSED_DAY: 'Missed day', CONSECUTIVE_MISSES: 'Missed days in a row', TEAM_STREAK_BREAK: 'Team streak broken', TEAM_STREAK_BROKEN: 'Team streak broken',
};
const n = (x: number) => x.toLocaleString('en-IN');
const rs = (x: number) => `Rs. ${(Math.round(x * 100) / 100 || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`; // never "-0"
const dm = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const dt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export async function participantReport(db: Queryable, actorUserId: number, participantId: number, now: Date): Promise<{ filename: string; pdf: Buffer }> {
  const p = await participantById(db, participantId);
  if (p.userId !== actorUserId && !(await accessFor(db, actorUserId, p.challengeId)).permissions.has('challenge.view_admin')) throw forbidden();
  const ctx = await challengeContext(db, p.challengeId, now);
  const { rows: [u] } = await db.query(`SELECT display_name, username FROM users WHERE user_id = $1`, [p.userId]);
  const days = await participantDays(db, ctx, p, now);
  const sum = summarize(days, ctx);
  const { facts } = await reconcile(db, p.challengeId, now);
  const st = facts.out.participants.find((x) => x.participantId === participantId);
  const { rows: ev } = await db.query(`SELECT rule, points FROM scoring_events WHERE participant_id = $1`, [participantId]);
  const byRule = new Map<string, number>();
  for (const e of ev) byRule.set(e.rule, (byRule.get(e.rule) ?? 0) + e.points);
  const points = ev.reduce((a, e) => a + e.points, 0);
  const cfg = ctx.cfgOn(daysBetween(ctx.today, ctx.ch.endsOn) < 0 ? ctx.ch.endsOn : daysBetween(ctx.ch.startsOn, ctx.today) < 0 ? ctx.ch.startsOn : ctx.today);
  const money = cfg.finance.enabled ? await statementOf(db, (await reconcileMoney(db, p.challengeId, now)).ctx, participantId) : null;

  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `${ctx.ch.name} - ${u.display_name}`, Author: 'Fitness' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width - 80;

  // ---- Header
  doc.font('Helvetica-Bold').fontSize(20).text(u.display_name);
  doc.font('Helvetica').fontSize(11).fillColor('#555').text(`${ctx.ch.name} · ${dt(ctx.ch.startsOn)} - ${dt(ctx.ch.endsOn)} · @${u.username}`);
  doc.text(`Status: ${p.status.toLowerCase()} · Joined ${dt(p.joinedOn)}${p.leftOn ? ` · Left ${dt(p.leftOn)}` : ''} · Report made ${now.toLocaleString('en-IN', { timeZone: ctx.ch.timeZone })}`);
  doc.moveDown(0.8).fillColor('#000');

  // ---- Summary
  const kv = (rows: [string, string][]) => {
    for (const [k, v] of rows) { const y = doc.y; doc.font('Helvetica').fontSize(10).fillColor('#555').text(k, 40, y, { width: 200 }); doc.fillColor('#000').font('Helvetica-Bold').text(v, 240, y, { width: W - 200 }); }
    doc.font('Helvetica').moveDown(0.6);
  };
  const h = (t: string) => { doc.moveDown(0.3).font('Helvetica-Bold').fontSize(13).fillColor('#000').text(t, 40); doc.moveDown(0.3); };
  h('Summary');
  kv([
    ['Daily target', `${n(cfg.activity.dailyTarget)} ${cfg.activity.unit}`],
    ['Days target met', String(sum.achieved)], ['Days missed', String(sum.missed)], ['Rest days', String(sum.rest)], ['Excused days', String(sum.excused)],
    ['Adherence', sum.adherencePct === null ? '-' : `${sum.adherencePct}% (prize line ${cfg.prizes.qualificationAdherencePct}%)`],
    ['Current streak / best', `${st?.currentStreak ?? 0} / ${st?.longestStreak ?? 0} days`],
    ['Points', n(points)],
  ]);
  if (byRule.size) { h('Points by kind'); kv([...byRule.entries()].map(([k, v]) => [RULE[k] ?? k, (v > 0 ? '+' : '') + n(v)])); }

  if (money) {
    h('Money');
    kv([['Still to pay (all weeks)', rs(money.owed)], ['Owed back', rs(money.refundDue)]]);
    const cols = [40, 110, 250, 330, 410, 490];
    doc.font('Helvetica-Bold').fontSize(9);
    ['Week', 'Dates', 'Due', 'Paid', 'Fines', 'Status'].forEach((t, i) => doc.text(t, cols[i]!, doc.y, { continued: false, lineBreak: false }));
    doc.moveDown(0.9).font('Helvetica');
    for (const w of money.weeks.filter((x) => x.status !== 'NOT_DUE')) {
      if (doc.y > doc.page.height - 60) doc.addPage();
      const y = doc.y;
      [String(w.periodNo), `${dm(w.startsOn)} - ${dm(w.endsOn)}`, rs(w.due), rs(w.paid), rs(w.fines), w.status.toLowerCase()].forEach((t, i) => doc.text(t, cols[i]!, y, { lineBreak: false }));
      doc.moveDown(0.9);
    }
    doc.moveDown(0.4);
  }

  // ---- Every day
  h('Day by day');
  const cols = [40, 175, 300, 380, 460];
  const header = () => { doc.font('Helvetica-Bold').fontSize(9); ['Date', 'Status', 'Counted', 'From', 'Note'].forEach((t, i) => doc.text(t, cols[i]!, doc.y, { lineBreak: false })); doc.moveDown(0.9).font('Helvetica'); };
  header();
  for (const d of days.filter((x) => x.status !== 'UPCOMING' && x.status !== 'NOT_PARTICIPATING')) {
    if (doc.y > doc.page.height - 60) { doc.addPage(); header(); }
    const sync = d.sync && !d.sync.doubted ? d.sync.steps : null;
    const shot = d.submission?.finalValue ?? null;
    const synced = sync !== null && (shot === null || sync >= shot);
    const value = synced ? sync : shot;
    const from = synced ? 'Apple Health' : shot !== null ? 'Screenshot' : d.restDay ? '-' : '';
    const note = d.sync?.doubted ? 'Synced steps doubted' : d.submission?.decisionReason ?? '';
    const y = doc.y;
    doc.fillColor(d.status === 'ACHIEVED' ? '#0a7a45' : ['TARGET_MISSED', 'REJECTED', 'MISSED_DEADLINE'].includes(d.status) ? '#b42318' : '#000');
    [dt(d.day), STATUS[d.status] ?? d.status, value === null ? '-' : n(value), from].forEach((t, i) => doc.text(t, cols[i]!, y, { lineBreak: false }));
    doc.fillColor('#555').text(note.slice(0, 40), cols[4]!, y, { width: W - (cols[4]! - 40), lineBreak: false });
    doc.fillColor('#000').moveDown(0.9);
  }
  doc.end();
  const safe = `${ctx.ch.name}-${u.display_name}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { filename: `${safe}-${ctx.today}.pdf`, pdf: await done };
}
