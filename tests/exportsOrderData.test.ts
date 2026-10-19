import { describe, expect, it } from 'vitest';
import {
  buildOrderDataset,
  UNKNOWN_STAFF,
  type ItemRow,
  type OrderDatasetInput,
  type OrderRow,
  type RefundRow,
} from '@/lib/reports/exports/orderData';
import { HSN_COFFEE_BEANS, SAC_RESTAURANT } from '@/lib/reports/exports/gstCodes';
import { computeBill, FALLBACK_STORE_SETTINGS, GST_NET_OF_DISCOUNT_FROM } from '@/lib/store/hours';
import type { ExportOrder } from '@/lib/reports/exports/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function order(over: Partial<OrderRow> & { id: string; order_number: number }): OrderRow {
  return {
    created_at: '2026-09-10T06:30:00Z', // 12:00 IST
    status: 'completed',
    payment_status: 'paid',
    payment_method: 'cash',
    channel: 'staff_pos',
    order_type: 'dine_in',
    table_label: '',
    reject_reason: '',
    created_by: null,
    subtotal_inr: 0,
    tax_inr: 0,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: 0,
    ...over,
  };
}

function item(orderId: string, over: Partial<ItemRow> & { line_total_inr: number }): ItemRow {
  seq += 1;
  return {
    id: `item-${seq}`,
    order_id: orderId,
    menu_item_id: null,
    name_snapshot: `Item ${seq}`,
    variant_label_snapshot: '',
    quantity: 1,
    gst_exempt: false,
    voided: false,
    void_reason: '',
    pass_drinks: 0,
    pass_covered_inr: 0,
    coffee_pass_plan_id: null,
    weight_grams: null,
    ...over,
  };
}

function input(over: Partial<OrderDatasetInput> = {}): OrderDatasetInput {
  return {
    from: '2026-09-01',
    to: '2026-09-30',
    gstRatePercent: 5,
    gstInclusive: false,
    orders: [],
    items: [],
    menuItems: [],
    parts: [],
    redemptions: [],
    orderRefunds: [],
    rangeRefunds: [],
    refundOrders: [],
    staffNames: new Map(),
    ...over,
  };
}

const paise = (n: number) => Math.round(n * 100);

/** The invariant everything else rests on: the lines add up EXACTLY to the order's tax. */
function expectExactTax(o: ExportOrder, taxInr: number) {
  const lineTax = o.lines.reduce((s, l) => s + paise(l.cgstInr) + paise(l.sgstInr), 0) + paise(o.packagingCgstInr) + paise(o.packagingSgstInr);
  const lineCgst = o.lines.reduce((s, l) => s + paise(l.cgstInr), 0) + paise(o.packagingCgstInr);
  const lineSgst = o.lines.reduce((s, l) => s + paise(l.sgstInr), 0) + paise(o.packagingSgstInr);
  expect(paise(o.cgstInr) + paise(o.sgstInr)).toBe(paise(taxInr));
  if (o.lines.some((l) => l.taxableInr > 0) || o.packagingTaxableInr > 0) {
    expect(lineTax).toBe(paise(taxInr));
    expect(lineCgst).toBe(paise(o.cgstInr));
    expect(lineSgst).toBe(paise(o.sgstInr));
  }
}

function only(ds: { orders: ExportOrder[] }): ExportOrder {
  expect(ds.orders).toHaveLength(1);
  return ds.orders[0];
}

// ── Dates, numbers, status ──────────────────────────────────────────────────

