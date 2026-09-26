// VAL-2 — matching the phone a staffer typed at the counter to a customer's
// account, so a regular earns and can spend at the till.
//
// Every caller goes through here, because this is where two mistakes are
// refused once instead of three times:
//
//  1. The beneficiary is NEVER read from a request body. It is derived, here,
//     from the phone number and nothing else. A client that could name whose
//     account an order belongs to could spend any customer's points — the same
//     reason orders.user_id has always come from the verified session rather
//     than the payload (app/api/orders/route.ts).
//
//  2. Only a VERIFIED phone links. profiles.phone is free text a customer types
//     into their own account, so an unverified match means no more than "some
//     account claims this number" — which is exactly what a typo, or someone
//     entering a stranger's number, produces. The OTP-verified number is the
//     only proof, and it is unique across accounts by construction
//     (idx_profiles_phone_verified_unique, supabase/2026-07-phone-unique.sql).
//
// POS-ACC — a walk-in whose number has no account yet gets one, opened by the
// order itself (createCounterCustomer below): the counter is where most
// customers first hand over their number, and an account that only exists once
// they find the app would lose every point they earned before that. The number
// is taken as the customer's because they gave it to a staffer in person — the
// same trust the counter's WhatsApp bill already places in it. Nobody can sign
// in to such an account without a code sent to that number, so a mistyped digit
// at worst files one order's points under the wrong number; it never exposes
// anyone's account.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeIndianMobile } from '@/lib/phone';

export interface LinkedCustomer {
  userId: string;
  /** Shown to the staffer so a mistyped digit is caught before it takes effect. */
  name: string;
}

/**
 * Converts anything a staffer might type into the E.164 form both
 * `orders.customer_phone` and `profiles.phone` are stored in, or null if it
 * isn't a valid Indian mobile number.
 */
export function toStoredPhone(input: unknown): string | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  const normalized = normalizeIndianMobile(input);
  return normalized ? `+91${normalized}` : null;
}

/**
 * The customer account owning `phoneE164`, or null when there is none.
 *
 * `phoneE164` must already be stored form ("+919876543210") — pass it through
 * `toStoredPhone` first if it came from a human.
 */
export async function findVerifiedCustomerByPhone(
  admin: SupabaseClient,
  phoneE164: string | null,
): Promise<LinkedCustomer | null> {
  if (!phoneE164) return null;

  // limit(2), not maybeSingle(): the partial unique index makes a second
  // verified holder of one number impossible, but if it were ever missing from
  // an environment we must not pick one of two at random and spend a stranger's
  // points. Ambiguity fails closed and says so.
  const { data, error } = await admin
    .from('profiles')
    .select('id, name')
    .eq('phone', phoneE164)
    .eq('phone_verified', true)
    .limit(2);

  if (error) {
    console.error('findVerifiedCustomerByPhone: lookup failed', error);
    return null;
  }

  const rows = (data ?? []) as { id: string; name: string | null }[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.error(
      'findVerifiedCustomerByPhone: more than one VERIFIED account holds this number — ' +
        'refusing to guess. Is supabase/2026-07-phone-unique.sql applied?',
    );
    return null;
  }

  return { userId: rows[0].id, name: (rows[0].name ?? '').trim() };
}

/**
 * Wraps a value in PostgREST's double-quoted-literal syntax, for embedding in
 * a raw `.or()`/`.in()` filter string. Not strictly required for a plain
 * digit string (none of the characters `.or()`'s own parser treats specially
 * — comma, period, parentheses — appear in a phone number), but `+` is the
 * one character that a naive/double URL-decode could turn into a space, and
 * quoting removes that ambiguity outright rather than leaning on supabase-js
 * encoding it correctly (it does: `.or()` appends through `URLSearchParams`,
 * which percent-encodes a literal `+` to `%2B` — but this is what PostgREST's
 * own docs recommend for any value that isn't a bare identifier or number,
 * and costs nothing to do here too).
 */
function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The `.or()` expression for "every order that belongs to whoever this phone
 * belongs to" — the read side of `loyaltyUserIdFor` (lib/loyalty/
 * beneficiary.ts writes that same relationship onto an order at creation
 * time; this finds every order it was written onto). Used by both
 * GET /api/customers/lookup (to count past orders) and GET /api/customers/
 * orders (to list them), so the two can never disagree about whose history a
 * phone number surfaces.
 *
 * `phoneE164` must already be stored form (`+91XXXXXXXXXX`); `accountUserId`
 * is the linked account's id from `findVerifiedCustomerByPhone`, or null when
 * the phone matches no verified account. With no account, only the phone
 * itself counts — a counter order is filed under `customer_phone` regardless
 * of who typed it, so this deliberately does NOT fall back to `user_id`/
 * `customer_user_id` being null (that would match every unrelated guest order
 * in the building).
 *
 * `customer_phone` is matched against BOTH the `+91`-prefixed form every
 * order since `toStoredPhone` shipped is written in, and the bare 10-digit
 * form a handful of older rows still store — an order predating that
 * normalization must not silently vanish from someone's order_count or
 * "Last orders" list just because its format is a year out of date.
 */
