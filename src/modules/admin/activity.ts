// Super Admin activity log: every audited action (who did what, when, where, from which device, before/after) and
// unexpected server errors, searchable and exportable. Read-only; the audit table itself refuses edits.
import type { Queryable } from '../../core/db.js';
import { forbidden, validation } from '../../core/errors.js';
import { accessFor } from '../identity/permissions.js';

const PAGE = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

async function requireSuper(db: Queryable, userId: number): Promise<void> {
  if (!(await accessFor(db, userId, null)).platformRoles.includes('SUPER_ADMIN')) throw forbidden('Only a Super Admin can see the activity log.');
}

export interface ActivityQuery { user?: unknown; challenge?: unknown; action?: unknown; q?: unknown; from?: unknown; to?: unknown; before?: unknown }

/** Builds the WHERE clause. Every value goes in as a numbered parameter; nothing from the request is put into the SQL text. */
function where(f: ActivityQuery): { sql: string; params: unknown[] } {
  const cond: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };

  if (f.user) {
    const u = p(Number(f.user));
    cond.push(`(a.actor_user_id = ${u} OR (a.entity = 'USER' AND a.entity_id = ${u}::text))`); // by them, or done to them
  }
  if (f.challenge) cond.push(`a.challenge_id = ${p(Number(f.challenge))}`);
  if (f.action) {
    const acts = String(f.action).split(',').map((s) => s.trim()).filter((s) => /^[A-Z_]{2,60}$/.test(s));
    if (acts.length) cond.push(`a.action = ANY(${p(acts)})`);
  }
  const q = String(f.q ?? '').trim().slice(0, 100);
  if (q) {
    const like = p(`%${q}%`);
    const exact = p(q);
    cond.push(`(a.action ILIKE ${like} OR a.entity ILIKE ${like} OR a.entity_id = ${exact} OR a.reason ILIKE ${like}
      OR a.before::text ILIKE ${like} OR a.after::text ILIKE ${like} OR u.display_name ILIKE ${like} OR u.username ILIKE ${like}
      OR host(a.ip) = ${exact})`);
  }
  if (f.from) {
    if (!DAY.test(String(f.from))) throw validation('"From" must be a date (YYYY-MM-DD).');
    cond.push(`a.at >= (${p(String(f.from))}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`);
  }
  if (f.to) {
    if (!DAY.test(String(f.to))) throw validation('"To" must be a date (YYYY-MM-DD).');
    cond.push(`a.at < ((${p(String(f.to))}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
  }
  if (f.before) cond.push(`a.audit_id < ${p(Math.trunc(Number(f.before)))}`);
  return { sql: cond.length ? `WHERE ${cond.join(' AND ')}` : '', params };
}

const SELECT = `SELECT a.audit_id, a.at, a.actor_user_id, u.display_name AS actor_name, u.username AS actor_username, a.challenge_id, c.name AS challenge_name,
                       a.action, a.entity, a.entity_id, a.reason, a.before, a.after, host(a.ip) AS ip, a.device,
                       CASE WHEN a.entity = 'USER' THEN (SELECT tu.display_name FROM users tu WHERE tu.user_id::text = a.entity_id) END AS target_name
                  FROM audit_log a LEFT JOIN users u ON u.user_id = a.actor_user_id LEFT JOIN challenges c ON c.challenge_id = a.challenge_id`;

const out = (r: Record<string, any>) => ({
  id: Number(r.audit_id), at: r.at.toISOString(), action: r.action, entity: r.entity, entityId: r.entity_id, targetName: r.target_name ?? null,
  actor: r.actor_user_id ? { userId: Number(r.actor_user_id), name: r.actor_name, username: r.actor_username } : null,
  challenge: r.challenge_id ? { challengeId: Number(r.challenge_id), name: r.challenge_name } : null,
  reason: r.reason, before: r.before, after: r.after, ip: r.ip, device: r.device,
});

/** Newest first, 50 at a time (pass `before` = the last id for the next page). */
export async function activity(db: Queryable, userId: number, f: ActivityQuery): Promise<unknown> {
  await requireSuper(db, userId);
  const w = where(f);
  const { rows } = await db.query(`${SELECT} ${w.sql} ORDER BY a.audit_id DESC LIMIT ${PAGE + 1}`, w.params);
  const page = rows.slice(0, PAGE);
  return { items: page.map(out), nextBefore: rows.length > PAGE ? Number(page[page.length - 1]!.audit_id) : null };
}

/** The choices for the filters: people, challenges and the kinds of action that occur. */
export async function facets(db: Queryable, userId: number): Promise<unknown> {
  await requireSuper(db, userId);
  const people = await db.query(`SELECT user_id, display_name, username FROM users ORDER BY lower(display_name)`);
  const challenges = await db.query(`SELECT challenge_id, name FROM challenges ORDER BY challenge_id DESC`);
  const actions = await db.query(`SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY action`);
  return {
    people: people.rows.map((r) => ({ userId: Number(r.user_id), name: r.display_name, username: r.username })),
    challenges: challenges.rows.map((r) => ({ challengeId: Number(r.challenge_id), name: r.name })),
    actions: actions.rows.map((r) => ({ action: r.action, count: r.n })),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // never let a spreadsheet run a formula from log data
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** The filtered log as CSV (up to 20,000 rows), for keeping or sharing with someone investigating. */
export async function activityCsv(db: Queryable, userId: number, f: ActivityQuery): Promise<string> {
  await requireSuper(db, userId);
  const w = where({ ...f, before: undefined });
  const { rows } = await db.query(`${SELECT} ${w.sql} ORDER BY a.audit_id DESC LIMIT 20000`, w.params);
  const head = ['id', 'time_ist', 'who', 'username', 'action', 'challenge', 'entity', 'entity_id', 'target', 'reason', 'before', 'after', 'ip', 'device'];
  const lines = rows.map((r) => [r.audit_id, new Date(r.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), r.actor_name ?? 'system', r.actor_username,
    r.action, r.challenge_name, r.entity, r.entity_id, r.target_name, r.reason, r.before, r.after, r.ip, r.device].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

/** Unexpected server errors, newest first, 50 at a time. */
export async function errors(db: Queryable, userId: number, beforeRaw: unknown): Promise<unknown> {
  await requireSuper(db, userId);
  const before = beforeRaw ? Math.trunc(Number(beforeRaw)) : null;
  const { rows } = await db.query(
    `SELECT e.*, host(e.ip) AS ip_text, u.display_name FROM error_log e LEFT JOIN users u USING (user_id)
      ${before ? 'WHERE e.error_id < $1' : ''} ORDER BY e.error_id DESC LIMIT ${PAGE + 1}`, before ? [before] : []);
  const page = rows.slice(0, PAGE);
  return {
    items: page.map((r) => ({ id: Number(r.error_id), at: r.at.toISOString(), source: r.source, user: r.user_id ? { userId: Number(r.user_id), name: r.display_name } : null,
      method: r.method, path: r.path, message: r.message, stack: r.stack, ip: r.ip_text, device: r.device })),
    nextBefore: rows.length > PAGE ? Number(page[page.length - 1]!.error_id) : null,
  };
}

/** Records an unexpected error. Never throws (logging must not break the request); keeps 180 days. */
export async function recordError(db: Queryable, e: { source: 'REQUEST' | 'BACKGROUND'; userId?: number | null; method?: string; path?: string; err: unknown; ip?: string | null; device?: string | null }): Promise<void> {
  try {
    const err = e.err as { message?: string; stack?: string };
    // The query string is dropped: it could carry search text, and the path is enough to find the screen.
    await db.query(`INSERT INTO error_log (at, source, user_id, method, path, message, stack, ip, device) VALUES (now(),$1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.source, e.userId ?? null, e.method ?? null, e.path?.split('?')[0]?.slice(0, 300) ?? null, String(err?.message ?? e.err).slice(0, 1000),
        err?.stack?.slice(0, 4000) ?? null, e.ip ?? null, e.device?.slice(0, 300) ?? null]);
    if (Math.random() < 0.02) await db.query(`DELETE FROM error_log WHERE at < now() - interval '180 days'`);
  } catch { /* the database itself may be the problem; the server log still has it */ }
}
