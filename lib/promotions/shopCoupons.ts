// Shop coupon lookup (E7). The shop's counterpart of validateAndComputeCoupon in coupons.ts:
// it answers "may this customer use this code in the shop, and on what terms?", and hands the
// terms to lib/shop/pricing.ts, which does the money (minimum order, product scope, the cap).
// Min order and product scope are deliberately NOT checked here: only the cart lines know them.
//
// What it does check, in this order: the code exists and works in the shop (a café-only coupon
// is "not valid" here, the same as a code that was never made), the phone lock, the dates and
// on/off switch, then usage limits through coupon_usage_counts (café + paid shop redemptions,
// by account, or by phone for a guest). Nothing is written: the redemption is recorded at
// payment capture. A database without coupons.channel has no shop coupons at all.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { PHONE_LOCK_REASON, redeemerHoldsAssignedPhone } from '@/lib/promotions/coupons';
import { couponChannelOf, couponCodePattern, couponWindowProblem, couponWorksIn, toShopCouponTerms } from '@/lib/promotions/couponRules';
import type { Coupon } from '@/lib/types';
import type { ShopCouponTerms } from '@/lib/shop/types';

export interface ShopCouponCtx {
  userId: string | null;
  /** +91XXXXXXXXXX */
  phone: string | null;
  email: string | null;
}

export type ShopCouponLookup = { ok: true; terms: ShopCouponTerms } | { ok: false; reason: string };

const NOT_VALID = "That code isn't valid";
const TRY_AGAIN = 'Could not check this code — please try again';

type Usage = { ok: true; total: number; mine: number } | { ok: false };

async function usageFor(admin: SupabaseClient, couponId: string, ctx: ShopCouponCtx): Promise<Usage> {
  const { data, error } = await admin.rpc('coupon_usage_counts', {
    p_coupon_id: couponId,
    p_user_id: ctx.userId,
    p_phone: ctx.phone,
  });
  if (error) {
    console.error('shop coupons: usage count failed', error);
    return { ok: false };
  }
  const first = (Array.isArray(data) ? data[0] : data) as { total_used?: number; mine_used?: number } | null;
  return { ok: true, total: Number(first?.total_used ?? 0), mine: Number(first?.mine_used ?? 0) };
}

/** Look a typed code up for the shop. */
export async function findShopCoupon(
  admin: SupabaseClient,
  code: string,
  ctx: ShopCouponCtx,
  nowMs: number = Date.now(),
): Promise<ShopCouponLookup> {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) return { ok: false, reason: 'Enter a code' };

  // Escaped pattern, so '%' / '_' typed by a visitor cannot probe for codes; null = never a code.
  const pattern = couponCodePattern(trimmed);
  if (pattern === null) return { ok: false, reason: NOT_VALID };

  const { data, error } = await admin.from('coupons').select('*').ilike('code', pattern).maybeSingle();
  if (error) {
    // Shop coupons need the migration: without coupons.channel there are none.
    if (isMissingColumnError(error)) return { ok: false, reason: NOT_VALID };
    console.error('shop coupons: lookup failed', error);
    return { ok: false, reason: TRY_AGAIN };
  }
  if (!data) return { ok: false, reason: NOT_VALID };
  const coupon = data as Coupon;
  // Second check: the row must really be the typed code, whatever the pattern matched.
  if (String(coupon.code).toLowerCase() !== trimmed.toLowerCase()) return { ok: false, reason: NOT_VALID };
  if (!couponWorksIn(coupon, 'shop')) return { ok: false, reason: NOT_VALID };

  // Phone lock first, never naming the number.
  if (coupon.assigned_phone) {
    const holds = await redeemerHoldsAssignedPhone(admin as never, ctx.userId, coupon.assigned_phone);
    if (holds === 'error') return { ok: false, reason: TRY_AGAIN };
    if (!holds) return { ok: false, reason: PHONE_LOCK_REASON };
  }

  const windowProblem = couponWindowProblem(coupon, nowMs);
  if (windowProblem) return { ok: false, reason: windowProblem };

  if (coupon.usage_limit > 0 || coupon.per_user_limit > 0) {
    if (coupon.per_user_limit > 0 && !ctx.userId && !ctx.phone) {
      return { ok: false, reason: 'Add your phone number to use this code' };
    }
    const usage = await usageFor(admin, coupon.id, ctx);
    if (!usage.ok) return { ok: false, reason: TRY_AGAIN };
    if (coupon.usage_limit > 0 && usage.total >= coupon.usage_limit) {
      return { ok: false, reason: 'This code has been fully used' };
    }
    if (coupon.per_user_limit > 0 && usage.mine >= coupon.per_user_limit) {
      return { ok: false, reason: "You've already used this code" };
    }
  }

  return { ok: true, terms: toShopCouponTerms(coupon) };
}

/**
 * Auto-apply shop coupons this customer can use right now: active, in their window, not tied to
 * a phone, and not used up for them. Pricing picks the best one for the cart. Any failure gives
 * [] (logged): a missing discount must never block checkout.
 */
export async function loadAutoShopCoupons(
  admin: SupabaseClient,
  ctx: ShopCouponCtx,
  nowMs: number = Date.now(),
): Promise<ShopCouponTerms[]> {
  const { data, error } = await admin
    .from('coupons')
    .select('*')
    .eq('active', true)
    .eq('is_auto', true)
    .in('channel', ['shop', 'both'])
    .is('assigned_phone', null);
  if (error) {
    if (!isMissingColumnError(error)) console.error('shop coupons: auto-apply load failed', error);
    return [];
  }

  const out: ShopCouponTerms[] = [];
  for (const row of (data ?? []) as Coupon[]) {
    if (!row.is_auto || !row.active || couponChannelOf(row) === 'cafe' || row.assigned_phone) continue;
    if (couponWindowProblem(row, nowMs)) continue;
    if (row.usage_limit > 0 || row.per_user_limit > 0) {
      if (row.per_user_limit > 0 && !ctx.userId && !ctx.phone) continue;
      const usage = await usageFor(admin, row.id, ctx);
      if (!usage.ok) continue;
      if (row.usage_limit > 0 && usage.total >= row.usage_limit) continue;
      if (row.per_user_limit > 0 && usage.mine >= row.per_user_limit) continue;
    }
    out.push(toShopCouponTerms(row));
  }
  return out;
}