describe('buildOrderDataset: identity and clock', () => {
  it('dates, times and hours are IST, flipping at 18:30 UTC', () => {
    const ds = buildOrderDataset(
      input({
        orders: [
          order({ id: 'a', order_number: 1001, created_at: '2026-09-30T18:29:59Z' }),
          order({ id: 'b', order_number: 1002, created_at: '2026-09-30T18:30:00Z' }),
        ],
      }),
    );
    expect(ds.orders[0]).toMatchObject({ date: '2026-09-30', time: '23:59', hour: 23 });
    expect(ds.orders[1]).toMatchObject({ date: '2026-10-01', time: '00:00', hour: 0 });
  });

  it('sorts by order number and prints the invoice number', () => {
    const ds = buildOrderDataset(
      input({
        orders: [order({ id: 'b', order_number: 1234 }), order({ id: 'a', order_number: 987 })],
      }),
    );
    expect(ds.orders.map((o) => o.invoiceNo)).toEqual(['HIOC-000987', 'HIOC-001234']);
  });

  it('cancelled and rejected orders are kept but not valid', () => {
    const ds = buildOrderDataset(
      input({
        orders: [
          order({ id: 'a', order_number: 1, status: 'cancelled', reject_reason: ' customer left ' }),
          order({ id: 'b', order_number: 2, status: 'rejected' }),
          order({ id: 'c', order_number: 3, status: 'received' }),
        ],
      }),
    );
    expect(ds.orders.map((o) => o.valid)).toEqual([false, false, true]);
    expect(ds.orders[0].rejectReason).toBe('customer left');
    expect(ds.orders[1].rejectReason).toBeNull();
  });

  it('defaults the optional columns of an older database', () => {
    const o = only(buildOrderDataset(input({ orders: [order({ id: 'a', order_number: 1, subtotal_inr: 80, total_inr: null })] })));
    expect(o).toMatchObject({
      orderKind: 'menu',
      settleDiscountInr: 0,
      tipInr: 0,
      passDiscountInr: 0,
      totalInr: 80,
      tableLabel: null,
    });
  });

  it('names the staff member, blank for customer orders and a fallback for an unknown id', () => {
    const ds = buildOrderDataset(
      input({
        orders: [
          order({ id: 'a', order_number: 1, created_by: 'u1' }),
          order({ id: 'b', order_number: 2, created_by: null }),
          order({ id: 'c', order_number: 3, created_by: 'gone' }),
        ],
        staffNames: new Map([['u1', 'Asha']]),
      }),
    );
    expect(ds.orders.map((o) => o.createdByName)).toEqual(['Asha', '', UNKNOWN_STAFF]);
  });
});

// ── Tax allocation ──────────────────────────────────────────────────────────

