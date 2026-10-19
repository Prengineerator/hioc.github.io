// Cash and expense sheets for the owner's downloads (Owner → Reports →
// Downloads). Pure: each builder takes rows the server has already read
// (cashReportsServer.ts, staff names resolved) and returns a CsvTable.
//
// The rules are the ones the reconciliation report and the cash day already
// use (lib/reports/reconcile.ts header): a cash day's figures are the ones frozen
// at its close, an expense is a cash out with a category (lib/cash/expenses.ts),
// and an undone expense (voided_at) never counts in a total. Dates and times are
// IST. Money headers end in "(INR)".

import { round2, type CsvTable, type CsvValue } from '@/lib/reports/csv';
import {
  cashDayOuts,
  istDateOf,
  REPORT_METHODS,
  type CashDayRow,
  type Report,
  type ReportDay,
} from '@/lib/reports/reconcile';
import { expenseCategoryLabel, expenseStatus, totalsByCategory, type ExpenseStatus } from '@/lib/cash/expenses';
import { APP_PAYMENT_METHODS } from '@/lib/orders/payments';
import type { PaymentMethod } from '@/lib/types';

/** The labels the owner's reports page uses for each tender (app/owner/reports/page.tsx). */
const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  online: 'Online (website)',
  swiggy_dineout: 'Swiggy Dineout',
  zomato_district: 'Zomato District',
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** HH:MM (24 h, IST) of an instant. */
function istTimeOf(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD HH:MM' (IST), for a timestamp that may fall on a different date than its business date. */
function istStampOf(iso: string | null | undefined): string {
  return iso ? `${istDateOf(iso)} ${istTimeOf(iso)}` : '';
}

function numeric(v: CsvValue): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ── Sheet plumbing ───────────────────────────────────────────────────────────

interface Column<T> {
  header: string;
  value: (r: T) => CsvValue;
  /** Summed on the TOTAL row. */
  sum?: boolean;
}

function headersOf<T>(columns: Column<T>[]): string[] {
  return columns.map((c) => c.header);
}

function bodyRows<T>(columns: Column<T>[], records: T[]): CsvValue[][] {
  return records.map((r) => columns.map((c) => c.value(r)));
}

/**
 * The TOTAL row: 'TOTAL' in the first column, the sum of each summed column over
 * the records `countIn` lets through, and an optional note in one column.
 */
function totalRow<T>(
  columns: Column<T>[],
  records: T[],
  opts: { countIn?: (r: T) => boolean; note?: { header: string; text: string } } = {},
): CsvValue[] {
  const counted = records.filter(opts.countIn ?? (() => true));
  return columns.map((c, i) => {
    if (i === 0) return 'TOTAL';
    if (opts.note && opts.note.header === c.header) return opts.note.text;
    if (!c.sum) return '';
    return round2(counted.reduce((s, r) => s + numeric(c.value(r)), 0));
  });
}

// ── Cash drawer register ─────────────────────────────────────────────────────

/** A cash day as the drawer register reads it: cash_days plus the staff names and the tender totals. */
export interface CashDayRecord extends CashDayRow {
  opened_by_name: string;
  closed_by_name: string;
  upi_inr?: number | null;
  card_inr?: number | null;
  /** 2026-10-aggregator-payments.sql; undefined before it. */
  swiggy_dineout_inr?: number | null;
  zomato_district_inr?: number | null;
}

const isClosed = (c: CashDayRecord) => c.status === 'closed';

/** A figure frozen at the close: blank on an open day, and on a closed day that never recorded it. */
function frozen(c: CashDayRecord, v: number | null | undefined): CsvValue {
  return isClosed(c) && typeof v === 'number' ? round2(v) : '';
}

/** The closed day's cash out split the owner's way (reconcile.ts cashDayOuts); null while nothing is frozen. */
function outsOf(c: CashDayRecord): ReturnType<typeof cashDayOuts> | null {
  return isClosed(c) && typeof c.cash_out_inr === 'number' ? cashDayOuts(c) : null;
}

const CASH_DAY_COLUMNS: Column<CashDayRecord>[] = [
  { header: 'Business date', value: (c) => c.business_date },
  { header: 'Status', value: (c) => (isClosed(c) ? 'Closed' : 'Open') },
  { header: 'Opened at (IST)', value: (c) => istStampOf(c.opened_at) },
  { header: 'Opened by', value: (c) => c.opened_by_name },
  { header: 'Opening float (INR)', value: (c) => round2(c.opening_total_inr ?? 0) },
  { header: 'Cash sales (INR)', value: (c) => frozen(c, c.cash_sales_inr), sum: true },
  { header: 'Cash bills', value: (c) => frozen(c, c.cash_sales_count), sum: true },
  { header: 'Cash refunds (INR)', value: (c) => frozen(c, c.cash_refunds_inr), sum: true },
  { header: 'Cash in (INR)', value: (c) => frozen(c, c.cash_in_inr), sum: true },
  {
    header: 'Expenses (INR)',
    value: (c) => {
      const o = outsOf(c);
      return o ? round2(o.expensesInr) : '';
    },
    sum: true,
  },
  {
    header: 'Cash out to owner (INR)',
    value: (c) => {
      const o = outsOf(c);
      return o ? round2(o.cashOutInr) : '';
    },
    sum: true,
  },
  { header: 'Handover (INR)', value: (c) => frozen(c, c.handover_inr), sum: true },
  { header: 'Expected cash (INR)', value: (c) => frozen(c, c.expected_cash_inr) },
  { header: 'Counted (INR)', value: (c) => frozen(c, c.counted_total_inr) },
  { header: 'Over/short (INR)', value: (c) => frozen(c, c.over_short_inr), sum: true },
  { header: 'Float left (INR)', value: (c) => frozen(c, c.float_left_total_inr) },
  { header: 'UPI (INR)', value: (c) => frozen(c, c.upi_inr), sum: true },
  { header: 'Card (INR)', value: (c) => frozen(c, c.card_inr), sum: true },
  { header: 'Swiggy Dineout (INR)', value: (c) => frozen(c, c.swiggy_dineout_inr), sum: true },
  { header: 'Zomato District (INR)', value: (c) => frozen(c, c.zomato_district_inr), sum: true },
  { header: 'Closed at (IST)', value: (c) => istStampOf(c.closed_at) },
  { header: 'Closed by', value: (c) => c.closed_by_name },
  // undefined = the column is not in the database yet, so it is unknown, not "No".
  { header: 'Auto-ended', value: (c) => (c.auto_ended_at === undefined ? '' : c.auto_ended_at ? 'Yes' : 'No') },
  { header: 'Close reason', value: (c) => (isClosed(c) ? (c.close_reason ?? '') : '') },
  { header: 'Notes', value: (c) => c.notes ?? '' },
];

function byOpened(a: CashDayRecord, b: CashDayRecord): number {
  return a.business_date.localeCompare(b.business_date) || (a.opened_at ?? '').localeCompare(b.opened_at ?? '');
}

/** One row per cash day (in the order it was opened), plus a TOTAL of the additive figures. */
export function cashRegister(days: CashDayRecord[]): CsvTable {
  const sorted = [...days].sort(byOpened);
  return {
    columns: headersOf(CASH_DAY_COLUMNS),
    rows: [...bodyRows(CASH_DAY_COLUMNS, sorted), totalRow(CASH_DAY_COLUMNS, sorted)],
  };
}

// ── Expense register ─────────────────────────────────────────────────────────

/** A categorised cash out (cash_movements, direction 'out', category set), with the staff names resolved. */
export interface ExpenseRecord {
  id: string;
  created_at: string;
  category: string;
  amount_inr: number;
  reason: string | null;
  recorded_by_name: string;
  approved_by_name: string;
  approved_at?: string | null;
  voided_at?: string | null;
}

const EXPENSE_STATUS_LABEL: Record<ExpenseStatus, string> = {
  approved: 'Approved',
  pending: 'Pending approval',
  undone: 'Voided',
};

const EXPENSE_COLUMNS: Column<ExpenseRecord>[] = [
  { header: 'Date', value: (e) => istDateOf(e.created_at) },
  { header: 'Time', value: (e) => istTimeOf(e.created_at) },
  { header: 'Category', value: (e) => expenseCategoryLabel(e.category) },
  { header: 'Amount (INR)', value: (e) => round2(e.amount_inr), sum: true },
  { header: 'Reason / note', value: (e) => e.reason ?? '' },
  { header: 'Recorded by', value: (e) => e.recorded_by_name },
  { header: 'Status', value: (e) => EXPENSE_STATUS_LABEL[expenseStatus(e)] },
  { header: 'Approved by', value: (e) => (expenseStatus(e) === 'approved' ? e.approved_by_name : '') },
  { header: 'Approved at (IST)', value: (e) => (expenseStatus(e) === 'approved' ? istStampOf(e.approved_at) : '') },
];

/** Every expense in the range, oldest first. Voided ones stay listed, but not in the TOTAL. */
export function expenseRegister(expenses: ExpenseRecord[]): CsvTable {
  const sorted = [...expenses].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    columns: headersOf(EXPENSE_COLUMNS),
    rows: [
      ...bodyRows(EXPENSE_COLUMNS, sorted),
      totalRow(EXPENSE_COLUMNS, sorted, {
        countIn: (e) => expenseStatus(e) !== 'undone',
        note: { header: 'Status', text: 'Non-voided only' },
      }),
    ],
  };
}

