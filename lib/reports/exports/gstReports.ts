// The GST filing pack, as sheets (CsvTable) built from the OrderDataset: a
// plain-words summary for the owner and accountant (GSTR-3B), and the three
// GSTR-1 tables a café with only walk-in customers files — Table 7 (B2C small
// supplies), Table 12 (HSN / SAC summary, B2C tab) and Table 13 (documents
// issued). Pure and unit-tested; lib/reports/exports/gstReportsServer.ts loads
// the dataset and picks the builder.
//
// What is reported is the tax the bills CHARGED (orders.tax_inr, see orderData.ts),
// never a recomputed figure. Cancelled and rejected orders are left out of every
// total, and all sales are intra-state: CGST + SGST, IGST always 0.
// Money is summed in integer paise and turned back into rupees once.

import { round2, type CsvTable, type CsvValue } from '@/lib/reports/csv';
import { B2CS_TYPE, PLACE_OF_SUPPLY, SAC_RESTAURANT, HSN_COFFEE_BEANS } from '@/lib/reports/exports/gstCodes';
import type { ExportOrder, GstCode, OrderDataset } from '@/lib/reports/exports/types';

const paise = (inr: number): number => Math.round(inr * 100);
const inr = (p: number): number => p / 100;

const valid = (ds: OrderDataset): ExportOrder[] => ds.orders.filter((o) => o.valid);
const rupees = (n: number): string => `₹${round2(n)}`;

/** What an order's lines do not carry of its taxable value / tax (only when tax was charged with no line to hold it). */
function unallocated(o: ExportOrder): { taxableP: number; cgstP: number; sgstP: number } {
  let taxableP = paise(o.taxableValueInr);
  let cgstP = paise(o.cgstInr);
  let sgstP = paise(o.sgstInr);
  for (const l of o.lines) {
    taxableP -= paise(l.taxableInr);
    cgstP -= paise(l.cgstInr);
    sgstP -= paise(l.sgstInr);
  }
  return { taxableP, cgstP, sgstP };
}

// ── Summary (GSTR-3B) ───────────────────────────────────────────────────────

interface CodeTally {
  orders: Set<string>;
  taxableP: number;
  cgstP: number;
  sgstP: number;
}

/** Taxable value and tax of the non-exempt lines reported under one kind of code. */
function tallyByCode(orders: ExportOrder[], gst: GstCode): CodeTally {
  const t: CodeTally = { orders: new Set(), taxableP: 0, cgstP: 0, sgstP: 0 };
  for (const o of orders) {
    for (const l of o.lines) {
      if (l.gstExempt || l.gstCode.code !== gst.code) continue;
      if (l.taxableInr === 0 && l.cgstInr === 0 && l.sgstInr === 0) continue;
      t.orders.add(o.id);
      t.taxableP += paise(l.taxableInr);
      t.cgstP += paise(l.cgstInr);
      t.sgstP += paise(l.sgstInr);
    }
    if (gst.code === SAC_RESTAURANT.code) {
      // Tax with no line to carry it is reported as restaurant service.
      const u = unallocated(o);
      if (u.taxableP !== 0 || u.cgstP !== 0 || u.sgstP !== 0) {
        t.orders.add(o.id);
        t.taxableP += u.taxableP;
        t.cgstP += u.cgstP;
        t.sgstP += u.sgstP;
      }
    }
  }
  return t;
}

const SUMMARY_COLUMNS = [
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
];

