// Shop pricing v2 (docs/SHOP-V2-SPEC.md E1, E2). Pure, client-safe, and shared
// by the /shop page (the running total the customer sees) and
// POST /api/shop/checkout (the amount Razorpay charges), so the two can never
// disagree. The server re-prices from shop_products; the browser's numbers are
// never read. quoteShopCart is the one entry point; the steps run in this order
// and each has its own line on the bill and its own stored column:
//
//   1 subtotal      unit price x quantity of every line, one line per
//                   (product, grind). Instant jars and Home Blend packs alike.
//   2 offer         the introductory offer ("1 for 399 · 2 for 599 · 3 for
//                   749"), only while the customer is eligible (once per
//                   customer, decided by the caller as intro_eligible) and only
//                   on INSTANT units. Home Blend never counts in jar tiers.
//   3 coupon        one auto-apply coupon or one typed code. It does NOT stack
//                   with the offer: the bill takes whichever saves more (a tie
//                   goes to the offer) and says which one it used.
//   4 Beanies       signed-in repeat customers with a balance of at least the
//                   minimum. At most beanies_max_redeem_pct % (5) of the goods
//                   after steps 2 and 3, rounded down to whole Beanies, never
//                   more than the balance. They DO stack with a coupon.
//   5 shipping      shipping_fee_inr, free when the goods after steps 2-4 come
//                   to free_shipping_min_inr (749) or more. It is by goods
//                   value, so it works across both lines: 3 jars at 749 ship
//                   free.
//   6 total         subtotal - (offer + coupon + Beanies) + shipping. Always
//                   more than 0: a coupon is capped at subtotal - 1.
//
// Caps: at most MAX_UNITS_PER_ORDER (12) units and MAX_PARCEL_KG (6) kg of
// goods per order; past either it is a wholesale enquiry (WHOLESALE_MESSAGE).
// Nudges come from the same quote, so they are never wrong.
//
// The v1 pricing functions (priceShopCart, shippingForJars, ...) were removed
// in SV2-14 once /shop and checkout moved to quoteShopCart.
//
// prepaid only    no cash on delivery

import { offerPriceFor } from '@/lib/orders/offers';
import { GRINDS, goodsWeightKg, isGrindCode, lineShipWeightKg, lineSku, MAX_PARCEL_KG } from './catalog';
import type { GrindCode, ShopCouponTerms, ShopLine, ShopOffer, ShopProduct, ShopSettings } from './types';

// ---------------------------------------------------------------------------
// The offer (shop_settings)
// ---------------------------------------------------------------------------

export const MAX_OFFER_TIERS = 6;
export const DEFAULT_OFFER_NAME = 'Introductory offer';

/**
 * Tier prices from the owner or the database → a clean list, or null. Each is
 * a whole rupee amount; 2 to 6 tiers; each tier costs more in all than the one
 * before (2 jars can't cost less than 1).
 */
export function normalizeOfferTiers(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_OFFER_TIERS) return null;
  const tiers: number[] = [];
  for (const v of value) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100000) return null;
    if (tiers.length && n <= tiers[tiers.length - 1]) return null;
    tiers.push(n);
  }
  return tiers;
}

/** The shop_settings row → the live offer, or null when it is off (or unreadable). */
export function shopOfferFromSettings(
  row: { offer_active?: unknown; offer_name?: unknown; offer_tier_prices?: unknown } | null | undefined,
): ShopOffer | null {
  if (!row || row.offer_active !== true) return null;
  const tiers = normalizeOfferTiers(row.offer_tier_prices);
  if (!tiers) return null;
  const name = typeof row.offer_name === 'string' && row.offer_name.trim() ? row.offer_name.trim() : DEFAULT_OFFER_NAME;
  return { name, tier_prices: tiers };
}

/** "1 for ₹399 · 2 for ₹599 · 3 for ₹749" */
export function describeOfferTiers(tiers: readonly number[]): string {
  return tiers.map((p, i) => `${i + 1} for ${rupees(p)}`).join(' · ');
}

/**
 * The tiers that save something against `unitPrice` — what a headline should
 * say: "2 for ₹599 · 3 for ₹749" (1 for ₹399 is just the price).
 */
export function offerDeals(tiers: readonly number[], unitPrice: number): { jars: number; price: number; was: number }[] {
  return tiers
    .map((price, i) => ({ jars: i + 1, price, was: unitPrice * (i + 1) }))
    .filter((t) => t.price < t.was);
}