export function orderMatchFilter(phoneE164: string, accountUserId: string | null): string {
  const bareDigits = phoneE164.startsWith('+91') ? phoneE164.slice(3) : phoneE164;
  const phoneVariants = [...new Set([phoneE164, bareDigits])].map(quotePostgrestValue).join(',');
  const clauses = [`customer_phone.in.(${phoneVariants})`];
  if (accountUserId) {
    clauses.push(`customer_user_id.eq.${accountUserId}`, `user_id.eq.${accountUserId}`);
  }
  return clauses.join(',');
}

export interface CounterCustomer extends LinkedCustomer {
  /** True when this call opened the account (vs. adopting an existing one). */
  created: boolean;
}

/** GoTrue's "this phone already belongs to a user" refusal. */
function isPhoneTaken(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === 'phone_exists' || error.code === 'user_already_exists') return true;
  return /already (been )?registered|already exists/i.test(error.message ?? '');
}

/**
 * Opens a customer account for a number given at the counter (POS-ACC), or
 * adopts the unverified Auth user that already holds it, and returns it linked.
 *
 * Call only after `findVerifiedCustomerByPhone` came back empty, from a staff
 * order, with `phoneE164` in stored form. Returns null — and the order simply
 * proceeds unlinked — on any failure: a counter must never refuse a paying
 * customer because an account could not be opened.
 *
 * What it writes:
 *  - an Auth user with the phone confirmed, so a later WhatsApp-code sign-in
 *    with the same number lands on THIS account rather than a new one;
 *    app_metadata records that the counter opened it, and which staffer;
 *  - profiles.phone / phone_verified (the profile row itself comes from the
 *    on_auth_user_created trigger), plus the name when the profile has none.
 *
 * Only a `customer` profile is ever adopted: a staff login that happens to hold
 * the number is not a loyalty account.
 */
export async function createCounterCustomer(
  admin: SupabaseClient,
  phoneE164: string | null,
  opts: { name: string; staffUserId: string | null },
): Promise<CounterCustomer | null> {
  if (!phoneE164) return null;
  const name = opts.name.trim();

  let userId: string | null = null;
  let created = false;
  try {
    const { data, error } = await admin.auth.admin.createUser({
      phone: phoneE164,
      phone_confirm: true,
      user_metadata: name ? { name } : {},
      app_metadata: { created_via: 'staff_pos', created_by: opts.staffUserId },
    });
    if (data?.user) {
      userId = data.user.id;
      created = true;
    } else if (isPhoneTaken(error)) {
      // Someone requested a login code for this number and never entered it —
      // the Auth user exists, unverified. It is this same number's account.
      const { data: existingId, error: rpcError } = await admin.rpc('auth_user_id_for_phone', {
        p_phone: phoneE164,
      });
      if (rpcError) {
        console.error(
          'createCounterCustomer: the number already has a login but it could not be looked up — ' +
            'is supabase/2026-09-counter-accounts.sql applied?',
          rpcError,
        );
        return null;
      }
      userId = typeof existingId === 'string' && existingId ? existingId : null;
    } else {
      console.error('createCounterCustomer: createUser failed', error);
      return null;
    }
  } catch (err) {
    console.error('createCounterCustomer: createUser threw', err);
    return null;
  }
  if (!userId) return null;

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('role, name, phone_verified')
    .eq('id', userId)
    .maybeSingle();
  if (profileError || !profile) {
    console.error('createCounterCustomer: no profile row for the new account', profileError);
    return null;
  }
  const row = profile as { role: string | null; name: string | null; phone_verified: boolean | null };
  if (row.role !== 'customer') {
    console.error('createCounterCustomer: the number belongs to a non-customer login — not linking', userId);
    return null;
  }
  if (row.phone_verified) {
    // Already verified, yet findVerifiedCustomerByPhone found nothing: that
    // lookup failed or refused an ambiguous match. Both fail closed there, so
    // they must not be bypassed here.
    console.error('createCounterCustomer: verified account the lookup did not return — not linking', userId);
    return null;
  }

  const existingName = (row.name ?? '').trim();
  const { error: updateError } = await admin
    .from('profiles')
    .update({ phone: phoneE164, phone_verified: true, ...(name && !existingName ? { name } : {}) })
    .eq('id', userId);
  if (updateError) {
    // 23505: another account verified this number between our lookup and now.
    // Linking either one would be a guess, so the order goes through unlinked.
    // A half-made account self-heals: the next counter order adopts it above.
    console.error('createCounterCustomer: profile update failed', updateError);
    return null;
  }

  return { userId, name: existingName || name, created };
}
