// Participation certificates (owner, 26 Nov 2026). Admins preview anyone's at any time (marked PREVIEW); once the
// challenge has ended they give them to everyone who took part (not removed, withdrawn or disqualified) - each person
// gets an alert and can download theirs. The PDF is drawn from the results each time: landscape A4, gold double
// border with corner ornaments, the name in large italic, the stats, a top-three ribbon, a seal and the admins'
// names. PDF standard fonts only (no emoji).
import PDFDocument from 'pdfkit';
import { writeAudit } from '../../core/audit.js';
import type { Queryable } from '../../core/db.js';
import { daysBetween } from '../../core/dates.js';
import { conflict, forbidden } from '../../core/errors.js';
import { accessFor, requirePermission } from '../identity/permissions.js';
import { challengeContext, participantById, participantDays, summarize } from '../checkin/days.js';
import { addNotice } from '../notifications/prefs.js';
import { standingsOf } from '../scoring/ledger.js';

const ELIGIBLE = `p.status NOT IN ('REMOVED','WITHDRAWN','DISQUALIFIED')`;
const dt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const n = (x: number) => x.toLocaleString('en-IN');
const ordinal = (r: number) => (r === 1 ? '1st' : r === 2 ? '2nd' : r === 3 ? '3rd' : `${r}th`);

async function ended(db: Queryable, challengeId: number, now: Date) {
  const ctx = await challengeContext(db, challengeId, now);
  return { ctx, over: daysBetween(ctx.ch.endsOn, ctx.today) > 0 };
}

/** Admin list: who can get one, who has. */
export async function certificateList(db: Queryable, actorUserId: number, challengeId: number, now: Date): Promise<unknown> {
  if (!(await accessFor(db, actorUserId, challengeId)).permissions.has('challenge.view_admin')) throw forbidden();
  const { ctx, over } = await ended(db, challengeId, now);
  const { rows } = await db.query(
    `SELECT p.participant_id, u.display_name, c.issued_at FROM participants p JOIN users u USING (user_id) LEFT JOIN certificates c USING (participant_id)
      WHERE p.challenge_id = $1 AND ${ELIGIBLE} ORDER BY u.display_name`, [challengeId]);
  return { ended: over, endsOn: ctx.ch.endsOn, people: rows.map((r) => ({ participantId: Number(r.participant_id), displayName: r.display_name, issuedAt: r.issued_at?.toISOString() ?? null })) };
}

/** After the end: gives a certificate to everyone who took part and hasn't one yet; each gets an alert. */
export async function issueCertificates(db: Queryable, actorUserId: number, challengeId: number, now: Date): Promise<{ issued: number }> {
  requirePermission(await accessFor(db, actorUserId, challengeId), 'roster.manage');
  const { ctx, over } = await ended(db, challengeId, now);
  if (!over) throw conflict(`Certificates can be given once the challenge has ended (after ${dt(ctx.ch.endsOn)}).`);
  const { rows } = await db.query(
    `INSERT INTO certificates (participant_id, challenge_id, issued_at, issued_by)
     SELECT p.participant_id, p.challenge_id, $2, $3 FROM participants p
      WHERE p.challenge_id = $1 AND ${ELIGIBLE} AND NOT EXISTS (SELECT 1 FROM certificates c WHERE c.participant_id = p.participant_id)
     RETURNING participant_id`, [challengeId, now, actorUserId]);
  for (const r of rows) {
    const p = await participantById(db, Number(r.participant_id));
    await addNotice(db, { userId: p.userId, challengeId, key: `cert:${p.participantId}`, category: 'essential', kind: 'info',
      title: `🎓 Your ${ctx.ch.name} certificate is ready`, body: 'Well done for taking part! Download it from the Today tab.', link: `/challenges/${challengeId}/today` }, now);
  }
  await writeAudit(db, now, { actorUserId, challengeId, action: 'CERTIFICATES_ISSUED', entity: 'CHALLENGE', entityId: challengeId, after: { count: rows.length } });
  return { issued: rows.length };
}

/** For the participant's Today tab: has mine been given? */
export async function myCertificate(db: Queryable, userId: number, challengeId: number): Promise<unknown> {
  const { rows: [r] } = await db.query(
    `SELECT p.participant_id, c.issued_at FROM participants p JOIN certificates c USING (participant_id) WHERE p.challenge_id = $1 AND p.user_id = $2`, [challengeId, userId]);
  return r ? { participantId: Number(r.participant_id), issuedAt: r.issued_at.toISOString() } : null;
}

