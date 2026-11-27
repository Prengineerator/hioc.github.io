import { describe, expect, it } from 'vitest';

// Multi-buy offers (lib/orders/offers.ts, supabase/2026-10-item-offers.sql):
// "Instant Coffee: 1 for ₹299, 2 for ₹499, 3 for ₹599" as its own offer
// record, taken off the bill as a discount while the jars stay at ₹399.

import {
  computeOffers,
  describeTiers,
  discountRows,
  isOfferLive,
  normalizeOfferPrices,
  offerLabel,
  offerLabelForLines,
  offerPriceFor,
  splitOrderDiscount,
} from '@/lib/orders/offers';
import { resolveOrderLines } from '@/lib/orders/lines';
import { composeOrderBill, passLinesFor } from '@/lib/orders/passPricing';
import { recomputeOrderTotals } from '@/lib/orders/amend';
import { editReductionInr } from '@/lib/orders/settleEdit';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { MenuItem, StoreSettings } from '@/lib/types';

const OFFER = [299, 499, 599];
const COFFEE = '11111111-1111-4111-8111-111111111111';
const CLASSIC = '11111111-1111-4111-8111-1111111111a1';
const HAZELNUT = '11111111-1111-4111-8111-1111111111a2';
const LATTE = '22222222-2222-4222-8222-222222222222';
const LATTE_L = '22222222-2222-4222-8222-2222222222b1';
const BEANS = '33333333-3333-4333-8333-333333333333';
const BEANS_WHOLE = '33333333-3333-4333-8333-3333333333c1';

const settings: StoreSettings = {
  ...FALLBACK_STORE_SETTINGS,
  gst_percent: 5,
  gst_inclusive: false,
  packaging_charge_inr: 10,
  hidden_categories: [],
  hidden_variant_labels: [],
};

const base = {
  description: '',
  parent_category: '',
  is_veg: true,
  is_available: true,
  sort_order: 0,
  image_url: '',
  unavailable_until: null,
  short_code: null,
  created_at: '',
  updated_at: '',
  addon_groups: [],
};
const instantCoffee: MenuItem = {
  ...base,
  id: COFFEE,
  name: 'Instant Coffee',
  category: 'In-store',
  in_store_only: true,
  gst_exempt: true,
  variants: [
    { id: CLASSIC, menu_item_id: COFFEE, label: 'Classic', price_inr: 399, sort_order: 0 },
    { id: HAZELNUT, menu_item_id: COFFEE, label: 'Hazelnut', price_inr: 399, sort_order: 10 },
  ],
};
const latte: MenuItem = {
  ...base,
  id: LATTE,
  name: 'Latte',
  category: 'Coffee',
  variants: [{ id: LATTE_L, menu_item_id: LATTE, label: 'Large', price_inr: 200, sort_order: 0 }],
};
const beans: MenuItem = {
  ...base,
  id: BEANS,
  name: 'House Beans',
  category: 'Coffee Beans',
  sold_by_weight: true,
  variants: [{ id: BEANS_WHOLE, menu_item_id: BEANS, label: 'Whole Bean', price_inr: 2000, sort_order: 0 }],
};
const menu = new Map([instantCoffee, latte, beans].map((m) => [m.id, m]));
const OFFER_ID = '55555555-5555-4555-8555-555555555555';
// The live offers (Promotions → Offers), by item. The beans' is ignored:
// offers are for by-the-unit items.
const offers = new Map([
  [COFFEE, { id: OFFER_ID, name: 'Instant Coffee offer', tier_prices: OFFER }],
  [BEANS, { id: OFFER_ID, name: 'Beans offer', tier_prices: OFFER }],
]);

const jar = (variant_id: string, quantity = 1) => ({
  menu_item_id: COFFEE,
  variant_id,
  quantity,
  addon_option_ids: [],
  special_instructions: '',
});

function resolve(items: Parameters<typeof resolveOrderLines>[0]) {
  const r = resolveOrderLines(items, menu, {}, offers);
  if (!r.ok) throw new Error(r.error);
  return r;
}

