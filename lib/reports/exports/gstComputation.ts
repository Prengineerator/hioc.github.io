// The GST working for a period, as one object (GstComputation, gstTypes.ts): what
// Owner → Reports → GST shows, what the CA's Excel workbook holds and what the GST
// CSVs are cut from. Pure — lib/reports/exports/gstComputationServer.ts loads the
// OrderDataset — so every view shows the same figures and the rules are unit-tested.
//
// WHAT IS REPORTED is the tax the bills CHARGED (orders.tax_inr, see orderData.ts),
// never a recomputed one. Only issued bills (not cancelled, not rejected) count; they
// stay in the registers and in the invoice-number range of Table 13. All sales are
// intra-state: CGST + SGST, no IGST, no cess. A restaurant at 5% takes no input tax
// credit, so everything in GSTR-3B is paid in cash.
//
// TWO GST RULES. From GST_NET_OF_DISCOUNT_FROM (lib/store/hours.ts) bills charge GST
// after the coupon / Beanies discount and on takeaway packaging; earlier bills
// charged it on the price before the discount with packaging untaxed. A month can
// hold both, so every figure here is summed bill by bill, each under its own rule
// (ExportOrder.gstRule).
//
// THE TWO RECONCILIATIONS tie to the paisa by construction. Per issued bill:
//   taxable value = Σ item totals − pass cover − discounts deducted before GST
//                   − exempt items + packaging taxed − GST inside prices
//   bill total    = taxable value + CGST + SGST + exempt sales + packaging billed
//                   without GST − discounts given after GST
// Whatever a bill's printed numbers do not explain falls into one "Rounding
// difference" line (shown only when not zero) and, above ₹1 on a bill, a check.
// ReconLine.amountInr is SIGNED (a 'less' step is negative) so the steps add up.
//
// Money is summed in integer paise and turned into rupees once.

import { datesBetween } from '@/lib/reports/reconcile';
import { wholeMonthOf } from '@/lib/reports/exports/period';
import {
  B2CS_TYPE,
  HSN_COFFEE_BEANS,
  PLACE_OF_SUPPLY,
  SAC_RESTAURANT,
} from '@/lib/reports/exports/gstCodes';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import { GST_NET_OF_DISCOUNT_FROM } from '@/lib/store/hours';
import type {
  B2csRow,
  DocsRow,
  GstBusiness,
  GstCheck,
  GstComputation,
  GstDayRow,
  GstInvoiceRow,
  GstPeriod,
  Gstr3bRow,
  HsnRow,
  NilExemptRow,
  ReconLine,
  TaxAmounts,
} from '@/lib/reports/exports/gstTypes';
import type { ExportOrder, GstCode, OrderDataset } from '@/lib/reports/exports/types';

// ── Wording shared with the CSVs, the page and the workbook ─────────────────

/** The portal's heading over GSTR-3B Table 3.1. */
export const GSTR3B_TABLE_31_HEADING =
  'Details of Outward Supplies and inward supplies liable to reverse charge (other than those covered by Table 3.1.1)';

/** GSTR-1 Table 8's four rows, as the offline tool words them. */
export const NIL_EXEMPT_DESCRIPTIONS = [
  'Inter-State supplies to registered persons',
  'Intra-State supplies to registered persons',
  'Inter-State supplies to unregistered persons',
  'Intra-State supplies to unregistered persons',
] as const;

/** GSTR-1 Table 13's only nature of document for this café. */
export const DOCS_NATURE = 'Invoices for outward supply';

/**
 * The day the app took over billing from Petpooja (see customerIdentity.ts). Bills
 * before it are in Petpooja, not in this report. There is no shared constant for it.
 */
export const APP_BILLING_FROM = '2026-09-25';

const PAID_LATER = new Set(['unpaid', 'payment_pending']);

// ── Small helpers ───────────────────────────────────────────────────────────

const paise = (inr: number): number => Math.round(inr * 100);
const inr = (p: number): number => p / 100;
const sum = <T>(list: readonly T[], f: (x: T) => number): number => list.reduce((s, x) => s + f(x), 0);

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const parts = (iso: string): [number, number, number] => {
  const [y, m, d] = iso.split('-').map(Number);
  return [y, m, d];
};

