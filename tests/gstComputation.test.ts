import { describe, expect, it } from 'vitest';
import {
  buildOrderDataset,
  type ItemRow,
  type OrderDatasetInput,
  type OrderRow,
  type RedemptionRow,
  type RefundRow,
} from '@/lib/reports/exports/orderData';
import {
  APP_BILLING_FROM,
  buildGstComputation,
  buildPeriod,
  businessFromLegal,
  DOCS_NATURE,
  GSTR3B_TABLE_31_HEADING,
  NIL_EXEMPT_DESCRIPTIONS,
} from '@/lib/reports/exports/gstComputation';
import type { GstCheck, GstComputation, ReconLine } from '@/lib/reports/exports/gstTypes';
import type { OrderDataset } from '@/lib/reports/exports/types';
import { computeBill, FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';

// ── Fixtures ────────────────────────────────────────────────────────────────

const BUSINESS = businessFromLegal({
  legalName: 'Arry Foods',
  name: 'HIOC',
  gstin: '09AGJPA9390E1Z9',
  address: '1 Test Road, Agra',
});
const NOW = new Date('2026-11-02T05:00:00Z');

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
    from: '2026-10-01',
    to: '2026-10-31',
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

const compute = (ds: OrderDataset): GstComputation => buildGstComputation(ds, { business: BUSINESS, now: NOW });

const paise = (n: number) => Math.round(n * 100);
const OLD_DAY = '2026-10-10T06:30:00Z'; // 12:00 IST, before 19 Oct 2026
const NEW_DAY = '2026-10-25T06:30:00Z'; // after

/** What a reader adds up: a 'less' step is negative, 'subtotal' and 'total' lines are running totals. */
function stepsSum(lines: ReconLine[]): number {
  return lines.filter((l) => l.kind !== 'subtotal' && l.kind !== 'total').reduce((s, l) => s + paise(l.amountInr), 0);
}
const totalLine = (lines: ReconLine[]): ReconLine => lines[lines.length - 1];
const lineBy = (lines: ReconLine[], label: string): ReconLine => {
  const l = lines.find((x) => x.label === label);
  if (!l) throw new Error(`no line "${label}" in ${JSON.stringify(lines.map((x) => x.label))}`);
  return l;
};
const checkBy = (c: GstComputation, start: string): GstCheck => {
  const k = c.checks.find((x) => x.title.startsWith(start));
  if (!k) throw new Error(`no check starting "${start}" in ${JSON.stringify(c.checks.map((x) => x.title))}`);
  return k;
};

/** Both reconciliations tie to the paisa, and the figures the rest of the pack uses are the same ones. */
function expectTies(c: GstComputation) {
  expect(stepsSum(c.toTaxableValue)).toBe(paise(totalLine(c.toTaxableValue).amountInr));
  expect(stepsSum(c.toInvoiceValue)).toBe(paise(totalLine(c.toInvoiceValue).amountInr));
  const a = c.gstr3b[0].amounts;
  const t7 = c.gstr1.b2cs.reduce((s, r) => s + paise(r.taxableValueInr), 0);
  expect(paise(a.taxableValueInr)).toBe(t7);
  expect(paise(totalLine(c.toTaxableValue).amountInr)).toBe(paise(a.taxableValueInr));
  const t8 = c.gstr1.nilExempt.reduce((s, r) => s + paise(r.nilRatedInr) + paise(r.exemptedInr) + paise(r.nonGstInr), 0);
  expect(paise(c.gstr3b[2].amounts.taxableValueInr)).toBe(t8);
  expect(c.gstr1.hsn.reduce((s, r) => s + paise(r.taxableValueInr), 0)).toBe(t7 + t8);
  expect(c.gstr1.hsn.reduce((s, r) => s + paise(r.cgstInr), 0)).toBe(paise(a.cgstInr));
  expect(c.gstr1.hsn.reduce((s, r) => s + paise(r.sgstInr), 0)).toBe(paise(a.sgstInr));
  expect(paise(c.taxPayable.totalInr)).toBe(paise(a.cgstInr) + paise(a.sgstInr));
  expect(paise(totalLine(c.toInvoiceValue).amountInr)).toBe(
    c.invoiceRegister.filter((r) => r.status === 'Issued').reduce((s, r) => s + paise(r.invoiceValueInr), 0),
  );
  expect(c.dayRegister.reduce((s, d) => s + paise(d.invoiceValueInr), 0)).toBe(paise(totalLine(c.toInvoiceValue).amountInr));
  expect(c.dayRegister.reduce((s, d) => s + paise(d.taxableValueInr), 0)).toBe(t7);
}

/**
 * 5% exclusive. 3001 (10 Oct): ₹200 latte, ₹20 off, ₹10 packaging: GST on the 200 only → 10; total 200.
 * 3002 (25 Oct, takeaway): ₹300 latte + 2 × 250 g beans ₹1200, ₹150 off, ₹10 packaging:
 * GST on 1350 + 10 = 1360 → 68; total 1428.
 */
function october(): OrderDataset {
  return build({
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

// ── The period ──────────────────────────────────────────────────────────────

describe('buildPeriod', () => {
  it('a whole month: label, return period, financial year and the monthly due dates', () => {
    expect(buildPeriod('2026-10-01', '2026-10-31')).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
      label: 'October 2026',
      isWholeMonth: true,
      returnPeriod: '102026',
      financialYear: '2026-27',
      gstr1DueDate: '2026-11-11',
      gstr3bDueDate: '2026-11-20',
    });
  });

  it('January to March belong to the year that began the April before; April starts a new one', () => {
    expect(buildPeriod('2027-03-01', '2027-03-31')).toMatchObject({ financialYear: '2026-27', returnPeriod: '032027' });
    expect(buildPeriod('2027-04-01', '2027-04-30')).toMatchObject({ financialYear: '2027-28' });
    expect(buildPeriod('2027-01-01', '2027-01-31')).toMatchObject({ financialYear: '2026-27', gstr1DueDate: '2027-02-11' });
  });

  it('December is due in January of the next year', () => {
    expect(buildPeriod('2026-12-01', '2026-12-31')).toMatchObject({
      label: 'December 2026',
      returnPeriod: '122026',
      gstr1DueDate: '2027-01-11',
      gstr3bDueDate: '2027-01-20',
    });
  });

  it('a February in a leap year is still a whole month', () => {
    expect(buildPeriod('2028-02-01', '2028-02-29')).toMatchObject({ isWholeMonth: true, label: 'February 2028' });
  });

  it('custom dates have no return period or due dates', () => {
    expect(buildPeriod('2026-10-01', '2026-10-15')).toEqual({
      from: '2026-10-01',
      to: '2026-10-15',
      label: '1 Oct – 15 Oct 2026',
      isWholeMonth: false,
      returnPeriod: null,
      financialYear: '2026-27',
      gstr1DueDate: null,
      gstr3bDueDate: null,
    });
    expect(buildPeriod('2026-10-10', '2026-10-10').label).toBe('10 Oct 2026');
    expect(buildPeriod('2026-12-20', '2027-01-05').label).toBe('20 Dec 2026 – 5 Jan 2027');
  });

  it('a range across two financial years names both', () => {
    expect(buildPeriod('2027-03-20', '2027-04-05').financialYear).toBe('2026-27 / 2027-28');
  });

  it('the month in progress (to = today) is a custom period, not a filing month', () => {
    expect(buildPeriod('2026-10-01', '2026-10-20')).toMatchObject({ isWholeMonth: false, returnPeriod: null });
  });
});

describe('businessFromLegal', () => {
  it('takes the state from the GSTIN', () => {
    expect(BUSINESS).toEqual({
      legalName: 'Arry Foods',
      tradeName: 'HIOC',
      gstin: '09AGJPA9390E1Z9',
      stateCode: '09',
      stateName: 'Uttar Pradesh',
      address: '1 Test Road, Agra',
    });
  });
});

// ── A month holding both GST rules ──────────────────────────────────────────

describe('a month that holds both GST rules (10 Oct before, 25 Oct after 19 Oct 2026)', () => {
  const c = compute(october());

  it('taxable value, tax and bills as charged, each bill under its own rule', () => {
    expect(c.counts).toEqual({ issuedBills: 2, cancelledBills: 0, afterDiscountBills: 1, beforeDiscountBills: 1 });
    expect(c.gstr3b[0].amounts).toEqual({ taxableValueInr: 1560, igstInr: 0, cgstInr: 39, sgstInr: 39, cessInr: 0 });
    expect(c.taxPayable).toEqual({ igstInr: 0, cgstInr: 39, sgstInr: 39, cessInr: 0, totalInr: 78 });
  });

  it('sales to taxable value: the discount comes off only on the later bill, packaging is added only there', () => {
    expect(c.toTaxableValue.map((l) => [l.kind, l.label, l.amountInr])).toEqual([
      ['start', 'Gross item sales', 1700],
      ['less', 'HIOC Ritual cups covered by a pass', 0],
      ['less', 'Discounts deducted before GST', -150],
      ['less', 'GST-exempt items', 0],
      ['add', 'Packaging taxed', 10],
      ['total', 'Taxable value', 1560],
    ]);
  });

  it('taxable value to bill totals: the earlier bill’s packaging is added and its discount taken off', () => {
    expect(c.toInvoiceValue.map((l) => [l.kind, l.label, l.amountInr])).toEqual([
      ['start', 'Taxable value', 1560],
      ['add', 'CGST', 39],
      ['add', 'SGST', 39],
      ['add', 'GST-exempt sales', 0],
      ['add', 'Packaging billed without GST', 10],
      ['less', 'Coupon and Beanies discounts given after GST', -20],
      ['total', 'Total invoice value of the bills issued', 1628],
    ]);
    expect(lineBy(c.toInvoiceValue, 'Coupon and Beanies discounts given after GST').note).toContain('coupons ₹20.00, Beanies ₹0.00');
  });

  it('ties exactly with no rounding lines', () => {
    expectTies(c);
    expect(c.toTaxableValue.some((l) => l.label === 'Rounding difference')).toBe(false);
    expect(c.toInvoiceValue.some((l) => l.label === 'Rounding difference')).toBe(false);
    expect(checkBy(c, 'Sales tie').status).toBe('ok');
  });

  it('Table 12 carries packaging under SAC 996331 and beans in kilos; Table 7 is one row', () => {
    expect(c.gstr1.hsn).toEqual([
      { hsn: '0901', description: 'Coffee, roasted', uqc: 'KGS-KILOGRAMS', quantity: 0.5, totalValueInr: 1134, rate: 5, taxableValueInr: 1080, igstInr: 0, cgstInr: 27, sgstInr: 27, cessInr: 0, kind: 'goods' },
      { hsn: '996331', description: 'Restaurant service', uqc: 'NA', quantity: 0, totalValueInr: 504, rate: 5, taxableValueInr: 480, igstInr: 0, cgstInr: 12, sgstInr: 12, cessInr: 0, kind: 'service' },
    ]);
    expect(c.gstr1.b2cs).toEqual([
      { type: 'OE', placeOfSupply: '09-Uttar Pradesh', applicablePercent: '', rate: 5, taxableValueInr: 1560, cessInr: 0, ecommerceGstin: '', cgstInr: 39, sgstInr: 39 },
    ]);
  });

  it('says the month holds two bases, with each side counted', () => {
    const k = checkBy(c, 'Two GST bases');
    expect(k.status).toBe('info');
    expect(k.detail).toContain('1 bill before 19 Oct 2026');
    expect(k.detail).toContain('1 bill from that date');
    expect(c.notes.find((n) => n.startsWith('GST basis'))).toContain('1 bill on the new basis, 1 bill on the earlier one');
  });

  it('the invoice register shows the basis of each bill', () => {
    expect(c.invoiceRegister.map((r) => [r.invoiceNo, r.gstBasis, r.taxableValueInr, r.packagingInr, r.discountInr, r.invoiceValueInr])).toEqual([
      ['HIOC-003001', 'Before discount', 200, 10, 20, 200],
      ['HIOC-003002', 'After discount', 1360, 10, 150, 1428],
    ]);
  });

  it('a month entirely on one basis does not raise the two-bases check', () => {
    const sept = compute(
      build({
        from: '2026-09-01',
        to: '2026-09-30',
        orders: [order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 5, total_inr: 105 })],
        items: [item('a', { line_total_inr: 100 })],
      }),
    );
    expect(sept.checks.some((k) => k.title.startsWith('Two GST bases'))).toBe(false);
  });
});