// ── Expenses by category ─────────────────────────────────────────────────────

/** Expenses by category, biggest first. Voided entries are left out entirely. */
export function expenseByCategory(expenses: ExpenseRecord[]): CsvTable {
  const live = expenses.filter((e) => expenseStatus(e) !== 'undone');
  const categories = totalsByCategory(live.map((e) => ({ category: e.category, amountInr: e.amount_inr })));
  const total = round2(live.reduce((s, e) => s + e.amount_inr, 0));
  const share = (amount: number) => (total > 0 ? round2((amount / total) * 100) : 0);
  return {
    columns: ['Category', 'Entries', 'Amount (INR)', 'Share %'],
    rows: [
      ...categories.map((c): CsvValue[] => [c.label, c.count, round2(c.amountInr), share(c.amountInr)]),
      ['TOTAL', live.length, total, total > 0 ? 100 : 0],
    ],
  };
}

// ── Dining-app payments ──────────────────────────────────────────────────────

/** One tender taken through Swiggy Dineout or Zomato District (or a bill paid that way with no tender row). */
export interface AppPaymentRecord {
  method: string;
  amount_inr: number;
  reference: string | null;
  /** When the money was taken: the tender's created_at, or the bill's paid_at. */
  created_at: string;
  invoice_no: string;
  order_status: string | null;
  payment_status: string | null;
  recorded_by_name: string;
}