function billFor(items: Parameters<typeof resolveOrderLines>[0], extra: { coupon?: number; dineIn?: boolean } = {}) {
  const r = resolve(items);
  const offers = computeOffers(r.lines);
  return composeOrderBill({
    settings,
    subtotalInr: r.subtotalInr,
    taxableSubtotalInr: r.taxableSubtotalInr,
    offerDiscountInr: offers.discountInr,
    couponDiscountInr: extra.coupon ?? 0,
    pointsDiscountInr: 0,
    passCoveredInr: 0,
    passCoveredTaxableInr: 0,
    isDineIn: extra.dineIn ?? true,
  });
}

describe('an offer record', () => {
  const offer = { active: true, valid_from: null, valid_to: null, tier_prices: OFFER };
  const now = new Date('2026-11-01T10:00:00Z');

  it('is live when switched on and inside its window (an empty edge is no limit)', () => {
    expect(isOfferLive(offer, now)).toBe(true);
    expect(isOfferLive({ ...offer, active: false }, now)).toBe(false);
    expect(isOfferLive({ ...offer, valid_from: '2026-11-02T00:00:00Z' }, now)).toBe(false);
    expect(isOfferLive({ ...offer, valid_to: '2026-11-01T10:00:00Z' }, now)).toBe(false); // ends at that instant
    expect(isOfferLive({ ...offer, valid_from: '2026-10-01T00:00:00Z', valid_to: '2026-12-01T00:00:00Z' }, now)).toBe(true);
    expect(isOfferLive({ ...offer, tier_prices: [499, 299] }, now)).toBe(false);
  });

  it('reads as "1 for ₹299 · 2 for ₹499 · 3 for ₹599"', () => {
    expect(describeTiers(OFFER)).toBe('1 for ₹299 · 2 for ₹499 · 3 for ₹599');
  });
});

describe('offer prices', () => {
  it('accepts 1–10 positive whole rupee tiers that never get cheaper, and nothing else', () => {
    expect(normalizeOfferPrices([299, 499, 599])).toEqual([299, 499, 599]);
    expect(normalizeOfferPrices([299, 299])).toEqual([299, 299]);
    for (const bad of [null, undefined, [], [0], [-1], [299.5], [499, 299], ['299'], new Array(11).fill(1), '299']) {
      expect(normalizeOfferPrices(bad)).toBeNull();
    }
  });

  it('1, 2, 3 jars cost 299, 499, 599; past 3 it is full groups of 3, then the tier for the rest', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => offerPriceFor(OFFER, n))).toEqual([
      0, 299, 499, 599, 599 + 299, 599 + 499, 1198, 1198 + 299,
    ]);
  });
});

describe('computeOffers', () => {
  const line = (quantity: number, extra: Record<string, unknown> = {}) => ({
    menu_item_id: COFFEE,
    name_snapshot: 'Instant Coffee',
    quantity,
    offer_prices: OFFER,
    offer_unit_inr: 399,
    ...extra,
  });

  it('takes ₹100 off one jar, ₹299 off two and ₹598 off three', () => {
    expect(computeOffers([line(1)]).discountInr).toBe(100);
    expect(computeOffers([line(2)]).discountInr).toBe(299);
    expect(computeOffers([line(3)]).discountInr).toBe(598);
    expect(computeOffers([line(4)]).discountInr).toBe(4 * 399 - 898);
  });

  it('counts different flavours (separate lines) together, and a voided line not at all', () => {
    const result = computeOffers([line(1), line(1), line(1, { voided: true })]);
    expect(result.discountInr).toBe(299);
    expect(result.offers).toEqual([
      { menu_item_id: COFFEE, name: 'Instant Coffee offer', units: 2, regular_inr: 798, offer_inr: 499, discount_inr: 299 },
    ]);
  });

  it('ignores lines with no offer snapshot (every other item, every old order)', () => {
    expect(computeOffers([{ menu_item_id: LATTE, name_snapshot: 'Latte', quantity: 3 }]).discountInr).toBe(0);
    expect(computeOffers([line(2, { offer_prices: null })]).discountInr).toBe(0);
    expect(computeOffers([line(2, { offer_unit_inr: null })]).discountInr).toBe(0);
  });

  it('never takes off more than the units cost at their own price', () => {
    // A jar already sold below the offer price (a cheaper size): nothing to take off.
    expect(computeOffers([line(1, { offer_unit_inr: 250 })]).discountInr).toBe(0);
  });

  it('labels the row with the offer name, or "Offers" for several', () => {
    expect(offerLabel(['Launch offer', 'Launch offer'])).toBe('Launch offer');
    expect(offerLabel(['Launch offer', 'Cookie deal'])).toBe('Offers');
    expect(offerLabel([])).toBe('Offer');
    expect(computeOffers([line(1, { offer_name: 'Launch offer' })]).offers[0].name).toBe('Launch offer');
    // A line with no name snapshot is "<item> offer".
    expect(offerLabelForLines([line(1), { name_snapshot: 'Latte', offer_prices: null }])).toBe('Instant Coffee offer');
    expect(offerLabelForLines([line(1, { offer_name: 'Launch offer' })])).toBe('Launch offer');
  });
});

