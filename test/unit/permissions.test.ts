import { describe, expect, it } from 'vitest';
import { PERMISSIONS, permissionsOf } from '../../src/modules/identity/permissions.js';

describe('role permissions (PRD 12)', () => {
  it('no role carries any health-data permission - not even Super Admin', () => {
    expect(PERMISSIONS.filter((p) => p.startsWith('health'))).toEqual([]);
  });

  it('Challenge Admin: runs the challenge, cannot touch money rules or approve settlement', () => {
    const p = permissionsOf([], ['CHALLENGE_ADMIN']);
    for (const ok of ['roster.manage', 'submissions.review', 'exemptions.review', 'challenge.config.edit'] as const) expect(p.has(ok)).toBe(true);
    for (const no of ['challenge.config.edit_financial', 'settlement.approve', 'payments.verify', 'challenge.publish'] as const) expect(p.has(no)).toBe(false);
    for (const ok of ['challenge.roles.manage', 'refunds.approve', 'payments.countersign', 'finance.manager.assign'] as const) expect(p.has(ok)).toBe(true);
  });

  it('Finance Admin: verifies and reconciles money, cannot approve settlement or change rules', () => {
    const p = permissionsOf([], ['FINANCE_ADMIN']);
    for (const ok of ['payments.verify', 'finance.reconcile', 'finance.settings', 'payouts.prepare', 'payouts.record'] as const) expect(p.has(ok)).toBe(true);
    for (const no of ['settlement.approve', 'challenge.config.edit', 'challenge.config.edit_financial', 'roster.manage', 'submissions.review', 'refunds.approve', 'finance.manager.assign', 'challenge.roles.manage'] as const) expect(p.has(no)).toBe(false);
  });

  it('Super Admin has every permission; roles combine', () => {
    expect(permissionsOf(['SUPER_ADMIN'], []).size).toBe(PERMISSIONS.length);
    const both = permissionsOf([], ['CHALLENGE_ADMIN', 'FINANCE_ADMIN']);
    expect(both.has('roster.manage') && both.has('payments.verify')).toBe(true);
    expect(both.has('settlement.approve')).toBe(false);
  });

  it('a plain participant has no admin permission', () => {
    expect(permissionsOf([], []).size).toBe(0);
  });
});
