import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';

// Unit test for hasPermission() (FND3-6). Mocks getUserRole (the fresh
// per-request role read) and the service-role role_permissions read so the
// helper's decision logic — owner/customer invariants, the rank comparison, and
// fail-closed-to-manager on a missing / errored / corrupt key — is exercised in
// isolation, no live DB.

// Shared, per-test mutable state the mocks read from.
const state: {
  role: string | null;
  permRow: { min_role?: unknown } | null;
  permError: unknown;
} = { role: null, permRow: null, permError: null };

vi.mock('@/lib/api/auth', () => ({
  getUserRole: () => Promise.resolve(state.role),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: state.permRow, error: state.permError }),
      });
      return chain;
    },
  }),
}));

// Imported after mocks are registered (vi.mock is hoisted).
const { hasPermission } = await import('@/lib/permissions');

const USER = { id: 'u1' } as unknown as User;

beforeEach(() => {
  state.role = 'staff';
  state.permRow = { min_role: 'staff' };
  state.permError = null;
});

describe('hasPermission', () => {
  it('denies an anonymous caller (no user) — never reads role or matrix', async () => {
    expect(await hasPermission(null, 'refund')).toBe(false);
  });

  it('grants owner every permission — even an unknown key with no row', async () => {
    state.role = 'owner';
    state.permRow = null;
    expect(await hasPermission(USER, 'totally_unknown_key')).toBe(true);
    expect(await hasPermission(USER, 'refund')).toBe(true);
  });

  it('denies a customer everything, even a staff-gated key', async () => {
    state.role = 'customer';
    state.permRow = { min_role: 'staff' };
    expect(await hasPermission(USER, 'menu_edit')).toBe(false);
  });

  it('denies when the role read errors out (getUserRole → null)', async () => {
    state.role = null;
    state.permRow = { min_role: 'staff' };
    expect(await hasPermission(USER, 'menu_edit')).toBe(false);
  });

  it('lets staff pass a staff-gated key', async () => {
    state.role = 'staff';
    state.permRow = { min_role: 'staff' };
    expect(await hasPermission(USER, 'menu_edit')).toBe(true);
  });

  it('denies staff a manager-gated key', async () => {
    state.role = 'staff';
    state.permRow = { min_role: 'manager' };
    expect(await hasPermission(USER, 'refund')).toBe(false);
  });

  it('lets a manager pass both staff- and manager-gated keys', async () => {
    state.role = 'manager';
    state.permRow = { min_role: 'staff' };
    expect(await hasPermission(USER, 'menu_edit')).toBe(true);
    state.permRow = { min_role: 'manager' };
    expect(await hasPermission(USER, 'refund')).toBe(true);
  });

  it('fails CLOSED to manager on a missing key (staff denied, manager allowed)', async () => {
    state.permRow = null; // no row for this key
    state.role = 'staff';
    expect(await hasPermission(USER, 'unknown_key')).toBe(false);
    state.role = 'manager';
    expect(await hasPermission(USER, 'unknown_key')).toBe(true);
  });

  it('fails CLOSED to manager on a read error', async () => {
    state.permRow = null;
    state.permError = { message: 'boom' };
    state.role = 'staff';
    expect(await hasPermission(USER, 'refund')).toBe(false);
    state.role = 'manager';
    expect(await hasPermission(USER, 'refund')).toBe(true);
  });

  it('fails CLOSED to manager on a corrupt / out-of-range min_role', async () => {
    state.permRow = { min_role: 'customer' }; // not 'staff' | 'manager'
    state.role = 'staff';
    expect(await hasPermission(USER, 'refund')).toBe(false);
    state.role = 'manager';
    expect(await hasPermission(USER, 'refund')).toBe(true);
  });
});
