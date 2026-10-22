import type { ParsedSettlement, SettlementDeduction, SettlementOrder, Sheets, DeductionKind } from './types';

// Parses a Zomato "Settlement Report" workbook (the weekly/monthly payout
// annexure Zomato emails to the restaurant) into orders + deductions.
//
// Layout, as of the 2026 reports (Zomato_Settlement_Report_<resid>_<from>_<to>.xlsx):
//   Order Level                   a title block, a row of "(1) (2) …" column
//                                 numbers, the header row (S.No., Order ID,
//                                 Order Date, …, Order level Payout, Settlement
//                                 status, Settlement date, Bank UTR, …), a
//                                 '#REF!' row, then one row per order.
//   Addition Deductions Details   section labels ('A) Investments in growth
//                                 services', 'B) …Hyperpure', 'C) Other
//                                 deductions', 'D) Adjustments from previous
//                                 weeks', and 'Addition Type' above them), each
//                                 with its own 'Type' header row, then rows, then
//                                 a 'Total …' row.
//   HSummary                      one data row: period ('01 Apr 2026 - 30 Apr
//                                 2026'), Res ID, …, owner name, address, PAN,
//                                 GSTIN — only the period and Res ID are read.
//   Payout Breakup / Discounts    formula sheets whose cached values come out
//   Summary                       as 0 / #REF! — ignored; everything is summed
//                                 from Order Level instead.
//
// Columns are found by their header TEXT (first line, trimmed, lower-cased),
// never by position: Zomato has added columns before (Brand pack fee, Express
// Order Fee), and a positional parser would silently shift every number.

const ORDER_SHEET = 'Order Level';
const DEDUCTION_SHEET = 'Addition Deductions Details';
const SUMMARY_SHEET = 'HSummary';

export function isZomatoSettlement(sheets: Sheets): boolean {
  return ORDER_SHEET in sheets && findHeaderRow(sheets[ORDER_SHEET]) >= 0;
}

