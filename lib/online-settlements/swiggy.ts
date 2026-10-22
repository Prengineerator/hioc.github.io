import type { DeductionKind, ParsedSettlement, SettlementDeduction, SettlementOrder, Sheets } from './types';
import { MONTHS, headerKey, istTimestamp, mapColumns, normalizeStatus, num, text, type Matcher } from './common';

// Parses a Swiggy weekly payout "Annexure" workbook (the .xlsx Swiggy emails
// the restaurant each week, invoice_Annexure_<rest id>_<DDMMYYYY>_<stamp>.xlsx
// — the date is the order settlement date) into orders + deductions.
//
// Layout, as of the Oct 2026 reports:
//   Summary                       the restaurant block ('Rest. ID - 123456'),
//                                 then 'Your Payout Details' as label | value
//                                 rows: Payout Period ('04 October - 10
//                                 October': day and month, NO year), Payout
//                                 Settlement Date, Total Payout ('₹1234.50  '),
//                                 Total Orders, Bank UTR.
//   Payout Breakup                week totals only — ignored; everything is
//                                 summed from Order Level instead.
//   Order Level                   a title row, a '(1) (2) (3a) …' numbering row,
//                                 the header row, then one row per order. Header
//                                 cells carry line breaks and trailing spaces,
//                                 money is a number or text ('  12', '24.0%'),
//                                 Order Date is 'YYYY-MM-DD HH:MM:SS' (IST) and
//                                 Order Settlement Date 'DD-MM-YYYY'. There is no
//                                 customer id and no UTR here (the UTR is the
//                                 Summary's, one per weekly transfer).
//   Unresolved Customer Complaints  orders held back by a complaint — not read;
//                                 they arrive in a later week's Order Level.
//   Growth Investments and Other De…  (Excel cuts the name at 31 characters)
//                                 four tables, each a title row ('Adjustments
//                                 this week', 'Adjustments from previous week',
//                                 'Investments this week', 'Investments from
//                                 previous week') and a header row starting
//                                 'Adjustment Type'. The first is often empty.
//                                 A 'Recovery Details' table follows; it is not read.
//   Discount Summary / Glossary   ignored.
//
// Columns are found by their header TEXT (first line, trimmed, lower-cased),
// never by position, as in zomato.ts.

const ORDER_SHEET = 'Order Level';
const SUMMARY_SHEET = 'Summary';
const DEDUCTION_SHEET_PREFIX = 'growth investments';

// The column only Swiggy's Order Level has (Zomato's is 'Order level Payout').
const PAYOUT_HEADER = 'net payout for order';

/** The Order Level table has Swiggy's Order ID and Net Payout for Order columns. */
export function isSwiggySettlement(sheets: Sheets): boolean {
  return ORDER_SHEET in sheets && findHeaderRow(sheets[ORDER_SHEET]) >= 0;
}

const COLUMNS = {
  orderId: { exact: 'order id' },
  orderDate: { exact: 'order date' },
  settlementDate: { exact: 'order settlement date' },
  status: { exact: 'order status' },
  orderType: { exact: 'order category' },
  paymentMode: { exact: 'order payment type' },
  cancelledBy: { prefix: 'cancelled by' },
  offer: { prefix: 'coupon type applied' },
  itemTotal: { exact: 'item total' },
  packaging: { exact: 'packaging charges' },
  discountShare: { prefix: 'restaurant discount share' },
  gstCollected: { exact: 'gst collected' },
  customerPaid: { prefix: 'total customer paid' },
  commissionPct: { prefix: 'service fees %' },
  paymentFee: { prefix: 'payment collection charges' },
  gstOnFees: { prefix: 'gst on service fee' },
  totalFees: { prefix: 'total swiggy fees' },
  complaintCharges: { prefix: 'complaint & cancellation charges' },
  gstDeduction: { prefix: 'gst deduction' },
  tcs: { exact: 'tcs' },
  tds: { exact: 'tds' },
  payout: { prefix: PAYOUT_HEADER },
} satisfies Record<string, Matcher>;
type Field = keyof typeof COLUMNS;

