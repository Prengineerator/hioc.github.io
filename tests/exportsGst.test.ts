import { describe, expect, it } from 'vitest';
import {
  buildOrderDataset,
  type ItemRow,
  type OrderDatasetInput,
  type OrderRow,
  type RefundRow,
} from '@/lib/reports/exports/orderData';
import { b2cs, docsIssued, gstSummary, hsnB2c } from '@/lib/reports/exports/gstReports';
import { B2CS_TYPE, PLACE_OF_SUPPLY } from '@/lib/reports/exports/gstCodes';
import type { CsvTable, CsvValue } from '@/lib/reports/csv';
import type { OrderDataset } from '@/lib/reports/exports/types';

// ── Fixtures ────────────────────────────────────────────────────────────────

let seq = 0;

function order(over: Partial<OrderRow> & { id: string; order_number: number }): OrderRow {
  return {
    created_at: '2026-09-10T06:30:00Z',
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
    menu_item_id: 'latte',
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

function build(over: Partial<OrderDatasetInput>): OrderDataset {
  return buildOrderDataset({
    from: '2026-09-01',
    to: '2026-09-30',
    gstRatePercent: 5,
    gstInclusive: false,
    orders: [],
    items: [],
    menuItems: [
      { id: 'latte', category: 'Coffee', sold_by_weight: false },
      { id: 'beans', category: 'Beans', sold_by_weight: true },
    ],
    parts: [],
    redemptions: [],
    orderRefunds: [],
    rangeRefunds: [],
    refundOrders: [],
    staffNames: new Map(),
    ...over,
  });
}

const refund = (over: Partial<RefundRow> & { id: string; order_id: string }): RefundRow => ({
  amount_inr: 40,
  method: 'cash',
  reason: '',
  status: 'processed',
  processed_at: '2026-09-12T10:00:00Z',
  created_by: null,
  created_at: '2026-09-12T09:55:00Z',
  ...over,
});

/**
 * A September at 5% exclusive. Valid: 1001 (coupon, packaging, tip), 1002 (beans by
 * weight + an exempt item), 1003 (a Ritual cup covers one line), 1006 (a voided line),
 * 1010 (a Ritual pass sale). 1004 is cancelled, 1005 rejected, 1007–1009 were deleted.
 */
function september(): OrderDataset {
  const orders = [
    order({ id: 'o1001', order_number: 1001, subtotal_inr: 249, tax_inr: 12, packaging_inr: 10, discount_inr: 20, total_inr: 251, settle_discount_inr: 5, tip_inr: 15 }),
    order({ id: 'o1002', order_number: 1002, subtotal_inr: 1250, tax_inr: 60, total_inr: 1310 }),
    order({ id: 'o1003', order_number: 1003, subtotal_inr: 300, tax_inr: 6, pass_discount_inr: 180, total_inr: 126 }),
    order({ id: 'o1004', order_number: 1004, status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
    order({ id: 'o1005', order_number: 1005, status: 'rejected', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
    order({ id: 'o1006', order_number: 1006, subtotal_inr: 200, tax_inr: 10, total_inr: 210 }),
    order({ id: 'o1010', order_number: 1010, order_kind: 'coffee_pass', subtotal_inr: 1000, tax_inr: 50, total_inr: 1050 }),
  ];
  const items = [
    item('o1001', { line_total_inr: 150 }),
    item('o1001', { line_total_inr: 99 }),
    item('o1002', { line_total_inr: 1200, menu_item_id: 'beans', quantity: 2, weight_grams: 250 }),
    item('o1002', { line_total_inr: 50, gst_exempt: true }),
    item('o1003', { line_total_inr: 180, pass_covered_inr: 180, pass_drinks: 1 }),
    item('o1003', { line_total_inr: 120 }),
    item('o1004', { line_total_inr: 100 }),
    item('o1005', { line_total_inr: 100 }),
    item('o1006', { line_total_inr: 200 }),
    item('o1006', { line_total_inr: 100, voided: true, void_reason: 'mistake' }),
    item('o1010', { line_total_inr: 1000, menu_item_id: null, coffee_pass_plan_id: 'plan-1' }),
  ];
  return build({
    orders,
    items,
    redemptions: [{ order_id: 'o1001', discount_inr: 20, code: 'WELCOME' }],
    rangeRefunds: [
      refund({ id: 'r1', order_id: 'o1001', amount_inr: 40 }),
      refund({ id: 'r2', order_id: 'o1002', amount_inr: 99, status: 'pending', processed_at: null }),
    ],
  });
}

function rowBy(t: CsvTable, label: string): CsvValue[] {
  const r = t.rows.find((x) => String(x[0]).trim().startsWith(label));
  if (!r) throw new Error(`no row starting "${label}" in ${JSON.stringify(t.rows.map((x) => x[0]))}`);
  return r;
}

const col = (t: CsvTable, name: string): number => {
  const i = t.columns.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return i;
};

const paise = (n: number) => Math.round(n * 100);

// ── Summary ─────────────────────────────────────────────────────────────────

describe('gstSummary', () => {
  const t = gstSummary(september());
  const at = (label: string, column: string) => rowBy(t, label)[col(t, column)];

  it('has the documented columns and square rows', () => {
    expect(t.columns).toEqual([
      'Line',
      'Return reference',
      'Orders',
      'Value (INR)',
      'Taxable value (INR)',
      'CGST (INR)',
      'SGST (INR)',
      'IGST (INR)',
      'Total tax (INR)',
      'Note',
    ]);
    for (const r of t.rows) expect(r).toHaveLength(t.columns.length);
    expect(t.rows.map((r) => String(r[0]).trim().split(' ')[0])).toEqual([
      'Taxable',
      'of',
      'of',
      'of',
      'GST-exempt',
      'Packaging',
      'Discounts',
      'HIOC',
      'Settle',
      'Tips',
      'Cancelled',
      'Refunds',
      'Total',
    ]);
  });

  it('taxable sales: valid orders only, tax as charged, CGST = SGST, no IGST', () => {
    expect(at('Taxable sales @ 5%', 'Orders')).toBe(5);
    expect(at('Taxable sales @ 5%', 'Taxable value (INR)')).toBe(2769);
    expect(at('Taxable sales @ 5%', 'CGST (INR)')).toBe(69);
    expect(at('Taxable sales @ 5%', 'SGST (INR)')).toBe(69);
    expect(at('Taxable sales @ 5%', 'IGST (INR)')).toBe(0);
    expect(at('Taxable sales @ 5%', 'Total tax (INR)')).toBe(138);
    expect(at('Taxable sales @ 5%', 'Value (INR)')).toBe(2907);
    expect(at('Taxable sales @ 5%', 'Return reference')).toContain('3.1(a)');
    expect(at('Taxable sales @ 5%', 'Note')).toContain('From 19 Oct 2026 bills charge GST after coupon and Beanies discounts');
    expect(at('Taxable sales @ 5%', 'Note')).toContain('0 bills on the new basis, 5 on the earlier one');
  });

  it('splits taxable sales into SAC 996331 and HSN 0901, which add back to the whole', () => {
    expect(at('of which Restaurant service', 'Taxable value (INR)')).toBe(1569);
    expect(at('of which Restaurant service', 'Total tax (INR)')).toBe(78);
    expect(at('of which Restaurant service', 'Orders')).toBe(4);
    expect(at('of which Coffee, roasted', 'Taxable value (INR)')).toBe(1200);
    expect(at('of which Coffee, roasted', 'CGST (INR)')).toBe(30);
    expect(at('of which Coffee, roasted', 'Orders')).toBe(1);
    expect(String(rowBy(t, 'of which Restaurant service')[0])).toContain('996331');
    expect(String(rowBy(t, 'of which Coffee, roasted')[0])).toContain('0901');
  });

  it('reports exempt sales, packaging, discounts, Ritual cover, settle discounts and tips apart', () => {
    expect(at('GST-exempt sales', 'Value (INR)')).toBe(50);
    expect(at('GST-exempt sales', 'Total tax (INR)')).toBe(0);
    expect(at('GST-exempt sales', 'Return reference')).toContain('3.1(c)');
    // September bills: packaging was billed without GST and discounts were not deducted.
    expect(at('Packaging charges billed without GST', 'Value (INR)')).toBe(10);
    expect(at('Packaging charges billed without GST', 'Orders')).toBe(1);
    expect(at('of which packaging', 'Taxable value (INR)')).toBe(0);
    expect(at('Discounts given', 'Value (INR)')).toBe(20);
    expect(at('Discounts given', 'Note')).toContain('Coupons ₹20');
    expect(at('Discounts given', 'Note')).toContain('Beanies ₹0');
    expect(at('Discounts given', 'Note')).toContain('From 19 Oct 2026 a discount is deducted');
    expect(at('Discounts given', 'Note')).toContain('(₹0 of this total)');
    expect(at('Discounts given', 'Note')).toContain('On earlier bills it was not deducted');
    expect(at('Discounts given', 'Note')).toContain('(₹20)');
    expect(at('HIOC Ritual cups', 'Value (INR)')).toBe(180);
    expect(at('HIOC Ritual cups', 'Note')).toContain('GST was charged when the pass was sold');
    expect(at('Settle discounts', 'Value (INR)')).toBe(5);
    expect(at('Tips', 'Value (INR)')).toBe(15);
    // Informational rows carry no tax figures.
    expect(at('Packaging charges', 'CGST (INR)')).toBe('');
  });

  it('counts cancelled and rejected bills as excluded, refunds as processed only', () => {
    expect(at('Cancelled / rejected', 'Orders')).toBe(2);
    expect(at('Cancelled / rejected', 'Value (INR)')).toBe(210);
    expect(at('Cancelled / rejected', 'Note')).toContain('1 cancelled, 1 rejected');
    expect(at('Refunds processed', 'Orders')).toBe(1);
    expect(at('Refunds processed', 'Value (INR)')).toBe(40);
    expect(at('Refunds processed', 'Note')).toContain('no credit notes');
  });

  it('totals the invoice value of valid orders', () => {
    expect(at('Total invoice value', 'Orders')).toBe(5);
    expect(at('Total invoice value', 'Value (INR)')).toBe(251 + 1310 + 126 + 210 + 1050);
  });

  it('notes inclusive pricing', () => {
    const ds = build({
      gstInclusive: true,
      orders: [order({ id: 'a', order_number: 1, subtotal_inr: 105, tax_inr: 5, total_inr: 105 })],
      items: [item('a', { line_total_inr: 105 })],
    });
    const s = gstSummary(ds);
    expect(rowBy(s, 'Taxable sales')[col(s, 'Taxable value (INR)')]).toBe(100);
    expect(rowBy(s, 'Taxable sales')[col(s, 'Note')]).toContain('Prices include GST');
    expect(rowBy(s, 'Taxable sales')[col(s, 'Value (INR)')]).toBe(105);
  });

  it('is all zeros for an empty month, not an error', () => {
    const s = gstSummary(build({}));
    expect(rowBy(s, 'Taxable sales')[col(s, 'Taxable value (INR)')]).toBe(0);
    expect(rowBy(s, 'Total invoice value')[col(s, 'Orders')]).toBe(0);
    for (const r of s.rows) expect(r).toHaveLength(s.columns.length);
  });
});

// ── Table 7 ─────────────────────────────────────────────────────────────────

describe('b2cs', () => {
  it('is one row at the current rate with the taxable value of valid orders, exempt value left out', () => {
    const t = b2cs(september());
    expect(t.columns).toEqual([
      'Type',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ]);
    expect(t.rows).toEqual([[B2CS_TYPE, PLACE_OF_SUPPLY, '', 5, 2769, 0, '']]);
    expect(t.rows[0][0]).toBe('OE');
    expect(t.rows[0][1]).toBe('09-Uttar Pradesh');
  });

  it('has no rows when nothing taxable was sold (empty, all exempt, or all cancelled)', () => {
    expect(b2cs(build({})).rows).toEqual([]);
    const exempt = build({
      orders: [order({ id: 'a', order_number: 1, subtotal_inr: 50, total_inr: 50 })],
      items: [item('a', { line_total_inr: 50, gst_exempt: true })],
    });
    expect(b2cs(exempt).rows).toEqual([]);
    const cancelled = build({
      orders: [order({ id: 'a', order_number: 1, status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 })],
      items: [item('a', { line_total_inr: 100 })],
    });
    expect(b2cs(cancelled).rows).toEqual([]);
  });

  it('uses whatever rate is set', () => {
    const ds = build({
      gstRatePercent: 18,
      orders: [order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 18, total_inr: 118 })],
      items: [item('a', { line_total_inr: 100 })],
    });
    expect(b2cs(ds).rows).toEqual([[B2CS_TYPE, PLACE_OF_SUPPLY, '', 18, 100, 0, '']]);
  });
});

// ── Table 12 ────────────────────────────────────────────────────────────────

describe('hsnB2c', () => {
  const ds = september();
  const t = hsnB2c(ds);

  it('has the Table 12 columns', () => {
    expect(t.columns).toEqual([
      'HSN',
      'Description',
      'UQC',
      'Total Quantity',
      'Total Value',
      'Rate',
      'Taxable Value',
      'Integrated Tax Amount',
      'Central Tax Amount',
      'State/UT Tax Amount',
      'Cess Amount',
    ]);
    for (const r of t.rows) expect(r).toHaveLength(t.columns.length);
  });

  it('has a row per code and rate: beans in kilos, restaurant service, and exempt at rate 0', () => {
    expect(t.rows).toEqual([
      ['0901', 'Coffee, roasted', 'KGS-KILOGRAMS', 0.5, 1260, 5, 1200, 0, 30, 30, 0],
      ['996331', 'Restaurant service', 'NA', 0, 1647, 5, 1569, 0, 39, 39, 0],
      ['996331', 'Restaurant service', 'NA', 0, 50, 0, 50, 0, 0, 0, 0],
    ]);
  });

  it('ties to Table 7 and the summary to the paisa', () => {
    const taxable = t.rows.filter((r) => r[5] === 5).reduce((s, r) => s + paise(r[6] as number), 0);
    expect(taxable).toBe(paise(b2cs(ds).rows[0][4] as number));
    const central = t.rows.reduce((s, r) => s + paise(r[8] as number), 0);
    const summary = gstSummary(ds);
    expect(central).toBe(paise(rowBy(summary, 'Taxable sales')[col(summary, 'CGST (INR)')] as number));
    // Total Value = taxable + tax.
    for (const r of t.rows) expect(paise(r[4] as number)).toBe(paise(r[6] as number) + paise(r[8] as number) + paise(r[9] as number));
  });

  it('exempt beans get their own HSN 0901 rate-0 row', () => {
    const exemptBeans = build({
      orders: [order({ id: 'a', order_number: 1, subtotal_inr: 600, tax_inr: 0, total_inr: 600 })],
      items: [item('a', { line_total_inr: 600, menu_item_id: 'beans', quantity: 1, weight_grams: 1000, gst_exempt: true })],
    });
    expect(hsnB2c(exemptBeans).rows).toEqual([['0901', 'Coffee, roasted', 'KGS-KILOGRAMS', 1, 600, 0, 600, 0, 0, 0, 0]]);
  });

  it('leaves out cancelled orders, voided lines and fully pass-covered lines', () => {
    const only = build({
      orders: [
        order({ id: 'a', order_number: 1, subtotal_inr: 180, tax_inr: 0, pass_discount_inr: 180, total_inr: 0 }),
        order({ id: 'b', order_number: 2, status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
      ],
      items: [item('a', { line_total_inr: 180, pass_covered_inr: 180, pass_drinks: 1 }), item('b', { line_total_inr: 100 })],
    });
    expect(hsnB2c(only).rows).toEqual([]);
    expect(hsnB2c(build({})).rows).toEqual([]);
  });

  it('still ties to Table 7 when tax was charged with no line to hold it', () => {
    const odd = build({
      orders: [order({ id: 'a', order_number: 1, subtotal_inr: 80, tax_inr: 10, total_inr: 90 })],
      items: [item('a', { line_total_inr: 80, gst_exempt: true })],
    });
    expect(b2cs(odd).rows[0][4]).toBe(200);
    expect(hsnB2c(odd).rows).toEqual([
      ['996331', 'Restaurant service', 'NA', 0, 210, 5, 200, 0, 5, 5, 0],
      ['996331', 'Restaurant service', 'NA', 0, 80, 0, 80, 0, 0, 0, 0],
    ]);
    const s = gstSummary(odd);
    expect(rowBy(s, 'Taxable sales')[col(s, 'Total tax (INR)')]).toBe(10);
    expect(rowBy(s, 'of which Restaurant service')[col(s, 'Total tax (INR)')]).toBe(10);
  });
});

// ── Table 13 ────────────────────────────────────────────────────────────────

describe('docsIssued', () => {
  it('counts the numbering from first to last, gaps as cancelled', () => {
    const t = docsIssued(september());
    expect(t.columns).toEqual(['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled', 'Net Issued']);
    // 1001..1010 = 10 numbers; 5 valid; 1004 + 1005 cancelled/rejected and 1007–1009 gone = 5.
    expect(t.rows).toEqual([['Invoices for outward supply', 'HIOC-001001', 'HIOC-001010', 10, 5, 5]]);
  });

  it('has no row when there are no orders', () => {
    expect(docsIssued(build({})).rows).toEqual([]);
  });

  it('a single order is one document', () => {
    const t = docsIssued(build({ orders: [order({ id: 'a', order_number: 1234 })] }));
    expect(t.rows).toEqual([['Invoices for outward supply', 'HIOC-001234', 'HIOC-001234', 1, 0, 1]]);
  });

  it('counts a cancelled first or last order in the range ends', () => {
    const t = docsIssued(
      build({
        orders: [
          order({ id: 'a', order_number: 10, status: 'cancelled' }),
          order({ id: 'b', order_number: 11 }),
          order({ id: 'c', order_number: 12, status: 'rejected' }),
        ],
      }),
    );
    expect(t.rows).toEqual([['Invoices for outward supply', 'HIOC-000010', 'HIOC-000012', 3, 2, 1]]);
  });
});


// ── A month that holds both GST rules ───────────────────────────────────────

describe('the pack across GST_NET_OF_DISCOUNT_FROM (2026-10-19)', () => {
  const OLD_DAY = '2026-10-10T06:30:00Z';
  const NEW_DAY = '2026-10-25T06:30:00Z';

  /**
   * 5% exclusive. 3001 (10 Oct): ₹200 latte, ₹20 off, ₹10 packaging: GST on the 200, packaging untaxed → 10.
   * 3002 (25 Oct, takeaway): ₹300 latte + 2 × 250 g beans ₹1200, ₹150 off, ₹10 packaging:
   * GST on 1350 + 10 = 1360 → 68.
   */
  function october(): OrderDataset {
    return build({
      from: '2026-10-01',
      to: '2026-10-31',
      orders: [
        order({ id: 'o3001', order_number: 3001, created_at: OLD_DAY, subtotal_inr: 200, discount_inr: 20, packaging_inr: 10, tax_inr: 10, total_inr: 200 }),
        order({ id: 'o3002', order_number: 3002, created_at: NEW_DAY, order_type: 'takeaway', subtotal_inr: 1500, discount_inr: 150, packaging_inr: 10, tax_inr: 68, total_inr: 1428 }),
      ],
      items: [
        item('o3001', { line_total_inr: 200 }),
        item('o3002', { line_total_inr: 300 }),
        item('o3002', { line_total_inr: 1200, menu_item_id: 'beans', quantity: 2, weight_grams: 250 }),
      ],
      redemptions: [
        { order_id: 'o3001', discount_inr: 20, code: 'WELCOME' },
        { order_id: 'o3002', discount_inr: 150, code: 'FESTIVE' },
      ],
    });
  }

  it('summary: packaging is taxable from the date, discounts are deducted from it, both stated', () => {
    const t = gstSummary(october());
    const at = (label: string, column: string) => rowBy(t, label)[col(t, column)];
    // 200 + (270 + 1080 + 10) taxable; 10 + 68 tax.
    expect(at('Taxable sales', 'Taxable value (INR)')).toBe(1560);
    expect(at('Taxable sales', 'Total tax (INR)')).toBe(78);
    expect(at('Taxable sales', 'CGST (INR)')).toBe(39);
    expect(at('Taxable sales', 'Note')).toContain('1 bill on the new basis, 1 on the earlier one');
    // SAC: 200 + 270 latte, 10 packaging; tax 10 + 13.5 + 0.5.
    expect(at('of which Restaurant service', 'Taxable value (INR)')).toBe(480);
    expect(at('of which Restaurant service', 'Total tax (INR)')).toBe(24);
    expect(at('of which Restaurant service', 'Note')).toContain('from 19 Oct 2026, takeaway packaging');
    expect(at('of which Coffee, roasted', 'Taxable value (INR)')).toBe(1080);
    expect(at('of which Coffee, roasted', 'Total tax (INR)')).toBe(54);
    expect(at('of which packaging', 'Orders')).toBe(1);
    expect(at('of which packaging', 'Taxable value (INR)')).toBe(10);
    expect(at('of which packaging', 'Total tax (INR)')).toBe(0.5);
    // The 10 October packaging stays outside the taxable value.
    expect(at('Packaging charges billed without GST', 'Value (INR)')).toBe(10);
    expect(at('Packaging charges billed without GST', 'Orders')).toBe(1);
    expect(at('Packaging charges billed without GST', 'Note')).toContain('Bills before 19 Oct 2026');
    expect(at('Discounts given', 'Value (INR)')).toBe(170);
    expect(at('Discounts given', 'Note')).toContain('From 19 Oct 2026 a discount is deducted from the taxable value');
    expect(at('Discounts given', 'Note')).toContain('(₹150 of this total)');
    expect(at('Discounts given', 'Note')).toContain('(₹20)');
  });

  it('Table 7 includes the packaging and takes the discount off', () => {
    expect(b2cs(october()).rows).toEqual([[B2CS_TYPE, PLACE_OF_SUPPLY, '', 5, 1560, 0, '']]);
  });

  it('Table 12 carries packaging under SAC 996331 and ties to Table 7', () => {
    const ds = october();
    const t = hsnB2c(ds);
    expect(t.rows).toEqual([
      ['0901', 'Coffee, roasted', 'KGS-KILOGRAMS', 0.5, 1134, 5, 1080, 0, 27, 27, 0],
      ['996331', 'Restaurant service', 'NA', 0, 504, 5, 480, 0, 12, 12, 0],
    ]);
    expect(t.rows.reduce((s, r) => s + paise(r[6] as number), 0)).toBe(paise(b2cs(ds).rows[0][4] as number));
  });

  it('an order each side of the date: only the later one carries packaging tax and the discount cut', () => {
    const ds = october();
    const [before, after] = ds.orders;
    expect([before.gstRule, after.gstRule]).toEqual(['pre_discount', 'net_of_discount']);
    expect([before.taxableValueInr, before.packagingTaxableInr]).toEqual([200, 0]);
    expect([after.taxableValueInr, after.packagingTaxableInr]).toEqual([1360, 10]);
  });

  it('Table 12, Table 7 and the summary agree to the paisa over many random bills of both rules', () => {
    let state = 424242;
    const rnd = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (const inclusive of [false, true]) {
      const orders: OrderRow[] = [];
      const items: ItemRow[] = [];
      for (let i = 0; i < 300; i++) {
        const id = `r${i}`;
        const created_at = rnd(2) === 0 ? OLD_DAY : NEW_DAY;
        const lines: ItemRow[] = [];
        for (let k = 0, n = 1 + rnd(5); k < n; k++) {
          lines.push(
            item(id, {
              line_total_inr: 20 + rnd(500),
              menu_item_id: rnd(5) === 0 ? 'beans' : 'latte',
              weight_grams: null,
              gst_exempt: rnd(7) === 0,
              pass_covered_inr: 0,
              voided: rnd(9) === 0,
            }),
          );
        }
        const subtotal = lines.filter((l) => !l.voided).reduce((s, l) => s + l.line_total_inr, 0);
        const taxable = lines.filter((l) => !l.voided && !l.gst_exempt).reduce((s, l) => s + l.line_total_inr, 0);
        const discount = rnd(3) === 0 ? rnd(subtotal + 1) : 0;
        const packaging = rnd(3) === 0 ? 10 : 0;
        const left = taxable === 0 ? 0 : (taxable * (subtotal - discount)) / subtotal;
        const gross = left + (created_at === NEW_DAY ? packaging : 0);
        const base = created_at === NEW_DAY ? gross : taxable;
        const pct = 5;
        const tax = inclusive ? Math.round((base * pct) / (100 + pct)) : Math.round((base * pct) / 100);
        orders.push(order({ id, order_number: 5000 + i, created_at, subtotal_inr: subtotal, discount_inr: discount, packaging_inr: packaging, tax_inr: subtotal === 0 ? 0 : tax }));
        items.push(...lines);
      }
      const ds = build({ from: '2026-10-01', to: '2026-10-31', gstInclusive: inclusive, orders, items });
      const sum = gstSummary(ds);
      const hsn = hsnB2c(ds).rows;
      const b = b2cs(ds).rows;

      const taxedRows = hsn.filter((r) => r[5] === 5);
      const exemptRows = hsn.filter((r) => r[5] === 0);
      const summaryTaxable = rowBy(sum, 'Taxable sales')[col(sum, 'Taxable value (INR)')] as number;
      const summaryTax = rowBy(sum, 'Taxable sales')[col(sum, 'Total tax (INR)')] as number;
      expect(taxedRows.reduce((s, r) => s + paise(r[6] as number), 0)).toBe(paise(summaryTaxable));
      expect(b.length ? paise(b[0][4] as number) : 0).toBe(paise(summaryTaxable));
      expect(taxedRows.reduce((s, r) => s + paise(r[8] as number) + paise(r[9] as number), 0)).toBe(paise(summaryTax));
      expect(paise(summaryTax)).toBe(ds.orders.filter((o) => o.valid).reduce((s, o) => s + paise(o.taxInr), 0));
      expect(exemptRows.reduce((s, r) => s + paise(r[6] as number), 0)).toBe(
        paise(rowBy(sum, 'GST-exempt sales')[col(sum, 'Value (INR)')] as number),
      );
      // The sub-rows add back to the whole.
      const part = (label: string) => paise(rowBy(sum, label)[col(sum, 'Taxable value (INR)')] as number);
      expect(part('of which Restaurant service') + part('of which Coffee, roasted')).toBe(paise(summaryTaxable));
    }
  });
});
