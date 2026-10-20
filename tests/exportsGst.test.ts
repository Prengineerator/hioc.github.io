import { describe, expect, it } from 'vitest';
import {
  buildOrderDataset,
  type ItemRow,
  type OrderDatasetInput,
  type OrderRow,
  type RefundRow,
} from '@/lib/reports/exports/orderData';
import {
  b2cs,
  dayRegister,
  docsIssued,
  exemptTable,
  gstSummary,
  hsnB2c,
  invoiceRegister,
} from '@/lib/reports/exports/gstReports';
import { buildGstComputation, businessFromLegal } from '@/lib/reports/exports/gstComputation';
import { B2CS_TYPE, PLACE_OF_SUPPLY } from '@/lib/reports/exports/gstCodes';
import { toCsv, type CsvTable, type CsvValue } from '@/lib/reports/csv';
import type { GstComputation } from '@/lib/reports/exports/gstTypes';
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

const BUSINESS = businessFromLegal({
  legalName: 'Arry Foods',
  name: 'HIOC',
  gstin: '09AGJPA9390E1Z9',
  address: 'Shop 1, Sanjay Place, Agra',
});
// 2 Nov 2026, 10:35 IST
const NOW = new Date('2026-11-02T05:05:00Z');
const compute = (ds: OrderDataset): GstComputation => buildGstComputation(ds, { business: BUSINESS, now: NOW });

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

const paise = (n: number) => Math.round(n * 100);

/** The first row whose first cell starts with `label`. */
function rowBy(t: CsvTable, label: string): CsvValue[] {
  const r = t.rows.find((x) => String(x[0] ?? '').startsWith(label));
  if (!r) throw new Error(`no row starting "${label}" in ${JSON.stringify(t.rows.map((x) => x[0]))}`);
  return r;
}

/** The rows of one summary section: from its title row to the next blank row. */
function section(t: CsvTable, title: string): CsvValue[][] {
  const start = t.rows.findIndex((r) => String(r[0] ?? '').startsWith(title));
  if (start < 0) throw new Error(`no section "${title}" in ${JSON.stringify(t.rows.map((x) => x[0]))}`);
  const out: CsvValue[][] = [];
  for (let i = start + 1; i < t.rows.length && t.rows[i].length > 0; i++) out.push(t.rows[i]);
  return out;
}

// ── Summary ─────────────────────────────────────────────────────────────────

