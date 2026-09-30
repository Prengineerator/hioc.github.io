// Offers as the customer sees them and as the database stores them (spec §1.6
// table, §1.7). Pure and client-safe.
//
// An owner-configured Offer has two lives:
//   * TEXT   — what the WhatsApp message says ("10% off (up to ₹60) on orders above
//              ₹150"). offerText().
//   * COUPON — a single-use code locked to one phone, inserted into `coupons` at the
//              moment a message is SENT (never at plan time, so a skipped or rejected
//              campaign leaves no orphan codes). couponFieldsFor(), generateCouponCode(),
//              validTill().
//
// Money on a coupon is INTEGER rupees (the coupons table and the checkout maths are
// integer); everything here that ends up on a coupon is already whole.

import {
  COUPON_CODE_ALPHABET,
  COUPON_CODE_PREFIXES,
  COUPON_CODE_SUFFIX_LENGTH,
} from './types';
import type { CouponFields, EconomicOffer, FreeItemOffer, Offer, PlaybookKey } from './types';
import { endOfIstDay, type Instant } from './ist';

/** True once a free-item offer has been pinned to a real, priced, costed variant (at plan time or by the owner). */
export function isFreeItemResolved(offer: FreeItemOffer): boolean {
  return (
    offer.item_id !== null &&
    offer.variant_id !== null &&
    typeof offer.price_inr === 'number' &&
    typeof offer.cost_inr === 'number'
  );
}

/** Does this offer become a coupon? ('none' and the implicit points offer do not.) */
export function needsCoupon(offer: EconomicOffer): boolean {
  return offer.type === 'percent' || offer.type === 'flat' || offer.type === 'free_item';
}

function rupees(n: number): string {
  return `₹${Math.round(n)}`;
}

/** " on orders above ₹M", or '' when there is no minimum. */
function aboveClause(minOrder: number): string {
  return minOrder > 0 ? ` on orders above ${rupees(minOrder)}` : '';
}

/**
 * The customer-facing text of an offer, for the {{offer_text}} token:
 *   none       ''                                          (a template that uses it gets '-')
 *   points     "₹X of points"
 *   percent    "p% off (up to ₹K) on orders above ₹M"     (cap and minimum clauses dropped when 0)
 *   flat       "₹F off on orders above ₹M"
 *   free_item  "a FREE {item} with any order above ₹M"
 *
 * A free item names the variant only when it is not the plain "Regular" size, so
 * "a FREE Cold Coffee" but "a FREE Cold Coffee (Large)".
 */
export function offerText(offer: EconomicOffer): string {
  switch (offer.type) {
    case 'none':
      return '';
    case 'points':
      return `${rupees(offer.points_value_inr)} of points`;
    case 'percent':
      return `${offer.percent}% off${offer.cap_inr > 0 ? ` (up to ${rupees(offer.cap_inr)})` : ''}${aboveClause(offer.min_order_inr)}`;
    case 'flat':
      return `${rupees(offer.amount_inr)} off${aboveClause(offer.min_order_inr)}`;
    case 'free_item': {
      const name = offer.item_name?.trim() || 'item';
      const label = offer.variant_label?.trim();
      const variant = label && label.toLowerCase() !== 'regular' ? ` (${label})` : '';
      const order = offer.min_order_inr > 0 ? ` above ${rupees(offer.min_order_inr)}` : '';
      return `a FREE ${name}${variant} with any order${order}`;
    }
  }
}

/**
 * The coupon row an offer becomes, or null when it needs none (`none`) or cannot
 * be issued (an unresolved free item). The caller distinguishes the two with
 * needsCoupon(): needsCoupon && result === null means "the offer is broken —
 * fail this recipient, do not send a message that promises a code it lacks".
 *
 *   percent    (percent, p, cap K, min M, scope {})
 *   flat       (flat,    F, 0,     min M, scope {})
 *   free_item  (flat, price_v, price_v, min M + price_v, scope {item_ids:[item]})
 *
 * The free-item minimum includes the item itself so "a free Cold Coffee with
 * ₹200 of other items" holds. Scope is the ITEM, not the variant, so a bigger
 * size also qualifies — capped at the chosen variant's price by max_discount.
 */
export function couponFieldsFor(offer: EconomicOffer): CouponFields | null {
  switch (offer.type) {
    case 'percent':
      return {
        discount_type: 'percent',
        discount_value: offer.percent,
        max_discount_inr: offer.cap_inr,
        min_order_inr: offer.min_order_inr,
        scope: {},
      };
    case 'flat':
      return {
        discount_type: 'flat',
        discount_value: offer.amount_inr,
        max_discount_inr: 0,
        min_order_inr: offer.min_order_inr,
        scope: {},
      };
    case 'free_item': {
      if (!isFreeItemResolved(offer)) return null;
      const price = offer.price_inr as number;
      return {
        discount_type: 'flat',
        discount_value: price,
        max_discount_inr: price,
        min_order_inr: offer.min_order_inr + price,
        scope: { item_ids: [offer.item_id as string] },
      };
    }
    default:
      return null;
  }
}

/** Days the coupon lives; 0 for offers without one. */
export function validityDays(offer: Offer): number {
  return offer.type === 'none' ? 0 : offer.validity_days;
}

/**
 * The instant a coupon stops working: the last millisecond of the IST day
 * `days` after `now`. "Valid for 10 days" sent on the 5th at 3pm runs through
 * 23:59:59 on the 15th, and the {{valid_till}} the customer reads ("15 Oct") is
 * the same IST day.
 */
export function validTill(now: Instant, days: number): Date {
  return endOfIstDay(now, Math.max(0, Math.floor(days)));
}

/** Code prefix for a campaign: PT for points playbooks, WB for win-back, OF for a manual campaign (null key). */
export function couponPrefixFor(playbookKey: PlaybookKey | null): string {
  if (playbookKey === null) return COUPON_CODE_PREFIXES.manual;
  return playbookKey.startsWith('points_') ? COUPON_CODE_PREFIXES.points : COUPON_CODE_PREFIXES.winback;
}

/**
 * A coupon code: the prefix plus 6 characters from an alphabet with no I, O, 0
 * or 1. The RNG is injected — `secureRng` in production, a scripted one in
 * tests. `rng` must return a number in [0, 1); a stray 1 is clamped.
 */
export function generateCouponCode(prefix: string, rng: () => number): string {
  let suffix = '';
  for (let i = 0; i < COUPON_CODE_SUFFIX_LENGTH; i++) {
    const idx = Math.min(COUPON_CODE_ALPHABET.length - 1, Math.floor(rng() * COUPON_CODE_ALPHABET.length));
    suffix += COUPON_CODE_ALPHABET[idx];
  }
  return `${prefix}${suffix}`;
}

/**
 * A crypto-backed RNG in [0, 1), for production code paths (codes and click
 * tokens are not secrets, but they should not be guessable in sequence either).
 * Uses the platform's Web Crypto, available in Node 20 and every browser.
 */
export function secureRng(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 0x1_0000_0000;
}