// Without the fee total the commission would come out wrong, so it is required too.
const REQUIRED: Field[] = ['orderId', 'orderDate', 'status', 'itemTotal', 'totalFees', 'payout'];

function findHeaderRow(rows: unknown[][]): number {
  return rows.findIndex((r) => {
    const keys = r.map(headerKey);
    return keys.includes('order id') && keys.some((k) => k.startsWith(PAYOUT_HEADER));
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const two = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for a real calendar date (month 0-based); null for 31 Feb and the like. */
function isoDay(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return `${year}-${two(month + 1)}-${two(day)}`;
}

/** The year that puts month/day nearest the `near` day: a report is read days after its period, so that is the period's own year, New Year included. */
function nearestYear(month: number, day: number, near: string): number {
  const base = Number(near.slice(0, 4));
  const nearMs = Date.parse(`${near}T00:00:00Z`);
  let best = base;
  let bestGap = Infinity;
  for (const y of [base - 1, base, base + 1]) {
    const gap = Math.abs(Date.UTC(y, month, day) - nearMs);
    if (gap < bestGap) {
      best = y;
      bestGap = gap;
    }
  }
  return best;
}

interface DayMonth {
  day: number;
  month: number; // 0-based
  year: number | null;
}

/** '04 October' / '04 Oct 26' / '4 October 2026'; the year is null when the text has none. */
function dayMonth(s: string): DayMonth | null {
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}|\d{2}))?$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const year = m[3] === undefined ? null : m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return { day: Number(m[1]), month, year };
}

/**
 * A date cell in whatever form Swiggy used: '2026-10-14' (an Excel date as
 * readWorkbook flattens it), '14-10-2026', '14/10/2026', '04 Oct 2026', or
 * '04 October' (year taken from `near`, a 'YYYY-MM-DD' close to the report).
 * Null when unreadable.
 */
function flexDate(v: unknown, near: string | null): string | null {
  const s = text(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[ T])/);
  if (m) return isoDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return isoDay(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  const dm = dayMonth(s);
  if (!dm) return null;
  const year = dm.year ?? (near ? nearestYear(dm.month, dm.day, near) : null);
  return year === null ? null : isoDay(year, dm.month, dm.day);
}

/**
 * '04 October - 10 October' → ['2026-10-04', '2026-10-10']. The text has no
 * year, so it comes from `near`; the start is in the end's year, or the year
 * before when it falls later in the calendar ('28 December - 03 January').
 */
export function payoutPeriod(periodText: string, near: string | null): [string, string] | null {
  const parts = periodText.split(/\s+(?:-|–|—|to)\s+/i);
  if (parts.length !== 2) return null;
  const a = dayMonth(parts[0]);
  const b = dayMonth(parts[1]);
  if (!a || !b) return null;
  const endYear = b.year ?? (near ? nearestYear(b.month, b.day, near) : a.year);
  if (endYear === null) return null;
  const startsLater = a.month > b.month || (a.month === b.month && a.day > b.day);
  const startYear = a.year ?? (startsLater ? endYear - 1 : endYear);
  const start = isoDay(startYear, a.month, a.day);
  const end = isoDay(endYear, b.month, b.day);
  if (!start || !end || start > end) return null;
  // A payout covers a week or so; anything longer is a misread ('10 October - 04 October').
  return Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) <= 100 * 86_400_000 ? [start, end] : null;
}