/** First line of a header cell, trimmed, lower-cased, spaces collapsed. */
export function headerKey(cell: unknown): string {
  return String(cell ?? '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// field → how its header reads. `exact` must equal the header key; `prefix`
// must start it (for headers Zomato words differently between versions).
type Matcher = { exact?: string; prefix?: string };
const COLUMNS = {
  orderId: { exact: 'order id' },
  orderDate: { exact: 'order date' },
  resId: { exact: 'res. id' },
  offer: { exact: 'discount construct' },
  paymentMode: { exact: 'mode of payment' },
  status: { prefix: 'order status' },
  refundPolicy: { prefix: 'cancellation policy' },
  cancelReason: { prefix: 'cancellation/ rejection reason' },
  cancelStage: { prefix: 'cancelled/ rejected state' },
  orderType: { exact: 'order type' },
  subtotal: { prefix: 'subtotal' },
  packaging: { exact: 'packaging charge' },
  promoDiscount: { prefix: 'restaurant discount [promo' },
  otherDiscount: { prefix: 'restaurant discount [' }, // [BOGO, Freebies, …] — checked after promo
  deliveryDiscount: { prefix: 'delivery charge discount' },
  gstFromCustomer: { prefix: 'total gst collected from customers' },
  netOrderValue: { prefix: 'net order value' },
  commissionPct: { prefix: 'service fees %' },
  commission: { exact: 'service fee' },
  paymentFee: { exact: 'payment mechanism fee' },
  gstOnFees: { prefix: 'taxes on service' },
  tcs: { exact: 'tax collected at source' },
  tcsIgst: { prefix: 'tcs igst' },
  tds: { prefix: 'tds 194o' },
  gstPaidByPlatform: { prefix: 'gst paid by zomato' },
  gstDueByRestaurant: { prefix: 'gst to be paid by restaurant' },
  otherDeductions: { prefix: 'other order-level deductions' },
  additions: { prefix: 'net additions' },
  payout: { prefix: 'order level payout' },
  settlementStatus: { exact: 'settlement status' },
  settlementDate: { exact: 'settlement date' },
  utr: { exact: 'bank utr' },
  unsettled: { exact: 'unsettled amount' },
  customerId: { exact: 'customer id' },
} satisfies Record<string, Matcher>;
type Field = keyof typeof COLUMNS;

const REQUIRED: Field[] = ['orderId', 'orderDate', 'status', 'subtotal', 'payout'];

function findHeaderRow(rows: unknown[][]): number {
  return rows.findIndex((r) => {
    const keys = r.map(headerKey);
    return keys.includes('order id') && keys.includes('order date');
  });
}

export function mapColumns(header: unknown[]): Partial<Record<Field, number>> {
  const keys = header.map(headerKey);
  const out: Partial<Record<Field, number>> = {};
  const taken = new Set<number>();
  for (const [field, m] of Object.entries(COLUMNS) as [Field, Matcher][]) {
    const idx = keys.findIndex(
      (k, i) => !taken.has(i) && k !== '' && (m.exact ? k === m.exact : k.startsWith(m.prefix as string)),
    );
    if (idx >= 0) {
      out[field] = idx;
      taken.add(idx);
    }
  }
  return out;
}

/** A report number: numbers as-is; '1,234.50', '₹ 20' parsed; 'NA', '', '-' and junk → 0. */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  const n = Number(v.replace(/[₹,\s%]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s.toUpperCase() === 'NA' ? '' : s;
}

const STATUS: Record<string, string> = {
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  TIMEDOUT: 'timed_out',
  'TIMED OUT': 'timed_out',
};

export function normalizeStatus(v: unknown): string {
  const s = text(v).toUpperCase();
  return STATUS[s] ?? s.toLowerCase().replace(/\s+/g, '_');
}

/** '2026-04-01 11:05:31' (IST wall clock) → '2026-04-01T11:05:31+05:30'; null if unreadable. */
export function istTimestamp(v: unknown): string | null {
  const m = text(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+05:30`;
}

function isoDate(v: unknown): string | null {
  const m = text(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** '01 April 26' / '01 Apr 2026' → '2026-04-01'; null if unreadable. */
export function dayMonthYear(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2}|\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${year}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** 'A - B' with both ends in dayMonthYear form → [start, end]; nulls if unreadable. */
export function dateRange(s: string): [string | null, string | null] {
  const parts = s.split(/\s+-\s+/);
  if (parts.length !== 2) return [null, null];
  return [dayMonthYear(parts[0]), dayMonthYear(parts[1])];
}

function parseOrders(rows: unknown[][], warnings: string[]): { orders: SettlementOrder[]; resId: string | null } {
  const h = findHeaderRow(rows);
  if (h < 0) {
    warnings.push(`"${ORDER_SHEET}" has no header row with Order ID and Order Date`);
    return { orders: [], resId: null };
  }
  const col = mapColumns(rows[h]);
  const missing = REQUIRED.filter((f) => col[f] === undefined);
  if (missing.length) {
    warnings.push(`"${ORDER_SHEET}" is missing columns: ${missing.join(', ')}`);
    return { orders: [], resId: null };
  }
  const cell = (r: unknown[], f: Field) => (col[f] === undefined ? null : r[col[f] as number]);

  const orders: SettlementOrder[] = [];
  let resId: string | null = null;
  let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const orderId = text(cell(r, 'orderId'));
    // The '#REF!' filler row under the header and blank rows are not orders;
    // a real id is digits. Anything else in the column is worth a warning.
    if (!/^\d{4,}$/.test(orderId)) {
      if (orderId && !orderId.startsWith('#')) skipped++;
      continue;
    }
    const orderedAt = istTimestamp(cell(r, 'orderDate'));
    if (!orderedAt) {
      skipped++;
      continue;
    }
    resId ??= text(cell(r, 'resId')) || null;
    const pct = cell(r, 'commissionPct');
    orders.push({
      orderId,
      orderedAt,
      status: normalizeStatus(cell(r, 'status')),
      orderType: text(cell(r, 'orderType')),
      offer: text(cell(r, 'offer')),
      paymentMode: text(cell(r, 'paymentMode')),
      cancelReason: text(cell(r, 'cancelReason')),
      cancelStage: text(cell(r, 'cancelStage')),
      refundPolicy: text(cell(r, 'refundPolicy')),
      menuSales: num(cell(r, 'subtotal')),
      packaging: num(cell(r, 'packaging')),
      discount: num(cell(r, 'promoDiscount')) + num(cell(r, 'otherDiscount')) + num(cell(r, 'deliveryDiscount')),
      gstFromCustomer: num(cell(r, 'gstFromCustomer')),
      netOrderValue: num(cell(r, 'netOrderValue')),
      commissionPct: pct === null || pct === undefined || text(pct) === '' ? null : num(pct),
      commission: num(cell(r, 'commission')),
      paymentFee: num(cell(r, 'paymentFee')),
      gstOnFees: num(cell(r, 'gstOnFees')),
      tcs: num(cell(r, 'tcs')) + num(cell(r, 'tcsIgst')),
      tds: num(cell(r, 'tds')),
      gstPaidByPlatform: num(cell(r, 'gstPaidByPlatform')),
      gstDueByRestaurant: num(cell(r, 'gstDueByRestaurant')),
      otherDeductions: num(cell(r, 'otherDeductions')),
      additions: num(cell(r, 'additions')),
      payout: num(cell(r, 'payout')),
      settlementStatus: text(cell(r, 'settlementStatus')).toLowerCase(),
      settlementDate: isoDate(cell(r, 'settlementDate')),
      utr: text(cell(r, 'utr')),
      unsettled: num(cell(r, 'unsettled')),
      customerRef: text(cell(r, 'customerId')) || null,
    });
  }
  if (skipped) warnings.push(`${skipped} order row(s) skipped: unreadable order id or date`);
  return { orders, resId };
}

const SECTION_KIND: [RegExp, DeductionKind][] = [
  [/^a\)/i, 'other'], // growth services: refined per row below (ADS → 'ads')
  [/^b\)/i, 'hyperpure'],
  [/^c\)/i, 'other'],
  [/^d\)/i, 'adjustment'],
];

function parseDeductions(rows: unknown[][]): SettlementDeduction[] {
  const out: SettlementDeduction[] = [];
  let section: DeductionKind | null = null;
  let cols: { type: number; ref: number; period: number; status: number; total: number; settled: number; outstanding: number } | null = null;

  for (const r of rows) {
    const cells = r.map((c) => text(c));
    const firstIdx = cells.findIndex((c) => c !== '');
    if (firstIdx < 0) continue;
    const first = cells[firstIdx];

    if (/^addition type$/i.test(first)) {
      section = 'addition';
      cols = null;
      continue;
    }
    const sec = SECTION_KIND.find(([re]) => re.test(first));
    if (sec) {
      section = sec[1];
      cols = null;
      continue;
    }
    if (/^type$/i.test(first)) {
      // e.g. Type | Res id … | Invoice No/Campaign id | Deduction time period | Settlement Status | Total amount | Adjusted amount | Outstanding amount
      const at = (re: RegExp) => cells.findIndex((c, i) => i > firstIdx && re.test(c));
      cols = {
        type: firstIdx,
        ref: at(/invoice|campaign|order ?id/i),
        period: at(/time period|order date/i),
        status: at(/settlement status/i),
        total: at(/^total amount/i),
        settled: at(/^adjusted amount/i),
        outstanding: at(/^outstanding amount/i),
      };
      continue;
    }
    if (!section || !cols || /^total/i.test(first) || cols.total < 0) continue;
    const label = cells[cols.type];
    if (!label) continue;
    const amountCell = r[cols.total];
    if (typeof amountCell !== 'number' && !/^-?[\d,.]+$/.test(text(amountCell))) continue;
    const periodText = cols.period >= 0 ? cells[cols.period] : '';
    const [periodStart, periodEnd] = dateRange(periodText);
    const kind: DeductionKind = section === 'other' && /^ads?$/i.test(label) ? 'ads' : section;
    out.push({
      kind,
      label,
      ref: cols.ref >= 0 ? cells[cols.ref] : '',
      periodText,
      periodStart,
      periodEnd,
      settlementStatus: cols.status >= 0 ? cells[cols.status].toLowerCase() : '',
      amount: num(amountCell),
      settled: cols.settled >= 0 ? num(r[cols.settled]) : 0,
      outstanding: cols.outstanding >= 0 ? num(r[cols.outstanding]) : 0,
    });
  }
  return out;
}

/** Period and Res ID from HSummary, falling back to the file name's dates. */
function parsePeriod(sheets: Sheets, fileName: string): { start: string | null; end: string | null; resId: string | null } {
  for (const r of sheets[SUMMARY_SHEET] ?? []) {
    const cells = r.map((c) => text(c));
    const i = cells.findIndex((c) => /^\d{1,2} [A-Za-z]{3,9} \d{4} - \d{1,2} [A-Za-z]{3,9} \d{4}$/.test(c));
    if (i >= 0) {
      const [start, end] = dateRange(cells[i]);
      return { start, end, resId: cells[i + 1] || null };
    }
  }
  // Zomato_Settlement_Report_20788341_01_Apr_2026_30_Apr_2026.xlsx
  const m = fileName.match(/_(\d+)_(\d{1,2})_([A-Za-z]{3})_(\d{4})_(\d{1,2})_([A-Za-z]{3})_(\d{4})/);
  if (m) {
    return {
      start: dayMonthYear(`${m[2]} ${m[3]} ${m[4]}`),
      end: dayMonthYear(`${m[5]} ${m[6]} ${m[7]}`),
      resId: m[1],
    };
  }
  return { start: null, end: null, resId: null };
}

export function parseZomatoSettlement(sheets: Sheets, fileName: string): ParsedSettlement {
  const warnings: string[] = [];
  const { orders, resId } = parseOrders(sheets[ORDER_SHEET] ?? [], warnings);
  const deductions = parseDeductions(sheets[DEDUCTION_SHEET] ?? []);
  if (!(DEDUCTION_SHEET in sheets)) warnings.push(`"${DEDUCTION_SHEET}" sheet not found: ads and other deductions not read`);
  const period = parsePeriod(sheets, fileName);
  return {
    platform: 'zomato',
    restaurantRef: period.resId ?? resId,
    periodStart: period.start,
    periodEnd: period.end,
    orders,
    deductions,
    warnings,
  };
}
