// Basic profile (PRD 4). Optional fields, each with its own visibility. Health data is NOT here (separate module,
// separate tables, consent required) - nothing in this file may ever select from health tables.
import { writeAudit } from '../../core/audit.js';
import type { Queryable } from '../../core/db.js';
import { isValidDate } from '../../core/dates.js';
import { validation } from '../../core/errors.js';

export const PROFILE_FIELDS = ['fullName', 'mobile', 'email', 'birthDate', 'gender', 'location', 'about'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export const VISIBILITIES = ['PRIVATE', 'CHALLENGE_MEMBERS', 'PUBLIC'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

const COLUMN: Record<ProfileField, string> = { fullName: 'full_name', mobile: 'mobile', email: 'email', birthDate: 'birth_date', gender: 'gender', location: 'location', about: 'about' };
const MAX: Record<ProfileField, number> = { fullName: 120, mobile: 16, email: 200, birthDate: 10, gender: 40, location: 120, about: 1000 };

export interface Profile {
  userId: number; username: string; displayName: string;
  fields: Record<ProfileField, string | null>;
  visibility: Record<ProfileField, Visibility>;
}

export async function getOwnProfile(db: Queryable, userId: number): Promise<Profile> {
  const { rows } = await db.query(
    `SELECT u.user_id, u.username, u.display_name, p.* FROM users u LEFT JOIN user_profiles p USING (user_id) WHERE u.user_id = $1`, [userId]);
  const r = rows[0];
  const vis = (r.visibility ?? {}) as Record<string, string>;
  const fields = {} as Record<ProfileField, string | null>;
  const visibility = {} as Record<ProfileField, Visibility>;
  for (const f of PROFILE_FIELDS) {
    fields[f] = r[COLUMN[f]] ?? null;
    visibility[f] = (VISIBILITIES as readonly string[]).includes(vis[f] ?? '') ? (vis[f] as Visibility) : 'PRIVATE';
  }
  return { userId: Number(r.user_id), username: r.username, displayName: r.display_name, fields, visibility };
}

export async function updateOwnProfile(db: Queryable, userId: number, input: { displayName?: unknown; fields?: Record<string, unknown>; visibility?: Record<string, unknown> }, now: Date): Promise<Profile> {
  const before = await getOwnProfile(db, userId);
  const fields = { ...before.fields };
  for (const [k, raw] of Object.entries(input.fields ?? {})) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(k)) throw validation(`Unknown profile field "${k}".`);
    const f = k as ProfileField;
    const v = raw == null ? '' : String(raw).trim();
    if (v.length > MAX[f]) throw validation(`${f} is too long.`);
    if (f === 'mobile' && v && !/^\+?[0-9]{8,15}$/.test(v.replace(/[\s-]/g, ''))) throw validation('Mobile number: 8–15 digits, optionally starting with +.');
    if (f === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw validation('Enter a valid email address.');
    if (f === 'birthDate' && v && !isValidDate(v)) throw validation('Date of birth must be YYYY-MM-DD.');
    fields[f] = v ? (f === 'mobile' ? v.replace(/[\s-]/g, '') : v) : null;
  }
  const visibility = { ...before.visibility };
  for (const [k, v] of Object.entries(input.visibility ?? {})) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(k)) throw validation(`Unknown profile field "${k}".`);
    if (!(VISIBILITIES as readonly string[]).includes(String(v))) throw validation('Visibility must be PRIVATE, CHALLENGE_MEMBERS or PUBLIC.');
    visibility[k as ProfileField] = v as Visibility;
  }
  let displayName = before.displayName;
  if (input.displayName !== undefined) {
    displayName = String(input.displayName ?? '').trim().slice(0, 80);
    if (!displayName) throw validation('Enter a display name.');
  }
  await db.query(`UPDATE users SET display_name = $2, updated_at = $3 WHERE user_id = $1`, [userId, displayName, now]);
  await db.query(
    `INSERT INTO user_profiles (user_id, full_name, mobile, email, birth_date, gender, location, about, visibility, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name, mobile = EXCLUDED.mobile, email = EXCLUDED.email,
       birth_date = EXCLUDED.birth_date, gender = EXCLUDED.gender, location = EXCLUDED.location, about = EXCLUDED.about,
       visibility = EXCLUDED.visibility, updated_at = EXCLUDED.updated_at`,
    [userId, fields.fullName, fields.mobile, fields.email, fields.birthDate, fields.gender, fields.location, fields.about, JSON.stringify(visibility), now]);
  // The audit records WHICH fields changed, not their values (profile data is personal).
  const changed = PROFILE_FIELDS.filter((f) => fields[f] !== before.fields[f] || visibility[f] !== before.visibility[f]);
  if (changed.length || displayName !== before.displayName) {
    await writeAudit(db, now, { actorUserId: userId, action: 'PROFILE_UPDATED', entity: 'USER', entityId: userId, after: { changed, displayNameChanged: displayName !== before.displayName } });
  }
  return getOwnProfile(db, userId);
}
