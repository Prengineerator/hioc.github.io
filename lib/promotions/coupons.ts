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
import type { Coupon } from '@/lib/types';

export interface CouponContext {
  subtotalInr: number;
  userId: string | null;
  itemIds: string[];
  categories: string[];
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
  if (coupon.per_user_limit > 0) {
    if (!ctx.userId) {
      return { ok: false, discountInr: 0, reason: 'Log in to use this coupon', coupon };
    }
    const { count, error: userUsageError } = await admin
      .from('coupon_redemptions')
      .select('id, orders!inner(status)', { count: 'exact', head: true })
      .eq('coupon_id', coupon.id)
      .eq('user_id', ctx.userId)
      .not('orders.status', 'in', '("cancelled","rejected")');
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