// ── Labels the portal and the offline tool use ──────────────────────────────

describe('return wording', () => {
  const c = compute(october());

  it('GSTR-3B Table 3.1 rows carry the portal’s labels, in order', () => {
    expect(GSTR3B_TABLE_31_HEADING).toBe(
      'Details of Outward Supplies and inward supplies liable to reverse charge (other than those covered by Table 3.1.1)',
    );
    expect(c.gstr3b.map((r) => [r.code, r.label])).toEqual([
      ['3.1(a)', 'Outward taxable supplies (other than zero rated, nil rated and exempted)'],
      ['3.1(b)', 'Outward taxable supplies (zero rated)'],
      ['3.1(c)', 'Other outward supplies (Nil rated, exempted)'],
      ['3.1(d)', 'Inward supplies (liable to reverse charge)'],
      ['3.1(e)', 'Non-GST outward supplies'],
      ['3.1.1(i)', 'Taxable supplies on which electronic commerce operator pays tax under sub-section (5) of section 9'],
      [
        '3.1.1(ii)',
        'Taxable supplies made by the registered person through electronic commerce operator, on which electronic commerce operator is required to pay tax under sub-section (5) of section 9',
      ],
    ]);
  });

  it('only (a) and (c) apply; the rest are nil with a reason', () => {
    expect(c.gstr3b.map((r) => r.applies)).toEqual([true, false, true, false, false, false, false]);
    for (const r of c.gstr3b.filter((x) => !x.applies)) {
      expect(r.amounts).toEqual({ taxableValueInr: 0, igstInr: 0, cgstInr: 0, sgstInr: 0, cessInr: 0 });
      expect(r.note).toMatch(/^Nil:/);
    }
    for (const r of c.gstr3b) expect(r.note.length).toBeGreaterThan(0);
  });

  it('Table 8 always has its four rows, exempt value in the intra-state unregistered one', () => {
    expect(c.gstr1.nilExempt.map((r) => r.description)).toEqual([...NIL_EXEMPT_DESCRIPTIONS]);
    expect([...NIL_EXEMPT_DESCRIPTIONS]).toEqual([
      'Inter-State supplies to registered persons',
      'Intra-State supplies to registered persons',
      'Inter-State supplies to unregistered persons',
      'Intra-State supplies to unregistered persons',
    ]);
  });

  it('Table 13 names its document and counts like the offline tool', () => {
    expect(DOCS_NATURE).toBe('Invoices for outward supply');
    expect(c.gstr1.docs).toEqual([
      { nature: 'Invoices for outward supply', fromNo: 'HIOC-003001', toNo: 'HIOC-003002', totalNumber: 2, cancelled: 0, netIssued: 2 },
    ]);
  });

  it('the glossary and notes are plain, one line each', () => {
    expect(c.glossary.map((g) => g.term)).toEqual([
      'Taxable value',
      'CGST / SGST',
      'IGST',
      'GSTR-1',
      'GSTR-3B',
      'B2CS',
      'HSN / SAC',
      'Nil rated / exempt',
      'Documents issued',
      'Input tax credit',
    ]);
    expect(c.glossary.find((g) => g.term === 'CGST / SGST')?.meaning).toBe(
      'The two halves of the 5% GST: 2.5% to the Centre, 2.5% to Uttar Pradesh.',
    );
    expect(c.glossary.find((g) => g.term === 'HSN / SAC')?.meaning).toContain('996331');
    expect(c.glossary.find((g) => g.term === 'HSN / SAC')?.meaning).toContain('0901');
    for (const g of c.glossary) expect(g.meaning).not.toMatch(/[\r\n]/);
    for (const n of c.notes) {
      expect(n).not.toMatch(/[\r\n]/);
      expect(n.length).toBeLessThan(400);
    }
    expect(c.notes.length).toBeLessThanOrEqual(12);
  });

  it('notes carry the filing facts: due dates, file GSTR-1 first, no input tax credit', () => {
    expect(c.notes[0]).toContain('GSTR-1 by the 11th (11 Nov 2026), GSTR-3B and payment by the 20th (20 Nov 2026)');
    expect(c.notes[0]).toContain('QRMP');
    expect(c.notes.some((n) => n.startsWith('Since July 2025 GSTR-3B Table 3.1 is filled from GSTR-1 and locked'))).toBe(true);
    expect(c.notes.some((n) => n.includes('without input tax credit'))).toBe(true);
  });
});