/** "₹1,197" */
export function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/** "1 jar", "3 jars" */
export function jarsLabel(n: number): string {
  return `${n} ${n === 1 ? 'jar' : 'jars'}`;
}

// ---------------------------------------------------------------------------
// v2: the cart, the settings and quoteShopCart
// ---------------------------------------------------------------------------

export const MAX_UNITS_PER_ORDER = 12;
export const WHOLESALE_MESSAGE =
  'For more than 12 packs or 6 kg in one order, please call or email us — we do wholesale.';

export const DEFAULT_SHOP_SETTINGS: ShopSettings = {
  offer: null,
  shipping_fee_inr: 49,
  free_shipping_min_inr: 749,
  beanies_max_redeem_pct: 5,
};

function wholeNumber(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/** The shop_settings row → settings. Whole numbers are clamped into range; anything unreadable falls back to the default. */
export function shopSettingsFromRow(row: Record<string, unknown> | null | undefined): ShopSettings {
  const d = DEFAULT_SHOP_SETTINGS;
  if (!row) return { ...d };
  const pick = (v: unknown, min: number, max: number, fallback: number) => {
    const n = wholeNumber(v);
    return n === null ? fallback : Math.min(max, Math.max(min, n));
  };
  return {
    offer: shopOfferFromSettings(row),
    shipping_fee_inr: pick(row.shipping_fee_inr, 0, 500, d.shipping_fee_inr),
    free_shipping_min_inr: pick(row.free_shipping_min_inr, 0, 100000, d.free_shipping_min_inr),
    beanies_max_redeem_pct: pick(row.beanies_max_redeem_pct, 0, 50, d.beanies_max_redeem_pct),
  };
}

export interface CartItem {
  product_id: string;
  quantity: number;
  grind?: GrindCode | null;
}

export type ParsedCart = { ok: true; items: CartItem[] } | { ok: false; error: string };

export function cartItemKey(i: CartItem): string {
  return `${i.product_id}:${i.grind ?? ''}`;
}

/**
 * The request body's `items` → clean cart items. Each names a product id, a
 * whole quantity, and a grind from the list (or none). The same product and
 * grind twice is merged; zero lines are skipped. Nothing left, or more than
 * MAX_UNITS_PER_ORDER units in all, is refused.
 */
export function parseCartItems(raw: unknown): ParsedCart {
  if (!Array.isArray(raw)) return { ok: false, error: 'items must be a list' };
  const merged = new Map<string, CartItem>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: 'Each item needs a product and a quantity' };
    const { product_id: id, quantity, grind } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id)) {
      return { ok: false, error: 'Each item needs a product and a quantity' };
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
      return { ok: false, error: 'Quantities must be whole numbers' };
    }
    if (grind !== undefined && grind !== null && !isGrindCode(grind)) {
      return { ok: false, error: 'Choose a grind from the list' };
    }
    if (quantity === 0) continue;
    const item: CartItem = grind ? { product_id: id, quantity, grind: grind as GrindCode } : { product_id: id, quantity };
    const key = cartItemKey(item);
    const had = merged.get(key);
    if (had) had.quantity += quantity;
    else merged.set(key, item);
  }
  const items = [...merged.values()];
  if (items.length === 0) return { ok: false, error: 'Add something to your order' };
  if (items.reduce((n, i) => n + i.quantity, 0) > MAX_UNITS_PER_ORDER) return { ok: false, error: WHOLESALE_MESSAGE };
  return { ok: true, items };
}

/**
 * What a coupon takes off these lines. The base is the lines the coupon is
 * for (all of them when it names none); percent is rounded down, capped by the
 * coupon's own cap, never above the base, and never so much that the order
 * costs ₹0 (at most subtotal − 1).
 */
