// PIN-3 — resolving the operator cookie against a request, and sliding its
// expiry. The crypto/cookie-shape half is lib/api/operatorCookie.ts (pure,
// tested); this half needs the database and next/headers, so it is
// server-only — same split as lib/api/device.ts / deviceCookie.ts.

import 'server-only';
import type { User } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getEnrolledDevice } from '@/lib/api/device';
import { isStaffRole } from '@/lib/api/auth';
import {
  OPERATOR_COOKIE,
  operatorCookieOptions,
  operatorSecretOk,
  signOperatorToken,
  verifyOperatorToken,
} from '@/lib/api/operatorCookie';
import type { OperatorOption, UserRole } from '@/lib/types';

/** OPERATOR_JWT_SECRET, gated through operatorSecretOk() everywhere it's
 * used — with it missing or short, every function below is a no-op/null, per
 * PIN-3's "the whole PIN feature reports disabled; nothing breaks". */
function secret(): string | undefined {
  return process.env.OPERATOR_JWT_SECRET;
}

/** Whether the whole feature has what it needs to run at all — used by the
 * lock-screen data (device context) and the owner PIN UI to decide whether to
 * say "not configured" instead of silently doing nothing. Does NOT depend on
 * the NEXT_PUBLIC_FLAG_PIN_SWITCH dark-launch flag — that's a separate,
 * independent gate the callers apply themselves (routes, layout, middleware),
 * exactly as D6-7/PIN-3 describe two different kinds of "off": not configured
 * vs not yet turned on. */
export function operatorFeatureConfigured(): boolean {
  return operatorSecretOk(secret());
}

/** True in production the same way deviceCookieOptions() decides `secure` —
 * used so operatorCookieOptions() gets the same non-Secure-on-localhost
 * escape hatch the device cookie has (a Secure cookie on http://localhost is
 * simply never stored, which would make unlocking silently do nothing). */
function isProd(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function issueOperatorCookieValue(op: string, dev: string): { value: string; iat: number } | null {
  const s = secret();
  if (!operatorSecretOk(s)) return null;
  const iat = Math.floor(Date.now() / 1000);
  return { value: signOperatorToken({ op, dev, iat }, s), iat };
}

export interface OperatorActor {
  user: User;
  role: UserRole;
}

/**
 * The operator this request's cookies resolve to, or null for EVERY failure
 * mode: secret missing/short, no cookie, forged/expired token, device
 * cookie absent or pointing at a different (or revoked) device than the
 * token names, or the operator no longer an active staff role (E3: a role
 * change mid-shift 401s the very next request, because this is read fresh
 * from `profiles` every time — never cached).
 *
 * On success, slides the cookie's expiry (best-effort — a failed re-set here
 * must never fail the request it's riding along on; `cookies().set()` is only
 * legal inside a Route Handler/Server Action, which is the only context this
 * is ever called from).
 */
export async function resolveOperatorActor(): Promise<OperatorActor | null> {
  const s = secret();
  if (!operatorSecretOk(s)) return null;

  const token = cookies().get(OPERATOR_COOKIE)?.value;
  if (!token) return null;

  const payload = verifyOperatorToken(token, s);
  if (!payload) return null;

  const device = await getEnrolledDevice();
  if (!device || device.id !== payload.dev) return null;

  const admin = createAdminSupabaseClient();
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('role')
    .eq('id', payload.op)
    .maybeSingle();
  if (profileError || !profile) return null;
  const realRole = (profile as { role?: string }).role as UserRole | undefined;
  if (!realRole || !isStaffRole(realRole)) return null;

  // D6-6, applied to the operator's OWN role, not just the surface: a 4-digit
  // PIN on shared hardware must never carry full owner authority, even when
  // the person who set it up is genuinely the owner. Capped to 'manager' for
  // every staff-surface purpose (hasPermission() etc.) — owner-only screens
  // and APIs never accept this path at all (they call getOwnerUser(), untouched),
  // so this cap only ever narrows what a device+PIN session can do, never
  // widens it. The real role stays in `profiles` and in the classic-session
  // path (getStaffOrOwner()) exactly as before — an owner who signs in with
  // their password still gets full owner authority everywhere that's legitimate.
  const role: UserRole = realRole === 'owner' ? 'manager' : realRole;

  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(payload.op);
  if (authError || !authUser?.user) return null;

  try {
    const fresh = issueOperatorCookieValue(payload.op, payload.dev);
    if (fresh) {
      cookies().set(OPERATOR_COOKIE, fresh.value, operatorCookieOptions(isProd()));
    }
  } catch (err) {
    // Sliding is a convenience, not a correctness requirement — some call
    // sites (e.g. during static generation) cannot set cookies at all.
    console.error('resolveOperatorActor: could not slide the operator cookie', err);
  }

  return { user: authUser.user, role };
}

/**
 * PIN-3's GET surface: names + ids of active staff who have a PIN set, for
 * the lock screen's tiles. Never touches staff_pins.pin_hash or any lockout
 * state — just which users have a row at all. Deliberately staff-agnostic
 * about the CALLER (the lock screen is shown to someone with no session yet)
 * — callers of this function are responsible for gating on an enrolled
 * device first, exactly like getEnrolledDevice() itself.
 *
 * Includes 'owner' profiles that happen to have a PIN set — safe to offer as
 * a tile because resolveOperatorActor() above caps an owner's OWN role to
 * 'manager' the moment they unlock through this path; tapping this tile can
 * never yield full owner authority on the staff surface.
 */
export async function listOperatorOptions(): Promise<OperatorOption[]> {
  const admin = createAdminSupabaseClient();

  const { data: pinRows, error: pinError } = await admin.from('staff_pins').select('user_id');
  if (pinError) return []; // missing table / any failure -> no tiles, never a leak

  const userIds = [...new Set(((pinRows ?? []) as { user_id: string }[]).map((r) => r.user_id))];
  if (userIds.length === 0) return [];

  const { data: profiles, error: profileError } = await admin
    .from('profiles')
    .select('id, role, name')
    .in('id', userIds)
    .in('role', ['staff', 'manager', 'owner']);
  if (profileError) return [];

  return ((profiles ?? []) as { id: string; role: string; name: string | null }[])
    .map((p) => ({ id: p.id, name: p.name?.trim() || 'Staff' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

