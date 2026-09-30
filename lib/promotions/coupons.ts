// Coupon validation + discount computation (FND-3). Validates a coupon code
// against: active flag, valid_from/valid_to window, min_order_inr, usage_limit
// + per_user_limit (counted from coupon_redemptions), and item/category scope
// — then computes the discount (percent/flat, capped by max_discount_inr).
//
// This is a pure VALIDATE + QUOTE function — it does not write a
// coupon_redemptions row itself. The caller (order creation, owned by the
// Payments pillar) is responsible for re-validating atomically and writing
// the redemption row in the same transaction as the order, which is what
// guards the "race on last remaining use" edge case in the spec.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { normalizeIndianMobileHonouringPlus } from '@/lib/phone';
import type { Coupon } from '@/lib/types';

// Marketing coupons (docs/MARKETING-AGENT-SPEC.md §1.7) are issued to ONE phone.
export const PHONE_LOCK_REASON =
  'This code is linked to another phone number. Log in with the number it was sent to, or show it at the counter.';

export interface CouponContext {
  subtotalInr: number;
  userId: string | null;
  itemIds: string[];
  categories: string[];
  /**
   * The customer phone a COUNTER ACTOR (staff session or enrolled device operator) typed for the
   * order, already normalised. Set ONLY by server code that has just established the caller is an
   * authenticated counter actor (POST /api/orders and /api/orders/quote when getCounterActor() is
   * non-null) — never from a customer web session and never straight from a request body on a
   * customer path, or anyone could "type" the number a forwarded code was sent to.
   *
   * It exists for the first-visit customer: a marketing code is locked to a phone, and the account
   * that would prove it (a VERIFIED profile phone) does not exist until the counter order itself
   * opens it — but the message promised "show it at the counter". A staffer looking at the
   * customer, with the number in the POS, is that proof.
   */
  counterPhone?: string | null;
}

export interface CouponResult {
  ok: boolean;
  discountInr: number;
  coupon?: Coupon;
  reason?: string; // human-readable reason when !ok
}