export function couponSavingFor(
  terms: ShopCouponTerms,
  lines: readonly ShopLine[],
): { ok: true; discount_inr: number } | { ok: false; reason: string } {
  const subtotal = lines.reduce((n, l) => n + l.line_total_inr, 0);
  const scoped = terms.shop_product_ids.length > 0;
  const base = lines
    .filter((l) => !scoped || terms.shop_product_ids.includes(l.product_id))
    .reduce((n, l) => n + l.line_total_inr, 0);
  if (base <= 0) return { ok: false, reason: "This code isn't for the items in your order" };
  if (subtotal < terms.min_order_inr) {
    return {
      ok: false,
      reason: `Add ${rupees(terms.min_order_inr - subtotal)} more to use ${terms.code} (minimum ${rupees(terms.min_order_inr)})`,
    };
  }
  let d = terms.discount_type === 'percent' ? Math.floor((base * terms.discount_value) / 100) : Math.floor(terms.discount_value);
  if (terms.max_discount_inr > 0) d = Math.min(d, terms.max_discount_inr);
  d = Math.min(d, base, subtotal - 1);
  if (!(d > 0)) return { ok: false, reason: 'This code gives no discount on this order' };
  return { ok: true, discount_inr: d };
}

/** The auto-apply coupon that saves the most on these lines, or null when none applies. */
export function pickBestAutoCoupon(
  candidates: readonly ShopCouponTerms[],
  lines: readonly ShopLine[],
): { terms: ShopCouponTerms; discount_inr: number } | null {
  let best: { terms: ShopCouponTerms; discount_inr: number } | null = null;
  for (const terms of candidates) {
    const r = couponSavingFor(terms, lines);
    if (r.ok && (!best || r.discount_inr > best.discount_inr)) best = { terms, discount_inr: r.discount_inr };
  }
  return best;
}

export interface BeaniesContext {
  signed_in: boolean;
  repeat_customer: boolean;
  balance: number;
  min_redeem_points: number;
  inr_per_point: number;
  points_per_inr: number;
  use: boolean;
}

export type BeaniesState = 'applied' | 'available_off' | 'below_min' | 'first_order' | 'guest' | 'unavailable';

export interface ShopPricingInput {
  products: readonly ShopProduct[];
  items: readonly CartItem[];
  settings: ShopSettings;
  /** Whether this customer may still have the introductory offer (E2a). */
  intro_eligible: boolean;
  /** The one coupon in play (typed or auto-picked), or null. */
  coupon: ShopCouponTerms | null;
  beanies: BeaniesContext | null;
}

export interface ShopQuoteV2 {
  lines: ShopLine[];
  unit_count: number;
  /** Same as unit_count (the column kept its v1 name). */
  jar_count: number;
  instant_units: number;
  goods_weight_kg: number;
  subtotal_inr: number;
  offer_name: string | null;
  offer_discount_inr: number;
  intro_offer_applied: boolean;
  coupon_id: string | null;
  coupon_code: string | null;
  coupon_discount_inr: number;
  /** Why a coupon was not applied (shown next to the code). */
  coupon_reason: string | null;
  /** Says which of offer and coupon the bill took, when both would have saved. */
  discount_choice_note: string | null;
  beanies: {
    state: BeaniesState;
    balance: number;
    points: number;
    discount_inr: number;
    balance_after: number;
    min_redeem_points: number;
    max_pct: number;
  };
  beanies_redeemed: number;
  beanies_discount_inr: number;
  /** offer + coupon + Beanies. */
  discount_inr: number;
  goods_after_discounts_inr: number;
  shipping_inr: number;
  free_shipping_min_inr: number;
  free_shipping_gap_inr: number;
  total_inr: number;
  earn_estimate_points: number;
  nudges: { free_shipping: string | null; jar_tier: string | null };
}

export type QuoteV2Result = ({ ok: true } & ShopQuoteV2) | { ok: false; error: string };

