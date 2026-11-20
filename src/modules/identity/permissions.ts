// Role -> permission matrix (PRD 12). Permissions are checked by the backend on every protected route, per challenge.
// Notable rules encoded here (and unit-tested):
//  - Nobody gets health-data access from a role: not Finance Admin, not Challenge Admin, not even Super Admin.
//    Health access only comes from the participant's own explicit grant (later phase).
//  - Challenge Admin cannot change financial allocations or approve final settlement; challenge admins can appoint
//    each other (at least 2 per challenge) and approve each other's money requests (never their own).
//  - Finance Admin cannot approve final settlement.
//  - Being an admin never gives scoring or exemption benefits: those are participant actions, checked separately,
//    and the conflict-of-interest rule (no reviewing your own items) is enforced in the services.
import type { Queryable } from '../../core/db.js';
import { forbidden } from '../../core/errors.js';

export const PERMISSIONS = [
  'challenge.create',          // create / duplicate challenges
  'challenge.view_admin',      // see the full configuration, roster and admin screens of a challenge
  'challenge.config.edit',     // edit non-financial rules
  'challenge.config.edit_financial', // edit finance and prize sections
  'challenge.publish',         // publish / archive
  'challenge.roles.manage',    // grant / revoke challenge admin roles
  'roster.manage',             // invitations, participants, lifecycle changes
  'submissions.review',
  'exemptions.review',
  'restdays.correct',
  'announcements.manage',
  'bonus.manage',
  'leaderboard.review',
  'finance.view',
  'payments.verify',
  'finance.reconcile',
  'finance.settings',          // payment QR / UPI details
  'payouts.prepare',
  'payouts.record',
  'settlement.approve',
  'audit.view',
  'refunds.approve',           // approve a refund someone else proposed (two-person rule)
  'payments.countersign',      // confirm a payment another admin recorded on someone's behalf (two-person rule)
  'finance.manager.assign',    // appoint / change the challenge's finance manager (handover)
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type ChallengeRole = 'CHALLENGE_ADMIN' | 'FINANCE_ADMIN';
export type PlatformRole = 'SUPER_ADMIN';

const CHALLENGE_ADMIN: Permission[] = [
  'challenge.view_admin', 'challenge.config.edit', 'roster.manage', 'submissions.review', 'exemptions.review',
  'restdays.correct', 'announcements.manage', 'bonus.manage', 'leaderboard.review', 'audit.view',
  // Owner (21 Nov 2026): admins appoint other admins (no limit, at least 2), approve each other's money requests,
  // and are the only ones who can change the finance manager.
  'challenge.roles.manage', 'refunds.approve', 'payments.countersign', 'finance.manager.assign',
];
const FINANCE_ADMIN: Permission[] = [
  'challenge.view_admin', 'finance.view', 'payments.verify', 'finance.reconcile', 'finance.settings', 'payouts.prepare', 'payouts.record', 'audit.view',
];

export const ROLE_PERMISSIONS: Record<ChallengeRole | PlatformRole, ReadonlySet<Permission>> = {
  SUPER_ADMIN: new Set(PERMISSIONS),
  CHALLENGE_ADMIN: new Set(CHALLENGE_ADMIN),
  FINANCE_ADMIN: new Set(FINANCE_ADMIN),
};

export interface Access {
  platformRoles: PlatformRole[];
  challengeRoles: ChallengeRole[];
  permissions: Set<Permission>;
}

export function permissionsOf(platformRoles: PlatformRole[], challengeRoles: ChallengeRole[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of [...platformRoles, ...challengeRoles]) for (const p of ROLE_PERMISSIONS[r]) out.add(p);
  return out;
}

export async function platformRolesOf(db: Queryable, userId: number): Promise<PlatformRole[]> {
  const { rows } = await db.query(`SELECT role FROM platform_roles WHERE user_id = $1`, [userId]);
  return rows.map((r) => r.role as PlatformRole);
}

/** The caller's roles and permissions for one challenge (challengeId null = platform-level only). */
export async function accessFor(db: Queryable, userId: number, challengeId: number | null): Promise<Access> {
  const platformRoles = await platformRolesOf(db, userId);
  let challengeRoles: ChallengeRole[] = [];
  if (challengeId !== null) {
    const { rows } = await db.query(`SELECT role FROM challenge_roles WHERE challenge_id = $1 AND user_id = $2`, [challengeId, userId]);
    challengeRoles = rows.map((r) => r.role as ChallengeRole);
  }
  return { platformRoles, challengeRoles, permissions: permissionsOf(platformRoles, challengeRoles) };
}

export function requirePermission(access: Access, p: Permission): void {
  if (!access.permissions.has(p)) throw forbidden();
}

/** May create user accounts: a Super Admin, or a Challenge Admin of any challenge (they invite people). */
export async function canManageAccounts(db: Queryable, userId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM platform_roles WHERE user_id = $1 AND role = 'SUPER_ADMIN')
         OR EXISTS (SELECT 1 FROM challenge_roles WHERE user_id = $1 AND role = 'CHALLENGE_ADMIN') AS ok`, [userId]);
  return rows[0].ok === true;
}
