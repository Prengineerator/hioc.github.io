// Everything the server knows when it prices a shop cart (docs/SHOP-V2-SPEC.md
// E1, E2, E2a, E3, E5). serverQuote() is the ONE place the live data is gathered
// and handed to the pure quoteShopCart (lib/shop/pricing.ts), so the quote the
// page shows (POST /api/shop/quote) and the amount checkout charges
// (POST /api/shop/checkout) come from the same code and can't disagree.
//
// It reads, in parallel: the products, the pricing settings, whether this buyer
// may still have the introductory offer, the auto-apply coupons, and for a
// signed-in buyer their Beanies balance, the Beanies rules and whether they have
// bought before. It writes nothing: the intro claim, the coupon redemption and
// the Beanies reservation all happen later (reservation at checkout, the rest at
// payment capture).
//
// Coupons: a typed code is looked up (findShopCoupon) and, if it works on this
// cart, used. If it fails for any reason, the reason comes back as coupon_error
// and the best auto coupon (if any) is used instead, so a typo never costs the
// customer a discount they'd have had anyway.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findShopCoupon, loadAutoShopCoupons } from '@/lib/promotions/shopCoupons';
import { releasableShopBeanies } from './beaniesRelease';
import { getBalance, getLoyaltyConfig } from '@/lib/loyalty/ledger';
import {
  couponSavingFor,
  pickBestAutoCoupon,
  quoteShopCart,
  type BeaniesContext,
  type CartItem,
  type ShopQuoteV2,
} from './pricing';
import { isIntroOfferEligible, isRepeatCustomer, loadShopPricingSettings, loadShopProducts, SHOP_V2_MIGRATION_HINT } from './server';
import type { ShopCouponTerms, ShopProduct, ShopSettings } from './types';

export interface ShopBuyer {
  userId: string | null;
  /** +91XXXXXXXXXX */
  phone: string | null;
  email: string | null;
}

export interface QuoteRequest {
  items: CartItem[];
  buyer: ShopBuyer;
  coupon_code: string | null;
  use_beanies: boolean;
  /**
   * Quote only: count Beanies held by the buyer's own releasable pending orders
   * (lib/shop/beaniesRelease.ts) as available, because checkout releases them
   * first. Checkout itself leaves this off: it has already released what it can,
   * so what is still held (a payment in flight) must not be counted.
   */
  count_releasable_beanies?: boolean;
  /** Owner-entered orders only (lib/shop/pricing.ts): whole rupees, at most 50% of the goods after offers. */
  owner_discount_inr?: number;
}

export type ServerQuote =
  | { ok: true; quote: ShopQuoteV2; coupon_error: string | null; settings: ShopSettings; products: ShopProduct[] }
  | { ok: false; status: 400 | 503; error: string };

export async function serverQuote(admin: SupabaseClient, req: QuoteRequest): Promise<ServerQuote> {
  const { buyer } = req;
  const signedIn = Boolean(buyer.userId);

  const [products, settings, introEligible, autoCoupons, balance, config, repeat] = await Promise.all([
    loadShopProducts(admin),
    loadShopPricingSettings(admin),
    isIntroOfferEligible(admin, buyer),
    loadAutoShopCoupons(admin, buyer),
    buyer.userId ? getBalance(buyer.userId) : Promise.resolve(0),
    getLoyaltyConfig(),
    buyer.userId ? isRepeatCustomer(admin, buyer.userId) : Promise.resolve(false),
  ]);
  // What checkout will free up first, so the quote shows the balance as it will be then.
  const releasable = buyer.userId && req.count_releasable_beanies ? await releasableShopBeanies(admin, buyer.userId) : 0;
  if (!products.ok) {
    return {
      ok: false,
      status: 503,
      error: products.missingSchema ? `The shop isn't open yet — ${SHOP_V2_MIGRATION_HINT}` : 'Could not load the shop just now — please try again.',
    };
  }

  const beanies: BeaniesContext | null = config
    ? {
        signed_in: signedIn,
        repeat_customer: repeat,
        balance: signedIn ? balance + releasable : 0,
        min_redeem_points: config.min_redeem_points,
        inr_per_point: config.inr_per_point,
        points_per_inr: config.points_per_inr,
        use: req.use_beanies,
      }
    : null;

  const base = { products: products.products, items: req.items, settings, intro_eligible: introEligible, beanies, owner_discount_inr: req.owner_discount_inr };

  // A first pass without a coupon prices the lines (and refuses a bad cart), so
  // a coupon can be checked against what is really in the cart.
  const first = quoteShopCart({ ...base, coupon: null });
  if (!first.ok) return { ok: false, status: 400, error: first.error };

  let coupon: ShopCouponTerms | null = null;
  let coupon_error: string | null = null;
  const code = req.coupon_code?.trim() || null;
  if (code) {
    const found = await findShopCoupon(admin, code, buyer);
    if (found.ok) {
      const saving = couponSavingFor(found.terms, first.lines);
      if (saving.ok) coupon = found.terms;
      else coupon_error = saving.reason;
    } else {
      coupon_error = found.reason;
    }
  }
  if (!coupon) coupon = pickBestAutoCoupon(autoCoupons, first.lines)?.terms ?? null;

  const final = coupon ? quoteShopCart({ ...base, coupon }) : first;
  if (!final.ok) return { ok: false, status: 400, error: final.error };
  const { ok: _ok, ...quote } = final;
  void _ok;
  return { ok: true, quote, coupon_error, settings, products: products.products };
}