/** '2026-10-19' → '19 Oct 2026'. */
export function longDate(iso: string): string {
  const [y, m, d] = parts(iso);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

const RULE_DATE = longDate(GST_NET_OF_DISCOUNT_FROM);

const moneyFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ₹ amount for a sentence: '₹12,345.50'. */
const money = (n: number): string => `₹${moneyFmt.format(n)}`;

const pct = (rate: number): string => `${rate}%`;

function financialYearOf(iso: string): string {
  const [y, m] = parts(iso);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The nth of the month after `iso`'s month, as an ISO date. */
function dayOfNextMonth(iso: string, day: number): string {
  const [y, m] = parts(iso);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function buildPeriod(from: string, to: string): GstPeriod {
  const month = wholeMonthOf(from, to);
  const fyFrom = financialYearOf(from);
  const fyTo = financialYearOf(to);
  let label: string;
  if (month) {
    const [y, m] = parts(from);
    label = `${MONTHS_LONG[m - 1]} ${y}`;
  } else if (from === to) {
    label = longDate(from);
  } else {
    const [fy, fm, fd] = parts(from);
    const [ty, tm, td] = parts(to);
    label =
      fy === ty
        ? `${fd} ${MONTHS_SHORT[fm - 1]} – ${td} ${MONTHS_SHORT[tm - 1]} ${ty}`
        : `${longDate(from)} – ${longDate(to)}`;
  }
  return {
    from,
    to,
    label,
    isWholeMonth: month !== null,
    returnPeriod: month ? `${month.slice(5, 7)}${month.slice(0, 4)}` : null,
    financialYear: fyFrom === fyTo ? fyFrom : `${fyFrom} / ${fyTo}`,
    gstr1DueDate: month ? dayOfNextMonth(to, 11) : null,
    gstr3bDueDate: month ? dayOfNextMonth(to, 20) : null,
  };
}

/** The business block from lib/legal.ts BUSINESS (kept out of this file so it stays free of site constants). */
export function businessFromLegal(b: { legalName: string; name: string; gstin: string; address: string }): GstBusiness {
  const stateCode = b.gstin.slice(0, 2);
  return {
    legalName: b.legalName,
    tradeName: b.name,
    gstin: b.gstin,
    stateCode,
    stateName: PLACE_OF_SUPPLY.startsWith(`${stateCode}-`) ? PLACE_OF_SUPPLY.slice(3) : '',
    address: b.address,
  };
}

const zeroAmounts = (): TaxAmounts => ({ taxableValueInr: 0, igstInr: 0, cgstInr: 0, sgstInr: 0, cessInr: 0 });

// ── One issued or dead bill, in paise ───────────────────────────────────────

interface Calc {
  o: ExportOrder;
  taxableP: number;
  cgstP: number;
  sgstP: number;
  exemptP: number;
  totalP: number;
  /** Σ line totals, voided lines already out. */
  grossP: number;
  coverP: number;
  /** Discount taken off before GST (net_of_discount bills): Σ line base − Σ line value. */
  discBeforeP: number;
  /** Packaging inside the taxable value (its price, GST included when prices include GST). */
  packTaxedP: number;
  /** GST inside the prices of the taxable parts (inclusive pricing only). */
  inclTaxP: number;
  /** Packaging billed with no GST on it (pre_discount bills). */
  packUntaxedP: number;
  /** Discount given after GST was worked out (pre_discount bills). */
  discAfterP: number;
  /** Taxable value less what the first reconciliation's steps explain. */
  resid1P: number;
  /** Bill total less what the second reconciliation's steps explain. */
  resid2P: number;
}

function calcOrder(o: ExportOrder, inclusive: boolean): Calc {
  let grossP = 0;
  let coverP = 0;
  let baseP = 0;
  let valueP = 0;
  let inclTaxP = 0;
  for (const l of o.lines) {
    const lineP = paise(l.lineTotalInr);
    const cv = paise(l.passCoveredInr);
    grossP += lineP;
    coverP += cv;
    baseP += lineP - cv;
    if (l.gstExempt) {
      valueP += paise(l.exemptValueInr);
    } else {
      const tax = paise(l.cgstInr) + paise(l.sgstInr);
      valueP += paise(l.taxableInr) + (inclusive ? tax : 0);
      if (inclusive) inclTaxP += tax;
    }
  }
  const packTax = paise(o.packagingCgstInr) + paise(o.packagingSgstInr);
  const packTaxedP = paise(o.packagingTaxableInr) + (inclusive ? packTax : 0);
  if (inclusive) inclTaxP += packTax;

  const early = o.gstRule === 'pre_discount';
  const taxableP = paise(o.taxableValueInr);
  const cgstP = paise(o.cgstInr);
  const sgstP = paise(o.sgstInr);
  const exemptP = paise(o.exemptValueInr);
  const totalP = paise(o.totalInr);
  const discBeforeP = baseP - valueP;
  const packUntaxedP = early ? Math.max(0, paise(o.packagingInr)) : 0;
  const discAfterP = early ? Math.max(0, paise(o.discountInr)) : 0;
  return {
    o,
    taxableP,
    cgstP,
    sgstP,
    exemptP,
    totalP,
    grossP,
    coverP,
    discBeforeP,
    packTaxedP,
    inclTaxP,
    packUntaxedP,
    discAfterP,
    resid1P: taxableP - (grossP - coverP - discBeforeP - exemptP + packTaxedP - inclTaxP),
    resid2P: totalP - (taxableP + cgstP + sgstP + exemptP + packUntaxedP - discAfterP),
  };
}

// ── Tables ──────────────────────────────────────────────────────────────────

/** What neither a bill's lines nor its packaging carry of its taxable value / tax (only when tax was charged with nothing to hold it). */
function unallocated(o: ExportOrder): { taxableP: number; cgstP: number; sgstP: number } {
  let taxableP = paise(o.taxableValueInr) - paise(o.packagingTaxableInr);
  let cgstP = paise(o.cgstInr) - paise(o.packagingCgstInr);
  let sgstP = paise(o.sgstInr) - paise(o.packagingSgstInr);
  for (const l of o.lines) {
    taxableP -= paise(l.taxableInr);
    cgstP -= paise(l.cgstInr);
    sgstP -= paise(l.sgstInr);
  }
  return { taxableP, cgstP, sgstP };
}

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

function buildHsn(sales: readonly ExportOrder[], rate: number): HsnRow[] {
  const groups = new Map<string, HsnGroup>();
  const group = (code: GstCode, r: number): HsnGroup => {
    const key = `${code.code}|${r}`;
    let g = groups.get(key);
    if (!g) {
      g = { code, rate: r, grams: 0, valueP: 0, taxableP: 0, cgstP: 0, sgstP: 0 };
      groups.set(key, g);
    }
    return g;
  };

  for (const o of sales) {
    for (const l of o.lines) {
      const g = group(l.gstCode, l.gstExempt ? 0 : rate);
      if (l.gstExempt) {
        // Exempt lines: their whole value is the "taxable value" of the rate-0 row.
        g.taxableP += paise(l.exemptValueInr);
        g.valueP += paise(l.exemptValueInr);
      } else {
        g.taxableP += paise(l.taxableInr);
        g.cgstP += paise(l.cgstInr);
        g.sgstP += paise(l.sgstInr);
        g.valueP += paise(l.taxableInr) + paise(l.cgstInr) + paise(l.sgstInr);
      }
      if (l.gstCode.kind === 'goods') g.grams += l.quantity * (l.weightGrams ?? 0);
    }
    // Packaging (taxed from GST_NET_OF_DISCOUNT_FROM) is restaurant service, and so is tax
    // charged with no line to hold it, so Table 12 still ties to Table 7.
    const pack = {
      taxableP: paise(o.packagingTaxableInr),
      cgstP: paise(o.packagingCgstInr),
      sgstP: paise(o.packagingSgstInr),
    };
    for (const part of [pack, unallocated(o)]) {
      if (part.taxableP === 0 && part.cgstP === 0 && part.sgstP === 0) continue;
      const g = group(SAC_RESTAURANT, rate);
      g.taxableP += part.taxableP;
      g.cgstP += part.cgstP;
      g.sgstP += part.sgstP;
      g.valueP += part.taxableP + part.cgstP + part.sgstP;
    }
  }

  return [...groups.values()]
    .filter((g) => g.valueP !== 0 || g.grams !== 0)
    .sort((a, b) => a.code.code.localeCompare(b.code.code) || b.rate - a.rate)
    .map(
      (g): HsnRow => ({
        hsn: g.code.code,
        description: g.code.description,
        uqc: g.code.uqc,
        quantity: g.code.kind === 'goods' ? g.grams / 1000 : 0,
        totalValueInr: inr(g.valueP),
        rate: g.rate,
        taxableValueInr: inr(g.taxableP),
        igstInr: 0,
        cgstInr: inr(g.cgstP),
        sgstInr: inr(g.sgstP),
        cessInr: 0,
        kind: g.code.kind,
      }),
    );
}

function buildDocs(orders: readonly ExportOrder[]): DocsRow[] {
  if (orders.length === 0) return [];
  // The range counts every number from the first to the last, so a gap (an order
  // deleted as a test) shows as cancelled, not as missing.
  let first = orders[0];
  let last = orders[0];
  for (const o of orders) {
    if (o.orderNumber < first.orderNumber) first = o;
    if (o.orderNumber > last.orderNumber) last = o;
  }
  const total = last.orderNumber - first.orderNumber + 1;
  const net = orders.filter((o) => o.valid).length;
  return [
    {
      nature: DOCS_NATURE,
      fromNo: first.invoiceNo,
      toNo: last.invoiceNo,
      totalNumber: total,
      cancelled: total - net,
      netIssued: net,
    },
  ];
}

function paymentModeOf(o: ExportOrder): string {
  if (o.paymentMethods.length > 0) {
    return o.paymentMethods.map((m) => PAYMENT_METHOD_LABEL[m] ?? m).join(' + ');
  }
  return PAID_LATER.has(o.paymentStatus) ? 'Unpaid' : '';
}

function buildInvoiceRegister(orders: readonly ExportOrder[]): GstInvoiceRow[] {
  return [...orders]
    .sort((a, b) => a.orderNumber - b.orderNumber)
    .map(
      (o): GstInvoiceRow => ({
        invoiceNo: o.invoiceNo,
        date: o.date,
        time: o.time,
        status: o.status === 'cancelled' ? 'Cancelled' : o.status === 'rejected' ? 'Rejected' : 'Issued',
        gstBasis: o.gstRule === 'net_of_discount' ? 'After discount' : 'Before discount',
        taxableValueInr: o.taxableValueInr,
        cgstInr: o.cgstInr,
        sgstInr: o.sgstInr,
        exemptValueInr: o.exemptValueInr,
        packagingInr: o.packagingInr,
        discountInr: o.discountInr,
        invoiceValueInr: o.totalInr,
        paymentMode: paymentModeOf(o),
      }),
    );
}

function buildDayRegister(from: string, to: string, orders: readonly ExportOrder[], calcs: ReadonlyMap<string, Calc>): GstDayRow[] {
  const byDay = new Map<string, ExportOrder[]>();
  for (const o of orders) {
    const list = byDay.get(o.date);
    if (list) list.push(o);
    else byDay.set(o.date, [o]);
  }
  // Every day of the range, and (should an order ever fall outside it) its own day too, so the register still adds up.
  const dates = [...new Set([...datesBetween(from, to), ...byDay.keys()])].sort();
  return dates.map((date): GstDayRow => {
    const day = (byDay.get(date) ?? []).sort((a, b) => a.orderNumber - b.orderNumber);
    const issued = day.filter((o) => o.valid);
    const calcOf = (o: ExportOrder) => calcs.get(o.id) as Calc;
    return {
      date,
      firstInvoice: day.length ? day[0].invoiceNo : '',
      lastInvoice: day.length ? day[day.length - 1].invoiceNo : '',
      bills: issued.length,
      cancelled: day.length - issued.length,
      taxableValueInr: inr(sum(issued, (o) => calcOf(o).taxableP)),
      cgstInr: inr(sum(issued, (o) => calcOf(o).cgstP)),
      sgstInr: inr(sum(issued, (o) => calcOf(o).sgstP)),
      exemptValueInr: inr(sum(issued, (o) => calcOf(o).exemptP)),
      invoiceValueInr: inr(sum(issued, (o) => calcOf(o).totalP)),
    };
  });
}

// ── Reconciliations ─────────────────────────────────────────────────────────

/** A signed step: `less` lines are stored negative. */
function line(label: string, kind: ReconLine['kind'], p: number, note?: string): ReconLine {
  const signed = kind === 'less' && p !== 0 ? -p : p;
  return note ? { label, amountInr: inr(signed), kind, note } : { label, amountInr: inr(signed), kind };
}

/** The rounding step, signed by its direction; null when nothing is left over. */
function roundingLine(p: number): ReconLine | null {
  if (p === 0) return null;
  return {
    label: 'Rounding difference',
    amountInr: inr(p),
    kind: p > 0 ? 'add' : 'less',
    note: 'What the bills’ own printed figures leave unexplained by the steps above; small differences are normal.',
  };
}

function buildToTaxableValue(calcs: readonly Calc[], inclusive: boolean, rate: number): ReconLine[] {
  const gross = sum(calcs, (c) => c.grossP);
  const cover = sum(calcs, (c) => c.coverP);
  const disc = sum(calcs, (c) => c.discBeforeP);
  const exempt = sum(calcs, (c) => c.exemptP);
  const packTaxed = sum(calcs, (c) => c.packTaxedP);
  const inclTax = sum(calcs, (c) => c.inclTaxP);
  const taxable = sum(calcs, (c) => c.taxableP);
  const resid = sum(calcs, (c) => c.resid1P);

  const lines: ReconLine[] = [
    line('Gross item sales', 'start', gross, 'Everything on the bills issued, at menu price. Cancelled and rejected bills and removed items are left out.'),
    line(
      'HIOC Ritual cups covered by a pass',
      'less',
      cover,
      'Paid for when the pass was sold, and GST was charged then, so these cups are left out to avoid counting GST twice.',
    ),
    line(
      'Discounts deducted before GST',
      'less',
      disc,
      `Coupons and Beanies on bills from ${RULE_DATE}: GST is worked out after the discount. Earlier bills are on the next sheet.`,
    ),
    line('GST-exempt items', 'less', exempt, 'Menu items marked GST-exempt. They have no GST and are reported on their own (GSTR-1 Table 8).'),
    line('Packaging taxed', 'add', packTaxed, `Takeaway packaging on bills from ${RULE_DATE} is part of the taxable value.`),
  ];
  if (inclusive) {
    lines.push(
      line(
        'GST inside prices',
        'less',
        inclTax,
        `Menu prices include ${pct(rate)} GST, so the tax is taken out of the price to get the taxable value.`,
      ),
    );
  }
  const r = roundingLine(resid);
  if (r) lines.push(r);
  lines.push(line('Taxable value', 'total', taxable, 'GSTR-1 Table 7 and GSTR-3B 3.1(a).'));
  return lines;
}

function buildToInvoiceValue(calcs: readonly Calc[]): ReconLine[] {
  const taxable = sum(calcs, (c) => c.taxableP);
  const cgst = sum(calcs, (c) => c.cgstP);
  const sgst = sum(calcs, (c) => c.sgstP);
  const exempt = sum(calcs, (c) => c.exemptP);
  const packUntaxed = sum(calcs, (c) => c.packUntaxedP);
  const discAfter = sum(calcs, (c) => c.discAfterP);
  const total = sum(calcs, (c) => c.totalP);
  const resid = sum(calcs, (c) => c.resid2P);
  const early = calcs.filter((c) => c.o.gstRule === 'pre_discount');
  const coupon = sum(early, (c) => paise(c.o.couponDiscountInr));
  const beanies = sum(early, (c) => paise(c.o.beaniesDiscountInr));

  const lines: ReconLine[] = [
    line('Taxable value', 'start', taxable, 'From the sheet above.'),
    line('CGST', 'add', cgst, 'Central GST charged on the bills.'),
    line('SGST', 'add', sgst, 'State GST charged on the bills.'),
    line('GST-exempt sales', 'add', exempt, 'Menu items with no GST (GSTR-1 Table 8, GSTR-3B 3.1(c)).'),
    line(
      'Packaging billed without GST',
      'add',
      packUntaxed,
      `Takeaway packaging on bills before ${RULE_DATE}, which was not taxed.`,
    ),
    line(
      'Coupon and Beanies discounts given after GST',
      'less',
      discAfter,
      `On bills before ${RULE_DATE} GST was charged on the price before the discount, so the discount comes off here instead (coupons ${money(inr(coupon))}, Beanies ${money(inr(beanies))}).`,
    ),
  ];
  const r = roundingLine(resid);
  if (r) lines.push(r);
  lines.push(line('Total invoice value of the bills issued', 'total', total, 'The totals printed on the bills, added up.'));
  return lines;
}

// ── Checks ──────────────────────────────────────────────────────────────────

/** A short list of invoice numbers for a sentence: 'A, B, C and 4 more'. */
function listOf(items: readonly string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

const bills = (n: number): string => `${n} ${n === 1 ? 'bill' : 'bills'}`;

function numberingCheck(orders: readonly ExportOrder[]): GstCheck {
  if (orders.length === 0) {
    return { status: 'info', title: 'Invoice numbers', detail: 'There are no bills in this period, so there is no numbering to check.' };
  }
  const have = new Set(orders.map((o) => o.orderNumber));
  let first = Infinity;
  let last = -Infinity;
  for (const n of have) {
    if (n < first) first = n;
    if (n > last) last = n;
  }
  const total = last - first + 1;
  const missing = total - have.size;
  const firstNo = orders.find((o) => o.orderNumber === first)?.invoiceNo ?? '';
  const lastNo = orders.find((o) => o.orderNumber === last)?.invoiceNo ?? '';
  if (missing <= 0) {
    return {
      status: 'ok',
      title: 'No gaps in invoice numbers',
      detail: `${firstNo} to ${lastNo}: all ${total} numbers are accounted for.`,
    };
  }
  const gaps: string[] = [];
  const pad = (n: number) => `HIOC-${String(n).padStart(6, '0')}`;
  for (let n = first; n <= last && gaps.length < 10; n++) if (!have.has(n)) gaps.push(pad(n));
  return {
    status: 'warn',
    title: 'Invoice numbers are missing',
    detail: `${missing} ${missing === 1 ? 'number' : 'numbers'} between ${firstNo} and ${lastNo} ${missing === 1 ? 'has' : 'have'} no bill at all (${listOf(gaps, 10)}${missing > gaps.length ? ` and ${missing - gaps.length} more` : ''}). Table 13 counts ${missing === 1 ? 'it' : 'them'} as cancelled; check ${missing === 1 ? 'it was' : 'none was'} not a real sale.`,
  };
}

// ── The computation ─────────────────────────────────────────────────────────

export interface GstComputeOptions {
  business: GstBusiness;
  now: Date;
}

export function buildGstComputation(ds: OrderDataset, opts: GstComputeOptions): GstComputation {
  const { business } = opts;
  const rate = ds.gstRatePercent;
  const inclusive = ds.gstInclusive;
  const period = buildPeriod(ds.from, ds.to);
  const orders = [...ds.orders].sort((a, b) => a.orderNumber - b.orderNumber);
  const sales = orders.filter((o) => o.valid);
  const dead = orders.filter((o) => !o.valid);

  const calcs = new Map<string, Calc>(orders.map((o) => [o.id, calcOrder(o, inclusive)]));
  const issued = sales.map((o) => calcs.get(o.id) as Calc);

  const taxableP = sum(issued, (c) => c.taxableP);
  const cgstP = sum(issued, (c) => c.cgstP);
  const sgstP = sum(issued, (c) => c.sgstP);
  const exemptP = sum(issued, (c) => c.exemptP);
  const totalP = sum(issued, (c) => c.totalP);

  const counts = {
    issuedBills: sales.length,
    cancelledBills: dead.length,
    afterDiscountBills: sales.filter((o) => o.gstRule === 'net_of_discount').length,
    beforeDiscountBills: sales.filter((o) => o.gstRule === 'pre_discount').length,
  };

  // GSTR-3B Table 3.1 (labels as on the portal)
  const nil = (code: string, label: string, note: string): Gstr3bRow => ({
    code,
    label,
    amounts: zeroAmounts(),
    applies: false,
    note,
  });
  const gstr3b: Gstr3bRow[] = [
    {
      code: '3.1(a)',
      label: 'Outward taxable supplies (other than zero rated, nil rated and exempted)',
      amounts: { taxableValueInr: inr(taxableP), igstInr: 0, cgstInr: inr(cgstP), sgstInr: inr(sgstP), cessInr: 0 },
      applies: true,
      note: `Everything the café charged ${pct(rate)} GST on: the taxable value, CGST and SGST of the bills issued.`,
    },
    nil('3.1(b)', 'Outward taxable supplies (zero rated)', 'Nil: the café does not export or sell to a special economic zone.'),
    {
      code: '3.1(c)',
      label: 'Other outward supplies (Nil rated, exempted)',
      amounts: { ...zeroAmounts(), taxableValueInr: inr(exemptP) },
      applies: true,
      note:
        exemptP > 0
          ? 'Menu items marked GST-exempt: sold with no GST charged.'
          : 'Nil: no GST-exempt items were sold in this period.',
    },
    nil('3.1(d)', 'Inward supplies (liable to reverse charge)', 'Nil: the café has no purchases on which it must pay the GST itself.'),
    nil('3.1(e)', 'Non-GST outward supplies', 'Nil: everything the café sells is inside GST.'),
    nil(
      '3.1.1(i)',
      'Taxable supplies on which electronic commerce operator pays tax under sub-section (5) of section 9',
      'Nil: filled by the app company when it pays the tax itself. Swiggy Dineout and Zomato District bills here are the café’s own dine-in bills.',
    ),
    nil(
      '3.1.1(ii)',
      'Taxable supplies made by the registered person through electronic commerce operator, on which electronic commerce operator is required to pay tax under sub-section (5) of section 9',
      'Nil: for the same reason, the café pays the tax on bills paid through an app.',
    ),
  ];

  // GSTR-1
  const b2cs: B2csRow[] =
    taxableP !== 0 || cgstP !== 0 || sgstP !== 0
      ? [
          {
            type: B2CS_TYPE,
            placeOfSupply: PLACE_OF_SUPPLY,
            applicablePercent: '',
            rate,
            taxableValueInr: inr(taxableP),
            cessInr: 0,
            ecommerceGstin: '',
            cgstInr: inr(cgstP),
            sgstInr: inr(sgstP),
          },
        ]
      : [];
  // Every sale is to a walk-in customer within the state: the exempt value sits in the last row.
  const nilExempt: NilExemptRow[] = NIL_EXEMPT_DESCRIPTIONS.map((description, i) => ({
    description,
    nilRatedInr: 0,
    exemptedInr: i === 3 ? inr(exemptP) : 0,
    nonGstInr: 0,
  }));
  const hsn = buildHsn(sales, rate);
  const docs = buildDocs(orders);

  const toTaxableValue = buildToTaxableValue(issued, inclusive, rate);
  const toInvoiceValue = buildToInvoiceValue(issued);
  const dayRegister = buildDayRegister(ds.from, ds.to, orders, calcs);
  const invoiceRegister = buildInvoiceRegister(orders);

  // ── Checks ──
  const checks: GstCheck[] = [];

  // GSTR-3B 3.1(a) = GSTR-1 Table 7
  {
    const row = gstr3b[0].amounts;
    const t7Taxable = sum(b2cs, (r) => paise(r.taxableValueInr));
    const t7Cgst = sum(b2cs, (r) => paise(r.cgstInr));
    const t7Sgst = sum(b2cs, (r) => paise(r.sgstInr));
    const same =
      paise(row.taxableValueInr) === t7Taxable && paise(row.cgstInr) === t7Cgst && paise(row.sgstInr) === t7Sgst;
    checks.push(
      same
        ? {
            status: 'ok',
            title: 'GSTR-3B 3.1(a) equals GSTR-1 Table 7',
            detail: `Both show ${money(row.taxableValueInr)} taxable value with ${money(row.cgstInr)} CGST and ${money(row.sgstInr)} SGST.`,
          }
        : {
            status: 'warn',
            title: 'GSTR-3B 3.1(a) does not match GSTR-1 Table 7',
            detail: `3.1(a) shows ${money(row.taxableValueInr)} taxable value but Table 7 shows ${money(inr(t7Taxable))}. Do not file until this is looked at.`,
          },
    );
  }

  // GSTR-1 Table 12 = Table 7 + Table 8
  {
    const t12Taxable = sum(hsn, (r) => paise(r.taxableValueInr));
    const t12Tax = sum(hsn, (r) => paise(r.cgstInr) + paise(r.sgstInr));
    const t7 = sum(b2cs, (r) => paise(r.taxableValueInr));
    const t8 = sum(nilExempt, (r) => paise(r.nilRatedInr) + paise(r.exemptedInr) + paise(r.nonGstInr));
    const t7Tax = sum(b2cs, (r) => paise(r.cgstInr) + paise(r.sgstInr));
    if (t12Taxable === t7 + t8 && t12Tax === t7Tax) {
      checks.push({
        status: 'ok',
        title: 'GSTR-1 Table 12 equals Table 7 plus Table 8',
        detail: `${money(inr(t12Taxable))} taxable value = ${money(inr(t7))} (Table 7) + ${money(inr(t8))} (Table 8), and the GST in Table 12 equals Table 7’s.`,
      });
    } else {
      checks.push({
        status: 'warn',
        title: 'GSTR-1 Table 12 does not match Tables 7 and 8',
        detail: `Table 12 shows ${money(inr(t12Taxable))} taxable value but Tables 7 and 8 add up to ${money(inr(t7 + t8))}. Do not file until this is looked at.`,
      });
    }
  }

  // GSTR-1 Table 13: total − cancelled = bills issued
  {
    const d = docs[0];
    if (!d) {
      checks.push({ status: 'info', title: 'GSTR-1 Table 13', detail: 'There are no bills in this period, so there are no documents to list.' });
    } else if (d.totalNumber - d.cancelled === counts.issuedBills && d.netIssued === counts.issuedBills) {
      checks.push({
        status: 'ok',
        title: 'GSTR-1 Table 13: total minus cancelled equals bills issued',
        detail: `${d.totalNumber} numbers − ${d.cancelled} cancelled = ${counts.issuedBills} ${counts.issuedBills === 1 ? 'bill' : 'bills'} issued.`,
      });
    } else {
      checks.push({
        status: 'warn',
        title: 'GSTR-1 Table 13 does not match the bills issued',
        detail: `Table 13 gives ${d.totalNumber - d.cancelled} issued but ${bills(counts.issuedBills)} were issued.`,
      });
    }
  }

  // The day-wise register adds up to the month
  {
    const dayTaxable = sum(dayRegister, (d) => paise(d.taxableValueInr));
    const dayTax = sum(dayRegister, (d) => paise(d.cgstInr) + paise(d.sgstInr));
    const dayExempt = sum(dayRegister, (d) => paise(d.exemptValueInr));
    const dayValue = sum(dayRegister, (d) => paise(d.invoiceValueInr));
    const dayBills = sum(dayRegister, (d) => d.bills);
    if (
      dayTaxable === taxableP &&
      dayTax === cgstP + sgstP &&
      dayExempt === exemptP &&
      dayValue === totalP &&
      dayBills === counts.issuedBills
    ) {
      checks.push({
        status: 'ok',
        title: 'Day-wise register adds up to the period',
        detail: `The ${dayRegister.length} days add up to the same ${money(inr(taxableP))} taxable value and ${money(inr(totalP))} invoice value.`,
      });
    } else {
      checks.push({
        status: 'warn',
        title: 'Day-wise register does not add up to the period',
        detail: `The days add up to ${money(inr(dayValue))} invoice value but the period total is ${money(inr(totalP))}.`,
      });
    }
  }

  // GST = rate × taxable value, within 50 paise a bill (a paisa of slack for the share-out; a little more when prices include GST)
  {
    const tolerance = 50 * (inclusive ? 1 + rate / 100 : 1) + 1;
    const off = issued.filter((c) => Math.abs(c.cgstP + c.sgstP - (c.taxableP * rate) / 100) > tolerance);
    if (off.length === 0) {
      checks.push({
        status: 'ok',
        title: `GST is ${pct(rate)} of the taxable value`,
        detail: `On every bill the GST is within 50 paise of ${pct(rate)} of its taxable value (the app rounds each bill’s GST to a whole rupee).`,
      });
    } else {
      const first = off[0];
      checks.push({
        status: 'warn',
        title: `GST is not ${pct(rate)} of the taxable value on ${bills(off.length)}`,
        detail: `${listOf(
          off.map((c) => c.o.invoiceNo),
          5,
        )}: for example ${first.o.invoiceNo} charged ${money(inr(first.cgstP + first.sgstP))} where ${pct(rate)} would be ${money(inr((first.taxableP * rate) / 100))}. Look them up in the invoice register.`,
      });
    }
  }

  // The two reconciliations
  {
    const resid1 = sum(issued, (c) => c.resid1P);
    const resid2 = sum(issued, (c) => c.resid2P);
    const big = issued.filter((c) => Math.abs(c.resid1P) > 100 || Math.abs(c.resid2P) > 100);
    if (big.length > 0) {
      checks.push({
        status: 'warn',
        title: `Totals do not add up on ${bills(big.length)}`,
        detail: `The printed total differs from its parts by more than ₹1 on ${listOf(
          big.map((c) => c.o.invoiceNo),
          5,
        )}; the difference is in the “Rounding difference” lines.`,
      });
    } else if (resid1 !== 0 || resid2 !== 0) {
      checks.push({
        status: 'info',
        title: 'Small rounding differences',
        detail: `The rounding lines hold ${money(inr(resid1))} (sales to taxable value) and ${money(inr(resid2))} (taxable value to bill totals) across ${bills(counts.issuedBills)}, under ₹1 a bill.`,
      });
    } else {
      checks.push({
        status: 'ok',
        title: 'Sales tie to taxable value and bill totals',
        detail: 'Both reconciliations add up exactly, with no rounding lines.',
      });
    }
  }

  // Invoice numbering
  checks.push(numberingCheck(orders));

  // Cancelled / rejected
  {
    const cancelled = dead.filter((o) => o.status === 'cancelled').length;
    const rejected = dead.length - cancelled;
    checks.push(
      dead.length === 0
        ? { status: 'ok', title: 'No cancelled bills', detail: 'No bill was cancelled or rejected in this period.' }
        : {
            status: 'info',
            title: `${bills(dead.length)} cancelled or rejected`,
            detail: `${[cancelled > 0 ? `${cancelled} cancelled` : '', rejected > 0 ? `${rejected} rejected` : ''].filter(Boolean).join(' and ')}: left out of every figure, but ${dead.length === 1 ? 'its invoice number is' : 'their invoice numbers are'} used, so Table 13 counts ${dead.length === 1 ? 'it' : 'them'} as cancelled.`,
          },
    );
  }

  // Unpaid bills (counted as sales)
  {
    const unpaid = sales.filter((o) => PAID_LATER.has(o.paymentStatus));
    checks.push(
      unpaid.length === 0
        ? { status: 'ok', title: 'Every bill is marked paid', detail: 'No issued bill is waiting for payment.' }
        : {
            status: 'warn',
            title: `${bills(unpaid.length)} not marked paid`,
            detail: `${listOf(
              unpaid.map((o) => o.invoiceNo),
              5,
            )}, worth ${money(inr(sum(unpaid, (o) => paise(o.totalInr))))} in all. They are counted as sales because GST is due when the bill is issued; if one was never paid, ask your CA whether to cancel it.`,
          },
    );
  }

  // Refunds without credit notes
  {
    const processed = ds.refunds.filter((r) => r.status === 'processed');
    const earlier = processed.filter((r) => r.orderDate !== '' && r.orderDate < ds.from).length;
    const amount = sum(processed, (r) => paise(r.amountInr));
    checks.push(
      processed.length === 0
        ? { status: 'ok', title: 'No refunds', detail: 'No refund was processed in this period.' }
        : {
            status: 'warn',
            title: `${processed.length} ${processed.length === 1 ? 'refund' : 'refunds'} without a credit note`,
            detail: `${money(inr(amount))} was refunded${earlier > 0 ? ` (${earlier} on bills from earlier months)` : ''}. The app issues no credit notes, so the GST on those bills stays in the figures above; ask your CA whether to adjust it.`,
          },
    );
  }

  // Mixed GST basis
  if (counts.afterDiscountBills > 0 && counts.beforeDiscountBills > 0) {
    checks.push({
      status: 'info',
      title: 'Two GST bases in this period',
      detail: `${bills(counts.beforeDiscountBills)} before ${RULE_DATE} charged GST before discounts with packaging untaxed; ${bills(counts.afterDiscountBills)} from that date charge it after discounts and on packaging. Each is reported as charged.`,
    });
  }

  if (inclusive) {
    checks.push({
      status: 'info',
      title: 'Prices include GST',
      detail: `Menu prices include ${pct(rate)} GST, so each bill’s taxable value is its price less the GST.`,
    });
  }

  // Tips and settle discounts: outside the supply
  {
    const tips = sum(sales, (o) => paise(o.tipInr));
    const settle = sum(sales, (o) => paise(o.settleDiscountInr));
    if (tips > 0 || settle > 0) {
      checks.push({
        status: 'info',
        title: 'Tips and counter discounts',
        detail: `${money(inr(tips))} in tips (not part of any sale) and ${money(inr(settle))} of discounts given when bills were settled; neither changes the GST charged.`,
      });
    }
  }

  // Period before the app took over billing
  if (ds.from < APP_BILLING_FROM) {
    checks.push({
      status: 'warn',
      title: 'Bills from before the app are not here',
      detail:
        ds.to < APP_BILLING_FROM
          ? `The app took over billing on ${longDate(APP_BILLING_FROM)}; bills before it were rung up in Petpooja, so take this period from Petpooja’s GST report.`
          : `The app took over billing on ${longDate(APP_BILLING_FROM)}; bills before it were rung up in Petpooja and are not in this report.`,
    });
  }

  const severity = { warn: 0, info: 1, ok: 2 } as const;
  checks.sort((a, b) => severity[a.status] - severity[b.status]);

  // ── Notes for the CA ──
  const notes: string[] = [];
  notes.push(
    period.isWholeMonth && period.gstr1DueDate && period.gstr3bDueDate
      ? `Monthly filer: GSTR-1 by the 11th (${longDate(period.gstr1DueDate)}), GSTR-3B and payment by the 20th (${longDate(period.gstr3bDueDate)}). If you are on QRMP (turnover up to ₹5 Cr): GSTR-1 by the 13th after the quarter, GSTR-3B by the 24th (Uttar Pradesh), and PMT-06 by the 25th for the first two months.`
      : 'Monthly filer: GSTR-1 by the 11th, GSTR-3B and payment by the 20th. If you are on QRMP (turnover up to ₹5 Cr): GSTR-1 by the 13th after the quarter, GSTR-3B by the 24th (Uttar Pradesh), and PMT-06 by the 25th for the first two months. This period is not a whole month, so file from a whole-month report.',
  );
  notes.push('Since July 2025 GSTR-3B Table 3.1 is filled from GSTR-1 and locked — file GSTR-1 first; correct mistakes through GSTR-1A.');
  notes.push(`Restaurant service at ${pct(rate)} is taken without input tax credit, so the whole GST is paid in cash (GSTR-3B Table 6.1).`);
  if (exemptP > 0) {
    notes.push('GST-exempt menu items are shown as Exempted in Table 8 — confirm whether any are nil-rated instead.');
    notes.push('Whether exempt items need a Table 12 row is not settled — they are shown at rate 0.');
    notes.push(
      'If the portal rejects GSTR-1 because Table 12 B2B is empty while Table 8 has values, add a zero dummy row in Table 12 B2B (GSTN advisory, June 2025).',
    );
  }
  notes.push(
    `Every sale is to a walk-in customer (no customer GSTINs are captured) within ${business.stateName || 'the state'}: all of it is in Table 7 as CGST + SGST, with no B2B and nothing for Table 3.2.`,
  );
  notes.push('Bills paid through an app (Swiggy Dineout, Zomato District, UPI apps) are the café’s own bills, so the café reports and pays that GST itself.');
  notes.push('HIOC Ritual passes: GST is charged when the pass is sold; cups drunk later on a pass are left out so the GST is not counted twice.');
  notes.push('Refunds do not change the GST on the original bill and the app issues no credit notes.');
  notes.push(
    `GST basis: from ${RULE_DATE} bills charge GST after coupon and Beanies discounts and on takeaway packaging; earlier bills charged it before discounts with packaging untaxed (this period: ${bills(counts.afterDiscountBills)} on the new basis, ${bills(counts.beforeDiscountBills)} on the earlier one).`,
  );
  notes.push('Figures are the GST as charged on each bill (rounded to a whole rupee per bill) and shared out over items for the code table, not recomputed.');

  const stateName = business.stateName || 'the state';
  const half = rate / 2;
  const glossary = [
    { term: 'Taxable value', meaning: 'The sale price GST is charged on (after discounts, before GST).' },
    {
      term: 'CGST / SGST',
      meaning: `The two halves of the ${pct(rate)} GST: ${pct(half)} to the Centre, ${pct(half)} to ${stateName}.`,
    },
    { term: 'IGST', meaning: 'GST on sales to another state (none here).' },
    { term: 'GSTR-1', meaning: 'The monthly return of what you sold.' },
    { term: 'GSTR-3B', meaning: 'The monthly summary of tax you pay; it must agree with GSTR-1.' },
    { term: 'B2CS', meaning: 'All walk-in customer sales, totalled by state and rate; no customer names needed.' },
    {
      term: 'HSN / SAC',
      meaning: `The government’s code for goods (HSN) or services (SAC): café service ${SAC_RESTAURANT.code}, roasted coffee beans ${HSN_COFFEE_BEANS.code}.`,
    },
    { term: 'Nil rated / exempt', meaning: 'Sales with no GST; still reported.' },
    {
      term: 'Documents issued',
      meaning: 'First and last bill number, how many bills were made and how many were cancelled.',
    },
    {
      term: 'Input tax credit',
      meaning: `GST paid on purchases that can be set off; restaurants at ${pct(rate)} can’t take it.`,
    },
  ];

  return {
    business,
    period,
    ratePercent: rate,
    pricesIncludeGst: inclusive,
    taxPayable: {
      igstInr: 0,
      cgstInr: inr(cgstP),
      sgstInr: inr(sgstP),
      cessInr: 0,
      totalInr: inr(cgstP + sgstP),
    },
    gstr3b,
    gstr1: { b2cs, nilExempt, hsn, docs },
    toTaxableValue,
    toInvoiceValue,
    dayRegister,
    invoiceRegister,
    checks,
    notes,
    glossary,
    counts,
    generatedAt: opts.now.toISOString(),
  };
}