/** The certificate PDF: admins any time (PREVIEW until given); the person once it has been given. */
export async function certificatePdf(db: Queryable, actorUserId: number, participantId: number, now: Date): Promise<{ filename: string; pdf: Buffer }> {
  const p = await participantById(db, participantId);
  const admin = (await accessFor(db, actorUserId, p.challengeId)).permissions.has('challenge.view_admin');
  const { rows: [cert] } = await db.query(`SELECT issued_at FROM certificates WHERE participant_id = $1`, [participantId]);
  if (!admin && (p.userId !== actorUserId || !cert)) throw forbidden();
  const ctx = await challengeContext(db, p.challengeId, now);
  const { rows: [u] } = await db.query(`SELECT display_name FROM users WHERE user_id = $1`, [p.userId]);
  const days = await participantDays(db, ctx, p, now);
  const sum = summarize(days, ctx);
  const taking = days.filter((d) => d.status !== 'NOT_PARTICIPATING' && daysBetween(d.day, ctx.today) >= 0).length;
  // Every step that counted (a screenshot's number or Apple Health, whichever was higher; doubted syncs left out).
  const steps = days.reduce((a, d) => a + Math.max(d.submission?.finalValue ?? 0, d.sync && !d.sync.doubted ? d.sync.steps : 0), 0);
  const st = (await standingsOf(db, p.challengeId, now)).standings.find((s) => s.participantId === participantId);
  const cfg = ctx.cfgOn(ctx.ch.endsOn);
  const { rows: admins } = await db.query(
    `SELECT u.display_name FROM challenge_roles r JOIN users u USING (user_id) WHERE r.challenge_id = $1 AND r.role = 'CHALLENGE_ADMIN' ORDER BY r.role, u.display_name LIMIT 2`, [p.challengeId]);
  const pdf = await draw({
    name: u.display_name, challenge: ctx.ch.name, from: dt(ctx.ch.startsOn), to: dt(ctx.ch.endsOn), year: ctx.ch.endsOn.slice(0, 4),
    target: `${n(cfg.activity.dailyTarget)} ${cfg.activity.unit}`, achieved: sum.achieved, days: taking, adherence: sum.adherencePct,
    streak: st?.longestStreak ?? 0, steps, rank: st && st.rank <= 3 && st.eligible ? st.rank : null,
    admins: admins.map((a) => a.display_name), issued: cert ? dt(cert.issued_at.toISOString().slice(0, 10)) : null, id: `FIT-${p.challengeId}-${participantId}`,
  });
  if (admin && !cert) await writeAudit(db, now, { actorUserId, challengeId: p.challengeId, action: 'CERTIFICATE_PREVIEWED', entity: 'PARTICIPANT', entityId: participantId });
  const safe = `${ctx.ch.name}-certificate-${u.display_name}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { filename: `${safe}.pdf`, pdf };
}

interface CertData { name: string; challenge: string; from: string; to: string; year: string; target: string; achieved: number; days: number; adherence: number | null;
  streak: number; steps: number; rank: number | null; admins: string[]; issued: string | null; id: string }

const C = { cream: '#fffaf4', gold: '#c9a227', goldLight: '#e8cf6f', coral: '#e8604c', pink: '#d6337a', plum: '#3b0d2c', ink: '#4a3a44', muted: '#8a7a84' };

function draw(d: CertData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate of Participation - ${d.name}`, Author: 'Fitness' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width, H = doc.page.height, cx = W / 2;

  // Paper, soft corner washes, double border, corner ornaments.
  doc.rect(0, 0, W, H).fill(C.cream);
  const wash = (x: number, y: number, r: number, col: string) => { doc.save().circle(x, y, r).fillOpacity(0.07).fill(col).restore(); };
  wash(0, 0, 210, C.coral); wash(W, H, 230, C.pink); wash(W, 0, 120, C.gold); wash(0, H, 130, C.gold);
  doc.lineWidth(4).strokeColor(C.gold).rect(18, 18, W - 36, H - 36).stroke();
  doc.lineWidth(1).strokeColor(C.goldLight).rect(26, 26, W - 52, H - 52).stroke();
  doc.lineWidth(1.2).strokeColor(C.coral).rect(34, 34, W - 68, H - 68).stroke();
  for (const [x, y] of [[34, 34], [W - 34, 34], [34, H - 34], [W - 34, H - 34]] as const) {
    doc.save().translate(x, y).rotate(45).rect(-9, -9, 18, 18).fill(C.gold).restore();
    doc.save().translate(x, y).rotate(45).rect(-4.5, -4.5, 9, 9).fill(C.cream).restore();
  }
  // A thin flourish under the title.
  const flourish = (y: number, w: number) => {
    doc.lineWidth(1).strokeColor(C.gold).moveTo(cx - w, y).lineTo(cx - 14, y).stroke().moveTo(cx + 14, y).lineTo(cx + w, y).stroke();
    doc.save().translate(cx, y).rotate(45).rect(-5, -5, 10, 10).fill(C.coral).restore();
  };

  const center = (text: string, y: number, font: string, size: number, color: string, opts: PDFKit.Mixins.TextOptions = {}) =>
    doc.font(font).fontSize(size).fillColor(color).text(text, 60, y, { width: W - 120, align: 'center', ...opts });

  center(`${d.challenge.toUpperCase()}  ·  ${d.year}`, 62, 'Helvetica-Bold', 10, C.coral, { characterSpacing: 3 });
  center('Certificate', 82, 'Times-BoldItalic', 54, C.plum);
  center('OF PARTICIPATION', 146, 'Helvetica-Bold', 13, C.gold, { characterSpacing: 6 });
  flourish(172, 150);
  center('This certificate is proudly presented to', 190, 'Times-Italic', 15, C.ink);
  center(d.name, 214, 'Times-BoldItalic', 44, C.coral);
  doc.lineWidth(1).strokeColor(C.goldLight).moveTo(cx - 190, 268).lineTo(cx + 190, 268).stroke();
  center(`for taking part in ${d.challenge}, ${d.from} to ${d.to},`, 280, 'Times-Roman', 14, C.ink);
  center(`walking towards ${d.target} every day.`, 298, 'Times-Roman', 14, C.ink);

  // Four stat tiles.
  const stats: [string, string][] = [
    [`${d.achieved} of ${d.days}`, 'days completed'],
    [d.adherence === null ? '-' : `${Math.round(d.adherence)}%`, 'adherence'],
    [`${d.streak} ${d.streak === 1 ? 'day' : 'days'}`, 'best streak'],
    [d.steps >= 100_000 ? `${(d.steps / 1000).toFixed(0)}k` : n(d.steps), 'steps walked'],
  ];
  const tw = 128, gap = 14, x0 = cx - (stats.length * tw + (stats.length - 1) * gap) / 2, ty = 330;
  stats.forEach(([v, l], i) => {
    const x = x0 + i * (tw + gap);
    doc.save().roundedRect(x, ty, tw, 58, 10).fillOpacity(0.9).fill('#ffffff').restore();
    doc.lineWidth(1).strokeColor(C.goldLight).roundedRect(x, ty, tw, 58, 10).stroke();
    doc.font('Helvetica-Bold').fontSize(18).fillColor(C.plum).text(v, x, ty + 10, { width: tw, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(l.toUpperCase(), x, ty + 36, { width: tw, align: 'center', characterSpacing: 1.2 });
  });

  // Top three: a ribbon banner at the top right.
  if (d.rank) {
    const rx = W - 210, ry = 60;
    doc.save().polygon([rx, ry], [rx + 150, ry], [rx + 138, ry + 17], [rx + 150, ry + 34], [rx, ry + 34], [rx + 12, ry + 17]).fill(d.rank === 1 ? C.gold : d.rank === 2 ? '#9aa4b1' : '#c27b48').restore();
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(`${ordinal(d.rank)} PLACE`, rx, ry + 10, { width: 150, align: 'center', characterSpacing: 2 });
  }

  // The seal: gold rings, a star and the year.
  const sy = H - 108;
  doc.circle(cx, sy, 40).fill(C.gold);
  doc.circle(cx, sy, 34).lineWidth(1.5).strokeColor(C.cream).stroke();
  const star = (r1: number, r2: number) => Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5; const r = i % 2 ? r2 : r1; return [cx + r * Math.cos(a), sy - 6 + r * Math.sin(a)] as [number, number]; });
  doc.polygon(...star(14, 6)).fill(C.cream);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(C.cream).text(d.year, cx - 30, sy + 12, { width: 60, align: 'center', characterSpacing: 1 });

  // Signature lines: the challenge admins.
  // Signature lines either side of the seal: two admins, or one admin and the date it was given.
  const names = d.admins.length ? d.admins : ['Challenge admin'];
  const lines: [string, string][] = names.length >= 2 ? [[names[0]!, 'CHALLENGE ADMIN'], [names[1]!, 'CHALLENGE ADMIN']] : [[names[0]!, 'CHALLENGE ADMIN'], [d.issued ?? '', 'DATE']];
  lines.forEach(([text, label], i) => {
    const x = i === 0 ? cx - 300 : cx + 120;
    doc.lineWidth(0.8).strokeColor(C.ink).moveTo(x, H - 100).lineTo(x + 180, H - 100).stroke();
    doc.font('Times-Italic').fontSize(13).fillColor(C.plum).text(text, x, H - 120, { width: 180, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor(C.muted).text(label, x, H - 94, { width: 180, align: 'center', characterSpacing: 1.5 });
  });
  doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
    .text(`${d.issued ? `Given on ${d.issued}` : 'Not given yet'}  ·  Certificate ${d.id}`, 60, H - 52, { width: W - 120, align: 'center' });

  if (!d.issued) { // Admin preview before it is given.
    doc.save().rotate(-24, { origin: [cx, H / 2] }).font('Helvetica-Bold').fontSize(110).fillColor(C.coral).fillOpacity(0.08).text('PREVIEW', 0, H / 2 - 60, { width: W, align: 'center' }).restore();
  }
  doc.end();
  return done;
}