describe('buildOrderDataset: tax allocation', () => {
  it('spreads the order tax over the lines pro-rata, in paise, summing exactly', () => {
    // 150 + 99 + 55 = 304 → tax round(15.2) = 15.
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, subtotal_inr: 304, tax_inr: 15, total_inr: 319 })],
          items: [
            item('a', { line_total_inr: 150 }),
            item('a', { line_total_inr: 99 }),
            item('a', { line_total_inr: 55 }),
          ],
        }),
      ),
    );
    // 1500 paise: floor(1500×15000/30400)=740, floor(1500×9900/30400)=488, remainder 272.
    expect(o.lines.map((l) => l.cgstInr + l.sgstInr)).toEqual([7.4, 4.88, 2.72]);
    expect(o.lines.map((l) => l.taxableInr)).toEqual([150, 99, 55]);
    expect(o.taxableValueInr).toBe(304);
    expect(o.cgstInr).toBe(7.5);
    expect(o.sgstInr).toBe(7.5);
    expectExactTax(o, 15);
  });

  it('splits odd paise between CGST and SGST so neither side drifts', () => {
    // An artificial ₹1 tax over three equal lines: 33 / 33 / 34 paise.
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, subtotal_inr: 300, tax_inr: 1, total_inr: 301 })],
          items: [item('a', { line_total_inr: 100 }), item('a', { line_total_inr: 100 }), item('a', { line_total_inr: 100 })],
        }),
      ),
    );
    expect(o.lines.map((l) => paise(l.cgstInr) + paise(l.sgstInr))).toEqual([33, 33, 34]);
    for (const l of o.lines) expect(Math.abs(paise(l.cgstInr) - paise(l.sgstInr))).toBeLessThanOrEqual(1);
    expect(o.cgstInr).toBe(0.5);
    expect(o.sgstInr).toBe(0.5);
    expectExactTax(o, 1);
  });

  it('puts no tax on a GST-exempt line and keeps its value apart', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, subtotal_inr: 250, tax_inr: 10, total_inr: 260 })],
          items: [item('a', { line_total_inr: 200 }), item('a', { line_total_inr: 50, gst_exempt: true })],
        }),
      ),
    );
    expect(o.lines[0]).toMatchObject({ taxableInr: 200, cgstInr: 5, sgstInr: 5, gstExempt: false });
    expect(o.lines[1]).toMatchObject({ taxableInr: 0, cgstInr: 0, sgstInr: 0, gstExempt: true });
    expect(o.taxableValueInr).toBe(200);
    expect(o.exemptValueInr).toBe(50);
    expectExactTax(o, 10);
  });

  it('takes pass-covered rupees out of the base: a covered line is untaxed, a part-covered one taxed on the rest', () => {
    // Latte ₹180 fully paid by a Ritual cup; brownie ₹120; shake ₹200 with ₹120 covered.
    // Taxable base 0 + 120 + 80 = 200 → tax 10; discount_inr is untouched by the pass.
    const o = only(
      buildOrderDataset(
        input({
          orders: [
            order({
              id: 'a',
              order_number: 1,
              subtotal_inr: 500,
              tax_inr: 10,
              pass_discount_inr: 300,
              total_inr: 210,
            }),
          ],
          items: [
            item('a', { line_total_inr: 180, pass_covered_inr: 180, pass_drinks: 1 }),
            item('a', { line_total_inr: 120 }),
            item('a', { line_total_inr: 200, pass_covered_inr: 120, pass_drinks: 1 }),
          ],
        }),
      ),
    );
    expect(o.lines.map((l) => l.taxableInr)).toEqual([0, 120, 80]);
    expect(o.lines.map((l) => l.passCoveredInr)).toEqual([180, 0, 120]);
    expect(o.lines.map((l) => l.cgstInr + l.sgstInr)).toEqual([0, 6, 4]);
    expect(o.passDiscountInr).toBe(300);
    expect(o.taxableValueInr).toBe(200);
    expectExactTax(o, 10);
  });

  it('leaves voided lines out of the lines and the allocation, listing them apart', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 5, total_inr: 105 })],
          items: [
            item('a', { line_total_inr: 100 }),
            item('a', { line_total_inr: 400, voided: true, void_reason: 'wrong order', name_snapshot: 'Pizza', quantity: 2 }),
          ],
        }),
      ),
    );
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0].taxableInr).toBe(100);
    expect(o.voidedLines).toEqual([
      { name: 'Pizza', variant: '', quantity: 2, lineTotalInr: 400, reason: 'wrong order' },
    ]);
    expectExactTax(o, 5);
  });

  it('inclusive pricing: taxable value is the price less its GST', () => {
    // 105 + 210 = 315 incl. 5% → tax 15, taxable 300.
    const o = only(
      buildOrderDataset(
        input({
          gstInclusive: true,
          orders: [order({ id: 'a', order_number: 1, subtotal_inr: 315, tax_inr: 15, total_inr: 315 })],
          items: [item('a', { line_total_inr: 105 }), item('a', { line_total_inr: 210 })],
        }),
      ),
    );
    expect(o.lines.map((l) => l.taxableInr)).toEqual([100, 200]);
    expect(o.lines.map((l) => l.cgstInr + l.sgstInr)).toEqual([5, 10]);
    expect(o.taxableValueInr).toBe(300);
    expectExactTax(o, 15);
  });

  it('still prices a cancelled order (it is just not valid)', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 })],
          items: [item('a', { line_total_inr: 100 })],
        }),
      ),
    );
    expect(o.valid).toBe(false);
    expect(o.taxableValueInr).toBe(100);
    expectExactTax(o, 5);
  });

  it('keeps tax that no line can carry on the order and backs the taxable value out of it', () => {
    // Every line exempt, yet ₹10 was charged: 10 / 5% = ₹200 taxable.
    const exclusive = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, subtotal_inr: 80, tax_inr: 10, total_inr: 90 })],
          items: [item('a', { line_total_inr: 80, gst_exempt: true })],
        }),
      ),
    );
    expect(exclusive.taxableValueInr).toBe(200);
    expect(exclusive.cgstInr).toBe(5);
    expect(exclusive.sgstInr).toBe(5);
    expect(exclusive.lines[0].taxableInr).toBe(0);
    expect(exclusive.exemptValueInr).toBe(80);

    // No tax, no taxable line: nothing to report.
    const none = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, subtotal_inr: 80, tax_inr: 0, total_inr: 80 })],
          items: [item('a', { line_total_inr: 80, gst_exempt: true })],
        }),
      ),
    );
    expect(none.taxableValueInr).toBe(0);
    expect(none.cgstInr + none.sgstInr).toBe(0);
  });

  it('an order with no lines at all gets no taxable value and no crash', () => {
    const o = only(buildOrderDataset(input({ orders: [order({ id: 'a', order_number: 1, tax_inr: 0 })] })));
    expect(o.lines).toEqual([]);
    expect(o.taxableValueInr).toBe(0);
  });

  it('holds the exact-sum invariant over many random bills (exclusive and inclusive)', () => {
    let state = 12345;
    const rnd = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (const inclusive of [false, true]) {
      const orders: OrderRow[] = [];
      const items: ItemRow[] = [];
      for (let i = 0; i < 300; i++) {
        const id = `o${i}`;
        const lines: ItemRow[] = [];
        const n = 1 + rnd(6);
        for (let k = 0; k < n; k++) {
          const total = 20 + rnd(980);
          const covered = rnd(5) === 0 ? rnd(total + 1) : 0;
          lines.push(
            item(id, {
              line_total_inr: total,
              gst_exempt: rnd(6) === 0,
              pass_covered_inr: covered,
              voided: rnd(8) === 0,
            }),
          );
        }
        const live = lines.filter((l) => !l.voided);
        const taxableBase = live.filter((l) => !l.gst_exempt).reduce((s, l) => s + l.line_total_inr - (l.pass_covered_inr ?? 0), 0);
        const tax = inclusive ? Math.round(taxableBase - taxableBase / 1.05) : Math.round(taxableBase * 0.05);
        orders.push(order({ id, order_number: 1000 + i, tax_inr: tax }));
        items.push(...lines);
      }
      const ds = buildOrderDataset(input({ gstInclusive: inclusive, orders, items }));
      for (const o of ds.orders) {
        expectExactTax(o, o.taxInr);
        for (const l of o.lines) {
          expect(Math.abs(paise(l.cgstInr) - paise(l.sgstInr))).toBeLessThanOrEqual(1);
          expect(l.taxableInr).toBeGreaterThanOrEqual(0);
        }
        // Exclusive: the taxable value is the base; inclusive: base less tax.
        const base = o.lines.filter((l) => !l.gstExempt).reduce((s, l) => s + paise(l.lineTotalInr) - paise(l.passCoveredInr), 0);
        const expected = inclusive ? base - paise(o.taxInr) : base;
        if (o.lines.some((l) => !l.gstExempt && l.lineTotalInr - l.passCoveredInr > 0)) {
          expect(paise(o.taxableValueInr)).toBe(expected);
        }
      }
    }
  });
});