describe('gstSummary', () => {
  const c = compute(september());
  const t = gstSummary(c);

  it('titles the sheet with the period and splits it into blank-line-separated sections', () => {
    expect(t.columns).toEqual(['GST working for September 2026']);
    const titles = t.rows.flatMap((r, i) => (i > 0 && t.rows[i - 1].length === 0 && r.length > 0 ? [String(r[0])] : []));
    expect(titles.map((x) => x.split(':')[0].split(' (')[0])).toEqual([
      'Tax to pay',
      'Bills',
      'GSTR-3B Table 3.1',
      'From sales to taxable value',
      'From taxable value to the bills’ totals',
      'Checks before you file',
      'Notes for your CA',
    ]);
    // Truly blank lines in the CSV text.
    expect(toCsv(t)).toContain('\r\n\r\n');
    expect(t.rows.every((r) => r.length <= 6)).toBe(true);
  });

  it('opens with the business and period block', () => {
    expect(t.rows.slice(0, 8)).toEqual([
      ['Business', 'Arry Foods (HIOC)'],
      ['GSTIN', '09AGJPA9390E1Z9'],
      ['State', '09 - Uttar Pradesh'],
      ['Address', 'Shop 1, Sanjay Place, Agra'],
      ['Period', '1 Sep 2026 to 30 Sep 2026'],
      ['Return period', '092026'],
      ['Financial year', '2026-27'],
      ['Prepared on', '2 Nov 2026, 10:35 IST'],
    ]);
  });

  it('tax to pay: CGST, SGST and the total, paid in cash, with the due dates', () => {
    const tax = section(t, 'Tax to pay');
    expect(String(t.rows.find((r) => String(r[0]).startsWith('Tax to pay'))?.[0])).toContain('all in cash');
    expect(tax).toEqual([
      ['CGST', 69],
      ['SGST', 69],
      ['Total GST to pay', 138],
      ['GSTR-1 due', '11 Oct 2026'],
      ['GSTR-3B due, with payment', '20 Oct 2026'],
    ]);
  });

  it('GSTR-3B Table 3.1: the portal’s heading and rows, with taxable value and tax in the right columns', () => {
    const rows = section(t, 'GSTR-3B Table 3.1');
    expect(rows[0]).toEqual([
      'Nature of supplies',
      'Total taxable value (INR)',
      'Integrated tax (INR)',
      'Central tax (INR)',
      'State/UT tax (INR)',
      'Cess (INR)',
    ]);
    expect(rows).toHaveLength(8);
    expect(rows[1]).toEqual(['3.1(a) Outward taxable supplies (other than zero rated, nil rated and exempted)', 2769, 0, 69, 69, 0]);
    expect(rows[3]).toEqual(['3.1(c) Other outward supplies (Nil rated, exempted)', 50, 0, 0, 0, 0]);
    expect(rows[2].slice(1)).toEqual([0, 0, 0, 0, 0]);
    expect(String(t.rows.find((r) => String(r[0]).startsWith('GSTR-3B Table 3.1'))?.[0])).toContain(
      '(other than those covered by Table 3.1.1)',
    );
  });

  it('the two reconciliations are ledgers whose amounts add up to the last line', () => {
    for (const title of ['From sales to taxable value', 'From taxable value to the bills’ totals']) {
      const rows = section(t, title);
      expect(rows[0]).toEqual(['Step', 'Amount (INR)']);
      const steps = rows.slice(1, -1).reduce((s, r) => s + paise(r[1] as number), 0);
      expect(steps).toBe(paise(rows[rows.length - 1][1] as number));
    }
    expect(section(t, 'From sales to taxable value').map((r) => r[0])).toEqual([
      'Step',
      'Gross item sales',
      'Less: HIOC Ritual cups covered by a pass',
      'Less: Discounts deducted before GST',
      'Less: GST-exempt items',
      'Add: Packaging taxed',
      'Equals: Taxable value',
    ]);
    expect(section(t, 'From sales to taxable value')[1]).toEqual(['Gross item sales', 2999]);
    expect(section(t, 'From sales to taxable value')[2]).toEqual(['Less: HIOC Ritual cups covered by a pass', -180]);
    const last = section(t, 'From taxable value to the bills’ totals').at(-1);
    expect(last).toEqual(['Equals: Total invoice value of the bills issued', 251 + 1310 + 126 + 210 + 1050]);
  });

  it('checks are one row each (result, check, detail) and notes one row each', () => {
    const checks = section(t, 'Checks before you file');
    expect(checks[0]).toEqual(['Result', 'Check', 'Detail']);
    expect(checks.slice(1).every((r) => ['OK', 'Look at this', 'Note'].includes(String(r[0])) && r.length === 3)).toBe(true);
    expect(checks.some((r) => r[0] === 'Look at this' && String(r[1]).startsWith('Invoice numbers are missing'))).toBe(true);
    const notes = section(t, 'Notes for your CA');
    expect(notes).toHaveLength(c.notes.length);
    expect(notes.every((r) => r.length === 1)).toBe(true);
  });

  it('never starts a text cell with = + - @ (the CSV writer would quote it)', () => {
    for (const r of t.rows) for (const v of r) if (typeof v === 'string') expect(v).not.toMatch(/^[=+\-@]/);
    expect(toCsv(t)).not.toContain("'=");
  });

  it('a custom period has no return period or due dates', () => {
    const custom = gstSummary(compute(build({ from: '2026-09-25', to: '2026-09-30' })));
    expect(rowBy(custom, 'Return period')).toEqual(['Return period', 'Not a whole month']);
    expect(rowBy(custom, 'Due dates')).toEqual(['Due dates', 'Not a whole month']);
    expect(custom.columns[0]).toBe('GST working for 25 Sep – 30 Sep 2026');
  });

  it('an empty month is all zeros, not an error', () => {
    const s = gstSummary(compute(build({})));
    expect(rowBy(s, 'Total GST to pay')).toEqual(['Total GST to pay', 0]);
    expect(rowBy(s, 'Bills issued')).toEqual(['Bills issued', 0]);
    expect(toCsv(s).length).toBeGreaterThan(200);
  });
});

// ── Table 7 ─────────────────────────────────────────────────────────────────

describe('b2cs (GSTR-1 Table 7)', () => {
  it('is one row at the current rate with the taxable value of issued bills, exempt value left out', () => {
    const t = b2cs(compute(september()));
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
    expect(b2cs(compute(build({}))).rows).toEqual([]);
    const exempt = build({
      orders: [order({ id: 'a', order_number: 1, subtotal_inr: 50, total_inr: 50 })],
      items: [item('a', { line_total_inr: 50, gst_exempt: true })],
    });
    expect(b2cs(compute(exempt)).rows).toEqual([]);
    const cancelled = build({
      orders: [order({ id: 'a', order_number: 1, status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 })],
      items: [item('a', { line_total_inr: 100 })],
    });
    expect(b2cs(compute(cancelled)).rows).toEqual([]);
  });

  it('uses whatever rate is set', () => {
    const ds = build({
      gstRatePercent: 18,
      orders: [order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 18, total_inr: 118 })],
      items: [item('a', { line_total_inr: 100 })],
    });
    expect(b2cs(compute(ds)).rows).toEqual([[B2CS_TYPE, PLACE_OF_SUPPLY, '', 18, 100, 0, '']]);
  });
});