describe('resolveOrderLines snapshots the offer', () => {
  it('on a line of an item with a live offer: which offer, its name, its tiers and the size price before add-ons', () => {
    const [coffeeLine, latteLine] = resolve([jar(CLASSIC, 2), { ...jar(LATTE_L), menu_item_id: LATTE }]).lines;
    expect(coffeeLine).toMatchObject({
      price_inr_snapshot: 399,
      line_total_inr: 798,
      offer_id: OFFER_ID,
      offer_name: 'Instant Coffee offer',
      offer_prices: OFFER,
      offer_unit_inr: 399,
    });
    // Every other line's row is exactly what it was before the migration.
    for (const key of ['offer_id', 'offer_name', 'offer_prices', 'offer_unit_inr']) {
      expect(latteLine).not.toHaveProperty(key);
    }
  });

  it('never changes the menu: with no live offer passed in, the line is a plain ₹399 jar', () => {
    const r = resolveOrderLines([jar(CLASSIC)], menu);
    expect(r.ok && r.lines[0]).toMatchObject({ price_inr_snapshot: 399 });
    expect(r.ok && r.lines[0]).not.toHaveProperty('offer_prices');
  });

  it('never on a sold-by-weight line', () => {
    const [weighed] = resolve([
      { menu_item_id: BEANS, variant_id: BEANS_WHOLE, quantity: 1, addon_option_ids: [], special_instructions: '', weight_grams: 250 },
    ]).lines;
    expect(weighed).not.toHaveProperty('offer_prices');
  });

  it('a HIOC Ritual cup never pays for a line on an offer', () => {
    const { lines } = resolve([jar(CLASSIC)]);
    expect(passLinesFor(lines, ['0'], new Set([COFFEE]))[0].eligible).toBe(false);
  });
});

describe('the bill: regular price, then the offer as its own discount', () => {
  it('1 jar ₹399 − ₹100 = ₹299; 2 jars (any flavours) ₹798 − ₹299 = ₹499; 3 jars ₹1197 − ₹598 = ₹599', () => {
    expect(billFor([jar(CLASSIC)])).toMatchObject({ subtotal_inr: 399, offer_discount_inr: 100, discount_inr: 100, tax_inr: 0, total_inr: 299 });
    expect(billFor([jar(CLASSIC), jar(HAZELNUT)])).toMatchObject({ subtotal_inr: 798, offer_discount_inr: 299, total_inr: 499 });
    expect(billFor([jar(HAZELNUT, 3)])).toMatchObject({ subtotal_inr: 1197, offer_discount_inr: 598, total_inr: 599 });
  });

  it('a takeaway adds the store packaging as on any order', () => {
    // ₹10 packaging, 5% GST on it (the jars are GST-exempt).
    expect(billFor([jar(CLASSIC, 2)], { dineIn: false })).toMatchObject({ packaging_inr: 10, tax_inr: 1, total_inr: 510 });
  });

  it('a coupon stacks on what is left after the offer, and the bill never goes below zero', () => {
    const bill = billFor([jar(CLASSIC, 2)], { coupon: 50 });
    expect(bill).toMatchObject({ offer_discount_inr: 299, discount_inr: 349, total_inr: 449 });
    expect(splitOrderDiscount(bill)).toEqual({ offerInr: 299, otherInr: 50, manualInr: 0 });
    const huge = billFor([jar(CLASSIC, 2)], { coupon: 100000 });
    expect(huge).toMatchObject({ offer_discount_inr: 299, discount_inr: 798, total_inr: 0 });
  });

  it('without an offer the bill is exactly what it was', () => {
    const latteOnly = billFor([{ ...jar(LATTE_L), menu_item_id: LATTE }], { coupon: 20 });
    expect(latteOnly).toMatchObject({ subtotal_inr: 200, discount_inr: 20, offer_discount_inr: 0, tax_inr: 9, total_inr: 189 });
  });

  it('shows the offer row first, then the coupon/Beanies row', () => {
    expect(discountRows({ discount_inr: 349, offer_discount_inr: 299 }, 'Instant Coffee offer', 'Discount (SAVE50)')).toEqual([
      { label: 'Instant Coffee offer', amountInr: 299 },
      { label: 'Discount (SAVE50)', amountInr: 50 },
    ]);
    // An order from before the migration: one Discount row, as always.
    expect(discountRows({ discount_inr: 40 }, 'Offer')).toEqual([{ label: 'Discount', amountInr: 40 }]);
    expect(discountRows({ discount_inr: 0, offer_discount_inr: 0 }, 'Offer')).toEqual([]);
  });
});