/** The whole price of an order: steps 1-6 in the header, in order. */
export function quoteShopCart(input: ShopPricingInput): QuoteV2Result {
  const { products, items, settings, intro_eligible, coupon, beanies: bctx } = input;
  const byId = new Map(products.map((p) => [p.id, p]));

  // Validate every item.
  for (const item of items) {
    const p = byId.get(item.product_id);
    if (!p || p.listed === false) return { ok: false, error: 'One of those items is no longer sold. Please refresh the page.' };
    if (!p.in_stock) return { ok: false, error: `${p.display_name || p.name} is out of stock right now.` };
    const name = p.display_name || p.name;
    if (p.requires_grind && !item.grind) return { ok: false, error: `Choose a grind for ${name}` };
    if (!p.requires_grind && item.grind) return { ok: false, error: `${name} doesn't need a grind` };
  }

  // Lines: one per (product, grind), by product order then grind order.
  const grindRank = (g: GrindCode | null | undefined) => (g ? GRINDS.findIndex((x) => x.code === g) : -1);
  const qty = new Map<string, CartItem>();
  for (const i of items) {
    if (!(i.quantity > 0)) continue;
    const key = cartItemKey(i);
    const had = qty.get(key);
    if (had) qty.set(key, { ...had, quantity: had.quantity + i.quantity });
    else qty.set(key, { ...i });
  }
  const lines: ShopLine[] = [...qty.values()]
    .map((i) => ({ item: i, p: byId.get(i.product_id) as ShopProduct }))
    .sort((a, b) => a.p.sort_order - b.p.sort_order || grindRank(a.item.grind) - grindRank(b.item.grind))
    .map(({ item, p }) => {
      const grind = item.grind ?? null;
      const g = grind ? GRINDS.find((x) => x.code === grind) : undefined;
      return {
        product_id: p.id,
        name: p.display_name || p.name,
        sku: lineSku(p.sku, grind),
        unit_price_inr: p.price_inr,
        quantity: item.quantity,
        line_total_inr: p.price_inr * item.quantity,
        line: p.line,
        base_sku: p.sku,
        pack_grams: p.pack_grams,
        grind,
        grind_label: g ? g.label : null,
        ship_weight_kg: p.ship_weight_kg,
      };
    });
  if (lines.length === 0) return { ok: false, error: 'Add something to your order' };

  const unit_count = lines.reduce((n, l) => n + l.quantity, 0);
  const goods_weight_kg = goodsWeightKg(lines);
  if (unit_count > MAX_UNITS_PER_ORDER || goods_weight_kg > MAX_PARCEL_KG) return { ok: false, error: WHOLESALE_MESSAGE };

  // 1. Subtotal.
  const subtotal_inr = lines.reduce((n, l) => n + l.line_total_inr, 0);

  // 2. Offer: instant units only.
  const instantLines = lines.filter((l) => (l.line ?? 'instant') === 'instant');
  const instant_units = instantLines.reduce((n, l) => n + l.quantity, 0);
  const instantSubtotal = instantLines.reduce((n, l) => n + l.line_total_inr, 0);
  let offerSaving = 0;
  if (intro_eligible && settings.offer && instant_units > 0) {
    const price = offerPriceFor(settings.offer.tier_prices, instant_units);
    if (price > 0) offerSaving = Math.max(0, instantSubtotal - price);
  }

  // 3. Coupon, and the choice between it and the offer (no stacking).
  let couponSaving = 0;
  let coupon_reason: string | null = null;
  if (coupon) {
    const r = couponSavingFor(coupon, lines);
    if (r.ok) couponSaving = r.discount_inr;
    else coupon_reason = r.reason;
  }
  const offerName = settings.offer?.name ?? DEFAULT_OFFER_NAME;
  let offer_discount_inr = 0;
  let coupon_discount_inr = 0;
  let discount_choice_note: string | null = null;
  if (offerSaving > 0 && couponSaving > 0) {
    if (offerSaving >= couponSaving) {
      offer_discount_inr = offerSaving;
      discount_choice_note = `${offerName} applied: it saves you more than ${coupon?.code}`;
    } else {
      coupon_discount_inr = couponSaving;
      discount_choice_note = `${coupon?.code} applied: it saves you more than the ${offerName}`;
    }
  } else if (offerSaving > 0) offer_discount_inr = offerSaving;
  else if (couponSaving > 0) coupon_discount_inr = couponSaving;
  const intro_offer_applied = offer_discount_inr > 0;
  const couponUsed = coupon_discount_inr > 0 && coupon ? coupon : null;

  // 4. Beanies.
  const goodsAfterOffers = subtotal_inr - offer_discount_inr - coupon_discount_inr;
  const maxPct = settings.beanies_max_redeem_pct;
  let state: BeaniesState = 'unavailable';
  let points = 0;
  let beaniesDiscount = 0;
  if (bctx) {
    if (!bctx.signed_in) state = 'guest';
    else if (!bctx.repeat_customer) state = 'first_order';
    else if (bctx.balance < bctx.min_redeem_points) state = 'below_min';
    else if (goodsAfterOffers > 0 && bctx.inr_per_point > 0) {
      const cap = Math.floor((Math.floor((goodsAfterOffers * maxPct) / 100)) / bctx.inr_per_point);
      points = Math.max(0, Math.min(bctx.balance, cap));
      if (points > 0) {
        beaniesDiscount = Math.floor(points * bctx.inr_per_point);
        state = bctx.use ? 'applied' : 'available_off';
      } else points = 0;
    }
  }
  const applied = state === 'applied';
  const beanies_redeemed = applied ? points : 0;
  const beanies_discount_inr = applied ? beaniesDiscount : 0;

  // 5. Shipping, by goods value after every discount.
  const goods_after_discounts_inr = goodsAfterOffers - beanies_discount_inr;
  const free = goods_after_discounts_inr >= settings.free_shipping_min_inr;
  const shipping_inr = free ? 0 : settings.shipping_fee_inr;
  const free_shipping_gap_inr = Math.max(0, settings.free_shipping_min_inr - goods_after_discounts_inr);

  // 6. Total.
  const discount_inr = offer_discount_inr + coupon_discount_inr + beanies_discount_inr;
  const total_inr = subtotal_inr - discount_inr + shipping_inr;
  if (!(total_inr > 0)) return { ok: false, error: 'This order comes to ₹0. Please remove a discount.' };

  const minUnit = Math.min(...instantLines.map((l) => l.unit_price_inr));
  // The nudge must never send the customer past a cap the quote would refuse.
  const cheapest = instantLines.reduce<ShopLine | null>((b, l) => (!b || l.unit_price_inr < b.unit_price_inr ? l : b), null);
  // Same default weight and rounding as goodsWeightKg, so 5.7 + 0.3 is 6, not 6.000…1.
  const nextJarKg = cheapest ? lineShipWeightKg(cheapest) : 0;
  const nextJarFits =
    unit_count < MAX_UNITS_PER_ORDER && Math.round((goods_weight_kg + nextJarKg) * 1000) / 1000 <= MAX_PARCEL_KG;
  return {
    ok: true,
    lines,
    unit_count,
    jar_count: unit_count,
    instant_units,
    goods_weight_kg,
    subtotal_inr,
    offer_name: intro_offer_applied ? offerName : null,
    offer_discount_inr,
    intro_offer_applied,
    coupon_id: couponUsed ? couponUsed.id : null,
    coupon_code: couponUsed ? couponUsed.code : null,
    coupon_discount_inr,
    coupon_reason,
    discount_choice_note,
    beanies: {
      state,
      balance: bctx?.balance ?? 0,
      points,
      discount_inr: beaniesDiscount,
      balance_after: (bctx?.balance ?? 0) - beanies_redeemed,
      min_redeem_points: bctx?.min_redeem_points ?? 0,
      max_pct: maxPct,
    },
    beanies_redeemed,
    beanies_discount_inr,
    discount_inr,
    goods_after_discounts_inr,
    shipping_inr,
    free_shipping_min_inr: settings.free_shipping_min_inr,
    free_shipping_gap_inr,
    total_inr,
    earn_estimate_points: bctx ? Math.floor((total_inr - shipping_inr) * bctx.points_per_inr) : 0,
    nudges: {
      free_shipping: free_shipping_gap_inr > 0 ? `Add ${rupees(free_shipping_gap_inr)} more for free shipping` : null,
      jar_tier: intro_eligible && nextJarFits && Number.isFinite(minUnit) ? jarTierNudge(instant_units, minUnit, settings.offer) : null,
    },
  };
}

/** "Add another jar for just ₹200 more: 2 for ₹599." Null when the next jar isn't a better deal. */
export function jarTierNudge(instantUnits: number, unitPrice: number, offer: ShopOffer | null): string | null {
  if (!offer || instantUnits <= 0 || instantUnits >= MAX_UNITS_PER_ORDER) return null;
  const next = instantUnits + 1;
  const tier = offerDeals(offer.tier_prices, unitPrice).find((d) => d.jars === next);
  if (!tier) return null;
  const cost = (n: number) => Math.min(unitPrice * n, offerPriceFor(offer.tier_prices, n));
  const more = cost(next) - cost(instantUnits);
  return `Add ${next === 2 ? 'another' : `a ${next === 3 ? '3rd' : `${next}th`}`} jar for just ${rupees(more)} more: ${next} for ${rupees(tier.price)}.`;
}

/** "1 item", "3 items" */
export function unitsLabel(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}