// ── Exempt items ────────────────────────────────────────────────────────────

describe('GST-exempt items', () => {
  /**
   * 25 Oct (after): ₹200 latte + ₹100 exempt cake, ₹30 off → the discount is spread over both:
   * 180 taxable + 90 exempt; GST 9; total 279.
   * 10 Oct (before): ₹200 latte + ₹100 exempt cake, ₹30 off after GST: GST on 200 → 10; total 280.
   */
  const ds = build({
    orders: [
      order({ id: 'a', order_number: 1, created_at: NEW_DAY, subtotal_inr: 300, discount_inr: 30, tax_inr: 9, total_inr: 279 }),
      order({ id: 'b', order_number: 2, created_at: OLD_DAY, subtotal_inr: 300, discount_inr: 30, tax_inr: 10, total_inr: 280 }),
    ],
    items: [
      item('a', { line_total_inr: 200 }),
      item('a', { line_total_inr: 100, gst_exempt: true }),
      item('b', { line_total_inr: 200 }),
      item('b', { line_total_inr: 100, gst_exempt: true }),
    ],
  });
  const c = compute(ds);

  it('exempt value is after the discount’s share on the later bill and at full price on the earlier one', () => {
    expect(c.invoiceRegister.map((r) => [r.taxableValueInr, r.exemptValueInr])).toEqual([
      [180, 90],
      [200, 100],
    ]);
    expect(c.gstr3b[2].amounts.taxableValueInr).toBe(190);
    expect(c.gstr3b[2].amounts.cgstInr).toBe(0);
    expect(c.gstr3b[2].note).toBe('Menu items marked GST-exempt: sold with no GST charged.');
  });

  it('Table 8 shows them as Exempted, in the intra-state unregistered row, nothing else', () => {
    expect(c.gstr1.nilExempt).toEqual([
      { description: 'Inter-State supplies to registered persons', nilRatedInr: 0, exemptedInr: 0, nonGstInr: 0 },
      { description: 'Intra-State supplies to registered persons', nilRatedInr: 0, exemptedInr: 0, nonGstInr: 0 },
      { description: 'Inter-State supplies to unregistered persons', nilRatedInr: 0, exemptedInr: 0, nonGstInr: 0 },
      { description: 'Intra-State supplies to unregistered persons', nilRatedInr: 0, exemptedInr: 190, nonGstInr: 0 },
    ]);
  });

  it('Table 12 shows exempt items at rate 0 and ties to Table 7 + Table 8', () => {
    expect(c.gstr1.hsn.map((r) => [r.hsn, r.rate, r.taxableValueInr, r.totalValueInr])).toEqual([
      ['996331', 5, 380, 399],
      ['996331', 0, 190, 190],
    ]);
    expectTies(c);
    expect(checkBy(c, 'GSTR-1 Table 12 equals').status).toBe('ok');
  });

  it('both reconciliations tie with no rounding line', () => {
    expect(c.toTaxableValue.map((l) => [l.label, l.amountInr])).toEqual([
      ['Gross item sales', 600],
      ['HIOC Ritual cups covered by a pass', 0],
      ['Discounts deducted before GST', -30],
      ['GST-exempt items', -190],
      ['Packaging taxed', 0],
      ['Taxable value', 380],
    ]);
    expect(c.toInvoiceValue.map((l) => [l.label, l.amountInr])).toEqual([
      ['Taxable value', 380],
      ['CGST', 9.5],
      ['SGST', 9.5],
      ['GST-exempt sales', 190],
      ['Packaging billed without GST', 0],
      ['Coupon and Beanies discounts given after GST', -30],
      ['Total invoice value of the bills issued', 559],
    ]);
  });

  it('the CA is told how exempt items are shown, and only when there are some', () => {
    expect(c.notes).toContain('GST-exempt menu items are shown as Exempted in Table 8 — confirm whether any are nil-rated instead.');
    expect(c.notes).toContain('Whether exempt items need a Table 12 row is not settled — they are shown at rate 0.');
    expect(c.notes.some((n) => n.includes('zero dummy row in Table 12 B2B'))).toBe(true);
    const none = compute(october());
    expect(none.notes.some((n) => n.includes('Exempted'))).toBe(false);
    expect(none.notes.some((n) => n.includes('dummy row'))).toBe(false);
    expect(none.gstr3b[2].note).toBe('Nil: no GST-exempt items were sold in this period.');
  });

  it('an all-exempt month has no Table 7 row and 3.1(a) is nil', () => {
    const only = compute(
      build({
        orders: [order({ id: 'a', order_number: 1, subtotal_inr: 50, total_inr: 50 })],
        items: [item('a', { line_total_inr: 50, gst_exempt: true })],
      }),
    );
    expect(only.gstr1.b2cs).toEqual([]);
    expect(only.gstr3b[0].amounts.taxableValueInr).toBe(0);
    expect(only.gstr3b[2].amounts.taxableValueInr).toBe(50);
    expect(only.taxPayable.totalInr).toBe(0);
    expectTies(only);
  });

  it('exempt beans keep their own HSN 0901 rate-0 row', () => {
    const c2 = compute(
      build({
        orders: [order({ id: 'a', order_number: 1, subtotal_inr: 600, total_inr: 600 })],
        items: [item('a', { line_total_inr: 600, menu_item_id: 'beans', quantity: 1, weight_grams: 1000, gst_exempt: true })],
      }),
    );
    expect(c2.gstr1.hsn).toEqual([
      { hsn: '0901', description: 'Coffee, roasted', uqc: 'KGS-KILOGRAMS', quantity: 1, totalValueInr: 600, rate: 0, taxableValueInr: 600, igstInr: 0, cgstInr: 0, sgstInr: 0, cessInr: 0, kind: 'goods' },
    ]);
    expectTies(c2);
  });
});