export function gstSummary(ds: OrderDataset): CsvTable {
  const sales = valid(ds);
  const dead = ds.orders.filter((o) => !o.valid);
  const rate = `${ds.gstRatePercent}%`;
  const sum = (f: (o: ExportOrder) => number) => inr(sales.reduce((s, o) => s + paise(f(o)), 0));
  const count = (f: (o: ExportOrder) => number) => sales.filter((o) => f(o) > 0).length;

  const taxableP = sales.reduce((s, o) => s + paise(o.taxableValueInr), 0);
  const cgstP = sales.reduce((s, o) => s + paise(o.cgstInr), 0);
  const sgstP = sales.reduce((s, o) => s + paise(o.sgstInr), 0);

  const taxRow = (
    line: string,
    ref: string,
    orders: number,
    t: { taxableP: number; cgstP: number; sgstP: number },
    note: string,
  ): CsvValue[] => [
    line,
    ref,
    orders,
    inr(t.taxableP + t.cgstP + t.sgstP),
    inr(t.taxableP),
    inr(t.cgstP),
    inr(t.sgstP),
    0,
    inr(t.cgstP + t.sgstP),
    note,
  ];
  // A line that is not a tax figure: only its amount, the tax columns left blank.
  const infoRow = (line: string, ref: string, orders: number, value: number, note: string): CsvValue[] => [
    line,
    ref,
    orders,
    value,
    '',
    '',
    '',
    '',
    '',
    note,
  ];

  const taxableOrders = sales.filter((o) => o.taxableValueInr > 0 || o.cgstInr > 0 || o.sgstInr > 0).length;
  const sac = tallyByCode(sales, SAC_RESTAURANT);
  const hsn = tallyByCode(sales, HSN_COFFEE_BEANS);
  const exemptValue = sum((o) => o.exemptValueInr);
  const couponTotal = sum((o) => o.couponDiscountInr);
  const beaniesTotal = sum((o) => o.beaniesDiscountInr);
  const cancelled = dead.filter((o) => o.status === 'cancelled').length;
  const rejected = dead.length - cancelled;
  const processedRefunds = ds.refunds.filter((r) => r.status === 'processed');

  const rows: CsvValue[][] = [
    taxRow(
      `Taxable sales @ ${rate}`,
      'GSTR-1 Table 7 · GSTR-3B 3.1(a)',
      taxableOrders,
      { taxableP, cgstP, sgstP },
      `GST charged on the bills, split half CGST and half SGST (all sales are within Uttar Pradesh, so no IGST). Taxable value is the bill before GST, with HIOC Ritual cups taken out. Coupon and Beanies discounts are NOT deducted.${
        ds.gstInclusive ? ' Prices include GST, so taxable value is the price less its GST.' : ''
      }`,
    ),
    taxRow(
      `  of which ${SAC_RESTAURANT.description} (SAC ${SAC_RESTAURANT.code})`,
      'GSTR-1 Table 12',
      sac.orders.size,
      sac,
      'Food, drinks and HIOC Ritual pass sales.',
    ),
    taxRow(
      `  of which ${HSN_COFFEE_BEANS.description} (HSN ${HSN_COFFEE_BEANS.code})`,
      'GSTR-1 Table 12',
      hsn.orders.size,
      hsn,
      'Roasted coffee beans sold by weight.',
    ),
    [
      'GST-exempt sales',
      'GSTR-1 Table 8 · GSTR-3B 3.1(c)',
      count((o) => o.exemptValueInr),
      exemptValue,
      exemptValue,
      0,
      0,
      0,
      0,
      'Items marked GST-exempt on the menu. No GST was charged on them; not part of Table 7.',
    ],
    infoRow(
      'Packaging charges',
      'Not in Table 7',
      count((o) => o.packagingInr),
      sum((o) => o.packagingInr),
      'Billed without GST in this system, so it is outside the taxable value above. Ask your accountant whether it should be treated as part of the supply.',
    ),
    infoRow(
      'Discounts given (coupons and Beanies)',
      'For reference',
      count((o) => o.discountInr),
      sum((o) => o.discountInr),
      `Coupons ${rupees(couponTotal)}, Beanies ${rupees(beaniesTotal)}. Not deducted from the taxable value: GST was charged before the discount.`,
    ),
    infoRow(
      'HIOC Ritual cups covered by a pass',
      'For reference',
      count((o) => o.passDiscountInr),
      sum((o) => o.passDiscountInr),
      'Prepaid cups. GST was charged when the pass was sold, so these cups are left out of the taxable value above (no GST twice).',
    ),
    infoRow(
      'Settle discounts',
      'For reference',
      count((o) => o.settleDiscountInr),
      sum((o) => o.settleDiscountInr),
      'Given at the counter when the bill was settled. They do not change the GST charged.',
    ),
    infoRow(
      'Tips',
      'Outside the supply',
      count((o) => o.tipInr),
      sum((o) => o.tipInr),
      'Left voluntarily by customers; not part of the bill or its GST.',
    ),
    infoRow(
      'Cancelled / rejected bills (excluded)',
      'Excluded',
      dead.length,
      inr(dead.reduce((s, o) => s + paise(o.totalInr), 0)),
      `${cancelled} cancelled, ${rejected} rejected. Left out of every figure above, but they still used up invoice numbers (see the Documents issued sheet).`,
    ),
    infoRow(
      'Refunds processed in the period',
      'No credit notes issued',
      new Set(processedRefunds.map((r) => r.orderId)).size,
      inr(processedRefunds.reduce((s, r) => s + paise(r.amountInr), 0)),
      'Refunds do not change the GST shown on the original bill and the app issues no credit notes. Tell your accountant if GST should be adjusted for them.',
    ),
    infoRow(
      'Total invoice value of valid orders',
      'For reference',
      sales.length,
      sum((o) => o.totalInr),
      'Bill totals as printed on the invoices: GST and packaging included, discounts and Ritual cover taken off.',
    ),
  ];

  return { columns: SUMMARY_COLUMNS, rows };
}

