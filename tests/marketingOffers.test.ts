import { describe, expect, it } from 'vitest';
import {
  couponFieldsFor,
  couponPrefixFor,
  generateCouponCode,
  isFreeItemResolved,
  needsCoupon,
  offerText,
  secureRng,
  validityDays,
  validTill,
} from '@/lib/marketing/offers';
import { COUPON_CODE_ALPHABET } from '@/lib/marketing/types';
import type { FreeItemOffer, Offer } from '@/lib/marketing/types';

const percent: Offer = { type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 };
const flat: Offer = { type: 'flat', amount_inr: 50, min_order_inr: 200, validity_days: 7 };
const freeItem = (over: Partial<FreeItemOffer> = {}): FreeItemOffer => ({
  type: 'free_item',
  item_id: 'item-1',
  variant_id: 'var-1',
  max_item_price: 250,
  min_order_inr: 200,
  validity_days: 10,
  item_name: 'Cold Coffee',
  variant_label: 'Regular',
  price_inr: 180,
  cost_inr: 45,
  ...over,
});

describe('offerText (spec §1.6 table)', () => {
  it('none has no text', () => {
    expect(offerText({ type: 'none' })).toBe('');
  });

  it('percent: "p% off (up to ₹K) on orders above ₹M"', () => {
    expect(offerText(percent)).toBe('10% off (up to ₹60) on orders above ₹150');
    expect(offerText({ type: 'percent', percent: 20, cap_inr: 120, min_order_inr: 200, validity_days: 7 })).toBe(
      '20% off (up to ₹120) on orders above ₹200',
    );
  });

  it('percent drops the cap clause when there is no cap and the minimum clause when there is none', () => {
    expect(offerText({ ...(percent as Extract<Offer, { type: 'percent' }>), cap_inr: 0 })).toBe('10% off on orders above ₹150');
    expect(offerText({ ...(percent as Extract<Offer, { type: 'percent' }>), min_order_inr: 0 })).toBe('10% off (up to ₹60)');
    expect(offerText({ ...(percent as Extract<Offer, { type: 'percent' }>), cap_inr: 0, min_order_inr: 0 })).toBe('10% off');
  });

  it('flat: "₹F off on orders above ₹M"', () => {
    expect(offerText(flat)).toBe('₹50 off on orders above ₹200');
    expect(offerText({ ...(flat as Extract<Offer, { type: 'flat' }>), min_order_inr: 0 })).toBe('₹50 off');
  });

  it('free_item: "a FREE {item} with any order above ₹M"', () => {
    expect(offerText(freeItem())).toBe('a FREE Cold Coffee with any order above ₹200');
  });

  it('free_item names a non-default size and drops the minimum clause when there is none', () => {
    expect(offerText(freeItem({ variant_label: 'Large' }))).toBe('a FREE Cold Coffee (Large) with any order above ₹200');
    expect(offerText(freeItem({ variant_label: 'regular' }))).toBe('a FREE Cold Coffee with any order above ₹200');
    expect(offerText(freeItem({ min_order_inr: 0 }))).toBe('a FREE Cold Coffee with any order');
  });

  it('an unresolved free item still reads sensibly', () => {
    expect(offerText(freeItem({ item_name: undefined, variant_label: undefined }))).toBe('a FREE item with any order above ₹200');
  });

  it('points: "₹X of points"', () => {
    expect(offerText({ type: 'points', points_value_inr: 80 })).toBe('₹80 of points');
    expect(offerText({ type: 'points', points_value_inr: 79.6 })).toBe('₹80 of points');
  });
});

describe('needsCoupon / isFreeItemResolved / validityDays', () => {
  it('only percent, flat and free_item become coupons', () => {
    expect(needsCoupon(percent)).toBe(true);
    expect(needsCoupon(flat)).toBe(true);
    expect(needsCoupon(freeItem())).toBe(true);
    expect(needsCoupon({ type: 'none' })).toBe(false);
    expect(needsCoupon({ type: 'points', points_value_inr: 80 })).toBe(false);
  });

  it('a free item is resolved only with ids AND a frozen price and cost', () => {
    expect(isFreeItemResolved(freeItem())).toBe(true);
    expect(isFreeItemResolved(freeItem({ variant_id: null }))).toBe(false);
    expect(isFreeItemResolved(freeItem({ item_id: null }))).toBe(false);
    expect(isFreeItemResolved(freeItem({ price_inr: undefined }))).toBe(false);
    expect(isFreeItemResolved(freeItem({ cost_inr: undefined }))).toBe(false);
    expect(isFreeItemResolved(freeItem({ cost_inr: 0 }))).toBe(true); // a real ₹0 cost is still a frozen value
  });

  it('validityDays', () => {
    expect(validityDays(percent)).toBe(10);
    expect(validityDays(flat)).toBe(7);
    expect(validityDays({ type: 'none' })).toBe(0);
  });
});