describe('corrections work the offer out again from the lines that remain', () => {
  const jarLine = (quantity: number, extra: Record<string, unknown> = {}) => ({
    voided: false,
    line_total_inr: 399 * quantity,
    gst_exempt: true,
    menu_item_id: COFFEE,
    name_snapshot: 'Instant Coffee',
    quantity,
    offer_prices: OFFER,
    offer_unit_inr: 399,
    ...extra,
  });
  const dineIn = { settings, orderType: 'dine_in' as const };

  it('voiding one jar of a pair leaves one jar at the 1-jar price', () => {
    const bill = recomputeOrderTotals({
      ...dineIn,
      items: [jarLine(1), jarLine(1, { voided: true })],
      discountInr: 299,
      offerDiscountInr: 299,
    });
    expect(bill).toMatchObject({ subtotal_inr: 399, offer_discount_inr: 100, discount_inr: 100, total_inr: 299 });
  });

  it('adding a jar to a running tab makes it a pair', () => {
    const bill = recomputeOrderTotals({ ...dineIn, items: [jarLine(1), jarLine(1)], discountInr: 100, offerDiscountInr: 100 });
    expect(bill).toMatchObject({ offer_discount_inr: 299, total_inr: 499 });
  });

  it('keeps the coupon part, clamped to what is left after the offer', () => {
    const items = [jarLine(2), { voided: false, line_total_inr: 200 }];
    const bill = recomputeOrderTotals({ ...dineIn, items, discountInr: 299 + 30, offerDiscountInr: 299 });
    expect(bill).toMatchObject({ subtotal_inr: 998, offer_discount_inr: 299, discount_inr: 329 });
    // Void the latte: 2 jars ₹798 − ₹299 = ₹499 left for the ₹30 coupon to come off.
    const voided = recomputeOrderTotals({
      ...dineIn,
      items: [jarLine(2), { voided: true, line_total_inr: 200 }],
      discountInr: 329,
      offerDiscountInr: 299,
    });
    expect(voided).toMatchObject({ subtotal_inr: 798, offer_discount_inr: 299, discount_inr: 329, total_inr: 469 });
  });

  it('an order with no offer recomputes exactly as before (offer 0, discount clamped as ever)', () => {
    const bill = recomputeOrderTotals({ ...dineIn, items: [{ voided: false, line_total_inr: 100 }], discountInr: 500 });
    expect(bill).toMatchObject({ subtotal_inr: 100, discount_inr: 100, offer_discount_inr: 0, total_inr: 0 });
  });

  it('the Settle edit preview nets off the offer the edit shrinks', () => {
    const lines = [{ id: 'a', ...jarLine(2), price_inr_snapshot: 399 }];
    const change = { item_id: 'a', from_quantity: 2, to_quantity: 1, from_line_total_inr: 798, to_line_total_inr: 399, remove: false };
    expect(editReductionInr([change])).toBe(399);
    // 2 jars ₹499 → 1 jar ₹299: the bill comes down ₹200.
    expect(editReductionInr([change], lines)).toBe(200);
  });
});