// ── Packaging, pass cover, prices that include GST ──────────────────────────

describe('packaging', () => {
  it('after 19 Oct packaging is taxed with the restaurant service; before it, it is billed without GST', () => {
    const c = compute(
      build({
        orders: [
          order({ id: 'a', order_number: 1, created_at: NEW_DAY, subtotal_inr: 100, packaging_inr: 20, tax_inr: 6, total_inr: 126 }),
          order({ id: 'b', order_number: 2, created_at: OLD_DAY, subtotal_inr: 100, packaging_inr: 20, tax_inr: 5, total_inr: 125 }),
        ],
        items: [item('a', { line_total_inr: 100 }), item('b', { line_total_inr: 100 })],
      }),
    );
    expect(lineBy(c.toTaxableValue, 'Packaging taxed').amountInr).toBe(20);
    expect(lineBy(c.toInvoiceValue, 'Packaging billed without GST').amountInr).toBe(20);
    expect(c.gstr3b[0].amounts.taxableValueInr).toBe(220);
    expect(c.gstr1.hsn.map((r) => [r.hsn, r.taxableValueInr])).toEqual([['996331', 220]]);
    expect(c.toInvoiceValue.at(-1)?.amountInr).toBe(251);
    expectTies(c);
  });

  it('a bill with packaging only (no items) still ties', () => {
    const c = compute(
      build({
        orders: [order({ id: 'a', order_number: 1, created_at: NEW_DAY, subtotal_inr: 0, packaging_inr: 10, tax_inr: 1, total_inr: 11 })],
      }),
    );
    expect(c.gstr3b[0].amounts.taxableValueInr).toBe(10);
    expectTies(c);
  });
});

describe('HIOC Ritual cups', () => {
  /** 1: a ₹180 cup covered by a pass plus a ₹120 cake (GST on 120 → 6; total 300 − 180 + 6 = 126). 2: the ₹1000 pass sale itself. */
  const c = compute(
    build({
      orders: [
        order({ id: 'a', order_number: 1, subtotal_inr: 300, tax_inr: 6, pass_discount_inr: 180, total_inr: 126 }),
        order({ id: 'p', order_number: 2, order_kind: 'coffee_pass', subtotal_inr: 1000, tax_inr: 50, total_inr: 1050 }),
      ],
      items: [
        item('a', { line_total_inr: 180, pass_covered_inr: 180, pass_drinks: 1 }),
        item('a', { line_total_inr: 120 }),
        item('p', { line_total_inr: 1000, menu_item_id: null, coffee_pass_plan_id: 'plan-1' }),
      ],
    }),
  );

  it('the cover comes off the gross sales; the pass sale is taxed in full when sold', () => {
    expect(lineBy(c.toTaxableValue, 'HIOC Ritual cups covered by a pass').amountInr).toBe(-180);
    expect(lineBy(c.toTaxableValue, 'Gross item sales').amountInr).toBe(1300);
    expect(c.gstr3b[0].amounts.taxableValueInr).toBe(1120);
    expect(c.gstr3b[0].amounts.cgstInr).toBe(28);
    expect(totalLine(c.toInvoiceValue).amountInr).toBe(1176);
    expectTies(c);
  });

  it('a bill the pass paid in full carries no tax and no taxable value', () => {
    const free = compute(
      build({
        orders: [order({ id: 'a', order_number: 1, subtotal_inr: 180, tax_inr: 0, pass_discount_inr: 180, total_inr: 0 })],
        items: [item('a', { line_total_inr: 180, pass_covered_inr: 180, pass_drinks: 1 })],
      }),
    );
    expect(free.counts.issuedBills).toBe(1);
    expect(free.gstr1.b2cs).toEqual([]);
    expect(free.gstr1.hsn).toEqual([]);
    expect(totalLine(free.toInvoiceValue).amountInr).toBe(0);
    expectTies(free);
  });
});