/** A money cell (a number, or '₹1234.50  ', '-63.60', '1,200'); null when it isn't one. */
function money(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = text(v).replace(/[₹,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

interface SummaryInfo {
  restaurantRef: string | null;
  periodText: string;
  totalPayout: number | null;
  utr: string;
}

/** Restaurant id and the 'Your Payout Details' label | value rows. */
function readSummary(rows: unknown[][]): SummaryInfo {
  const info: SummaryInfo = { restaurantRef: null, periodText: '', totalPayout: null, utr: '' };
  for (const r of rows) {
    const cells = r.map(text);
    for (let i = 0; i < cells.length; i++) {
      const label = cells[i].toLowerCase().replace(/:$/, '');
      // The label's value is the next cell that says something else (a merged cell repeats its text).
      const value = () => cells.slice(i + 1).find((c) => c !== '' && c !== cells[i]) ?? '';
      const restId = cells[i].match(/^rest\.?\s*id\s*[-:]\s*(\d+)/i);
      if (restId) info.restaurantRef ??= restId[1];
      else if (label === 'payout period') info.periodText ||= value();
      else if (label === 'total payout') info.totalPayout ??= money(value());
      else if (label === 'bank utr') info.utr ||= value();
    }
  }
  return info;
}

function parseOrders(rows: unknown[][], utr: string, warnings: string[]): SettlementOrder[] {
  const h = findHeaderRow(rows);
  if (h < 0) {
    warnings.push(`"${ORDER_SHEET}" has no header row with Order ID and Net Payout for Order`);
    return [];
  }
  const col = mapColumns(rows[h], COLUMNS);
  const missing = REQUIRED.filter((f) => col[f] === undefined);
  if (missing.length) {
    warnings.push(`"${ORDER_SHEET}" is missing columns: ${missing.join(', ')}`);
    return [];
  }
  const cell = (r: unknown[], f: Field) => (col[f] === undefined ? null : r[col[f] as number]);

  const orders: SettlementOrder[] = [];
  let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const orderId = text(cell(r, 'orderId'));
    // A real id is digits; a blank row or a 'Total' line is not an order.
    if (!/^\d{4,}$/.test(orderId)) {
      if (orderId && !/^total/i.test(orderId)) skipped++;
      continue;
    }
    const orderedAt = istTimestamp(cell(r, 'orderDate'));
    if (!orderedAt) {
      skipped++;
      continue;
    }
    const pct = cell(r, 'commissionPct');
    const settlementDate = flexDate(cell(r, 'settlementDate'), null);
    const paymentFee = num(cell(r, 'paymentFee'));
    const gstOnFees = num(cell(r, 'gstOnFees'));
    orders.push({
      orderId,
      orderedAt,
      status: normalizeStatus(cell(r, 'status')),
      orderType: text(cell(r, 'orderType')),
      offer: text(cell(r, 'offer')),
      paymentMode: text(cell(r, 'paymentMode')),
      cancelReason: text(cell(r, 'cancelledBy')),
      cancelStage: '',
      refundPolicy: '',
      menuSales: num(cell(r, 'itemTotal')),
      packaging: num(cell(r, 'packaging')),
      discount: num(cell(r, 'discountShare')),
      gstFromCustomer: num(cell(r, 'gstCollected')),
      netOrderValue: num(cell(r, 'customerPaid')),
      commissionPct: pct === null || pct === undefined || text(pct) === '' ? null : num(pct),
      // Swiggy's fee total also holds long-distance and other small charges; with
      // the gateway fee and GST taken out, the rest is what the page calls commission.
      commission: r2(num(cell(r, 'totalFees')) - gstOnFees - paymentFee),
      paymentFee,
      gstOnFees,
      tcs: num(cell(r, 'tcs')),
      tds: num(cell(r, 'tds')),
      gstPaidByPlatform: num(cell(r, 'gstDeduction')),
      gstDueByRestaurant: 0,
      otherDeductions: num(cell(r, 'complaintCharges')),
      additions: 0,
      payout: num(cell(r, 'payout')),
      settlementStatus: settlementDate ? 'settled' : '',
      settlementDate,
      utr: settlementDate ? utr : '',
      unsettled: 0,
      customerRef: null,
    });
  }
  if (skipped) warnings.push(`${skipped} order row(s) skipped: unreadable order id or date`);
  if (!orders.length && !skipped) warnings.push(`"${ORDER_SHEET}" has no order rows`);
  return orders;
}

type Section = 'adjustmentsThisWeek' | 'adjustmentsPrevious' | 'investmentsThisWeek' | 'investmentsPrevious';

const SECTION_TITLE: [RegExp, Section | null][] = [
  [/^adjustments? this week/i, 'adjustmentsThisWeek'],
  [/^adjustments? from previous week/i, 'adjustmentsPrevious'],
  [/^investments? this week/i, 'investmentsThisWeek'],
  [/^investments? from previous week/i, 'investmentsPrevious'],
  [/^recovery details/i, null], // another outlet's recovery: not read
];

const TABLE_COLUMNS = {
  type: { exact: 'adjustment type' },
  total: { exact: 'total amount' },
  settled: { exact: 'settled amount' },
  outstanding: { exact: 'outstanding amount' },
  from: { exact: 'period from' },
  to: { exact: 'period to' },
  campaignStart: { exact: 'campaign start date' },
  campaignEnd: { exact: 'campaign end date' },
  ref: { exact: 'invoice number' },
} satisfies Record<string, Matcher>;
type TableCols = Partial<Record<keyof typeof TABLE_COLUMNS, number>>;

const ADS_LABEL = /\bads?\b|advert|marketing|\bcpc\b|promotion|campaign/i;
const REFUND_LABEL = /refund|reversal|credit note/i;

function deductionKind(section: Section, label: string): DeductionKind {
  if (section === 'adjustmentsPrevious' || section === 'investmentsPrevious') return 'adjustment';
  if (REFUND_LABEL.test(label)) return 'other';
  return section === 'investmentsThisWeek' || ADS_LABEL.test(label) ? 'ads' : 'other';
}

interface ParsedDeductions {
  deductions: SettlementDeduction[];
  /** The amounts exactly as Swiggy prints them, this week's tables only, for the payout check. */
  thisWeekPrinted: number;
}

function parseDeductions(rows: unknown[][], near: string | null, warnings: string[]): ParsedDeductions {
  const deductions: SettlementDeduction[] = [];
  let thisWeekPrinted = 0;
  const byKey = new Map<string, SettlementDeduction>();
  let combined = 0;
  let section: Section | null = null;
  let cols: TableCols | null = null;

  for (const r of rows) {
    const cells = r.map(text);
    const firstIdx = cells.findIndex((c) => c !== '');
    if (firstIdx < 0) continue;
    const head = cells[firstIdx].split('\n')[0].trim();

    const title = SECTION_TITLE.find(([re]) => re.test(head));
    if (title) {
      section = title[1];
      cols = null;
      continue;
    }
    if (headerKey(head) === 'adjustment type') {
      cols = mapColumns(r, TABLE_COLUMNS);
      continue;
    }
    const c = cols;
    if (!section || !c || c.type === undefined || c.total === undefined) continue;
    // The ads table's invoice number header can sit on a row of its own under the main header.
    if (cells[c.type] === '' && money(r[c.total]) === null) {
      const extra = mapColumns(r, TABLE_COLUMNS);
      if (c.ref === undefined && extra.ref !== undefined) c.ref = extra.ref;
      continue;
    }
    if (/^total/i.test(head)) continue;

    const label = cells[c.type];
    const printed = money(r[c.total]);
    if (!label || printed === null) continue;
    const kind = deductionKind(section, label);
    // An ad bill is money out whichever sign Swiggy prints it with; other rows keep their sign.
    const sign = (x: number | null) => (kind === 'ads' ? Math.abs(x ?? 0) : x ?? 0);
    const at = (f: keyof TableCols) => (c[f] === undefined ? null : r[c[f] as number]);
    const from = flexDate(at('from'), near) ?? flexDate(at('campaignStart'), near);
    const to = flexDate(at('to'), near) ?? flexDate(at('campaignEnd'), near);
    const rawPeriod = [text(at('from')), text(at('to'))].filter(Boolean).join(' - ');
    const outstanding = money(at('outstanding')) ?? 0;
    if (section === 'adjustmentsThisWeek' || section === 'investmentsThisWeek') thisWeekPrinted += printed;
    const row: SettlementDeduction = {
      kind,
      label,
      ref: text(at('ref')),
      periodText: from && to ? `${from} - ${to}` : rawPeriod,
      periodStart: from,
      periodEnd: to,
      settlementStatus: printed === 0 ? '' : outstanding === 0 ? 'settled' : 'pending',
      amount: sign(printed),
      settled: sign(money(at('settled'))),
      outstanding: sign(outstanding),
    };

    // Rows are stored one per (kind, label, invoice, period); two with the same
    // key (say, no invoice number shown) become one, so no money is dropped.
    const key = [row.kind, row.label, row.ref, row.periodText].join('\u0000');
    const same = byKey.get(key);
    if (!same) {
      byKey.set(key, row);
      deductions.push(row);
      continue;
    }
    combined++;
    same.amount = r2(same.amount + row.amount);
    same.settled = r2(same.settled + row.settled);
    same.outstanding = r2(same.outstanding + row.outstanding);
    same.settlementStatus = same.amount === 0 ? '' : same.outstanding === 0 ? 'settled' : 'pending';
  }
  if (combined) warnings.push(`${combined} adjustment row(s) with the same type, invoice and period were added together`);
  return { deductions, thisWeekPrinted };
}

/** The settlement date in the file name (…_<rest id>_14102026_…), and the restaurant id before it. */
function fromFileName(fileName: string): { restId: string | null; day: string | null } {
  const m = fileName.match(/annexure_(\d+)_(\d{2})(\d{2})(\d{4})(?=[_.])/i);
  if (!m) return { restId: null, day: null };
  return { restId: m[1], day: isoDay(Number(m[4]), Number(m[3]) - 1, Number(m[2])) };
}

const inr = (n: number) => `₹${n.toFixed(2)}`;

export function parseSwiggySettlement(sheets: Sheets, fileName: string): ParsedSettlement {
  const warnings: string[] = [];
  const summary = readSummary(sheets[SUMMARY_SHEET] ?? []);
  const orders = parseOrders(sheets[ORDER_SHEET] ?? [], summary.utr, warnings);

  const dedSheet = Object.keys(sheets).find((n) => n.toLowerCase().startsWith(DEDUCTION_SHEET_PREFIX));
  if (!dedSheet) warnings.push('"Growth Investments and Other Deductions" sheet not found: ads and other deductions not read');

  // A day close to this report, to give the year-less dates theirs: the file name's
  // settlement date, else the latest settlement date or order date inside.
  const settled = orders.flatMap((o) => (o.settlementDate ? [o.settlementDate] : [])).sort();
  const ordered = orders.map((o) => o.orderedAt.slice(0, 10)).sort(); // IST calendar days
  const file = fromFileName(fileName);
  const near = file.day ?? settled[settled.length - 1] ?? ordered[ordered.length - 1] ?? null;

  const { deductions, thisWeekPrinted } = parseDeductions(dedSheet ? sheets[dedSheet] : [], near, warnings);

  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  const period = payoutPeriod(summary.periodText, near);
  if (period) [periodStart, periodEnd] = period;
  else if (ordered.length) {
    periodStart = ordered[0];
    periodEnd = ordered[ordered.length - 1];
    warnings.push('Report period taken from the order dates');
  }

  // The orders and this week's adjustments should add up to the Summary's Total
  // Payout. Swiggy's sign for an adjustment isn't known (the sample's tables were
  // empty), so either sign may explain it. A difference is a warning, not a failure.
  if (orders.length) {
    const payouts = r2(orders.reduce((sum, o) => sum + o.payout, 0));
    const adjustments = r2(thisWeekPrinted);
    if (summary.totalPayout === null) {
      warnings.push('The Summary has no readable Total Payout, so the order payouts were not cross-checked');
    } else if (
      Math.abs(payouts - adjustments - summary.totalPayout) > 1 &&
      Math.abs(payouts + adjustments - summary.totalPayout) > 1
    ) {
      warnings.push(
        `Order payouts ${inr(payouts)} less this week's adjustments ${inr(adjustments)} come to ${inr(payouts - adjustments)}, ` +
          `but the Summary's Total Payout is ${inr(summary.totalPayout)}`,
      );
    }
  }

  return {
    platform: 'swiggy',
    restaurantRef: summary.restaurantRef ?? file.restId,
    periodStart,
    periodEnd,
    orders,
    deductions,
    warnings,
  };
}
