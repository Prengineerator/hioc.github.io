import { describe, expect, it } from 'vitest';

// Spend offers (lib/orders/offers.ts billOffers, supabase/2026-11-spend-offers.sql):
// "spend ₹1099 on everything else (before GST), get one Instant Coffee jar at
// ₹49". One jar per bill; never with a coupon or Beanies; against the 1/2/3-jar
// multi-buy offer the bill takes whichever saves more.

import {
  billOffers,
  describeSpendOffer,
  spendOfferBlocks,
  liveSpendOffers,
  mergeSpendSnapshot,
  orderOfferLabel,
  parseSpendSnapshot,
  type BillOfferLine,
  type SpendOffer,
} from '@/lib/orders/offers';
import { resolveOrderLines } from '@/lib/orders/lines';
import { composeOrderBill } from '@/lib/orders/billPricing';
import { recomputeOrderTotals } from '@/lib/orders/amend';
import { editReductionInr } from '@/lib/orders/settleEdit';
import { quoteLocally } from '@/lib/pos/localQuote';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { MenuItem, StoreSettings } from '@/lib/types';

const COFFEE = '11111111-1111-4111-8111-111111111111';
const CLASSIC = '11111111-1111-4111-8111-1111111111a1';
const HAZELNUT = '11111111-1111-4111-8111-1111111111a2';
const WAFFLE = '22222222-2222-4222-8222-222222222222';
const WAFFLE_R = '22222222-2222-4222-8222-2222222222b1';
const MULTI_ID = '55555555-5555-4555-8555-555555555555';
const SPEND_ID = '66666666-6666-4666-8666-666666666666';

