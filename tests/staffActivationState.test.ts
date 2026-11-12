import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_STATES,
  classifyActivation,
  deactivationSteps,
  effectiveTeamRole,
  isBannedUntil,
  isDeactivatedAccount,
  reactivationPlan,
  type ActivationStores,
} from '@/lib/staff/accounts';

// A staffer's activation lives in three stores — the auth ban, profiles.role,
// staff_accounts.status (lib/staff/accounts.ts). These pure rules classify any
// combination and say which steps each action still has to run, so both are
// re-runnable from a half-finished state. The routes are exercised in
// ownerStaffAccountsLifecycle.test.ts.

const stores = (over: Partial<ActivationStores> = {}): ActivationStores => ({
  banned: false,
  profileRole: 'staff',
  account: { status: 'active', role_before_deactivation: null },
  ...over,
});
const deactivated = { status: 'deactivated', role_before_deactivation: 'manager' };

describe('classifyActivation', () => {
  it('names every combination of the three stores', () => {
    expect(ACTIVATION_STATES).toContain('inconsistent_active');
    // Consistent.
    expect(classifyActivation(stores())).toBe('active');
    expect(classifyActivation(stores({ account: null }))).toBe('active'); // no row (backfill-skipped)
    expect(classifyActivation(stores({ banned: true, profileRole: 'customer', account: deactivated }))).toBe('deactivated');
    // Recorded active, but banned: a deactivate that stopped before its record.
    expect(classifyActivation(stores({ banned: true }))).toBe('inconsistent_active');
    expect(classifyActivation(stores({ banned: true, profileRole: 'customer' }))).toBe('inconsistent_active');
    // Recorded deactivated, but not all the way.
    expect(classifyActivation(stores({ banned: false, profileRole: 'customer', account: deactivated }))).toBe(
      'inconsistent_deactivated',
    );
    expect(classifyActivation(stores({ banned: false, profileRole: 'manager', account: deactivated }))).toBe(
      'inconsistent_deactivated',
    );
    expect(classifyActivation(stores({ banned: true, profileRole: 'manager', account: deactivated }))).toBe(
      'inconsistent_deactivated',
    );
    // A plain customer.
    expect(classifyActivation(stores({ profileRole: 'customer' }))).toBe('not_staff');
    expect(classifyActivation(stores({ profileRole: 'customer', account: null }))).toBe('not_staff');
  });

  it('"is deactivated" is the row, whatever the other two stores say', () => {
    expect(isDeactivatedAccount(deactivated)).toBe(true);
    expect(isDeactivatedAccount({ status: 'active' })).toBe(false);
    expect(isDeactivatedAccount(null)).toBe(false);
    expect(effectiveTeamRole('customer', deactivated)).toBe('manager');
    expect(effectiveTeamRole('manager', { status: 'deactivated', role_before_deactivation: null })).toBe('staff');
    expect(effectiveTeamRole('manager', { status: 'active' })).toBe('manager');
  });

  it('reads the ban as GoTrue stores it', () => {
    const now = Date.parse('2026-11-12T00:00:00.000Z');
    expect(isBannedUntil('2126-01-01T00:00:00.000Z', now)).toBe(true);
    expect(isBannedUntil('2026-11-11T00:00:00.000Z', now)).toBe(false); // lapsed
    expect(isBannedUntil(null, now)).toBe(false);
    expect(isBannedUntil('garbage', now)).toBe(false);
  });
});

describe('deactivationSteps — ban → record → demote, only what is missing', () => {
  it('runs all three on an active account and parks its role', () => {
    expect(deactivationSteps(stores({ profileRole: 'manager' }))).toEqual({
      steps: ['ban', 'record', 'demote'],
      parkRole: 'manager',
    });
  });

  it('finishes each half-done state, and does nothing on a deactivated one', () => {
    expect(deactivationSteps(stores({ banned: true })).steps).toEqual(['record', 'demote']);
    expect(deactivationSteps(stores({ banned: true, profileRole: 'manager', account: deactivated })).steps).toEqual(['demote']);
    expect(deactivationSteps(stores({ banned: false, profileRole: 'manager', account: deactivated })).steps).toEqual([
      'ban',
      'demote',
    ]);
    expect(deactivationSteps(stores({ banned: true, profileRole: 'customer', account: deactivated })).steps).toEqual([]);
  });

  it('never parks "customer", and keeps a role already parked', () => {
    expect(deactivationSteps(stores({ banned: true, profileRole: 'customer' })).parkRole).toBeNull();
    expect(
      deactivationSteps(stores({ banned: true, profileRole: 'customer', account: { status: 'active', role_before_deactivation: 'manager' } }))
        .parkRole,
    ).toBe('manager');
  });
});

describe('reactivationPlan — unban → restore role → record, only what is missing', () => {
  it('runs all three on a deactivated account, restoring the parked role', () => {
    expect(reactivationPlan(stores({ banned: true, profileRole: 'customer', account: deactivated }))).toEqual({
      steps: ['unban', 'restore_role', 'record'],
      restoreRole: 'manager',
    });
  });

  it('finishes each half-done state, and does nothing on an active one', () => {
    // Unbanned and restored, row still deactivated.
    expect(reactivationPlan(stores({ banned: false, profileRole: 'manager', account: deactivated })).steps).toEqual(['record']);
    // A deactivate that only banned.
    expect(reactivationPlan(stores({ banned: true }))).toEqual({ steps: ['unban'], restoreRole: 'staff' });
    // An old half-deactivation that demoted without parking: back to 'staff'.
    expect(reactivationPlan(stores({ banned: true, profileRole: 'customer' }))).toEqual({
      steps: ['unban', 'restore_role'],
      restoreRole: 'staff',
    });
    expect(reactivationPlan(stores()).steps).toEqual([]);
  });

  it('the parked role wins while the row says deactivated (the owner may have edited it)', () => {
    const edited = { status: 'deactivated', role_before_deactivation: 'manager' };
    expect(reactivationPlan(stores({ banned: true, profileRole: 'staff', account: edited }))).toEqual({
      steps: ['unban', 'restore_role', 'record'],
      restoreRole: 'manager',
    });
  });

  it('never touches an owner\'s role', () => {
    expect(reactivationPlan(stores({ profileRole: 'owner', account: deactivated })).steps).toEqual(['record']);
  });
});
