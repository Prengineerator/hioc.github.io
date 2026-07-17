// Session verification for Route Handlers.

import type { User } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '@/lib/supabase-server';

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

  const supabase = createServerSupabaseClient();
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (error) {
    // Fails closed either way (returns null below), but logging this means
    // a transient DB/network fault is distinguishable from "this account
    // genuinely isn't staff" in server logs, instead of looking identical.
    console.error('getStaffUser: profiles role lookup failed', error);
  }

  return profile?.role === 'staff' ? user : null;
}