const SPEND: SpendOffer = {
  id: SPEND_ID,
  name: 'Instant Coffee at ₹49',
  menu_item_id: COFFEE,
  min_spend_inr: 1099,
  price_inr: 49,
};
const MULTI = { id: MULTI_ID, name: 'Instant Coffee offer', tier_prices: [299, 499, 599] };

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
const coffee: MenuItem = {
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
// A ₹157 waffle: 7 of them are ₹1099.
const waffle: MenuItem = {
  ...base,
  id: WAFFLE,
  name: 'Waffle',
  category: 'Stick Waffles',
  variants: [{ id: WAFFLE_R, menu_item_id: WAFFLE, label: 'Regular', price_inr: 157, sort_order: 0 }],
};
const menu = new Map([coffee, waffle].map((m) => [m.id, m]));

const jars = (n: number, variant_id = CLASSIC) => ({
  menu_item_id: COFFEE,
  variant_id,
  quantity: n,
  addon_option_ids: [],
  special_instructions: '',
});
const waffles = (n: number) => ({ menu_item_id: WAFFLE, variant_id: WAFFLE_R, quantity: n, addon_option_ids: [], special_instructions: '' });

/** Lines resolved with both offers live (as the server and the POS resolve them). */
function linesFor(items: Parameters<typeof resolveOrderLines>[0], { multi = true } = {}) {
  const r = resolveOrderLines(items, menu, {}, multi ? new Map([[COFFEE, MULTI]]) : new Map(), new Set([COFFEE]));
  if (!r.ok) throw new Error(r.error);
  return r;
}

function offersFor(items: Parameters<typeof resolveOrderLines>[0], extra: { multi?: boolean; blocked?: boolean; pass?: number } = {}) {
  return billOffers({
    lines: linesFor(items, { multi: extra.multi }).lines,
    spendOffers: [SPEND],
    passCoveredInr: extra.pass ?? 0,
    otherDiscountApplied: extra.blocked ?? false,
  });
}

describe('spend offer terms', () => {
  it('reads as "Spend ₹1099 → one for ₹49"', () => {
    expect(describeSpendOffer(SPEND)).toBe('Spend ₹1099 → one for ₹49');
  });

  it('is live when switched on and inside its window; malformed or duplicate rows are skipped', () => {
    const row = { ...SPEND, active: true, valid_from: null, valid_to: null };
    const now = new Date('2026-11-01T10:00:00Z');
    expect(liveSpendOffers([row], now)).toEqual([SPEND]);
    expect(liveSpendOffers([{ ...row, active: false }], now)).toEqual([]);
    expect(liveSpendOffers([{ ...row, valid_to: '2026-11-01T09:00:00Z' }], now)).toEqual([]);
    expect(liveSpendOffers([{ ...row, min_spend_inr: 0 }], now)).toEqual([]);
    expect(liveSpendOffers([{ ...row, price_inr: -1 }], now)).toEqual([]);
    expect(liveSpendOffers([row, { ...row, id: 'other', price_inr: 1 }], now)).toHaveLength(1);
  });

  it('a stored snapshot reads back, and grows only with live offers on items the bill has', () => {
    expect(parseSpendSnapshot([SPEND, { junk: true }])).toEqual([SPEND]);
    expect(parseSpendSnapshot(null)).toEqual([]);
    const other = { ...SPEND, id: 'x', menu_item_id: WAFFLE };
    expect(mergeSpendSnapshot([SPEND], [SPEND, other], [COFFEE])).toEqual([SPEND]);
    expect(mergeSpendSnapshot([], [SPEND, other], [COFFEE, WAFFLE])).toEqual([SPEND, other]);
  });
});

describe('billOffers with a spend offer', () => {
  it('₹1099 of other items + 1 jar: the jar is ₹49 (₹350 off), labelled with the offer name', () => {
    const r = offersFor([waffles(7), jars(1)]);
    expect(r).toMatchObject({ discountInr: 350, kind: 'spend', label: 'Instant Coffee at ₹49', notes: [] });
    expect(r.offers).toEqual([
      { offer_id: SPEND_ID, menu_item_id: COFFEE, name: 'Instant Coffee at ₹49', units: 1, regular_inr: 399, offer_inr: 49, discount_inr: 350 },
    ]);
  });

  it('the jar itself never counts toward the minimum: ₹1098 of other items is not enough', () => {
    // 6 waffles (₹942) + 1 jar (₹399) = ₹1341 on the bill, but only ₹942 is "everything else".
    expect(offersFor([waffles(6), jars(1)])).toMatchObject({ kind: 'multi_buy', discountInr: 100 });
    // Without the multi-buy offer either, nothing comes off.
    expect(offersFor([waffles(6), jars(1)], { multi: false })).toMatchObject({ kind: 'none', discountInr: 0 });
  });

  it('other jars DO count as "everything else", and only one jar per bill is ₹49', () => {
    // 2 jars: 3 jars' worth would be needed otherwise; here 7 waffles + 1 other jar.
    const r = offersFor([waffles(7), jars(2)], { multi: false });
    expect(r).toMatchObject({ kind: 'spend', discountInr: 350 });
    expect(r.offers[0].units).toBe(1);
  });

  it('against the 1/2/3-jar offer the bill takes whichever saves more, never both', () => {
    // 1 jar: ₹350 vs ₹100 → the ₹49 jar.
    expect(offersFor([waffles(7), jars(1)])).toMatchObject({ kind: 'spend', discountInr: 350 });
    // 2 jars: ₹350 vs ₹299 → the ₹49 jar (the other jar at ₹399).
    expect(offersFor([waffles(7), jars(2)])).toMatchObject({ kind: 'spend', discountInr: 350 });
    // 3 jars: ₹350 vs ₹598 → 3 for ₹599.
    expect(offersFor([waffles(7), jars(3)])).toMatchObject({ kind: 'multi_buy', discountInr: 598, label: 'Instant Coffee offer' });
  });

  it('with a coupon or Beanies on the bill it stays off, and says why', () => {
    const r = offersFor([waffles(7), jars(1)], { blocked: true });
    expect(r).toMatchObject({ kind: 'multi_buy', discountInr: 100 });
    expect(r.notes).toEqual(["Instant Coffee at ₹49 isn't applied: it can't be combined with a coupon or Beanies."]);
  });

  it('what Ritual cups pay for is not spent today, so it does not count toward the minimum', () => {
    expect(offersFor([waffles(8), jars(1)], { multi: false, pass: 157 })).toMatchObject({ kind: 'spend' });
    expect(offersFor([waffles(8), jars(1)], { multi: false, pass: 158 })).toMatchObject({ kind: 'none' });
  });

  it('a line with no unit-price snapshot (sold before the offer existed) is never priced by it', () => {
    const r = resolveOrderLines([waffles(7), jars(1)], menu);
    expect(r.ok && billOffers({ lines: r.lines, spendOffers: [SPEND] }).kind).toBe('none');
  });

  it('resolveOrderLines records the jar price for a spend-offer item without inventing a multi-buy', () => {
    const [w, j] = linesFor([waffles(1), jars(1)], { multi: false }).lines;
    expect(j).toMatchObject({ offer_unit_inr: 399 });
    expect(j).not.toHaveProperty('offer_prices');
    expect(w).not.toHaveProperty('offer_unit_inr');
  });
});

describe('the bill', () => {
  function bill(items: Parameters<typeof resolveOrderLines>[0], dineIn = true) {
    const r = linesFor(items);
    const offers = billOffers({ lines: r.lines, spendOffers: [SPEND] });
    return composeOrderBill({
      settings,
      subtotalInr: r.subtotalInr,
      taxableSubtotalInr: r.taxableSubtotalInr,
      offerDiscountInr: offers.discountInr,
      couponDiscountInr: 0,
      pointsDiscountInr: 0,
      passCoveredInr: 0,
      passCoveredTaxableInr: 0,
      isDineIn: dineIn,
    });
  }

  it('₹1099 of waffles + a jar: subtotal ₹1498, offer −₹350, items come to ₹1148 before GST', () => {
    const b = bill([waffles(7), jars(1)]);
    expect(b).toMatchObject({ subtotal_inr: 1498, offer_discount_inr: 350, discount_inr: 350 });
    expect(b.total_inr).toBe(1498 - 350 + b.tax_inr);
  });

  it('the stored label wins over the lines on a printed bill', () => {
    expect(orderOfferLabel({ offer_name: 'Instant Coffee at ₹49', items: [] })).toBe('Instant Coffee at ₹49');
    expect(
      orderOfferLabel({ offer_name: null, items: [{ name_snapshot: 'Instant Coffee', offer_prices: [299, 499, 599], offer_name: 'Instant Coffee offer' }] }),
    ).toBe('Instant Coffee offer');
  });
});

describe('once per customer, by phone number', () => {
  it('no number: blocked with a note asking for it; a number that had it: blocked with a note saying so', () => {
    expect(spendOfferBlocks([SPEND], null, new Set())).toEqual(
      new Map([[SPEND_ID, "Instant Coffee at ₹49: add the customer's phone number to give it (once per customer)."]]),
    );
    expect(spendOfferBlocks([SPEND], '+919876543210', new Set([SPEND_ID]))).toEqual(
      new Map([[SPEND_ID, "Instant Coffee at ₹49 isn't applied: this customer has already had it (once per customer)."]]),
    );
    expect(spendOfferBlocks([SPEND], '+919876543210', new Set())).toEqual(new Map());
  });

  it('a blocked customer gets the multi-buy offer instead, with the note; a bill that does not qualify says nothing', () => {
    const blocked = spendOfferBlocks([SPEND], null, new Set());
    const r = billOffers({ lines: linesFor([waffles(7), jars(1)]).lines, spendOffers: [SPEND], spendBlocked: blocked });
    expect(r).toMatchObject({ kind: 'multi_buy', discountInr: 100 });
    expect(r.notes).toEqual([blocked.get(SPEND_ID)]);
    const small = billOffers({ lines: linesFor([waffles(1), jars(1)]).lines, spendOffers: [SPEND], spendBlocked: blocked });
    expect(small.notes).toEqual([]);
  });

  it('an empty note blocks silently (a correction on an order that never had it)', () => {
    const r = billOffers({ lines: linesFor([waffles(7), jars(1)]).lines, spendOffers: [SPEND], spendBlocked: new Map([[SPEND_ID, '']]) });
    expect(r).toMatchObject({ kind: 'multi_buy', notes: [] });
  });

  it('the applied offer names its id, for the once-per-customer record', () => {
    expect(offersFor([waffles(7), jars(1)]).offers[0].offer_id).toBe(SPEND_ID);
  });
});

describe('the POS prices it on its own screen exactly as the server does', () => {
  it('a cart that qualifies for a spend offer goes to the server (only it knows who has had it)', () => {
    const q = quoteLocally({
      items: [waffles(7), jars(1)],
      menuItems: [coffee, waffle],
      pricing: {
        settings,
        offers: [{ ...MULTI, menu_item_id: COFFEE, active: true, valid_from: null, valid_to: null }],
        spendOffers: [{ ...SPEND, active: true, valid_from: null, valid_to: null }],
      },
      isDineIn: true,
    });
    expect(q).toEqual({ ok: false, error: '', needsServer: true });
  });

  it('a cart under the minimum still prices on the screen, with the multi-buy offer', () => {
    const q = quoteLocally({
      items: [waffles(1), jars(1)],
      menuItems: [coffee, waffle],
      pricing: {
        settings,
        offers: [{ ...MULTI, menu_item_id: COFFEE, active: true, valid_from: null, valid_to: null }],
        spendOffers: [{ ...SPEND, active: true, valid_from: null, valid_to: null }],
      },
      isDineIn: true,
    });
    expect(q.ok && q.bill).toMatchObject({ subtotal_inr: 556, offer_discount_inr: 100 });
    expect(q.ok && q.offerLabel).toBe('Instant Coffee offer');
  });

  it('an older menu answer with no spend offers prices as before', () => {
    const q = quoteLocally({
      items: [waffles(7), jars(1)],
      menuItems: [coffee, waffle],
      pricing: { settings, offers: [] },
      isDineIn: true,
    });
    expect(q.ok && q.bill).toMatchObject({ offer_discount_inr: 0, discount_inr: 0 });
  });
});

describe('corrections re-check the minimum against what remains', () => {
  type TestLine = Omit<BillOfferLine, 'offer_prices' | 'menu_item_id'> & {
    menu_item_id: string;
    offer_prices?: number[] | null;
    gst_exempt?: boolean;
  };
  const line = (over: Partial<TestLine> & { line_total_inr: number }): TestLine & { voided: boolean } => ({
    menu_item_id: '',
    name_snapshot: '',
    quantity: 1,
    voided: false,
    gst_exempt: false,
    ...over,
  });
  const waffleLine = (qty: number, voided = false) =>
    line({ menu_item_id: WAFFLE, name_snapshot: 'Waffle', quantity: qty, line_total_inr: 157 * qty, price_inr_snapshot: 157, voided });
  const jarLine = line({
    menu_item_id: COFFEE,
    name_snapshot: 'Instant Coffee',
    quantity: 1,
    line_total_inr: 399,
    price_inr_snapshot: 399,
    gst_exempt: true,
    offer_unit_inr: 399,
    offer_prices: [299, 499, 599],
    offer_name: 'Instant Coffee offer',
  });
  const dineIn = { settings, orderType: 'dine_in' as const };

  it('an order that never had it (blocked) does not gain it on a correction', () => {
    const bill = recomputeOrderTotals({
      ...dineIn,
      items: [waffleLine(7), jarLine],
      discountInr: 100,
      offerDiscountInr: 100,
      spendOffers: [SPEND],
      spendBlocked: new Map([[SPEND_ID, '']]),
    });
    expect(bill).toMatchObject({ offer_discount_inr: 100, offer_kind: 'multi_buy', spend_offer_id: null });
  });

  it('voiding a waffle takes the rest under ₹1099: the jar goes back to the 1/2/3-jar offer (₹299)', () => {
    const bill = recomputeOrderTotals({
      ...dineIn,
      items: [waffleLine(6), waffleLine(1, true), jarLine],
      discountInr: 350,
      offerDiscountInr: 350,
      spendOffers: [SPEND],
    });
    expect(bill).toMatchObject({ offer_discount_inr: 100, offer_kind: 'multi_buy', offer_label: 'Instant Coffee offer' });
  });

  it('while the rest still qualifies the ₹49 jar stays, labelled for the bill', () => {
    const bill = recomputeOrderTotals({
      ...dineIn,
      items: [waffleLine(7), jarLine],
      discountInr: 350,
      offerDiscountInr: 350,
      spendOffers: [SPEND],
    });
    expect(bill).toMatchObject({
      subtotal_inr: 1498,
      offer_discount_inr: 350,
      offer_kind: 'spend',
      offer_label: 'Instant Coffee at ₹49',
      spend_offer_id: SPEND_ID,
    });
  });

  it('a coupon on the order keeps it off, as at creation', () => {
    const bill = recomputeOrderTotals({
      ...dineIn,
      items: [waffleLine(7), jarLine],
      discountInr: 100 + 50,
      offerDiscountInr: 100,
      spendOffers: [SPEND],
    });
    expect(bill).toMatchObject({ offer_discount_inr: 100, discount_inr: 150, offer_kind: 'multi_buy' });
  });

  it('the Settle edit preview shows the jar going back up when an edit breaks the minimum', () => {
    const lines = [
      { id: 'w', ...waffleLine(7) },
      { id: 'j', ...jarLine },
    ];
    const change = { item_id: 'w', from_quantity: 7, to_quantity: 6, from_line_total_inr: 1099, to_line_total_inr: 942, remove: false };
    // ₹157 off the waffles, but the jar's offer falls from ₹350 to ₹100: the bill comes down only ₹157 − ₹250.
    expect(editReductionInr([change], lines, { spend_offers: [SPEND], discount_inr: 350, offer_discount_inr: 350 })).toBe(157 - 250);
  });
});
