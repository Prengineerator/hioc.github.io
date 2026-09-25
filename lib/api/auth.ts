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
 * Who counts as "behind the counter" — owner and manager inherit everything
 * plain staff can do. Exported so a route that has already loaded the role (to
 * avoid a second session round-trip) asks the same question the gates below do
 * rather than re-listing the roles and eventually missing one.
 */
export function isStaffRole(role: UserRole | null): boolean {
  return role === 'staff' || role === 'owner' || role === 'manager';
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
  return isStaffRole(role) ? user : null;
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
  if (!isStaffRole(role)) return null;
  return { user, role: role as UserRole };
}

/**
 * PIN-3 — additive. Resolves a classic Supabase staff session FIRST, via
 * getStaffOrOwner() exactly unchanged: nothing about that path is touched by
 * this function existing, and every test that already covers a session-based
 * caller keeps meaning what it always meant. Only when there is NO classic
 * session does this fall through to the device+operator cookie pair
 * (lib/api/operator.ts): a valid, unrevoked enrolled device whose id matches
 * the operator JWT's `dev` claim, and an operator still holding an active
 * staff/manager/owner role, re-read from `profiles` on every call (never
 * cached — E3: a role change mid-shift takes effect on the very next
 * request, same posture as hasPermission()). An owner's OWN role is capped
 * to 'manager' for this path (lib/api/operator.ts) — see D6-6 note there.
 *
 * `via` tells a caller which path answered, for the rare case that matters
 * (PIN-4 attribution surfaces that want to say "via PIN switch"); most
 * callers only need `.user` and `.role` and can otherwise treat this exactly
 * like getStaffOrOwner()'s result.
 *
 * D6-6 (CRITICAL, never relax this): this function is for STAFF surfaces
 * ONLY. `/owner/**` and every `app/api/owner/**` route must keep calling
 * getOwnerUser() and must never be migrated to this — a 4-digit PIN on
 * shared hardware must never reach payroll or settings.
 */
export async function getCounterActor(): Promise<{ user: User; role: UserRole; via: 'session' | 'device' } | null> {
  const classic = await getStaffOrOwner();
  if (classic) return { ...classic, via: 'session' };

  // Deferred import: lib/api/operator.ts pulls in next/headers' cookies() and
  // the admin Supabase client, which this module otherwise has no reason to
  // load for every caller of getAuthUser()/getStaffUser() etc. — those stay
  // exactly as cheap as they were before this function existed.
  const { resolveOperatorActor } = await import('@/lib/api/operator');
  const operator = await resolveOperatorActor();
  if (!operator) return null;
  return { ...operator, via: 'device' };
}

/**
 * Like getManagerUser(), but additive over getCounterActor(): a classic
 * session first, an enrolled device's PIN operator otherwise. Passes for
 * 'manager' or 'owner' (a device operator's role is already capped to
 * 'manager' at most — see getCounterActor()'s own note), refuses 'staff'.
 *
 * For a route whose existing gate is a plain role check (getManagerUser()),
 * not the hasPermission() matrix — e.g. cash-counts' history view — this is
 * the direct drop-in that adds the device path without inventing a
 * permission-matrix key for something that was never one.
 */
export async function getCounterManager(): Promise<{ user: User; role: UserRole; via: 'session' | 'device' } | null> {
  const actor = await getCounterActor();
  if (!actor) return null;
  return actor.role === 'manager' || actor.role === 'owner' ? actor : null;
}