// ── GSTR-1 Table 7: B2C small ───────────────────────────────────────────────

export function b2cs(ds: OrderDataset): CsvTable {
  const taxableP = valid(ds).reduce((s, o) => s + paise(o.taxableValueInr), 0);
  // One rate in force (store_settings), so one row; all-exempt months have nothing to report here.
  const rows: CsvValue[][] =
    taxableP > 0 ? [[B2CS_TYPE, PLACE_OF_SUPPLY, '', ds.gstRatePercent, inr(taxableP), 0, '']] : [];
  return {
    columns: [
      'Type',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ],
    rows,
  };
}

// ── GSTR-1 Table 12: HSN / SAC summary (B2C) ────────────────────────────────

interface HsnGroup {
  code: GstCode;
  rate: number;
  /** Grams × units, goods only. */
  grams: number;
  valueP: number;
  taxableP: number;
  cgstP: number;
  sgstP: number;
}

export function hsnB2c(ds: OrderDataset): CsvTable {
  const groups = new Map<string, HsnGroup>();
  const group = (code: GstCode, rate: number): HsnGroup => {
    const key = `${code.code}|${rate}`;
    let g = groups.get(key);
    if (!g) {
      g = { code, rate, grams: 0, valueP: 0, taxableP: 0, cgstP: 0, sgstP: 0 };
      groups.set(key, g);
    }
    return g;
  };

  for (const o of valid(ds)) {
    for (const l of o.lines) {
      const g = group(l.gstCode, l.gstExempt ? 0 : ds.gstRatePercent);
      if (l.gstExempt) {
        // Exempt lines: the whole (post-pass) value is the "taxable value" of the rate-0 row.
        g.taxableP += paise(l.lineTotalInr) - paise(l.passCoveredInr);
        g.valueP += paise(l.lineTotalInr) - paise(l.passCoveredInr);
      } else {
        g.taxableP += paise(l.taxableInr);
        g.cgstP += paise(l.cgstInr);
        g.sgstP += paise(l.sgstInr);
        g.valueP += paise(l.taxableInr) + paise(l.cgstInr) + paise(l.sgstInr);
      }
      if (l.gstCode.kind === 'goods') g.grams += l.quantity * (l.weightGrams ?? 0);
    }
    // Tax charged with no line to hold it: report it as restaurant service so the table ties to Table 7.
    const u = unallocated(o);
    if (u.taxableP !== 0 || u.cgstP !== 0 || u.sgstP !== 0) {
      const g = group(SAC_RESTAURANT, ds.gstRatePercent);
      g.taxableP += u.taxableP;
      g.cgstP += u.cgstP;
      g.sgstP += u.sgstP;
      g.valueP += u.taxableP + u.cgstP + u.sgstP;
    }
  }

  const rows = [...groups.values()]
    .filter((g) => g.valueP !== 0 || g.grams !== 0)
    .sort((a, b) => a.code.code.localeCompare(b.code.code) || b.rate - a.rate)
    .map((g): CsvValue[] => [
      g.code.code,
      g.code.description,
      g.code.uqc,
      g.code.kind === 'goods' ? g.grams / 1000 : 0,
      inr(g.valueP),
      g.rate,
      inr(g.taxableP),
      0,
      inr(g.cgstP),
      inr(g.sgstP),
      0,
    ]);

  return {
    columns: [
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
    ],
    rows,
  };
}

// ── GSTR-1 Table 13: documents issued ───────────────────────────────────────

export function docsIssued(ds: OrderDataset): CsvTable {
  const columns = ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled', 'Net Issued'];
  if (ds.orders.length === 0) return { columns, rows: [] };

  // The range counts every number from the first to the last, so a gap (an order
  // deleted as a test) shows as cancelled, not as missing.
  let first = ds.orders[0];
  let last = ds.orders[0];
  for (const o of ds.orders) {
    if (o.orderNumber < first.orderNumber) first = o;
    if (o.orderNumber > last.orderNumber) last = o;
  }
  const total = last.orderNumber - first.orderNumber + 1;
  const net = ds.orders.filter((o) => o.valid).length;
  return {
    columns,
    rows: [['Invoices for outward supply', first.invoiceNo, last.invoiceNo, total, total - net, net]],
  };
}
