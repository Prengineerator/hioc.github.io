// Instant Coffee shop pricing (docs/INSTANT-COFFEE-SHOP.md). Pure, and shared
// by the /shop page (the running total the customer sees) and
// POST /api/shop/checkout (the amount Razorpay charges), so the two can never
// disagree. The server re-prices from shop_products; the browser's numbers are
// never read.
//
//   each jar        its shop_products.price_inr (₹399 for all three flavours)
//   online offer    shop_settings, while switched on: the introductory offer
//                   "1 for ₹399 · 2 for ₹599 · 3 for ₹749", any flavours. More
//                   jars = full groups of 3, then the rest (4 = ₹749 + ₹399),
//                   the same rule as the café's offers (offerPriceFor). The
//                   jars keep ₹399 on the lines; the offer is its own discount.
//   shipping        ₹49 per order for 1 or 2 jars, free from 3 jars
//   prepaid only    no cash on delivery

import { offerPriceFor } from '@/lib/orders/offers';
import type { ShopLine, ShopOffer, ShopProduct } from './types';

export const SHIPPING_FEE_INR = 49;
export const FREE_SHIPPING_MIN_JARS = 3;
/** A bigger order is a wholesale enquiry: call or email the café. */
export const MAX_JARS_PER_ORDER = 12;

/** ₹49 below 3 jars, ₹0 from 3. Nothing to ship costs nothing. */
export function shippingForJars(jarCount: number): number {
  if (!(jarCount > 0)) return 0;
  return jarCount >= FREE_SHIPPING_MIN_JARS ? 0 : SHIPPING_FEE_INR;
}

/** How many more jars until shipping is free (0 once it is). */
export function jarsToFreeShipping(jarCount: number): number {
  return Math.max(0, FREE_SHIPPING_MIN_JARS - Math.max(0, jarCount));
}

export interface CartItem {
  product_id: string;
  quantity: number;
}

export type ParsedCart = { ok: true; items: CartItem[] } | { ok: false; error: string };

/**
 * The request body's `items` → clean cart items. Each must name a product id
 * and a whole quantity of at least 1; the same product twice is merged. Zero
 * lines, or more than MAX_JARS_PER_ORDER jars in all, is refused.
 */
export function parseCartItems(raw: unknown): ParsedCart {
  if (!Array.isArray(raw)) return { ok: false, error: 'items must be a list' };
  const merged = new Map<string, number>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: 'Each item needs a product and a quantity' };
    const { product_id: id, quantity } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id)) {
      return { ok: false, error: 'Each item needs a product and a quantity' };
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
      return { ok: false, error: 'Quantities must be whole numbers' };
    }
    if (quantity === 0) continue;
    merged.set(id, (merged.get(id) ?? 0) + quantity);
  }
  const items = [...merged].map(([product_id, quantity]) => ({ product_id, quantity }));
  if (items.length === 0) return { ok: false, error: 'Add at least one jar' };
  const jars = items.reduce((n, i) => n + i.quantity, 0);
  if (jars > MAX_JARS_PER_ORDER) {
    return { ok: false, error: `At most ${MAX_JARS_PER_ORDER} jars an order online. For more, please call or email us.` };
  }
  return { ok: true, items };
}

export interface ShopQuote {
  lines: ShopLine[];
  jar_count: number;
  /** The jars at their own price (₹399 each). */
  subtotal_inr: number;
  /** What the offer takes off (0 without one, or when it saves nothing). */
  discount_inr: number;
  /** The offer's name when it took something off. */
  offer_name: string | null;
  shipping_inr: number;
  /** subtotal − discount + shipping: what Razorpay charges. */
  total_inr: number;
}

export type QuoteResult = ({ ok: true } & ShopQuote) | { ok: false; error: string };

/**
 * Prices cart items against the products, and the offer when there is one. A
 * product that doesn't exist or is out of stock is refused by name, so the
 * customer knows which flavour to take out. Lines come back in the products'
 * own order (sort_order), not the cart's. The offer never adds: if its price
 * for the jars isn't lower than the jars' own, nothing comes off.
 */
export function priceShopCart(
  products: readonly ShopProduct[],
  items: readonly CartItem[],
  offer: ShopOffer | null = null,
): QuoteResult {
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const item of items) {
    const product = byId.get(item.product_id);
    if (!product) return { ok: false, error: 'One of those flavours is no longer sold. Please refresh the page.' };
    if (!product.in_stock) return { ok: false, error: `${product.name} is out of stock right now.` };
  }
  const qty = new Map(items.map((i) => [i.product_id, i.quantity]));
  const lines: ShopLine[] = [...products]
    .sort((a, b) => a.sort_order - b.sort_order)
    .filter((p) => (qty.get(p.id) ?? 0) > 0)
    .map((p) => {
      const quantity = qty.get(p.id) ?? 0;
      return {
        product_id: p.id,
        name: p.name,
        sku: p.sku,
        unit_price_inr: p.price_inr,
        quantity,
        line_total_inr: p.price_inr * quantity,
      };
    });
  if (lines.length === 0) return { ok: false, error: 'Add at least one jar' };
  const jar_count = lines.reduce((n, l) => n + l.quantity, 0);
  const subtotal_inr = lines.reduce((n, l) => n + l.line_total_inr, 0);
  const offerPrice = offer ? offerPriceFor(offer.tier_prices, jar_count) : subtotal_inr;
  const discount_inr = offer && offerPrice > 0 ? Math.max(0, subtotal_inr - offerPrice) : 0;
  const shipping_inr = shippingForJars(jar_count);
  return {
    ok: true,
    lines,
    jar_count,
    subtotal_inr,
    discount_inr,
    offer_name: discount_inr > 0 && offer ? offer.name : null,
    shipping_inr,
    total_inr: subtotal_inr - discount_inr + shipping_inr,
  };
}

/** Same-priced jars: what `jars` of them cost in all, offer and shipping included. */
export function totalForJars(unitPrice: number, jars: number, offer: ShopOffer | null): number {
  if (!(jars > 0)) return 0;
  const own = unitPrice * jars;
  const goods = offer ? Math.min(own, offerPriceFor(offer.tier_prices, jars)) : own;
  return goods + shippingForJars(jars);
}

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
