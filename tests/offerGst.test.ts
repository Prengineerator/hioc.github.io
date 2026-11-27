import { describe, expect, it } from 'vitest';

// GST on an offer (lib/orders/billPricing.ts billWithOffer, offerTaxableShare):
// an offer is a discount on its OWN item, so it comes out of that item's value.
// The ₹350 off a GST-free Instant Coffee jar leaves the café items' GST as it
// was, instead of being spread over the whole bill like a coupon. The bill, a
// correction and the GST export all use the same rule, so they agree.

import { composeOrderBill } from '@/lib/orders/billPricing';
import { offerTaxableShare } from '@/lib/orders/offers';
import { recomputeOrderTotals } from '@/lib/orders/amend';
import { buildOrderDataset, type ItemRow, type OrderRow } from '@/lib/reports/exports/orderData';
import { buildGstComputation, businessFromLegal } from '@/lib/reports/exports/gstComputation';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

const settings: StoreSettings = { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0 };

// 7 waffles (₹1099, GST at 5%) + 1 Instant Coffee jar (₹399, GST-free) with the
// "spend ₹1099, get the jar at ₹49" offer: ₹350 off the jar.
const waffles = { line_total_inr: 1099, gst_exempt: false };
const jar = { line_total_inr: 399, gst_exempt: true, offer_unit_inr: 399 };

function bill(extra: Partial<Parameters<typeof composeOrderBill>[0]> = {}) {
  return composeOrderBill({
    settings,
    subtotalInr: 1498,
    taxableSubtotalInr: 1099,
    offerDiscountInr: 350,
    couponDiscountInr: 0,
    pointsDiscountInr: 0,
    passCoveredInr: 0,
    passCoveredTaxableInr: 0,
    isDineIn: true,
    ...extra,
  });
}

describe('an offer comes out of its own item for GST', () => {
  it('the jar is GST-free, so its offer has no GST-liable share', () => {
    expect(offerTaxableShare([waffles, jar])).toBe(0);
    // An offer on a taxable item is all GST-liable.
    expect(offerTaxableShare([{ ...waffles, offer_unit_inr: 157 }, { line_total_inr: 20, gst_exempt: true }])).toBe(1);
    // No line carries an offer (data that shouldn't exist): spread like a coupon.
    expect(offerTaxableShare([waffles, { ...jar, offer_unit_inr: null }])).toBeCloseTo(1099 / 1498);
  });

  it('₹1099 of waffles + the ₹49 jar: GST stays 5% of ₹1099 (₹55), not ₹42', () => {
    const b = bill({ offerTaxableShare: offerTaxableShare([waffles, jar]) });
    expect(b).toMatchObject({ subtotal_inr: 1498, discount_inr: 350, offer_discount_inr: 350, pass_discount_inr: 0, tax_inr: 55 });
    expect(b.total_inr).toBe(1498 - 350 + 55);
    // The old spread-over-the-bill rule (no share given) under-charged it.
    expect(bill().tax_inr).toBe(42);
  });

  it('an offer on a taxable item takes its whole value out of the taxable base', () => {
    // A ₹1000 taxable item at ₹500 under its offer, beside ₹1000 of GST-free items.
    const b = composeOrderBill({
      settings,
      subtotalInr: 2000,
      taxableSubtotalInr: 1000,
      offerDiscountInr: 500,
      offerTaxableShare: 1,
      couponDiscountInr: 0,
      pointsDiscountInr: 0,
      passCoveredInr: 0,
      passCoveredTaxableInr: 0,
      isDineIn: true,
    });
    expect(b.tax_inr).toBe(25); // 5% of 500 (the spread rule would say 38)
  });

  it('a coupon beside a multi-buy offer is still shared over what the offer leaves', () => {
    // Waffles ₹1099 + 2 jars ₹798 with "2 for ₹499" (₹299 off the jars), and a ₹100 coupon.
    const lines = [waffles, { line_total_inr: 798, gst_exempt: true, offer_unit_inr: 399 }];
    const b = composeOrderBill({
      settings,
      subtotalInr: 1897,
      taxableSubtotalInr: 1099,
      offerDiscountInr: 299,
      offerTaxableShare: offerTaxableShare(lines),
      couponDiscountInr: 100,
      pointsDiscountInr: 0,
      passCoveredInr: 0,
      passCoveredTaxableInr: 0,
      isDineIn: true,
    });
    // 1099 × (1598 − 100) / 1598 = 1030.23 taxable → ₹52 GST.
    expect(b).toMatchObject({ discount_inr: 399, offer_discount_inr: 299, tax_inr: 52, total_inr: 1897 - 399 + 52 });
  });

  it('with no offer the bill is exactly what it always was', () => {
    const b = bill({ offerDiscountInr: 0, couponDiscountInr: 50, offerTaxableShare: 0 });
    const legacy = bill({ offerDiscountInr: 0, couponDiscountInr: 50 });
    expect(b).toEqual(legacy);
  });

  it('a correction recomputes the same GST the order was placed with', () => {
    const placed = bill({ offerTaxableShare: offerTaxableShare([waffles, jar]) });
    const corrected = recomputeOrderTotals({
      items: [
        { voided: false, ...waffles, menu_item_id: 'waffle', name_snapshot: 'Waffle', quantity: 7, price_inr_snapshot: 157 },
        {
          voided: false,
          ...jar,
          menu_item_id: 'jar',
          name_snapshot: 'Instant Coffee',
          quantity: 1,
          price_inr_snapshot: 399,
        },
      ],
      settings,
      orderType: 'dine_in',
      discountInr: 350,
      offerDiscountInr: 350,
      spendOffers: [{ id: 'spend', name: 'Instant Coffee at ₹49', menu_item_id: 'jar', min_spend_inr: 1099, price_inr: 49 }],
    });
    expect(corrected).toMatchObject({ tax_inr: placed.tax_inr, total_inr: placed.total_inr, discount_inr: 350 });
  });
});

