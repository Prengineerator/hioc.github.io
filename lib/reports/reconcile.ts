// Reconciliation report (owner → Reports): for a range of IST days, what was
// sold, what money came in and how, what went back out, and how each day's
// drawer closed. Pure — the rows are fetched by lib/reports/reconcileServer.ts
// — so every rule here is unit-tested.
//
// Two different clocks, on purpose:
//   • SALES are counted on the day the order was PLACED (orders.created_at),
//     the same day v_daily_sales and the dashboard use.
//   • MONEY is counted on the day it was RECEIVED, exactly as the cash day and
//     the drawer checkpoints count it (lib/cash/checkpoints.ts
//     cashActivityBetween): a split bill's parts by their own time, a
//     single-tender bill by orders.paid_at, refunds by processed_at. So a bill
//     placed on the 3rd and paid on the 4th is a 3rd sale and 4th money — which
//     is what the drawer on each day actually saw.
// "Unpaid" explains most of the gap between the two: orders from the range
// whose money has still not been taken.

import type { PaymentMethod } from '@/lib/types';

export const REPORT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'upi',
  'card',
  'online',
  'swiggy_dineout',
  'zomato_district',
];

/** Longest range one report covers (keeps the queries and the table sane). */
export const MAX_REPORT_DAYS = 93;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The IST calendar date ('YYYY-MM-DD') an instant falls on. */
export function istDateOf(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Every IST date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  for (let t = Date.UTC(fy, fm - 1, fd); t <= Date.UTC(ty, tm - 1, td); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** UTC instants bounding IST days [from 00:00, the day after `to` 00:00). */
export function rangeBounds(from: string, to: string): { startIso: string; endIso: string } {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return {
    startIso: new Date(Date.UTC(fy, fm - 1, fd) - IST_OFFSET_MS).toISOString(),
    endIso: new Date(Date.UTC(ty, tm - 1, td) + DAY_MS - IST_OFFSET_MS).toISOString(),
  };
}

/** Validates a requested range. `today` bounds it (no future days). */
export function parseRange(
  fromRaw: unknown,
  toRaw: unknown,
  today: string,
): { ok: true; from: string; to: string } | { ok: false; message: string } {
  const from = typeof fromRaw === 'string' && fromRaw ? fromRaw : today;
  const to = typeof toRaw === 'string' && toRaw ? toRaw : from;
  if (!isRealDate(from) || !isRealDate(to)) return { ok: false, message: 'Dates must be real dates (YYYY-MM-DD).' };
  if (from > to) return { ok: false, message: 'The start date is after the end date.' };
  if (to > today) return { ok: false, message: 'The range can’t end in the future.' };
  if (datesBetween(from, to).length > MAX_REPORT_DAYS) {
    return { ok: false, message: `Pick at most ${MAX_REPORT_DAYS} days at a time.` };
  }
  return { ok: true, from, to };
}

// ── Input rows (as fetched) ─────────────────────────────────────────────────

export interface SaleOrderRow {
  id: string;
  created_at: string;
  status: string;
  payment_status: string;
  total_inr: number | null;
  subtotal_inr: number | null;
  tax_inr: number | null;
  discount_inr: number | null;
  settle_discount_inr?: number | null;
}

export interface PaymentPartRow {
  order_id: string;
  method: string;
  amount_inr: number | null;
  created_at: string;
}

export interface PaidOrderRow {
  id: string;
  payment_method: string | null;
  total_inr: number | null;
  subtotal_inr: number | null;
  paid_at: string;
  tip_inr?: number | null;
}

export interface RefundRow {
  amount_inr: number | null;
  method: string | null;
  processed_at: string;
}

export interface CashMovementRow {
  direction: string;
  amount_inr: number | null;
  created_at: string;
}

export interface CashDayRow {
  business_date: string;
  status: string;
  opening_total_inr: number | null;
  cash_sales_inr: number | null;
  expected_cash_inr: number | null;
  counted_total_inr: number | null;
  over_short_inr: number | null;
  handover_inr?: number | null;
}

export interface ReportInput {
  from: string;
  to: string;
  /** Orders PLACED in the range (any status). */
  orders: SaleOrderRow[];
  /** Split-bill parts RECEIVED in the range. */
  parts: PaymentPartRow[];
  /** Single-tender bills PAID in the range (paid_at in range). */
  paidOrders: PaidOrderRow[];
  /** Ids of any of paidOrders that have split parts (counted via parts instead). */
  ordersWithParts: Set<string>;
  refunds: RefundRow[];
  movements: CashMovementRow[];
  cashDays: CashDayRow[];
}

// ── Output ─────────────────────────────────────────────────────────────────

export type MethodAmounts = Record<PaymentMethod, number>;

export interface ReportDay {
  date: string;
  /** Orders placed this day, not cancelled/rejected. */
  orders: number;
  cancelled: number;
  grossSalesInr: number;
  taxInr: number;
  discountInr: number;
  settleDiscountInr: number;
  /** Gross minus settlement discounts (tips are never sales). */
  netSalesInr: number;
  /** From this day's orders, still not paid. */
  unpaidOrders: number;
  unpaidInr: number;
  /** Money received this day, by how it came in. */
  received: MethodAmounts;
  receivedTotalInr: number;
  refunds: MethodAmounts;
  refundsTotalInr: number;
  /** Received − refunded. */
  netReceivedInr: number;
  tipsInr: number;
  cashInInr: number;
  cashOutInr: number;
  cashDay: CashDayRow | null;
}

export interface Report {
  from: string;
  to: string;
  days: ReportDay[];
  totals: Omit<ReportDay, 'date' | 'cashDay'> & {
    cashDaysClosed: number;
    /** Σ over/short across closed cash days (negative = short). */
    overShortInr: number;
  };
}

const zeroMethods = (): MethodAmounts =>
  Object.fromEntries(REPORT_METHODS.map((m) => [m, 0])) as MethodAmounts;
const isMethod = (m: string | null | undefined): m is PaymentMethod =>
  (REPORT_METHODS as readonly (string | null | undefined)[]).includes(m);
const DEAD = new Set(['cancelled', 'rejected']);

function emptyDay(date: string): ReportDay {
  return {
    date,
    orders: 0,
    cancelled: 0,
    grossSalesInr: 0,
    taxInr: 0,
    discountInr: 0,
    settleDiscountInr: 0,
    netSalesInr: 0,
    unpaidOrders: 0,
    unpaidInr: 0,
    received: zeroMethods(),
    receivedTotalInr: 0,
    refunds: zeroMethods(),
    refundsTotalInr: 0,
    netReceivedInr: 0,
    tipsInr: 0,
    cashInInr: 0,
    cashOutInr: 0,
    cashDay: null,
  };
}

export function buildReport(input: ReportInput): Report {
  const days = new Map(datesBetween(input.from, input.to).map((d) => [d, emptyDay(d)]));
  const dayOf = (iso: string) => days.get(istDateOf(iso));

  for (const o of input.orders) {
    const day = dayOf(o.created_at);
    if (!day) continue;
    if (DEAD.has(o.status)) {
      day.cancelled += 1;
      continue;
    }
    const total = o.total_inr ?? o.subtotal_inr ?? 0;
    day.orders += 1;
    day.grossSalesInr += total;
    day.taxInr += o.tax_inr ?? 0;
    day.discountInr += o.discount_inr ?? 0;
    day.settleDiscountInr += o.settle_discount_inr ?? 0;
    if (o.payment_status === 'unpaid' || o.payment_status === 'payment_pending') {
      day.unpaidOrders += 1;
      day.unpaidInr += total;
    }
  }

  // Money in: split parts by their own time; single-tender bills by paid_at,
  // unless they have parts (then the parts already counted them).
  for (const p of input.parts) {
    const day = dayOf(p.created_at);
    if (!day || !isMethod(p.method)) continue;
    day.received[p.method] += p.amount_inr ?? 0;
  }
  for (const o of input.paidOrders) {
    if (input.ordersWithParts.has(o.id)) continue;
    const day = dayOf(o.paid_at);
    if (!day || !isMethod(o.payment_method)) continue;
    day.received[o.payment_method] += o.total_inr ?? o.subtotal_inr ?? 0;
  }
  // Tips ride on the day the bill was paid (whenever it was placed).
  for (const o of input.paidOrders) {
    const day = dayOf(o.paid_at);
    if (day && o.tip_inr) day.tipsInr += o.tip_inr;
  }

  // Refunds by when they were processed. A legacy refund with no method was
  // a cash refund (same rule as the drawer math).
  for (const r of input.refunds) {
    const day = dayOf(r.processed_at);
    if (!day) continue;
    const method: PaymentMethod = isMethod(r.method) ? r.method : 'cash';
    day.refunds[method] += r.amount_inr ?? 0;
  }

  for (const m of input.movements) {
    const day = dayOf(m.created_at);
    if (!day) continue;
    if (m.direction === 'in') day.cashInInr += m.amount_inr ?? 0;
    else if (m.direction === 'out') day.cashOutInr += m.amount_inr ?? 0;
  }

  for (const c of input.cashDays) {
    const day = days.get(c.business_date);
    if (day) day.cashDay = c;
  }

  const list = [...days.values()];
  for (const d of list) {
    d.netSalesInr = d.grossSalesInr - d.settleDiscountInr;
    d.receivedTotalInr = REPORT_METHODS.reduce((s, m) => s + d.received[m], 0);
    d.refundsTotalInr = REPORT_METHODS.reduce((s, m) => s + d.refunds[m], 0);
    d.netReceivedInr = d.receivedTotalInr - d.refundsTotalInr;
  }

  const { date: _date, cashDay: _cashDay, ...blank } = emptyDay('');
  void _date;
  void _cashDay;
  const totals: Report['totals'] = { ...blank, cashDaysClosed: 0, overShortInr: 0 };
  const numericKeys = [
    'orders',
    'cancelled',
    'grossSalesInr',
    'taxInr',
    'discountInr',
    'settleDiscountInr',
    'netSalesInr',
    'unpaidOrders',
    'unpaidInr',
    'receivedTotalInr',
    'refundsTotalInr',
    'netReceivedInr',
    'tipsInr',
    'cashInInr',
    'cashOutInr',
  ] as const;
  for (const d of list) {
    for (const k of numericKeys) totals[k] += d[k];
    for (const m of REPORT_METHODS) {
      totals.received[m] += d.received[m];
      totals.refunds[m] += d.refunds[m];
    }
    if (d.cashDay?.status === 'closed') {
      totals.cashDaysClosed += 1;
      totals.overShortInr += d.cashDay.over_short_inr ?? 0;
    }
  }

  return { from: input.from, to: input.to, days: list, totals };
}

// ── CSV ────────────────────────────────────────────────────────────────────

const CSV_COLUMNS: [string, (d: ReportDay) => string | number][] = [
  ['Date', (d) => d.date],
  ['Orders', (d) => d.orders],
  ['Cancelled/rejected', (d) => d.cancelled],
  ['Gross sales (INR)', (d) => d.grossSalesInr],
  ['Tax (INR)', (d) => d.taxInr],
  ['Discounts (INR)', (d) => d.discountInr],
  ['Settle discounts (INR)', (d) => d.settleDiscountInr],
  ['Net sales (INR)', (d) => d.netSalesInr],
  ['Unpaid orders', (d) => d.unpaidOrders],
  ['Unpaid (INR)', (d) => d.unpaidInr],
  ['Cash received (INR)', (d) => d.received.cash],
  ['UPI received (INR)', (d) => d.received.upi],
  ['Card received (INR)', (d) => d.received.card],
  ['Online received (INR)', (d) => d.received.online],
  ['Swiggy Dineout received (INR)', (d) => d.received.swiggy_dineout],
  ['Zomato District received (INR)', (d) => d.received.zomato_district],
  ['Total received (INR)', (d) => d.receivedTotalInr],
  ['Refunds (INR)', (d) => d.refundsTotalInr],
  ['Net received (INR)', (d) => d.netReceivedInr],
  ['Tips (INR)', (d) => d.tipsInr],
  ['Cash in (INR)', (d) => d.cashInInr],
  ['Cash out (INR)', (d) => d.cashOutInr],
  ['Cash day', (d) => d.cashDay?.status ?? ''],
  ['Drawer expected (INR)', (d) => d.cashDay?.expected_cash_inr ?? ''],
  ['Drawer counted (INR)', (d) => (d.cashDay?.status === 'closed' ? d.cashDay.counted_total_inr ?? '' : '')],
  ['Over/short (INR)', (d) => (d.cashDay?.status === 'closed' ? d.cashDay.over_short_inr ?? '' : '')],
];

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per day plus a TOTAL row, for a spreadsheet. */
export function reportCsv(report: Report): string {
  const header = CSV_COLUMNS.map(([h]) => h).join(',');
  const rows = report.days.map((d) => CSV_COLUMNS.map(([, f]) => csvCell(f(d))).join(','));
  const t = report.totals;
  const totalDay: ReportDay = { ...t, date: 'TOTAL', cashDay: null };
  const totalRow = CSV_COLUMNS.map(([h, f]) => {
    if (h === 'Over/short (INR)') return csvCell(t.overShortInr);
    return csvCell(f(totalDay));
  }).join(',');
  return [header, ...rows, totalRow].join('\n') + '\n';
}