/** Why a payment is left out of the totals, or null when it counts (the rule of the Payments page). */
function leftOutReason(p: AppPaymentRecord): string | null {
  if (p.order_status === 'cancelled') return 'Order cancelled';
  if (p.order_status === 'rejected') return 'Order rejected';
  if (p.payment_status === 'refunded') return 'Fully refunded';
  return null;
}

function appLabel(method: string): string {
  return METHOD_LABEL[method as PaymentMethod] ?? method;
}

/**
 * Every dining-app payment in the range, oldest first, then one subtotal per app
 * and a TOTAL. Cancelled, rejected and fully refunded payments are listed with
 * their status but left out of the subtotals and the TOTAL.
 */
export function appPayments(payments: AppPaymentRecord[]): CsvTable {
  const sorted = [...payments].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const counted = sorted.filter((p) => leftOutReason(p) === null);
  const columns = ['Date', 'Time', 'Invoice no', 'App', 'Amount (INR)', 'Booking reference', 'Recorded by', 'Status'];
  const rows: CsvValue[][] = sorted.map((p) => [
    istDateOf(p.created_at),
    istTimeOf(p.created_at),
    p.invoice_no,
    appLabel(p.method),
    round2(p.amount_inr),
    p.reference ?? '',
    p.recorded_by_name,
    leftOutReason(p) ?? 'Counted',
  ]);
  for (const method of APP_PAYMENT_METHODS) {
    const mine = counted.filter((p) => p.method === method);
    rows.push([
      'Subtotal',
      '',
      '',
      appLabel(method),
      round2(mine.reduce((s, p) => s + p.amount_inr, 0)),
      '',
      '',
      `${mine.length} counted`,
    ]);
  }
  rows.push([
    'TOTAL',
    '',
    '',
    '',
    round2(counted.reduce((s, p) => s + p.amount_inr, 0)),
    '',
    '',
    'Excludes cancelled, rejected and refunded',
  ]);
  return { columns, rows };
}

// ── Collections by payment mode ──────────────────────────────────────────────

const PAYMENT_MODE_COLUMNS: Column<ReportDay>[] = [
  { header: 'Date', value: (d) => d.date },
  ...REPORT_METHODS.map(
    (m): Column<ReportDay> => ({
      header: `${METHOD_LABEL[m]} (INR)`,
      value: (d) => round2(d.received[m]),
      sum: true,
    }),
  ),
  { header: 'Total received (INR)', value: (d) => round2(d.receivedTotalInr), sum: true },
  { header: 'Refunds (INR)', value: (d) => round2(d.refundsTotalInr), sum: true },
  { header: 'Net received (INR)', value: (d) => round2(d.netReceivedInr), sum: true },
  { header: 'Tips (INR)', value: (d) => round2(d.tipsInr), sum: true },
];

/**
 * Money received per day by payment method, from the reconciliation report's
 * days (the money-clock rules live there, not here), plus a TOTAL row.
 */
export function paymentModes(report: Report): CsvTable {
  return {
    columns: headersOf(PAYMENT_MODE_COLUMNS),
    rows: [...bodyRows(PAYMENT_MODE_COLUMNS, report.days), totalRow(PAYMENT_MODE_COLUMNS, report.days)],
  };
}
