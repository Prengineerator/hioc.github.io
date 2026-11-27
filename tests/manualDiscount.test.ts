import { describe, expect, it } from 'vitest';

// Manager discount (lib/orders/manualDiscount.ts, 2026-11-manual-discount.sql):
// a manager or the owner types an amount and a reason at the POS. Pure money
// tests — the bill (composeOrderBill), a correction on the order
// (recomputeOrderTotals), the bill's rows (discountRows) and the POS's own
// pricing (quoteLocally) — plus the request rules. computeBill runs for real.

import {
  canGiveManualDiscount,
  MANUAL_DISCOUNT_LABEL,
  manualDiscountStaffLabel,
  parseManualDiscount,
  parseManualDiscountInput,
} from '@/lib/orders/manualDiscount';
import { composeOrderBill } from '@/lib/orders/billPricing';
import { recomputeOrderTotals } from '@/lib/orders/amend';
import { discountRows, splitOrderDiscount } from '@/lib/orders/offers';
import { quoteLocally } from '@/lib/pos/localQuote';
import { shapeMenuItem, type MenuItemRow } from '@/lib/orders/lines';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { MenuItem, StoreSettings } from '@/lib/types';

const settings: StoreSettings = { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0 };

const bill = (over: Partial<Parameters<typeof composeOrderBill>[0]> = {}) =>
  composeOrderBill({
    settings,
    subtotalInr: 500,
    taxableSubtotalInr: 500,
    couponDiscountInr: 0,
    pointsDiscountInr: 0,
    passCoveredInr: 0,
    passCoveredTaxableInr: 0,
    isDineIn: true,
    ...over,
  });

describe('who may give a manager discount', () => {
  it('a manager or the owner, never staff or a customer', () => {
    expect(canGiveManualDiscount('manager')).toBe(true);
    expect(canGiveManualDiscount('owner')).toBe(true);
    expect(canGiveManualDiscount('staff')).toBe(false);
    expect(canGiveManualDiscount('customer')).toBe(false);
    expect(canGiveManualDiscount(null)).toBe(false);
    expect(canGiveManualDiscount(undefined)).toBe(false);
  });
});

describe('parseManualDiscount (the request field)', () => {
  it('absent, null or ₹0 is no discount', () => {
    expect(parseManualDiscount(undefined)).toEqual({ ok: true, value: null });
    expect(parseManualDiscount(null)).toEqual({ ok: true, value: null });
    expect(parseManualDiscount({ amount_inr: 0, reason: '' })).toEqual({ ok: true, value: null });
  });

  it('takes whole rupees with a trimmed reason', () => {
    expect(parseManualDiscount({ amount_inr: 50, reason: '  Regular customer ' })).toEqual({
      ok: true,
      value: { amountInr: 50, reason: 'Regular customer' },
    });
  });

  it('refuses a reasonless, fractional, negative or absurd amount, and a non-object', () => {
    for (const raw of [
      { amount_inr: 50 },
      { amount_inr: 50, reason: '   ' },
      { amount_inr: 12.5, reason: 'x' },
      { amount_inr: -5, reason: 'x' },
      { amount_inr: '50', reason: 'x' },
      { amount_inr: 100_001, reason: 'x' },
      { amount_inr: 50, reason: 'x'.repeat(201) },
      'fifty',
      [50],
    ]) {
      expect(parseManualDiscount(raw).ok).toBe(false);
    }
  });
});

describe('parseManualDiscountInput (the POS amount box)', () => {
  it('whole rupees above zero, else null', () => {
    expect(parseManualDiscountInput('50')).toBe(50);
    expect(parseManualDiscountInput(' 120 ')).toBe(120);
    for (const t of ['', '0', 'abc', '-5', '12.5', '1e3']) expect(parseManualDiscountInput(t)).toBeNull();
  });
});

describe('composeOrderBill with a manager discount', () => {
  it('comes off before GST, so GST is on what is left', () => {
    const b = bill({ manualDiscountInr: 100 });
    // ₹400 taxable at 5% = ₹20 GST.
    expect(b).toMatchObject({ subtotal_inr: 500, discount_inr: 100, manual_discount_inr: 100, tax_inr: 20, total_inr: 420 });
  });

  it('comes off after a coupon and Beanies, on what they leave', () => {
    const b = bill({ couponDiscountInr: 50, pointsDiscountInr: 20, manualDiscountInr: 30 });
    expect(b).toMatchObject({ discount_inr: 100, manual_discount_inr: 30, total_inr: 420 });
  });

  it('is never more than the bill has left (and the bill never goes below zero)', () => {
    const b = bill({ couponDiscountInr: 450, manualDiscountInr: 200 });
    expect(b).toMatchObject({ discount_inr: 500, manual_discount_inr: 50, tax_inr: 0, total_inr: 0 });
  });

  it('comes off what the offer and the Ritual leave', () => {
    const b = bill({ offerDiscountInr: 100, passCoveredInr: 200, passCoveredTaxableInr: 200, manualDiscountInr: 500 });
    // 500 - 200 cover = 300 payable, - 100 offer = 200 left for the manager discount.
    expect(b).toMatchObject({ offer_discount_inr: 100, manual_discount_inr: 200, discount_inr: 300, pass_discount_inr: 200, total_inr: 0 });
  });

  it('none asked for: the bill is exactly as before', () => {
    expect(bill({ manualDiscountInr: 0 })).toEqual({ ...bill(), manual_discount_inr: 0 });
    expect(bill().manual_discount_inr).toBe(0);
  });
});