export async function validateAndComputeCoupon(
  code: string,
  ctx: CouponContext,
): Promise<CouponResult> {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    return { ok: false, discountInr: 0, reason: 'Enter a coupon code' };
  }
  if (!Number.isFinite(ctx.subtotalInr) || ctx.subtotalInr <= 0) {
    return { ok: false, discountInr: 0, reason: 'Your cart is empty' };
  }

  const admin = createAdminSupabaseClient();

  const { data: row, error } = await admin
    .from('coupons')
    .select('*')
    .ilike('code', trimmed)
    .maybeSingle();

  if (error) {
    console.error('validateAndComputeCoupon: lookup failed', error);
    return { ok: false, discountInr: 0, reason: 'Could not validate coupon — please try again' };
  }
  if (!row) {
    return { ok: false, discountInr: 0, reason: 'Invalid coupon code' };
  }
  const coupon = row as Coupon;

  // PHONE LOCK — first, before ANY other rule, and a rejection here deliberately carries no
  // `coupon`: every later rejection returns the coupon row to the client (the checkout shows
  // it), and this row names the phone it was sent to. A forwarded WhatsApp message must be
  // worthless to a stranger AND must not tell them whose it is.
  //
  // The redeemer must be a signed-in (or counter-linked) user whose VERIFIED profile phone is
  // the assigned one. Unverified does not count: profiles.phone is free text a customer types
  // into their own account, so an unverified match proves nothing (lib/loyalty/customerLink.ts).
  // A database without the column returns `assigned_phone` undefined — no lock, as before.
  let heldViaCounterPhone = false;
  if (coupon.assigned_phone) {
    const locked = await redeemerHoldsAssignedPhone(admin, ctx.userId, coupon.assigned_phone);
    if (locked === 'error') {
      return { ok: false, discountInr: 0, reason: 'Could not validate coupon — please try again' };
    }
    if (!locked) {
      // Second way in: the counter actor typed exactly the assigned number (see CouponContext.counterPhone).
      heldViaCounterPhone = counterPhoneMatches(ctx.counterPhone, coupon.assigned_phone);
      if (!heldViaCounterPhone) return { ok: false, discountInr: 0, reason: PHONE_LOCK_REASON };
    }
  }

  if (!coupon.active) {
    return { ok: false, discountInr: 0, reason: 'This coupon is no longer active', coupon };
  }

  const now = Date.now();
  if (coupon.valid_from && now < Date.parse(coupon.valid_from)) {
    return { ok: false, discountInr: 0, reason: 'This coupon is not active yet', coupon };
  }
  if (coupon.valid_to && now > Date.parse(coupon.valid_to)) {
    return { ok: false, discountInr: 0, reason: 'This coupon has expired', coupon };
  }

  if (coupon.min_order_inr > 0 && ctx.subtotalInr < coupon.min_order_inr) {
    return {
      ok: false,
      discountInr: 0,
      reason: `Minimum order of ₹${coupon.min_order_inr} required for this coupon`,
      coupon,
    };
  }

  // Scope eligibility — empty scope means "whole menu". A non-empty scope
  // requires an overlap with the cart's items OR categories (either list
  // matching is enough; there's no per-line discount here, only a gate).
  const scopedItems = coupon.scope?.item_ids ?? [];
  const scopedCategories = coupon.scope?.category ?? [];
  if (scopedItems.length > 0 || scopedCategories.length > 0) {
    const itemMatch = scopedItems.length > 0 && ctx.itemIds.some((id) => scopedItems.includes(id));
    const categoryMatch =
      scopedCategories.length > 0 && ctx.categories.some((cat) => scopedCategories.includes(cat));
    if (!itemMatch && !categoryMatch) {
      return {
        ok: false,
        discountInr: 0,
        reason: 'This coupon does not apply to the items in your cart',
        coupon,
      };
    }
  }

  // Total usage limit (0 = unlimited).
  if (coupon.usage_limit > 0) {
    // Count only redemptions on orders that weren't cancelled/rejected (H7) —
    // an abandoned/rejected order must not permanently burn a limited coupon.
    const { count, error: usageError } = await admin
      .from('coupon_redemptions')
      .select('id, orders!inner(status)', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id)
      .not('orders.status', 'in', '("cancelled","rejected")');
    if (usageError) {
      console.error('validateAndComputeCoupon: usage count failed', usageError);
      return { ok: false, discountInr: 0, reason: 'Could not validate coupon — please try again', coupon };
    }
    if ((count ?? 0) >= coupon.usage_limit) {
      return { ok: false, discountInr: 0, reason: 'This coupon has reached its usage limit', coupon };
    }
  }

  // Per-user limit (0 = unlimited). A coupon that's per-user-limited requires
  // a logged-in user to enforce — guests can't be identified across orders.
  //
  // The exception is a phone-locked code redeemed by its phone at the counter with no account yet:
  // its one holder is the phone, so EVERY redemption of it is that holder's and the per-user count
  // is simply the coupon's redemption count. (Refusing here would send the first-visit customer
  // away with "Log in", the very thing the counter route exists to avoid.)
  if (coupon.per_user_limit > 0) {
    if (!ctx.userId && !heldViaCounterPhone) {
      return { ok: false, discountInr: 0, reason: 'Log in to use this coupon', coupon };
    }
    let userUsage = admin
      .from('coupon_redemptions')
      .select('id, orders!inner(status)', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id);
    if (ctx.userId) userUsage = userUsage.eq('user_id', ctx.userId);
    const { count, error: userUsageError } = await userUsage.not('orders.status', 'in', '("cancelled","rejected")');
    if (userUsageError) {
      console.error('validateAndComputeCoupon: per-user count failed', userUsageError);
      return { ok: false, discountInr: 0, reason: 'Could not validate coupon — please try again', coupon };
    }
    if ((count ?? 0) >= coupon.per_user_limit) {
      return {
        ok: false,
        discountInr: 0,
        reason: "You've already used this coupon the maximum number of times",
        coupon,
      };
    }
  }

  let discountInr =
    coupon.discount_type === 'percent'
      ? Math.floor((ctx.subtotalInr * coupon.discount_value) / 100)
      : coupon.discount_value;

  if (coupon.max_discount_inr > 0) {
    discountInr = Math.min(discountInr, coupon.max_discount_inr);
  }
  discountInr = Math.max(0, Math.min(discountInr, ctx.subtotalInr));

  if (discountInr <= 0) {
    return {
      ok: false,
      discountInr: 0,
      reason: 'This coupon does not provide a discount for this order',
      coupon,
    };
  }

  return { ok: true, discountInr, coupon };
}

/**
 * Does `userId` hold `assignedPhone` as a VERIFIED profile phone? Both sides are
 * normalised (a stored '+919876543210' and a bare '9876543210' are the same number).
 * 'error' when the profile could not be read: the caller answers "try again" rather than
 * guessing either way.
 */
async function redeemerHoldsAssignedPhone(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  userId: string | null,
  assignedPhone: string,
): Promise<boolean | 'error'> {
  if (!userId) return false; // a guest cannot prove a phone
  const { data, error } = await admin
    .from('profiles')
    .select('phone, phone_verified')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('validateAndComputeCoupon: phone-lock profile lookup failed', error);
    return 'error';
  }
  const profile = data as { phone: string | null; phone_verified: boolean | null } | null;
  if (!profile || profile.phone_verified !== true || !profile.phone) return false;
  // '+'-aware: a verified '+6581234567' is not the Indian 6581234567 the code was sent to.
  const mine = normalizeIndianMobileHonouringPlus(profile.phone);
  const assigned = normalizeIndianMobileHonouringPlus(assignedPhone);
  return mine !== null && assigned !== null && mine === assigned;
}

/** Did a counter actor type exactly the phone this code is locked to? False for no phone or any mismatch. */
function counterPhoneMatches(counterPhone: string | null | undefined, assignedPhone: string): boolean {
  if (!counterPhone) return false;
  const typed = normalizeIndianMobileHonouringPlus(counterPhone);
  const assigned = normalizeIndianMobileHonouringPlus(assignedPhone);
  return typed !== null && assigned !== null && typed === assigned;
}
