// The checkout's double-tap guard (docs/SHOP-V2-SPEC.md E8). Pure: no database, no
// crypto import, so the browser could use it too. The page makes one
// Idempotency-Key (a random uuid) per checkout attempt and sends it with every
// retry of that attempt; the route stores it on shop_orders.idempotency_key.
//
// A repeat with the same key AND the same cart gets the order it opened (no
// second order, no second Razorpay order). A repeat with the same key but a
// different cart is refused (409), because the customer changed something and
// must see the new total before paying. "Same cart" is decided by comparing
// sha256 of checkoutFingerprintSource(...): everything that changes the price or
// where the parcel goes, written in one canonical order so it never depends on
// how the browser ordered its fields.

import { cartItemKey, type CartItem } from './pricing';
import type { ShopAddress } from './types';

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A random (v4) uuid, in either case. Anything else is refused, so a key can't be a probe or a collision. */
export function isIdempotencyKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v);
}

export interface CheckoutFingerprintInput {
  items: CartItem[];
  address: ShopAddress | null;
  address_id: string | null;
  coupon_code: string | null;
  use_beanies: boolean;
  save_address_label: string | null;
}

/** JSON with object keys sorted at every level (arrays keep their order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * What makes two checkouts "the same": the cart (sorted, so order never
 * matters), the delivery address or the saved address chosen, the coupon
 * typed (case-folded), Beanies on/off, and the label to save the address
 * under. The route hashes this with sha256.
 */
export function checkoutFingerprintSource(input: CheckoutFingerprintInput): string {
  const items = [...input.items]
    .sort((a, b) => (cartItemKey(a) < cartItemKey(b) ? -1 : cartItemKey(a) > cartItemKey(b) ? 1 : 0))
    .map((i) => ({ grind: i.grind ?? null, product_id: i.product_id, quantity: i.quantity }));
  return canonical({
    address: input.address,
    address_id: input.address_id,
    coupon_code: input.coupon_code ? input.coupon_code.trim().toLowerCase() : null,
    items,
    save_address_label: input.save_address_label,
    use_beanies: input.use_beanies,
  });
}
