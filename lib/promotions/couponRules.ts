// Coupon channel rules shared by the café validator (lib/promotions/coupons.ts), the shop
// lookup (lib/promotions/shopCoupons.ts), the owner form and the API validation (E7).
//
// PURE and client-safe: no database, no 'server-only'. Both sides call the same helpers so
// "does this coupon work here?" and "is it inside its dates?" can never drift apart between
// the café and the shop. Every coupon that predates the shop migration has no `channel`
// and is café-only, so a missing or unknown value always reads as 'cafe'.

import type { Coupon, CouponChannel } from '@/lib/types';
import type { ShopCouponTerms } from '@/lib/shop/types';

/** The label the owner sees for each channel. */
export const CHANNEL_LABEL: Record<CouponChannel, string> = {
  cafe: 'Café',
  shop: 'Shop',
  both: 'Café + Shop',
};

/** The coupon's channel; missing, null or unknown means 'cafe'. */
export function couponChannelOf(c: { channel?: string | null }): CouponChannel {
  return c.channel === 'shop' || c.channel === 'both' ? c.channel : 'cafe';
}

/** Does this coupon work at the café till / the shop checkout? */
export function couponWorksIn(c: { channel?: string | null }, where: 'cafe' | 'shop'): boolean {
  const channel = couponChannelOf(c);
  return channel === 'both' || channel === where;
}

/** Longest code a lookup will search for; anything longer cannot be a real code. */
export const MAX_COUPON_CODE_LENGTH = 40;

/**
 * The pattern to hand to `.ilike('code', ...)` so it matches ONE code exactly (ignoring case).
 * ilike treats `%` and `_` as wildcards (and PostgREST also treats `*` as one), and the lookup
 * is public, so a typed 'A%' would otherwise probe for codes a letter at a time. `\`, `%` and
 * `_` are escaped with a backslash. Returns null when the code must not be searched at all
 * (it contains `*`, or is longer than 40 characters): the caller answers "not valid" with no
 * query. Callers must also compare the fetched row's code to the typed one as a second check.
 */
export function couponCodePattern(code: string): string | null {
  if (typeof code !== 'string') return null;
  if (code.length > MAX_COUPON_CODE_LENGTH || code.includes('*')) return null;
  return code.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Why a coupon cannot be used right now because of its on/off switch or dates, or null when
 * it is inside its window. The café's existing wording, reused by the shop.
 */
export function couponWindowProblem(
  c: Pick<Coupon, 'active' | 'valid_from' | 'valid_to'>,
  nowMs: number,
): string | null {
  if (!c.active) return 'This coupon is no longer active';
  if (c.valid_from && nowMs < Date.parse(c.valid_from)) return 'This coupon is not active yet';
  if (c.valid_to && nowMs > Date.parse(c.valid_to)) return 'This coupon has expired';
  return null;
}

/** Shop product ids the coupon is limited to; empty means every shop product. */
export function shopScopeOf(c: Pick<Coupon, 'scope'>): string[] {
  const ids = c.scope?.shop_product_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** What shop pricing needs to know about a coupon. */
export function toShopCouponTerms(c: Coupon): ShopCouponTerms {
  return {
    id: c.id,
    code: c.code,
    discount_type: c.discount_type,
    discount_value: c.discount_value,
    min_order_inr: c.min_order_inr,
    max_discount_inr: c.max_discount_inr,
    shop_product_ids: shopScopeOf(c),
    is_auto: c.is_auto,
  };
}
