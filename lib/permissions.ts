// Owner-configurable permission matrix (FND3-6).
//
// A single hasPermission() helper backs every Phase-3 sensitive gate, replacing
// hard-coded role checks. It consults the role_permissions table (seeded with
// the D4 defaults) on EVERY call — no cache — so an owner flipping a permission
// mid-shift takes effect on the next action (FND3-6 AC / edge case). Invariants
// are enforced HERE, not in the DB: owner ALWAYS passes; nothing is grantable to
// customers; and any unknown / missing / corrupt key fails CLOSED to manager-and-up.

import type { User } from '@supabase/supabase-js';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getUserRole } from '@/lib/api/auth';
import type { PermissionKey, PermissionMinRole, RolePermission } from '@/lib/types';

// The 8 defined sensitive-action keys (must match the role_permissions seed and
// the PermissionKey union in lib/types.ts). Used to validate owner edits and to
// build a complete matrix for the grid.
export const KNOWN_PERMISSION_KEYS: PermissionKey[] = [
  'pos_order_entry',
  'settle_payment',
  'menu_edit',
  'cash_day_open',
  'void_line',
  'comp_order',
  'refund',
  'cash_day_close',
];

// The D4 defaults — the source of truth for filling any key whose row is missing
// from role_permissions (money-touching actions = manager; routine ops = staff).
export const DEFAULT_MIN_ROLE: Record<PermissionKey, PermissionMinRole> = {
  pos_order_entry: 'staff',
  settle_payment: 'staff',
  menu_edit: 'staff',
  cash_day_open: 'staff',
  void_line: 'manager',
  comp_order: 'manager',
  refund: 'manager',
  cash_day_close: 'manager',
};

// Rank ladder for the min_role comparison. owner is handled before this is used
// (owner always passes); customer/anon are never grantable and never reach here.
const ROLE_RANK: Record<string, number> = { staff: 1, manager: 2, owner: 3 };

function isMinRole(value: unknown): value is PermissionMinRole {
  return value === 'staff' || value === 'manager';
}

/**
 * Resolves whether `user` may perform the sensitive action `key`.
 *
 * - No user (anon) → false.
 * - owner → true for EVERY key, even unknown ones (owner invariant).
 * - customer (or an errored role read) → false — nothing is grantable to customers.
 * - staff / manager → compared against the key's required min_role, read FRESH
 *   from role_permissions on every call (no cache — flips take effect immediately).
 * - A missing row, a read error, or a corrupt min_role → fails CLOSED to
 *   'manager' (staff denied, manager/owner allowed).
 */
export async function hasPermission(user: User | null, key: string): Promise<boolean> {
  if (!user) return false;

  const role = await getUserRole(user);
  if (role === 'owner') return true; // owner always has every permission
  if (role !== 'staff' && role !== 'manager') return false; // customer / null / anything else

  const requiredMinRole = await getRequiredMinRole(key);
  return ROLE_RANK[role] >= ROLE_RANK[requiredMinRole];
}

// Fresh per-request read of one key's required min_role. Fails CLOSED to
// 'manager' on a missing row, a read error, or an out-of-range value.
async function getRequiredMinRole(key: string): Promise<PermissionMinRole> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('role_permissions')
    .select('min_role')
    .eq('permission_key', key)
    .maybeSingle();

  const minRole = (data as { min_role?: unknown } | null)?.min_role;
  if (error || !isMinRole(minRole)) {
    return 'manager'; // fail closed
  }
  return minRole;
}

/**
 * Returns the full permission matrix for the owner grid: every KNOWN key with
 * its current min_role, filling the D4 default for any key that has no row yet
 * (so the grid is always complete). Rows for keys not in KNOWN_PERMISSION_KEYS
 * are ignored.
 */
export async function getPermissionMatrix(): Promise<RolePermission[]> {
  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from('role_permissions')
    .select('permission_key, min_role, updated_by, updated_at');

  const byKey = new Map<string, RolePermission>();
  for (const row of (data ?? []) as RolePermission[]) {
    byKey.set(row.permission_key, row);
  }

  return KNOWN_PERMISSION_KEYS.map((key) => {
    const existing = byKey.get(key);
    if (existing && isMinRole(existing.min_role)) return existing;
    return {
      permission_key: key,
      min_role: DEFAULT_MIN_ROLE[key],
      updated_by: null,
      updated_at: '',
    } satisfies RolePermission;
  });
}