// ── Lines: category, code, weight ───────────────────────────────────────────

describe('buildOrderDataset: line classification', () => {
  it('uses the menu category, HIOC Ritual for pass sales and Uncategorised when the item is gone', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1 })],
          menuItems: [
            { id: 'm1', category: 'Coffee' },
            { id: 'm2', category: '  ' },
          ],
          items: [
            item('a', { line_total_inr: 100, menu_item_id: 'm1' }),
            item('a', { line_total_inr: 100, menu_item_id: 'm2' }),
            item('a', { line_total_inr: 100, menu_item_id: null }),
            item('a', { line_total_inr: 100, menu_item_id: 'deleted' }),
            item('a', { line_total_inr: 999, coffee_pass_plan_id: 'plan-1' }),
          ],
        }),
      ),
    );
    expect(o.lines.map((l) => l.category)).toEqual(['Coffee', 'Uncategorised', 'Uncategorised', 'Uncategorised', 'HIOC Ritual']);
  });

  it('reports beans sold by weight under HSN 0901 and everything else under SAC 996331', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1 })],
          menuItems: [
            { id: 'beans', category: 'Beans', sold_by_weight: true },
            { id: 'latte', category: 'Coffee', sold_by_weight: false },
          ],
          items: [
            item('a', { line_total_inr: 1200, menu_item_id: 'beans', quantity: 2, weight_grams: 250 }),
            item('a', { line_total_inr: 150, menu_item_id: 'latte' }),
            // The item was switched back to by-the-unit later; the line still carries its weight.
            item('a', { line_total_inr: 600, menu_item_id: 'latte', weight_grams: 250 }),
          ],
        }),
      ),
    );
    expect(o.lines[0]).toMatchObject({ gstCode: HSN_COFFEE_BEANS, weightGrams: 250, quantity: 2 });
    expect(o.lines[1]).toMatchObject({ gstCode: SAC_RESTAURANT, weightGrams: null });
    expect(o.lines[2].gstCode).toBe(HSN_COFFEE_BEANS);
  });

  it('keeps the variant label and treats a missing one as empty', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1 })],
          items: [
            item('a', { line_total_inr: 100, variant_label_snapshot: 'Large' }),
            item('a', { line_total_inr: 100, variant_label_snapshot: null }),
          ],
        }),
      ),
    );
    expect(o.lines.map((l) => l.variant)).toEqual(['Large', '']);
  });
});

// ── Payments, coupons, refunds ──────────────────────────────────────────────

