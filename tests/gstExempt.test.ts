import { describe, expect, it } from 'vitest';
import { computeBill, FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import { recomputeOrderTotals } from '@/lib/orders/amend';
import { resolveOrderLines } from '@/lib/orders/lines';
import { cartTaxableSubtotal } from '@/lib/cart/CartContext';
import type { MenuItem, StoreSettings } from '@/lib/types';

// Per-item GST exemption (supabase/2026-09-gst-exempt.sql). GST is money on a
// customer's bill, so every place it is computed is pinned here.

const exclusive: StoreSettings = { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0 };
const inclusive: StoreSettings = { ...exclusive, gst_inclusive: true };

describe('computeBill with a taxable subtotal', () => {
  it('adds GST only on the taxable part when prices exclude GST', () => {
    // ₹200 coffee (taxable) + ₹10 water (exempt): GST 5% of 200 = 10.
    expect(computeBill(210, exclusive, 0, 200)).toEqual({
      subtotal_inr: 210,
      tax_inr: 10,
      packaging_inr: 0,
      discount_inr: 0,
      total_inr: 220,
    });
  });

  it('extracts GST only from the taxable part when prices include GST', () => {
    const bill = computeBill(210, inclusive, 0, 200);
    expect(bill.tax_inr).toBe(10); // 200 - 200/1.05 = 9.52 → 10
    expect(bill.total_inr).toBe(210);
  });

  it('charges no GST on an all-exempt order', () => {
    expect(computeBill(50, exclusive, 0, 0).tax_inr).toBe(0);
  });

  it('defaults to taxing the whole subtotal, and never taxes more than the subtotal', () => {
    expect(computeBill(200, exclusive).tax_inr).toBe(10);
    expect(computeBill(200, exclusive, 0, 10_000).tax_inr).toBe(10);
    expect(computeBill(200, exclusive, 0, -5).tax_inr).toBe(0);
  });
});

function menuItem(id: string, price: number, gst_exempt?: boolean): MenuItem {
  return {
    id,
    name: id,
    description: '',
    category: 'Coffee',
    parent_category: '',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    gst_exempt,
    created_at: '',
    updated_at: '',
    variants: [{ id: `${id}-v`, menu_item_id: id, label: 'Regular', price_inr: price, sort_order: 0 }],
    addon_groups: [],
  } as MenuItem;
}

describe('resolveOrderLines', () => {
  it('snapshots each line exemption and returns the taxable subtotal', () => {
    const menu = new Map([
      ['coffee', menuItem('coffee', 200)],
      ['water', menuItem('water', 10, true)],
    ]);
    const result = resolveOrderLines(
      [
        { menu_item_id: 'coffee', variant_id: 'coffee-v', quantity: 1, addon_option_ids: [], special_instructions: '' },
        { menu_item_id: 'water', variant_id: 'water-v', quantity: 3, addon_option_ids: [], special_instructions: '' },
      ],
      menu,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.subtotalInr).toBe(230);
    expect(result.taxableSubtotalInr).toBe(200);
    expect(result.lines.map((l) => l.gst_exempt)).toEqual([false, true]);
  });
});

describe('recomputeOrderTotals (voids / added lines)', () => {
  it('taxes only non-voided lines that were not exempt when sold', () => {
    const bill = recomputeOrderTotals({
      items: [
        { voided: false, line_total_inr: 200 },
        { voided: false, line_total_inr: 20, gst_exempt: true },
        { voided: true, line_total_inr: 100 },
      ],
      settings: exclusive,
      orderType: 'takeaway',
      discountInr: 0,
    });
    expect(bill.subtotal_inr).toBe(220);
    expect(bill.tax_inr).toBe(10);
    expect(bill.total_inr).toBe(230);
  });

  it('treats a line saved before the migration (no snapshot) as taxable', () => {
    const bill = recomputeOrderTotals({
      items: [{ voided: false, line_total_inr: 200 }],
      settings: exclusive,
      orderType: 'takeaway',
      discountInr: 0,
    });
    expect(bill.tax_inr).toBe(10);
  });
});

describe('cartTaxableSubtotal', () => {
  it('leaves exempt lines out, and treats carts saved before the flag as taxable', () => {
    expect(
      cartTaxableSubtotal([
        { qty: 2, unitPriceInr: 100 },
        { qty: 3, unitPriceInr: 10, gstExempt: true },
        { qty: 1, unitPriceInr: 50, gstExempt: false },
      ]),
    ).toBe(250);
  });
});
