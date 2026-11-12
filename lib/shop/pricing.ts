// Instant Coffee shop pricing (docs/INSTANT-COFFEE-SHOP.md). Pure, and shared
// by the /shop page (the running total the customer sees) and
// POST /api/shop/checkout (the amount Razorpay charges), so the two can never
// disagree. The server re-prices from shop_products; the browser's numbers are
// never read.
//
//   each jar        its shop_products.price_inr (₹399 for all three flavours)
//   shipping        ₹49 per order for 1 or 2 jars, free from 3 jars
//   prepaid only    no cash on delivery

import type { ShopLine, ShopProduct } from './types';

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
  subtotal_inr: number;
  shipping_inr: number;
  total_inr: number;
}

export type QuoteResult = ({ ok: true } & ShopQuote) | { ok: false; error: string };

/**
 * Prices cart items against the products. A product that doesn't exist or is
 * out of stock is refused by name, so the customer knows which flavour to take
 * out. Lines come back in the products' own order (sort_order), not the cart's.
 */
export function priceShopCart(products: readonly ShopProduct[], items: readonly CartItem[]): QuoteResult {
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
  const shipping_inr = shippingForJars(jar_count);
  return { ok: true, lines, jar_count, subtotal_inr, shipping_inr, total_inr: subtotal_inr + shipping_inr };
}

/** "₹1,197" */
export function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

/** "1 jar", "3 jars" */
export function jarsLabel(n: number): string {
  return `${n} ${n === 1 ? 'jar' : 'jars'}`;
}