describe('couponFieldsFor (spec §1.7)', () => {
  it('percent → (percent, p, cap K, min M, no scope)', () => {
    expect(couponFieldsFor(percent)).toEqual({
      discount_type: 'percent',
      discount_value: 10,
      max_discount_inr: 60,
      min_order_inr: 150,
      scope: {},
    });
  });

  it('percent with cap 0 keeps 0 = no cap (the coupons table convention)', () => {
    expect(couponFieldsFor({ ...(percent as Extract<Offer, { type: 'percent' }>), cap_inr: 0 })?.max_discount_inr).toBe(0);
  });

  it('flat → (flat, F, 0, min M, no scope)', () => {
    expect(couponFieldsFor(flat)).toEqual({
      discount_type: 'flat',
      discount_value: 50,
      max_discount_inr: 0,
      min_order_inr: 200,
      scope: {},
    });
  });

  it('free_item → a flat coupon for the item price, capped at it, minimum = M + price, scoped to the item', () => {
    expect(couponFieldsFor(freeItem())).toEqual({
      discount_type: 'flat',
      discount_value: 180,
      max_discount_inr: 180,
      min_order_inr: 380, // 200 of other items + the ₹180 item itself
      scope: { item_ids: ['item-1'] },
    });
  });

  it('free_item with no minimum still requires the free item itself in the cart', () => {
    expect(couponFieldsFor(freeItem({ min_order_inr: 0 }))?.min_order_inr).toBe(180);
  });

  it('an unresolved free item cannot be issued: null, and needsCoupon says that is an error', () => {
    const unresolved = freeItem({ item_id: null, variant_id: null, price_inr: undefined, cost_inr: undefined });
    expect(couponFieldsFor(unresolved)).toBeNull();
    expect(needsCoupon(unresolved)).toBe(true);
  });

  it('none and points issue no coupon', () => {
    expect(couponFieldsFor({ type: 'none' })).toBeNull();
    expect(couponFieldsFor({ type: 'points', points_value_inr: 80 })).toBeNull();
  });

  it('every coupon amount is a whole number of rupees', () => {
    for (const o of [percent, flat, freeItem()]) {
      const f = couponFieldsFor(o)!;
      for (const n of [f.discount_value, f.max_discount_inr, f.min_order_inr]) expect(Number.isInteger(n)).toBe(true);
    }
  });
});

describe('validTill — end of the IST day N days ahead', () => {
  it('is 23:59:59.999 IST on the target IST day', () => {
    expect(validTill('2026-10-05T09:30:00Z', 10).toISOString()).toBe('2026-10-15T18:29:59.999Z');
  });

  it('counts calendar days from the IST date, not 24-hour blocks: sent just before IST midnight', () => {
    // 23:50 IST on 5 Oct (= 18:20Z). 10 days → 15 Oct IST, not 16 Oct.
    expect(validTill('2026-10-05T18:20:00Z', 10).toISOString()).toBe('2026-10-15T18:29:59.999Z');
  });

  it('sent just after IST midnight is already the next IST day', () => {
    // 00:10 IST on 6 Oct (= 18:40Z on the 5th).
    expect(validTill('2026-10-05T18:40:00Z', 10).toISOString()).toBe('2026-10-16T18:29:59.999Z');
  });

  it('0 days is the end of today', () => {
    expect(validTill('2026-10-05T09:30:00Z', 0).toISOString()).toBe('2026-10-05T18:29:59.999Z');
  });

  it('crosses month and year ends', () => {
    expect(validTill('2026-12-28T05:00:00Z', 7).toISOString()).toBe('2027-01-04T18:29:59.999Z');
  });

  it('negative and fractional days are normalised', () => {
    expect(validTill('2026-10-05T09:30:00Z', -3).toISOString()).toBe('2026-10-05T18:29:59.999Z');
    expect(validTill('2026-10-05T09:30:00Z', 2.9).toISOString()).toBe('2026-10-07T18:29:59.999Z');
  });
});

describe('couponPrefixFor', () => {
  it('PT for the points playbooks, WB for win-back, OF for manual', () => {
    expect(couponPrefixFor('points_expiring')).toBe('PT');
    expect(couponPrefixFor('points_balance')).toBe('PT');
    expect(couponPrefixFor('winback_1')).toBe('WB');
    expect(couponPrefixFor('winback_2')).toBe('WB');
    expect(couponPrefixFor('winback_3')).toBe('WB');
    expect(couponPrefixFor(null)).toBe('OF');
  });
});

describe('generateCouponCode', () => {
  const scripted = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  it('is the prefix plus 6 characters from the unambiguous alphabet', () => {
    const code = generateCouponCode('WB', scripted([0, 0.5, 0.999, 0.25, 0.75, 0.1]));
    expect(code).toHaveLength(8);
    expect(code.startsWith('WB')).toBe(true);
    for (const ch of code.slice(2)) expect(COUPON_CODE_ALPHABET).toContain(ch);
  });

  it('the alphabet has no I, O, 0 or 1 and 32 characters', () => {
    expect(COUPON_CODE_ALPHABET).toHaveLength(32);
    for (const bad of ['I', 'O', '0', '1']) expect(COUPON_CODE_ALPHABET).not.toContain(bad);
  });

  it('is deterministic for a given RNG (injected, never Math.random inside)', () => {
    const a = generateCouponCode('OF', scripted([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
    const b = generateCouponCode('OF', scripted([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
    expect(a).toBe(b);
    expect(a).toBe('OF' + [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((v) => COUPON_CODE_ALPHABET[Math.floor(v * 32)]).join(''));
  });

  it('maps the ends of [0, 1) to the first and last characters, and clamps a stray 1', () => {
    expect(generateCouponCode('PT', () => 0)).toBe('PT' + 'A'.repeat(6));
    expect(generateCouponCode('PT', () => 0.999999)).toBe('PT' + '9'.repeat(6));
    expect(generateCouponCode('PT', () => 1)).toBe('PT' + '9'.repeat(6));
  });

  it('different RNG values give different codes', () => {
    expect(generateCouponCode('WB', scripted([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]))).not.toBe(
      generateCouponCode('WB', scripted([0.6, 0.5, 0.4, 0.3, 0.2, 0.1])),
    );
  });
});

describe('secureRng', () => {
  it('returns numbers in [0, 1) and varies', () => {
    const values = Array.from({ length: 50 }, () => secureRng());
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(40);
  });

  it('drives generateCouponCode end to end', () => {
    expect(generateCouponCode('WB', secureRng)).toMatch(/^WB[A-HJ-NP-Z2-9]{6}$/);
  });
});