// ── Table 8 ─────────────────────────────────────────────────────────────────

describe('exemptTable (GSTR-1 Table 8)', () => {
  it('has the offline tool’s columns, spelt exactly', () => {
    expect(exemptTable(compute(september())).columns).toEqual([
      'Description',
      'Nil Rated Supplies',
      'Exempted(other than nil rated/non GST supply)',
      'Non-GST Supplies',
    ]);
  });

  it('always has the four rows; the exempt items are Exempted, intra-state, unregistered', () => {
    expect(exemptTable(compute(september())).rows).toEqual([
      ['Inter-State supplies to registered persons', 0, 0, 0],
      ['Intra-State supplies to registered persons', 0, 0, 0],
      ['Inter-State supplies to unregistered persons', 0, 0, 0],
      ['Intra-State supplies to unregistered persons', 0, 50, 0],
    ]);
    expect(exemptTable(compute(build({}))).rows.map((r) => r.slice(1))).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });
});

// ── Table 12 ────────────────────────────────────────────────────────────────

describe('hsnB2c (GSTR-1 Table 12)', () => {
  const c = compute(september());
  const t = hsnB2c(c);

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

  it('Table 12 = Table 7 + Table 8, and Total Value = taxable + tax, to the paisa', () => {
    const t7 = b2cs(c).rows.reduce((s, r) => s + paise(r[4] as number), 0);
    const t8 = exemptTable(c).rows.reduce((s, r) => s + paise(r[1] as number) + paise(r[2] as number) + paise(r[3] as number), 0);
    expect(t.rows.reduce((s, r) => s + paise(r[6] as number), 0)).toBe(t7 + t8);
    for (const r of t.rows) expect(paise(r[4] as number)).toBe(paise(r[6] as number) + paise(r[8] as number) + paise(r[9] as number));
  });

  it('leaves out cancelled bills, voided lines and fully pass-covered lines', () => {
    const only = build({
      orders: [
        order({ id: 'a', order_number: 1, subtotal_inr: 180, tax_inr: 0, pass_discount_inr: 180, total_inr: 0 }),
        order({ id: 'b', order_number: 2, status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
      ],
      items: [item('a', { line_total_inr: 180, pass_covered_inr: 180, pass_drinks: 1 }), item('b', { line_total_inr: 100 })],
    });
    expect(hsnB2c(compute(only)).rows).toEqual([]);
    expect(hsnB2c(compute(build({}))).rows).toEqual([]);
  });

  it('still ties when tax was charged with no line to hold it', () => {
    const odd = build({
      orders: [order({ id: 'a', order_number: 1, subtotal_inr: 80, tax_inr: 10, total_inr: 90 })],
      items: [item('a', { line_total_inr: 80, gst_exempt: true })],
    });
    const oc = compute(odd);
    expect(b2cs(oc).rows[0][4]).toBe(200);
    expect(hsnB2c(oc).rows).toEqual([
      ['996331', 'Restaurant service', 'NA', 0, 210, 5, 200, 0, 5, 5, 0],
      ['996331', 'Restaurant service', 'NA', 0, 80, 0, 80, 0, 0, 0, 0],
    ]);
  });
});

// ── Table 13 ────────────────────────────────────────────────────────────────

describe('docsIssued (GSTR-1 Table 13)', () => {
  it('has the offline tool’s five columns, no Net Issued, and counts the numbering first to last', () => {
    const t = docsIssued(compute(september()));
    expect(t.columns).toEqual(['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled']);
    // 1001..1010 = 10 numbers; 5 issued; 1004 + 1005 cancelled/rejected and 1007–1009 gone = 5.
    expect(t.rows).toEqual([['Invoices for outward supply', 'HIOC-001001', 'HIOC-001010', 10, 5]]);
  });

  it('has no row when there are no orders', () => {
    expect(docsIssued(compute(build({}))).rows).toEqual([]);
  });

  it('a single order is one document', () => {
    const t = docsIssued(compute(build({ orders: [order({ id: 'a', order_number: 1234 })] })));
    expect(t.rows).toEqual([['Invoices for outward supply', 'HIOC-001234', 'HIOC-001234', 1, 0]]);
  });
});

// ── Registers ───────────────────────────────────────────────────────────────

describe('dayRegister', () => {
  const t = dayRegister(compute(september()));

  it('has a row for every day and a total that ties to the summary', () => {
    expect(t.columns).toEqual([
      'Date',
      'First invoice',
      'Last invoice',
      'Bills issued',
      'Cancelled or rejected',
      'Taxable value (INR)',
      'CGST (INR)',
      'SGST (INR)',
      'GST-exempt sales (INR)',
      'Invoice value (INR)',
    ]);
    expect(t.rows).toHaveLength(31);
    for (const r of t.rows) expect(r).toHaveLength(t.columns.length);
    expect(t.rows[0]).toEqual(['2026-09-01', '', '', 0, 0, 0, 0, 0, 0, 0]);
    expect(t.rows[9]).toEqual(['2026-09-10', 'HIOC-001001', 'HIOC-001010', 5, 2, 2769, 69, 69, 50, 2947]);
    expect(rowBy(t, 'Total')).toEqual(['Total', '', '', 5, 2, 2769, 69, 69, 50, 2947]);
  });
});

describe('invoiceRegister', () => {
  const c = compute(september());
  const t = invoiceRegister(c);

  it('lists every bill with its status and what it was billed, cancelled ones included', () => {
    expect(t.columns).toEqual([
      'Invoice no.',
      'Date',
      'Time',
      'Status',
      'GST basis',
      'Taxable value (INR)',
      'CGST (INR)',
      'SGST (INR)',
      'GST-exempt sales (INR)',
      'Packaging charged (INR)',
      'Discount (INR)',
      'Invoice value (INR)',
      'Paid by',
    ]);
    expect(t.rows.slice(0, -1).map((r) => [r[0], r[3]])).toEqual([
      ['HIOC-001001', 'Issued'],
      ['HIOC-001002', 'Issued'],
      ['HIOC-001003', 'Issued'],
      ['HIOC-001004', 'Cancelled'],
      ['HIOC-001005', 'Rejected'],
      ['HIOC-001006', 'Issued'],
      ['HIOC-001010', 'Issued'],
    ]);
    expect(t.rows[0]).toEqual(['HIOC-001001', '2026-09-10', '12:00', 'Issued', 'Before discount', 249, 6, 6, 0, 10, 20, 251, 'Cash']);
    for (const r of t.rows) expect(r).toHaveLength(t.columns.length);
  });

  it('the total counts the issued bills only and ties to the summary’s invoice value', () => {
    const total = t.rows[t.rows.length - 1];
    expect(total[0]).toBe('Total of issued bills');
    expect(total[3]).toBe('5 issued');
    expect(total[5]).toBe(2769);
    expect(total[11]).toBe(251 + 1310 + 126 + 210 + 1050);
  });
});

// ── A month that holds both GST rules ───────────────────────────────────────

describe('the pack across GST_NET_OF_DISCOUNT_FROM (2026-10-19)', () => {
  const OLD_DAY = '2026-10-10T06:30:00Z';
  const NEW_DAY = '2026-10-25T06:30:00Z';
  const ds = build({
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
  const c = compute(ds);

  it('Table 7 includes the packaging and takes the discount off', () => {
    expect(b2cs(c).rows).toEqual([[B2CS_TYPE, PLACE_OF_SUPPLY, '', 5, 1560, 0, '']]);
  });

  it('Table 12 carries packaging under SAC 996331 and ties to Table 7', () => {
    const t = hsnB2c(c);
    expect(t.rows).toEqual([
      ['0901', 'Coffee, roasted', 'KGS-KILOGRAMS', 0.5, 1134, 5, 1080, 0, 27, 27, 0],
      ['996331', 'Restaurant service', 'NA', 0, 504, 5, 480, 0, 12, 12, 0],
    ]);
    expect(t.rows.reduce((s, r) => s + paise(r[6] as number), 0)).toBe(paise(b2cs(c).rows[0][4] as number));
  });

  it('the summary’s reconciliations show both bases and tie', () => {
    const t = gstSummary(c);
    expect(section(t, 'From sales to taxable value').slice(1)).toEqual([
      ['Gross item sales', 1700],
      ['Less: HIOC Ritual cups covered by a pass', 0],
      ['Less: Discounts deducted before GST', -150],
      ['Less: GST-exempt items', 0],
      ['Add: Packaging taxed', 10],
      ['Equals: Taxable value', 1560],
    ]);
    expect(section(t, 'From taxable value to the bills’ totals').slice(1)).toEqual([
      ['Taxable value', 1560],
      ['Add: CGST', 39],
      ['Add: SGST', 39],
      ['Add: GST-exempt sales', 0],
      ['Add: Packaging billed without GST', 10],
      ['Less: Coupon and Beanies discounts given after GST', -20],
      ['Equals: Total invoice value of the bills issued', 1628],
    ]);
    expect(section(t, 'Checks before you file').some((r) => String(r[1]).startsWith('Two GST bases'))).toBe(true);
  });

  it('the invoice register tells the two bases apart', () => {
    const t = invoiceRegister(c);
    expect(t.rows.slice(0, 2).map((r) => r[4])).toEqual(['Before discount', 'After discount']);
  });
});