describe('the GST export agrees with the bill', () => {
  const orderRow: OrderRow = {
    id: 'o1',
    order_number: 101,
    created_at: '2026-11-01T06:30:00Z',
    status: 'completed',
    payment_status: 'paid',
    payment_method: 'cash',
    channel: 'staff_pos',
    order_type: 'dine_in',
    table_label: '',
    reject_reason: '',
    created_by: null,
    subtotal_inr: 1498,
    tax_inr: 55,
    packaging_inr: 0,
    discount_inr: 350,
    total_inr: 1203,
    offer_discount_inr: 350,
  };
  const base = { order_id: 'o1', variant_label_snapshot: '', voided: false, void_reason: '', pass_drinks: 0, pass_covered_inr: 0, coffee_pass_plan_id: null, weight_grams: null };
  const items: ItemRow[] = [
    { ...base, id: 'w', menu_item_id: 'waffle', name_snapshot: 'Waffle', quantity: 7, line_total_inr: 1099, gst_exempt: false, offer_unit_inr: null },
    { ...base, id: 'j', menu_item_id: 'jar', name_snapshot: 'Instant Coffee', quantity: 1, line_total_inr: 399, gst_exempt: true, offer_unit_inr: 399 },
  ];
  const ds = buildOrderDataset({
    from: '2026-11-01',
    to: '2026-11-30',
    gstRatePercent: 5,
    gstInclusive: false,
    orders: [orderRow],
    items,
    menuItems: [
      { id: 'waffle', category: 'Stick Waffles', sold_by_weight: false },
      { id: 'jar', category: 'In-store', sold_by_weight: false },
    ],
    parts: [],
    redemptions: [],
    orderRefunds: [],
    rangeRefunds: [],
    refundOrders: [],
    staffNames: new Map(),
  });
  const o = ds.orders[0];

  it('reads the bill as net of its discount, the offer off the jar alone', () => {
    expect(o.gstRule).toBe('net_of_discount');
    expect(o.taxableValueInr).toBe(1099);
    expect(o.exemptValueInr).toBe(49);
    const [w, j] = o.lines;
    expect(w).toMatchObject({ taxableInr: 1099, exemptValueInr: 0 });
    expect(w.cgstInr + w.sgstInr).toBe(55);
    expect(j).toMatchObject({ taxableInr: 0, exemptValueInr: 49, cgstInr: 0, sgstInr: 0 });
  });

  it('does not count the offer as a Beanies discount', () => {
    expect(o.beaniesDiscountInr).toBe(0);
  });

  it('the GST working reconciles with no warnings about the figures', () => {
    const gst = buildGstComputation(ds, {
      business: businessFromLegal({ legalName: 'Arry Foods', name: 'HIOC', gstin: '09AGJPA9390E1Z9', address: 'Agra' }),
      now: new Date('2026-12-01T00:00:00Z'),
    });
    const warnings = gst.checks.filter((c) => c.status === 'warn').map((c) => c.title);
    expect(warnings.filter((t) => !/invoice number/i.test(t))).toEqual([]);
    expect(gst.taxPayable.totalInr).toBe(55);
  });
});