describe('buildOrderDataset: payments and discounts', () => {
  it('lists split parts in the order they were taken, distinct; else the single method', () => {
    const ds = buildOrderDataset(
      input({
        orders: [
          order({ id: 'split', order_number: 1, payment_method: 'cash' }),
          order({ id: 'single', order_number: 2, payment_method: 'upi' }),
          order({ id: 'unpaid', order_number: 3, payment_method: null, payment_status: 'unpaid' }),
        ],
        parts: [
          { order_id: 'split', method: 'cash', created_at: '2026-09-10T06:32:00Z' },
          { order_id: 'split', method: 'upi', created_at: '2026-09-10T06:31:00Z' },
          { order_id: 'split', method: 'upi', created_at: '2026-09-10T06:33:00Z' },
        ],
      }),
    );
    expect(ds.orders.map((o) => o.paymentMethods)).toEqual([['upi', 'cash'], ['upi'], []]);
  });

  it('splits discount_inr into coupon and Beanies, never below zero', () => {
    const ds = buildOrderDataset(
      input({
        orders: [
          order({ id: 'a', order_number: 1, discount_inr: 50 }),
          order({ id: 'b', order_number: 2, discount_inr: 20 }),
          order({ id: 'c', order_number: 3, discount_inr: 40 }),
        ],
        redemptions: [
          { order_id: 'a', discount_inr: 30, code: 'WELCOME' },
          { order_id: 'b', discount_inr: 30, code: 'WELCOME' },
          { order_id: 'b', discount_inr: 0, code: 'WELCOME' },
          { order_id: 'b', discount_inr: 0, code: null },
        ],
      }),
    );
    expect(ds.orders[0]).toMatchObject({ couponDiscountInr: 30, beaniesDiscountInr: 20, couponCodes: ['WELCOME'] });
    expect(ds.orders[1]).toMatchObject({ couponDiscountInr: 30, beaniesDiscountInr: 0, couponCodes: ['WELCOME'] });
    // All Beanies, no coupon.
    expect(ds.orders[2]).toMatchObject({ couponDiscountInr: 0, beaniesDiscountInr: 40, couponCodes: [] });
  });
});

describe('buildOrderDataset: refunds', () => {
  const refund = (over: Partial<RefundRow> & { id: string; order_id: string }): RefundRow => ({
    amount_inr: 40,
    method: 'cash',
    reason: 'cold coffee',
    status: 'processed',
    processed_at: '2026-09-12T10:00:00Z',
    created_by: 'mgr',
    created_at: '2026-09-12T09:55:00Z',
    ...over,
  });

  it('refundedInr counts processed refunds only, whenever they happened', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1 })],
          orderRefunds: [
            refund({ id: 'r1', order_id: 'a', amount_inr: 40 }),
            refund({ id: 'r2', order_id: 'a', amount_inr: 25, processed_at: '2026-10-02T10:00:00Z' }),
            refund({ id: 'r3', order_id: 'a', amount_inr: 20, status: 'pending', processed_at: null }),
            refund({ id: 'r4', order_id: 'a', amount_inr: 10, status: 'failed', processed_at: null }),
          ],
        }),
      ),
    );
    expect(o.refundedInr).toBe(65);
  });

  it('dates a refund by processed_at (IST), or created_at while pending, and keeps only those in the range', () => {
    const ds = buildOrderDataset(
      input({
        orders: [order({ id: 'a', order_number: 1005, created_at: '2026-09-10T06:30:00Z' })],
        refundOrders: [{ id: 'old', order_number: 990, created_at: '2026-08-31T18:40:00Z' }],
        staffNames: new Map([['mgr', 'Meera']]),
        rangeRefunds: [
          // Processed 00:10 IST on 1 Sep (18:40 UTC on 31 Aug) for a bill from an earlier month.
          refund({ id: 'r1', order_id: 'old', processed_at: '2026-08-31T18:40:00Z' }),
          // Still pending: dated by when it was raised.
          refund({ id: 'r2', order_id: 'a', status: 'pending', processed_at: null, created_at: '2026-09-20T05:00:00Z', created_by: 'nobody' }),
          // Processed after the range ends: not in the dataset.
          refund({ id: 'r3', order_id: 'a', processed_at: '2026-09-30T18:30:00Z' }),
        ],
      }),
    );
    expect(ds.refunds).toHaveLength(2);
    expect(ds.refunds[0]).toMatchObject({
      id: 'r1',
      invoiceNo: 'HIOC-000990',
      orderDate: '2026-09-01',
      date: '2026-09-01',
      amountInr: 40,
      method: 'cash',
      reason: 'cold coffee',
      status: 'processed',
      createdByName: 'Meera',
    });
    expect(ds.refunds[1]).toMatchObject({
      id: 'r2',
      invoiceNo: 'HIOC-001005',
      orderDate: '2026-09-10',
      date: '2026-09-20',
      status: 'pending',
      processedAt: null,
      createdByName: UNKNOWN_STAFF,
    });
  });

  it('carries the range and the GST settings through', () => {
    const ds = buildOrderDataset(input({ gstRatePercent: 18, gstInclusive: true }));
    expect(ds).toMatchObject({ from: '2026-09-01', to: '2026-09-30', gstRatePercent: 18, gstInclusive: true, orders: [], refunds: [] });
  });
});


// ── The two GST rules (GST_NET_OF_DISCOUNT_FROM) ────────────────────────────