describe('prices that include GST', () => {
  const c = compute(
    build({
      gstInclusive: true,
      orders: [
        // ₹105 incl. 5%: taxable 100, GST 5
        order({ id: 'a', order_number: 1, created_at: OLD_DAY, subtotal_inr: 105, tax_inr: 5, total_inr: 105 }),
        // after: ₹210, ₹21 off, ₹10 packaging → (189 + 10) incl. 5% → GST round(199 × 5/105) = 9; total 210 + 10 − 21 = 199
        order({ id: 'b', order_number: 2, created_at: NEW_DAY, subtotal_inr: 210, discount_inr: 21, packaging_inr: 10, tax_inr: 9, total_inr: 199 }),
      ],
      items: [item('a', { line_total_inr: 105 }), item('b', { line_total_inr: 210 })],
    }),
  );

  it('takes the GST out of the prices and says so', () => {
    expect(c.pricesIncludeGst).toBe(true);
    expect(lineBy(c.toTaxableValue, 'GST inside prices').amountInr).toBe(-14);
    expect(c.gstr3b[0].amounts).toMatchObject({ taxableValueInr: 290, cgstInr: 7, sgstInr: 7 });
    expect(totalLine(c.toInvoiceValue).amountInr).toBe(304);
    expect(checkBy(c, 'Prices include GST').status).toBe('info');
    expectTies(c);
  });

  it('tax is within tolerance of 5% of the taxable value', () => {
    expect(checkBy(c, 'GST is 5%').status).toBe('ok');
  });

  it('without inclusive pricing there is no such line', () => {
    expect(compute(october()).toTaxableValue.some((l) => l.label === 'GST inside prices')).toBe(false);
  });
});

// ── Cancelled and rejected bills, numbering, registers ──────────────────────

describe('cancelled and rejected bills and the numbering', () => {
  /** 1001..1010: 1004 cancelled, 1005 rejected, 1007–1009 never saved. */
  const c = compute(
    build({
      orders: [
        order({ id: 'a', order_number: 1001, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'b', order_number: 1002, subtotal_inr: 200, tax_inr: 10, total_inr: 210 }),
        order({ id: 'c', order_number: 1004, status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'd', order_number: 1005, status: 'rejected', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'e', order_number: 1006, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'f', order_number: 1010, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
      ],
      items: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id, { line_total_inr: id === 'b' ? 200 : 100 })),
    }),
  );

  it('dead bills count in no total but keep their numbers', () => {
    expect(c.counts).toMatchObject({ issuedBills: 4, cancelledBills: 2 });
    expect(c.gstr3b[0].amounts.taxableValueInr).toBe(500);
    expect(c.taxPayable.totalInr).toBe(25);
    expect(totalLine(c.toInvoiceValue).amountInr).toBe(105 + 210 + 105 + 105);
    expectTies(c);
  });

  it('Table 13 counts the whole number range, gaps as cancelled', () => {
    expect(c.gstr1.docs).toEqual([
      { nature: 'Invoices for outward supply', fromNo: 'HIOC-001001', toNo: 'HIOC-001010', totalNumber: 10, cancelled: 6, netIssued: 4 },
    ]);
    expect(checkBy(c, 'GSTR-1 Table 13').status).toBe('ok');
  });

  it('a gap in the numbers is a warning that lists the missing ones', () => {
    const k = checkBy(c, 'Invoice numbers are missing');
    expect(k.status).toBe('warn');
    expect(k.detail).toContain('4 numbers between HIOC-001001 and HIOC-001010 have no bill at all');
    expect(k.detail).toContain('HIOC-001003, HIOC-001007, HIOC-001008, HIOC-001009');
    expect(k.detail).not.toContain('more');
  });

  it('lists at most ten missing numbers', () => {
    const wide = compute(
      build({
        orders: [order({ id: 'a', order_number: 1 }), order({ id: 'b', order_number: 40 })],
      }),
    );
    const k = checkBy(wide, 'Invoice numbers are missing');
    expect(k.detail).toContain('38 numbers');
    expect(k.detail).toContain('HIOC-000002, HIOC-000003');
    expect(k.detail).toContain('HIOC-000011');
    expect(k.detail).not.toContain('HIOC-000012');
    expect(k.detail).toContain('and 28 more');
  });

  it('gap-free numbering is an OK that names the range', () => {
    const k = checkBy(compute(october()), 'No gaps');
    expect(k).toMatchObject({ status: 'ok' });
    expect(k.detail).toBe('HIOC-003001 to HIOC-003002: all 2 numbers are accounted for.');
    expect(checkBy(compute(october()), 'No cancelled bills').status).toBe('ok');
  });

  it('counts cancelled and rejected bills in a note', () => {
    const k = checkBy(c, '2 bills cancelled or rejected');
    expect(k.status).toBe('info');
    expect(k.detail).toContain('1 cancelled and 1 rejected: left out of every figure');
  });

  it('the invoice register lists every bill in invoice order with its status', () => {
    expect(c.invoiceRegister.map((r) => [r.invoiceNo, r.status])).toEqual([
      ['HIOC-001001', 'Issued'],
      ['HIOC-001002', 'Issued'],
      ['HIOC-001004', 'Cancelled'],
      ['HIOC-001005', 'Rejected'],
      ['HIOC-001006', 'Issued'],
      ['HIOC-001010', 'Issued'],
    ]);
    // Cancelled rows show what was printed.
    expect(c.invoiceRegister[2]).toMatchObject({ taxableValueInr: 100, cgstInr: 2.5, sgstInr: 2.5, invoiceValueInr: 105 });
  });

  it('a cancelled first or last bill still sets the ends of Table 13', () => {
    const t = compute(
      build({
        orders: [
          order({ id: 'a', order_number: 10, status: 'cancelled' }),
          order({ id: 'b', order_number: 11 }),
          order({ id: 'c', order_number: 12, status: 'rejected' }),
        ],
      }),
    );
    expect(t.gstr1.docs[0]).toMatchObject({ fromNo: 'HIOC-000010', toNo: 'HIOC-000012', totalNumber: 3, cancelled: 2, netIssued: 1 });
  });
});

