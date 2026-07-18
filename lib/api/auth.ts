// Session verification for Route Handlers.

import type { User } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import type { ActorRole, UserRole } from '@/lib/types';

/**
 * Looks up the caller's `profiles.role`. Returns null when there's no session
 * or no profile row (the on-signup trigger defaults everyone to 'customer',
 * so a missing row is treated as 'customer' by callers).
 */
export async function getUserRole(user: User): Promise<UserRole | null> {
  const supabase = createServerSupabaseClient();
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    console.error('getUserRole: profiles role lookup failed', error);
    return null;
  }
  return (profile?.role as UserRole) ?? 'customer';
}

// Map a UserRole to the ActorRole recorded on lifecycle events. manager maps to
// 'owner' so managers inherit owner-level state-machine overrides (FND-5); the
// events table's actor_id still records the real user for attribution.
export function actorRoleFor(role: UserRole): ActorRole {
  return role === 'owner' || role === 'manager' ? 'owner' : 'staff';
}

/**
 * Verifies the caller's Supabase auth session server-side (cookie-based).
 * Uses `getUser()` rather than `getSession()` — it re-validates the JWT
 * against the Supabase Auth server instead of trusting an unverified cookie
 * payload, which is the correct check for any authenticated route.
 *
 * Returns the authenticated `User` — staff OR customer — on success, or
 * `null` if there is no valid session. Use this for routes any signed-in
 * user may call; use `getStaffUser()` below for staff-only routes.
 */
export async function getAuthUser(): Promise<User | null> {
  const supabase = createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return null;
  }
  return user;
}

/**
 * Like `getAuthUser()`, but additionally requires `profiles.role ===
 * 'staff'`. Customers authenticate through the same Supabase Auth user pool
 * as staff (see supabase/schema.sql's `profiles` table), so this role check
 * is what actually gates staff-only Route Handlers — without it, any
 * logged-in customer would pass an "is there a session" check too.
 *
 * Returns `null` for a valid customer session, not just an anonymous one.
 */
export async function getStaffUser(): Promise<User | null> {
  const user = await getAuthUser();
  if (!user) {
    return null;
  }

  // owner + manager inherit full access to staff ops, so 'staff', 'owner', and
  // 'manager' pass this gate. Owner-only routes use getOwnerUser(); manager-
  // gated routes (refunds, FND-5) use getManagerUser().
  const role = await getUserRole(user);
  return role === 'staff' || role === 'owner' || role === 'manager' ? user : null;
}

/**
 * Requires `profiles.role` in ('manager', 'owner') — the gate for sensitive
 * actions like refunds, discount overrides, and comping (FND-5). Plain staff
 * do NOT pass.
 */
export async function getManagerUser(): Promise<User | null> {
  const user = await getAuthUser();
  if (!user) return null;
  const role = await getUserRole(user);
  return role === 'manager' || role === 'owner' ? user : null;
}

/**
 * Like `getStaffUser()`, but requires `profiles.role === 'owner'` — the gate
 * for the owner dashboard and settings (F3). Staff sessions do NOT pass.
 */
export async function getOwnerUser(): Promise<User | null> {
  const user = await getAuthUser();
  if (!user) {
    return null;
  }
  const role = await getUserRole(user);
  return role === 'owner' ? user : null;
}

/**
 * Returns the caller and their role in one call — handy for routes that need
 * to record who acted (order transitions) and branch on staff vs owner.
 */
export async function getStaffOrOwner(): Promise<{ user: User; role: UserRole } | null> {
  const user = await getAuthUser();
  if (!user) return null;
  const role = await getUserRole(user);
  if (role !== 'staff' && role !== 'owner' && role !== 'manager') return null;
  return { user, role };
}