// 2026-10-19: from this IST date GST is charged after the discount's share and on packaging.
const OLD_DAY = '2026-10-18T06:30:00Z'; // 12:00 IST, the day before
const NEW_DAY = '2026-10-20T06:30:00Z'; // 12:00 IST, after

describe('buildOrderDataset: the rule by date', () => {
  it('switches at IST midnight of GST_NET_OF_DISCOUNT_FROM', () => {
    expect(GST_NET_OF_DISCOUNT_FROM).toBe('2026-10-19');
    const ds = buildOrderDataset(
      input({
        orders: [
          order({ id: 'a', order_number: 1, created_at: '2026-10-18T18:29:59Z' }), // 23:59 IST on the 18th
          order({ id: 'b', order_number: 2, created_at: '2026-10-18T18:30:00Z' }), // 00:00 IST on the 19th
        ],
      }),
    );
    expect(ds.orders.map((o) => o.gstRule)).toEqual(['pre_discount', 'net_of_discount']);
  });

  const lines = (id: string) => [
    item(id, { line_total_inr: 150 }),
    item(id, { line_total_inr: 99 }),
    item(id, { line_total_inr: 55 }),
  ];

  it('net_of_discount: tax on the lines after the discount plus packaging, all adding up to tax_inr', () => {
    // 304 − 40 discount = 264, + 10 packaging = 274 → tax round(13.7) = 14.
    const o = only(
      buildOrderDataset(
        input({
          orders: [
            order({ id: 'a', order_number: 1, created_at: NEW_DAY, order_type: 'takeaway', subtotal_inr: 304, discount_inr: 40, packaging_inr: 10, tax_inr: 14, total_inr: 288 }),
          ],
          items: lines('a'),
        }),
      ),
    );
    expect(o.gstRule).toBe('net_of_discount');
    // The 264 left after the discount is shared over the lines by value: 130.26 + 85.98 + 47.76.
    expect(o.lines.map((l) => l.taxableInr)).toEqual([130.26, 85.98, 47.76]);
    expect(o.packagingTaxableInr).toBe(10);
    expect(o.taxableValueInr).toBe(274);
    expect(o.exemptValueInr).toBe(0);
    // 1400 paise over [packaging 1000, 13026, 8598, 4776]: 51 / 665 / 439 / 245.
    expect(o.packagingCgstInr + o.packagingSgstInr).toBe(0.51);
    expect(o.lines.map((l) => paise(l.cgstInr) + paise(l.sgstInr))).toEqual([665, 439, 245]);
    expect(o.cgstInr).toBe(7);
    expect(o.sgstInr).toBe(7);
    expectExactTax(o, 14);
  });

  it('pre_discount: the same bill dated before is taxed on the full price, packaging untaxed', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [
            order({ id: 'a', order_number: 1, created_at: OLD_DAY, order_type: 'takeaway', subtotal_inr: 304, discount_inr: 40, packaging_inr: 10, tax_inr: 15, total_inr: 259 }),
          ],
          items: lines('a'),
        }),
      ),
    );
    expect(o.gstRule).toBe('pre_discount');
    expect(o.lines.map((l) => l.taxableInr)).toEqual([150, 99, 55]);
    expect(o.packagingTaxableInr).toBe(0);
    expect(o.packagingCgstInr + o.packagingSgstInr).toBe(0);
    expect(o.taxableValueInr).toBe(304);
    expectExactTax(o, 15);
  });

  it('uses the rule the stored tax reproduces when the date cannot have produced it', () => {
    // The go-live day, before the deploy: dated 20 Oct, taxed the old way (15, not 14).
    const early = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, created_at: NEW_DAY, subtotal_inr: 304, discount_inr: 40, packaging_inr: 10, tax_inr: 15 })],
          items: lines('a'),
        }),
      ),
    );
    expect(early.gstRule).toBe('pre_discount');
    expect(early.taxableValueInr).toBe(304);
    // An old bill amended after go-live is re-taxed the new way (14).
    const amended = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, created_at: OLD_DAY, subtotal_inr: 304, discount_inr: 40, packaging_inr: 10, tax_inr: 14 })],
          items: lines('a'),
        }),
      ),
    );
    expect(amended.gstRule).toBe('net_of_discount');
    expect(amended.packagingTaxableInr).toBe(10);
    // Tax that matches neither: the date decides.
    const odd = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, created_at: NEW_DAY, subtotal_inr: 304, discount_inr: 40, packaging_inr: 10, tax_inr: 99 })],
          items: lines('a'),
        }),
      ),
    );
    expect(odd.gstRule).toBe('net_of_discount');
    expectExactTax(odd, 99);
  });

  it('with no discount and no packaging the two rules give the same numbers', () => {
    const rows = lines('a');
    const run = (created_at: string) =>
      only(buildOrderDataset(input({ orders: [order({ id: 'a', order_number: 1, created_at, subtotal_inr: 304, tax_inr: 15 })], items: rows })));
    const figures = (o: ExportOrder) => ({
      lines: o.lines.map((l) => [l.taxableInr, l.exemptValueInr, l.cgstInr, l.sgstInr]),
      order: [o.taxableValueInr, o.exemptValueInr, o.cgstInr, o.sgstInr, o.packagingTaxableInr],
    });
    expect(figures(run(NEW_DAY))).toEqual(figures(run(OLD_DAY)));
  });

  it('shares the discount with a GST-exempt line, which keeps its share as exempt value', () => {
    // 200 taxable + 100 exempt, ₹30 off: 180 + 90 left → tax 9 on the 180.
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, created_at: NEW_DAY, subtotal_inr: 300, discount_inr: 30, tax_inr: 9 })],
          items: [item('a', { line_total_inr: 200 }), item('a', { line_total_inr: 100, gst_exempt: true })],
        }),
      ),
    );
    expect(o.lines[0]).toMatchObject({ taxableInr: 180, exemptValueInr: 0, cgstInr: 4.5, sgstInr: 4.5 });
    expect(o.lines[1]).toMatchObject({ taxableInr: 0, exemptValueInr: 90, cgstInr: 0, sgstInr: 0 });
    expect(o.taxableValueInr).toBe(180);
    expect(o.exemptValueInr).toBe(90);
    expectExactTax(o, 9);

    // Before the date the exempt line was worth its full 100 and the taxable one 200.
    const old = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, created_at: OLD_DAY, subtotal_inr: 300, discount_inr: 30, tax_inr: 10 })],
          items: [item('a', { line_total_inr: 200 }), item('a', { line_total_inr: 100, gst_exempt: true })],
        }),
      ),
    );
    expect(old.lines[1].exemptValueInr).toBe(100);
    expect(old.exemptValueInr).toBe(100);
    expect(old.taxableValueInr).toBe(200);
  });

  it('packaging is a taxable part even when every line is exempt', () => {
    // ₹100 exempt + ₹10 packaging: tax round(0.5) = 1, all of it on the packaging.
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, created_at: NEW_DAY, order_type: 'takeaway', subtotal_inr: 100, packaging_inr: 10, tax_inr: 1 })],
          items: [item('a', { line_total_inr: 100, gst_exempt: true })],
        }),
      ),
    );
    expect(o.packagingTaxableInr).toBe(10);
    expect(o.packagingCgstInr + o.packagingSgstInr).toBe(1);
    expect(o.lines[0]).toMatchObject({ taxableInr: 0, exemptValueInr: 100 });
    expect(o.taxableValueInr).toBe(10);
    expect(o.exemptValueInr).toBe(100);
    expectExactTax(o, 1);
  });

  it('inclusive pricing takes each part’s tax out of its share of what is left, packaging included', () => {
    // 105 + 210 = 315, ₹30 off → 285 left, + 10 packaging = 295 gross → tax round(14.04) = 14.
    const o = only(
      buildOrderDataset(
        input({
          gstInclusive: true,
          orders: [order({ id: 'a', order_number: 1, created_at: NEW_DAY, order_type: 'takeaway', subtotal_inr: 315, discount_inr: 30, packaging_inr: 10, tax_inr: 14, total_inr: 295 })],
          items: [item('a', { line_total_inr: 105 }), item('a', { line_total_inr: 210 })],
        }),
      ),
    );
    expect(o.gstRule).toBe('net_of_discount');
    // 1400 paise over [packaging 1000, 9500, 19000]: 47 / 450 / 903.
    expect(o.packagingTaxableInr).toBe(9.53);
    expect(o.lines.map((l) => l.taxableInr)).toEqual([90.5, 180.97]);
    expect(o.taxableValueInr).toBe(281);
    expect(o.taxableValueInr + o.taxInr).toBe(295);
    expectExactTax(o, 14);
  });

  it('pass-covered lines leave the base before the coupon is spread over what is left', () => {
    // Latte ₹180 fully covered, brownie ₹120, shake ₹200 with ₹120 covered: 200 left, ₹20 coupon → 180, tax 9.
    const o = only(
      buildOrderDataset(
        input({
          orders: [
            order({ id: 'a', order_number: 1, created_at: NEW_DAY, subtotal_inr: 500, discount_inr: 20, pass_discount_inr: 300, tax_inr: 9, total_inr: 189 }),
          ],
          items: [
            item('a', { line_total_inr: 180, pass_covered_inr: 180, pass_drinks: 1 }),
            item('a', { line_total_inr: 120 }),
            item('a', { line_total_inr: 200, pass_covered_inr: 120, pass_drinks: 1 }),
          ],
        }),
      ),
    );
    expect(o.gstRule).toBe('net_of_discount');
    expect(o.lines.map((l) => l.taxableInr)).toEqual([0, 108, 72]);
    expect(o.lines.map((l) => paise(l.cgstInr) + paise(l.sgstInr))).toEqual([0, 540, 360]);
    expect(o.taxableValueInr).toBe(180);
    expectExactTax(o, 9);
  });

  it('a discount larger than what is left is clamped, never a negative taxable value', () => {
    const o = only(
      buildOrderDataset(
        input({
          orders: [order({ id: 'a', order_number: 1, created_at: NEW_DAY, subtotal_inr: 100, discount_inr: 500, tax_inr: 0, total_inr: 0 })],
          items: [item('a', { line_total_inr: 100 })],
        }),
      ),
    );
    expect(o.lines[0].taxableInr).toBe(0);
    expect(o.taxableValueInr).toBe(0);
  });

  it('keeps the exact-sum invariants over many random bills under both rules', () => {
    let state = 987654;
    const rnd = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (const created_at of [OLD_DAY, NEW_DAY]) {
      for (const inclusive of [false, true]) {
        const orders: OrderRow[] = [];
        const items: ItemRow[] = [];
        const expectedRule = created_at === NEW_DAY ? 'net_of_discount' : 'pre_discount';
        for (let i = 0; i < 300; i++) {
          const id = `o${i}`;
          const n = 1 + rnd(6);
          const lines: ItemRow[] = [];
          for (let k = 0; k < n; k++) {
            const total = 20 + rnd(980);
            lines.push(
              item(id, {
                line_total_inr: total,
                gst_exempt: rnd(6) === 0,
                pass_covered_inr: rnd(5) === 0 ? rnd(total + 1) : 0,
                voided: rnd(8) === 0,
              }),
            );
          }
          const live = lines.filter((l) => !l.voided);
          const covered = (l: ItemRow) => l.pass_covered_inr ?? 0;
          const subtotal = live.reduce((s, l) => s + l.line_total_inr, 0);
          const cover = live.reduce((s, l) => s + covered(l), 0);
          const taxableBase = live.filter((l) => !l.gst_exempt).reduce((s, l) => s + l.line_total_inr - covered(l), 0);
          const discount = rnd(3) === 0 ? rnd(Math.max(1, subtotal - cover) + 1) : 0;
          const packaging = rnd(3) === 0 ? 5 + rnd(20) : 0;
          // The stored tax is whatever the bill of that day charged.
          const tax =
            expectedRule === 'net_of_discount'
              ? computeBill(
                  subtotal - cover,
                  { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, gst_inclusive: inclusive, packaging_charge_inr: packaging },
                  discount,
                  taxableBase,
                ).tax_inr
              : inclusive
                ? Math.round(taxableBase - taxableBase / 1.05)
                : Math.round(taxableBase * 0.05);
          orders.push(
            order({ id, order_number: 1000 + i, created_at, tax_inr: tax, discount_inr: discount, packaging_inr: packaging }),
          );
          items.push(...lines);
        }
        const ds = buildOrderDataset(input({ gstInclusive: inclusive, orders, items }));
        for (const o of ds.orders) {
          expect(o.gstRule).toBe(expectedRule);
          expectExactTax(o, o.taxInr);
          const lineTaxable = o.lines.reduce((s, l) => s + paise(l.taxableInr), 0);
          expect(paise(o.taxableValueInr)).toBe(lineTaxable + paise(o.packagingTaxableInr));
          for (const l of o.lines) {
            expect(Math.abs(paise(l.cgstInr) - paise(l.sgstInr))).toBeLessThanOrEqual(1);
            expect(l.taxableInr).toBeGreaterThanOrEqual(0);
          }
          const carried = o.lines.some((l) => l.taxableInr > 0) || o.packagingTaxableInr > 0;
          if (!carried) continue;
          // Everything the bill charged on is accounted for: taxable + tax + exempt = what the lines and packaging were worth.
          const live = o.lines.reduce((s, l) => s + paise(l.lineTotalInr) - paise(l.passCoveredInr), 0);
          const discountP = Math.min(paise(o.discountInr), live);
          const worth = expectedRule === 'net_of_discount' ? live - discountP + paise(o.packagingInr) : live;
          const total = paise(o.taxableValueInr) + paise(o.exemptValueInr) + (inclusive ? paise(o.taxInr) : 0);
          expect(total).toBe(worth);
        }
      }
    }
  });
});