describe('the day register', () => {
  const c = compute(
    build({
      from: '2026-10-01',
      to: '2026-10-07',
      orders: [
        order({ id: 'a', order_number: 1, created_at: '2026-10-02T06:30:00Z', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'b', order_number: 2, created_at: '2026-10-02T10:30:00Z', status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'c', order_number: 3, created_at: '2026-10-02T12:30:00Z', subtotal_inr: 200, tax_inr: 10, total_inr: 210 }),
        // 23:59 IST on the 5th and 00:00 IST on the 6th
        order({ id: 'd', order_number: 4, created_at: '2026-10-05T18:29:59Z', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'e', order_number: 5, created_at: '2026-10-05T18:30:00Z', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
      ],
      items: [
        item('a', { line_total_inr: 100 }),
        item('b', { line_total_inr: 100 }),
        item('c', { line_total_inr: 200 }),
        item('d', { line_total_inr: 100 }),
        item('e', { line_total_inr: 100 }),
      ],
    }),
  );

  it('has a row for every date of the period, zeros where nothing happened', () => {
    expect(c.dayRegister.map((d) => d.date)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
    expect(c.dayRegister[0]).toEqual({
      date: '2026-10-01',
      firstInvoice: '',
      lastInvoice: '',
      bills: 0,
      cancelled: 0,
      taxableValueInr: 0,
      cgstInr: 0,
      sgstInr: 0,
      exemptValueInr: 0,
      invoiceValueInr: 0,
    });
  });

  it('first and last invoice include cancelled bills; the amounts are for the issued ones', () => {
    expect(c.dayRegister[1]).toEqual({
      date: '2026-10-02',
      firstInvoice: 'HIOC-000001',
      lastInvoice: 'HIOC-000003',
      bills: 2,
      cancelled: 1,
      taxableValueInr: 300,
      cgstInr: 7.5,
      sgstInr: 7.5,
      exemptValueInr: 0,
      invoiceValueInr: 315,
    });
  });

  it('the day flips at midnight IST', () => {
    expect(c.dayRegister[4]).toMatchObject({ date: '2026-10-05', bills: 1, lastInvoice: 'HIOC-000004' });
    expect(c.dayRegister[5]).toMatchObject({ date: '2026-10-06', bills: 1, firstInvoice: 'HIOC-000005' });
  });

  it('adds up to the period and says so', () => {
    expectTies(c);
    expect(checkBy(c, 'Day-wise register').status).toBe('ok');
  });
});

// ── A custom period and an empty month ──────────────────────────────────────

describe('a custom (non-month) period', () => {
  const c = compute(
    build({
      from: '2026-10-01',
      to: '2026-10-15',
      orders: [order({ id: 'a', order_number: 1, created_at: OLD_DAY, subtotal_inr: 100, tax_inr: 5, total_inr: 105 })],
      items: [item('a', { line_total_inr: 100 })],
    }),
  );

  it('has no return period or due dates, and says the period is not a whole month', () => {
    expect(c.period).toMatchObject({ label: '1 Oct – 15 Oct 2026', isWholeMonth: false, returnPeriod: null, gstr1DueDate: null, gstr3bDueDate: null });
    expect(c.notes[0]).toContain('not a whole month');
    expect(c.notes[0]).toContain('QRMP');
    expect(c.dayRegister).toHaveLength(15);
    expectTies(c);
  });
});

describe('an empty month', () => {
  const c = compute(build({}));

  it('is all zeros, not an error', () => {
    expect(c.counts).toEqual({ issuedBills: 0, cancelledBills: 0, afterDiscountBills: 0, beforeDiscountBills: 0 });
    expect(c.taxPayable).toEqual({ igstInr: 0, cgstInr: 0, sgstInr: 0, cessInr: 0, totalInr: 0 });
    expect(c.gstr1.b2cs).toEqual([]);
    expect(c.gstr1.hsn).toEqual([]);
    expect(c.gstr1.docs).toEqual([]);
    expect(c.gstr1.nilExempt).toHaveLength(4);
    expect(c.invoiceRegister).toEqual([]);
    expect(c.dayRegister).toHaveLength(31);
    expect(c.dayRegister.every((d) => d.bills === 0 && d.invoiceValueInr === 0 && d.firstInvoice === '')).toBe(true);
    expect(c.toTaxableValue.every((l) => l.amountInr === 0)).toBe(true);
    expect(c.toInvoiceValue.every((l) => l.amountInr === 0)).toBe(true);
    expect(c.gstr3b).toHaveLength(7);
    expectTies(c);
  });

  it('raises no warning, and still gives the CA the standing notes', () => {
    expect(c.checks.filter((k) => k.status === 'warn')).toEqual([]);
    expect(checkBy(c, 'Invoice numbers').status).toBe('info');
    expect(c.notes.length).toBeGreaterThan(3);
    expect(c.glossary).toHaveLength(10);
    expect(c.generatedAt).toBe(NOW.toISOString());
  });
});

// ── Unpaid bills and refunds ────────────────────────────────────────────────

describe('unpaid bills', () => {
  const c = compute(
    build({
      orders: [
        order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'b', order_number: 2, payment_status: 'unpaid', payment_method: null, subtotal_inr: 200, tax_inr: 10, total_inr: 210 }),
        order({ id: 'c', order_number: 3, payment_status: 'payment_pending', payment_method: null, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'd', order_number: 4, status: 'cancelled', payment_status: 'unpaid', payment_method: null, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
      ],
      items: [item('a', { line_total_inr: 100 }), item('b', { line_total_inr: 200 }), item('c', { line_total_inr: 100 }), item('d', { line_total_inr: 100 })],
    }),
  );

  it('are counted as sales and flagged, cancelled ones excluded', () => {
    expect(c.counts.issuedBills).toBe(3);
    expect(c.gstr3b[0].amounts.taxableValueInr).toBe(400);
    const k = checkBy(c, '2 bills not marked paid');
    expect(k.status).toBe('warn');
    expect(k.detail).toContain('HIOC-000002, HIOC-000003');
    expect(k.detail).toContain('₹315.00');
    expect(k.detail).toContain('counted as sales');
  });

  it('show as Unpaid in the register; paid ones show the method', () => {
    expect(c.invoiceRegister.map((r) => r.paymentMode)).toEqual(['Cash', 'Unpaid', 'Unpaid', 'Unpaid']);
  });

  it('a month where every bill is paid is an OK', () => {
    expect(checkBy(compute(october()), 'Every bill is marked paid').status).toBe('ok');
  });
});

describe('refunds', () => {
  const refund = (over: Partial<RefundRow> & { id: string; order_id: string }): RefundRow => ({
    amount_inr: 40,
    method: 'cash',
    reason: '',
    status: 'processed',
    processed_at: '2026-10-12T10:00:00Z',
    created_by: null,
    created_at: '2026-10-12T09:55:00Z',
    ...over,
  });

  const c = compute(
    build({
      orders: [
        order({ id: 'a', order_number: 1, created_at: OLD_DAY, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        order({ id: 'b', order_number: 2, created_at: OLD_DAY, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
      ],
      items: [item('a', { line_total_inr: 100 }), item('b', { line_total_inr: 100 })],
      rangeRefunds: [
        refund({ id: 'r1', order_id: 'a', amount_inr: 40 }),
        refund({ id: 'r2', order_id: 'b', amount_inr: 99, status: 'pending', processed_at: null }),
        refund({ id: 'r3', order_id: 'old', amount_inr: 60 }),
      ],
      refundOrders: [{ id: 'old', order_number: 900, created_at: '2026-09-20T06:00:00Z' }],
    }),
  );

  it('processed refunds are flagged as having no credit note; the GST is not changed', () => {
    const k = checkBy(c, '2 refunds without a credit note');
    expect(k.status).toBe('warn');
    expect(k.detail).toContain('₹100.00 was refunded (1 on bills from earlier months)');
    expect(k.detail).toContain('no credit notes');
    expect(c.gstr3b[0].amounts.taxableValueInr).toBe(200);
    expect(c.notes).toContain('Refunds do not change the GST on the original bill and the app issues no credit notes.');
  });

  it('a month without refunds says so', () => {
    expect(checkBy(compute(october()), 'No refunds').status).toBe('ok');
  });
});

// ── Differences that cannot be explained ────────────────────────────────────

describe('rounding and mismatches', () => {
  it('a printed total off by a few paise gets one rounding line and an info note, not a warning', () => {
    const c = compute(
      build({
        orders: [
          order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
          order({ id: 'b', order_number: 2, subtotal_inr: 100, tax_inr: 5, total_inr: 105.5 }),
        ],
        items: [item('a', { line_total_inr: 100 }), item('b', { line_total_inr: 100 })],
      }),
    );
    expect(c.toInvoiceValue.map((l) => [l.kind, l.label, l.amountInr])).toEqual([
      ['start', 'Taxable value', 200],
      ['add', 'CGST', 5],
      ['add', 'SGST', 5],
      ['add', 'GST-exempt sales', 0],
      ['add', 'Packaging billed without GST', 0],
      ['less', 'Coupon and Beanies discounts given after GST', 0],
      ['add', 'Rounding difference', 0.5],
      ['total', 'Total invoice value of the bills issued', 210.5],
    ]);
    expect(stepsSum(c.toInvoiceValue)).toBe(21050);
    expect(checkBy(c, 'Small rounding differences').status).toBe('info');
  });

  it('a negative difference is a "less" rounding line', () => {
    const c = compute(
      build({
        orders: [order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 5, total_inr: 104.5 })],
        items: [item('a', { line_total_inr: 100 })],
      }),
    );
    const r = lineBy(c.toInvoiceValue, 'Rounding difference');
    expect(r).toMatchObject({ kind: 'less', amountInr: -0.5 });
    expect(stepsSum(c.toInvoiceValue)).toBe(10450);
  });

  it('more than ₹1 on a bill is a warning that names the bill', () => {
    const c = compute(
      build({
        orders: [
          order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
          order({ id: 'b', order_number: 2, subtotal_inr: 100, tax_inr: 5, total_inr: 120 }),
        ],
        items: [item('a', { line_total_inr: 100 }), item('b', { line_total_inr: 100 })],
      }),
    );
    const k = checkBy(c, 'Totals do not add up on 1 bill');
    expect(k.status).toBe('warn');
    expect(k.detail).toContain('HIOC-000002');
    expect(lineBy(c.toInvoiceValue, 'Rounding difference').amountInr).toBe(15);
    expect(stepsSum(c.toInvoiceValue)).toBe(22500);
  });

  it('tax that is not the rate of the taxable value is a warning (a bill taxed on another basis)', () => {
    const c = compute(
      build({
        orders: [
          order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
          order({ id: 'b', order_number: 2, subtotal_inr: 100, tax_inr: 12, total_inr: 112 }),
        ],
        items: [item('a', { line_total_inr: 100 }), item('b', { line_total_inr: 100 })],
      }),
    );
    const k = checkBy(c, 'GST is not 5% of the taxable value on 1 bill');
    expect(k.status).toBe('warn');
    expect(k.detail).toContain('HIOC-000002');
    expect(k.detail).toContain('charged ₹12.00 where 5% would be ₹5.00');
  });

  it('GST within 50 paise of the rate (whole-rupee rounding) is fine', () => {
    // 5% of ₹130 = 6.50; the app charges 6 or 7 (rounds half up → 7): both within 0.50
    for (const tax of [6, 7]) {
      const c = compute(
        build({
          orders: [order({ id: 'a', order_number: 1, subtotal_inr: 130, tax_inr: tax, total_inr: 130 + tax })],
          items: [item('a', { line_total_inr: 130 })],
        }),
      );
      expect(checkBy(c, 'GST is 5%').status).toBe('ok');
    }
  });

  it('tax charged with nothing to hold it (every line exempt) is kept, tied through Table 12, and flagged by the rounding line', () => {
    const c = compute(
      build({
        orders: [order({ id: 'a', order_number: 1, subtotal_inr: 80, tax_inr: 10, total_inr: 90 })],
        items: [item('a', { line_total_inr: 80, gst_exempt: true })],
      }),
    );
    expect(c.gstr3b[0].amounts).toMatchObject({ taxableValueInr: 200, cgstInr: 5, sgstInr: 5 });
    expect(c.gstr1.hsn.map((r) => [r.rate, r.taxableValueInr, r.cgstInr])).toEqual([
      [5, 200, 5],
      [0, 80, 0],
    ]);
    expectTies(c);
    expect(c.checks.some((k) => k.status === 'warn' && k.title.startsWith('Totals do not add up'))).toBe(true);
  });
});

// ── The period before the app ───────────────────────────────────────────────

describe('the app’s start date', () => {
  it('warns when the period begins before billing moved into the app', () => {
    expect(APP_BILLING_FROM).toBe('2026-09-25');
    const c = compute(build({ from: '2026-09-01', to: '2026-09-30' }));
    const k = checkBy(c, 'Bills from before the app');
    expect(k.status).toBe('warn');
    expect(k.detail).toContain('25 Sep 2026');
    expect(k.detail).toContain('not in this report');
  });

  it('a period wholly before it points at Petpooja', () => {
    const k = checkBy(compute(build({ from: '2026-09-01', to: '2026-09-10' })), 'Bills from before the app');
    expect(k.detail).toContain('Petpooja’s GST report');
  });

  it('does not appear from the cut-over day on', () => {
    const c = compute(build({ from: '2026-09-25', to: '2026-10-05' }));
    expect(c.checks.some((k) => k.title.startsWith('Bills from before the app'))).toBe(false);
  });
});

describe('tips and counter discounts', () => {
  it('are noted as outside the supply when there are any', () => {
    const c = compute(
      build({
        orders: [order({ id: 'a', order_number: 1, subtotal_inr: 100, tax_inr: 5, total_inr: 105, settle_discount_inr: 5, tip_inr: 15 })],
        items: [item('a', { line_total_inr: 100 })],
      }),
    );
    const k = checkBy(c, 'Tips and counter discounts');
    expect(k.status).toBe('info');
    expect(k.detail).toContain('₹15.00 in tips');
    expect(k.detail).toContain('₹5.00 of discounts');
    expectTies(c);
  });
});

describe('check order', () => {
  it('shows what needs a look first, then notes, then the all-clear', () => {
    const c = compute(
      build({
        from: '2026-09-01',
        to: '2026-09-30',
        orders: [
          order({ id: 'a', order_number: 1, payment_status: 'unpaid', payment_method: null, subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
          order({ id: 'b', order_number: 2, status: 'cancelled', subtotal_inr: 100, tax_inr: 5, total_inr: 105 }),
        ],
        items: [item('a', { line_total_inr: 100 }), item('b', { line_total_inr: 100 })],
      }),
    );
    const rank = { warn: 0, info: 1, ok: 2 } as const;
    const ranks = c.checks.map((k) => rank[k.status]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    expect(ranks[0]).toBe(0);
    for (const k of c.checks) {
      expect(k.title.length).toBeGreaterThan(0);
      expect(k.title.length).toBeLessThan(90);
      expect(k.detail).not.toMatch(/[\r\n]/);
    }
  });
});

// ── Random months ───────────────────────────────────────────────────────────

describe('both rules, random bills: everything ties to the paisa', () => {
  it('reconciliations, tables and registers agree for exclusive and inclusive pricing', () => {
    let state = 987654;
    const rnd = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (const inclusive of [false, true]) {
      const orders: OrderRow[] = [];
      const items: ItemRow[] = [];
      const redemptions: RedemptionRow[] = [];
      for (let i = 0; i < 400; i++) {
        const id = `r${i}`;
        const day = 1 + rnd(30);
        const created_at = `2026-10-${String(day).padStart(2, '0')}T${String(4 + rnd(14)).padStart(2, '0')}:15:00Z`;
        const lateRule = day >= 19;
        const lines: ItemRow[] = [];
        for (let k = 0, n = 1 + rnd(5); k < n; k++) {
          const lineTotal = 20 + rnd(500);
          const covered = rnd(8) === 0 ? Math.min(lineTotal, 40 + rnd(120)) : 0;
          lines.push(
            item(id, {
              line_total_inr: lineTotal,
              menu_item_id: rnd(5) === 0 ? 'beans' : 'latte',
              weight_grams: null,
              gst_exempt: rnd(7) === 0,
              pass_covered_inr: covered,
              pass_drinks: covered > 0 ? 1 : 0,
              voided: rnd(9) === 0,
            }),
          );
        }
        const live = lines.filter((l) => !l.voided);
        const subtotal = live.reduce((s, l) => s + l.line_total_inr, 0);
        const cover = live.reduce((s, l) => s + (l.pass_covered_inr ?? 0), 0);
        const base = subtotal - cover;
        const taxableBase = live.filter((l) => !l.gst_exempt).reduce((s, l) => s + l.line_total_inr - (l.pass_covered_inr ?? 0), 0);
        const discount = base > 0 && rnd(3) === 0 ? rnd(base + 1) : 0;
        const packaging = rnd(3) === 0 ? 10 : 0;
        let tax: number;
        if (lateRule) {
          tax = computeBill(
            base,
            { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, gst_inclusive: inclusive, packaging_charge_inr: packaging },
            discount,
            taxableBase,
          ).tax_inr;
        } else {
          tax = inclusive ? Math.round(taxableBase - taxableBase / 1.05) : Math.round(taxableBase * 0.05);
        }
        const total = base - discount + packaging + (inclusive ? 0 : tax);
        const status = rnd(15) === 0 ? 'cancelled' : 'completed';
        orders.push(
          order({
            id,
            order_number: 7000 + i + (rnd(25) === 0 ? 1 : 0) * 0,
            created_at,
            status,
            payment_status: rnd(20) === 0 ? 'unpaid' : 'paid',
            subtotal_inr: subtotal,
            discount_inr: discount,
            packaging_inr: packaging,
            tax_inr: tax,
            pass_discount_inr: cover,
            total_inr: total,
          }),
        );
        if (discount > 0) redemptions.push({ order_id: id, discount_inr: Math.floor(discount / 2), code: 'X' });
        items.push(...lines);
      }
      const c = compute(build({ gstInclusive: inclusive, orders, items, redemptions }));
      expectTies(c);
      // No bill left anything unexplained, so there are no rounding lines at all.
      expect(c.toTaxableValue.some((l) => l.label === 'Rounding difference')).toBe(false);
      expect(c.toInvoiceValue.some((l) => l.label === 'Rounding difference')).toBe(false);
      expect(c.checks.filter((k) => k.status === 'warn').map((k) => k.title)).toEqual(
        expect.not.arrayContaining([expect.stringMatching(/^(GST is not|Totals do not|GSTR-)/)]),
      );
      expect(checkBy(c, 'GST is 5%').status).toBe('ok');
      expect(checkBy(c, 'Sales tie').status).toBe('ok');
      expect(c.counts.issuedBills + c.counts.cancelledBills).toBe(400);
      expect(c.counts.afterDiscountBills + c.counts.beforeDiscountBills).toBe(c.counts.issuedBills);
      expect(c.counts.afterDiscountBills).toBeGreaterThan(50);
      expect(c.counts.beforeDiscountBills).toBeGreaterThan(50);
      // Tax payable is exactly the sum of the tax the bills charged.
      const charged = orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + paise(o.tax_inr ?? 0), 0);
      expect(paise(c.taxPayable.totalInr)).toBe(charged);
      expect(paise(totalLine(c.toInvoiceValue).amountInr)).toBe(
        orders.filter((o) => o.status !== 'cancelled').reduce((s, o) => s + paise(o.total_inr ?? 0), 0),
      );
    }
  });
});