describe('recomputeOrderTotals keeps a manager discount through a correction', () => {
  const line = (total: number, voided = false) => ({ voided, line_total_inr: total });

  it('a void keeps it in full when the bill still covers it', () => {
    const b = recomputeOrderTotals({
      items: [line(300), line(200, true)],
      settings,
      orderType: 'dine_in',
      discountInr: 80, // ₹30 coupon + ₹50 manager
      manualDiscountInr: 50,
    });
    expect(b).toMatchObject({ subtotal_inr: 300, discount_inr: 80, manual_discount_inr: 50, total_inr: 231 });
  });

  it('lowers it only when the bill falls below it — after the coupon has taken its part', () => {
    const b = recomputeOrderTotals({
      items: [line(60), line(440, true)],
      settings,
      orderType: 'dine_in',
      discountInr: 130, // ₹30 coupon + ₹100 manager
      manualDiscountInr: 100,
    });
    expect(b).toMatchObject({ subtotal_inr: 60, discount_inr: 60, manual_discount_inr: 30, total_inr: 0 });
  });

  it('a stored manager discount larger than the stored discount is read as at most that discount', () => {
    const b = recomputeOrderTotals({ items: [line(500)], settings, orderType: 'dine_in', discountInr: 40, manualDiscountInr: 90 });
    expect(b).toMatchObject({ discount_inr: 40, manual_discount_inr: 40 });
  });

  it('an order without one is unchanged (manual_discount_inr 0)', () => {
    const b = recomputeOrderTotals({ items: [line(500)], settings, orderType: 'dine_in', discountInr: 40 });
    expect(b).toMatchObject({ discount_inr: 40, manual_discount_inr: 0, total_inr: 483 });
  });
});

describe('the bill rows', () => {
  it('the manager discount is its own row, after the offer and the coupon/Beanies row', () => {
    const order = { discount_inr: 180, offer_discount_inr: 100, manual_discount_inr: 50 };
    expect(splitOrderDiscount(order)).toEqual({ offerInr: 100, otherInr: 30, manualInr: 50 });
    expect(discountRows(order, 'Instant Coffee offer', 'Discount (SAVE30)')).toEqual([
      { label: 'Instant Coffee offer', amountInr: 100 },
      { label: 'Discount (SAVE30)', amountInr: 30 },
      { label: MANUAL_DISCOUNT_LABEL, amountInr: 50 },
    ]);
  });

  it('a staff screen shows the reason beside it', () => {
    expect(discountRows({ discount_inr: 50, manual_discount_inr: 50 }, 'Offer', 'Discount', manualDiscountStaffLabel('Late order'))).toEqual([
      { label: 'Manager discount — Late order', amountInr: 50 },
    ]);
    expect(manualDiscountStaffLabel('  ')).toBe(MANUAL_DISCOUNT_LABEL);
  });

  it('an order from before the migration shows its rows as it always did', () => {
    expect(discountRows({ discount_inr: 40 }, 'Offer')).toEqual([{ label: 'Discount', amountInr: 40 }]);
  });
});

describe('quoteLocally (the POS screen) prices it the same way', () => {
  const LATTE = '11111111-1111-4111-8111-111111111111';
  const LATTE_R = '11111111-1111-4111-8111-1111111111a1';
  // The menu as GET /api/menu?pos=true serves it: a database row, shaped.
  const latte: MenuItem = shapeMenuItem({
    id: LATTE,
    name: 'Latte',
    category: 'Coffee',
    is_available: true,
    unavailable_until: null,
    menu_item_variants: [{ id: LATTE_R, label: 'Regular', price_inr: 200, sort_order: 0 }],
    menu_item_addon_groups: [],
  } as unknown as MenuItemRow);

  it('takes it off before GST, exactly as composeOrderBill does', () => {
    const q = quoteLocally({
      items: [{ menu_item_id: LATTE, variant_id: LATTE_R, quantity: 2, addon_option_ids: [], special_instructions: '' }],
      menuItems: [latte],
      pricing: { settings: { gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0, hidden_categories: [], hidden_variant_labels: [] }, offers: [] },
      isDineIn: true,
      manualDiscountInr: 100,
    });
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.bill).toMatchObject({ subtotal_inr: 400, discount_inr: 100, manual_discount_inr: 100, tax_inr: 15, total_inr: 315 });
  });
});
