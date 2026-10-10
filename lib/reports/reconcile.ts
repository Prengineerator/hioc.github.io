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
//
// THE CASH DRAWER is neither clock: it is reported by CASH DAY, from when the
// drawer was opened to when it was counted and closed, with the figures frozen
// at that close (cash_days) — the same ones staff saw on the close screen. The
// café runs past midnight, so a day's drawer can hold cash a calendar day would
// put on the next date; re-deriving the drawer from calendar days could never
// tie out to the over/short. A cash day sits on the date it was OPENED
// (cash_days.business_date).
//
// CASH OUT, the owner's way: an EXPENSE (a cash out with a category) is money
// spent and is always reported on its own; EVERY OTHER cash out is cash handed
// to the owner — taken out during the day, or the handover a close writes
// (cash_days.handover_inr, also a cash_movements 'out' row for the chain).
// cashOutInr never includes expenses.
//
// HIOC Ritual (docs/COFFEE-PASS-SPEC.md §7, CP-D21): revenue is counted when the
// pass is SOLD, so a pass sale is an ordinary paid order in every number below
// and is also broken out as `passSales`. What a redeemed cup covered
// (orders.pass_discount_inr) is NOT a marketing discount: it stays out of
// `discountInr` and is reported on its own as `passRedemptions`.

import type { CashDenoms, PaymentMethod } from '@/lib/types';
import { DENOMINATIONS, LEGACY_COINS_KEY } from '@/lib/cash/denoms';

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
  /** 'coffee_pass' = the SALE of a HIOC Ritual pass; absent (before 2026-10-coffee-pass.sql) = 'menu'. */
  order_kind?: string | null;
  /** What pass cups covered on this order (kept apart from discount_inr); absent = 0. */
  pass_discount_inr?: number | null;
}

/** Cups a HIOC Ritual pass paid for on one order line (order_items.pass_drinks). */
export interface PassLineRow {
  order_id: string;
  pass_drinks: number | null;
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
  /** Set on an expense paid from the drawer (supabase/2026-10-cash-expenses.sql); absent before that migration. */
  category?: string | null;
  /** Set when an expense was undone (same migration); such a row never left the drawer. */
  voided_at?: string | null;
}

/** A cash day, with the figures frozen at its close (null on a day still open, or closed before they were kept). */
export interface CashDayRow {
  id?: string;
  business_date: string;
  status: string;
  opened_at?: string | null;
  closed_at?: string | null;
  opening_total_inr: number | null;
  cash_sales_inr: number | null;
  cash_sales_count?: number | null;
  cash_refunds_inr?: number | null;
  cash_in_inr?: number | null;
  cash_out_inr?: number | null;
  /** Of cash_out_inr, the store expenses (2026-10-cash-expenses.sql; absent before it — then none). */
  expenses_inr?: number | null;
  expected_cash_inr: number | null;
  counted_total_inr: number | null;
  over_short_inr: number | null;
  /** The closing count, by denomination. */
  closing_denoms?: CashDenoms | null;
  /** Cash taken out to the owner/bank at the close = counted − float left. */
  handover_inr?: number | null;
  float_left_total_inr?: number | null;
  float_left_denoms?: CashDenoms | null;
  /** Why the drawer was over/short (days closed before close_reason kept it in notes). */
  close_reason?: string | null;
  /** Set when nobody closed the day and it ended on its own at 3 am (lib/cash/autoEnd.ts). */
  auto_ended_at?: string | null;
  notes?: string | null;
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
  /** The non-voided lines of orders that used pass cups, with the cups each spent. Absent = none. */
  passLines?: PassLineRow[];
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
  /** Passes sold: paid HIOC Ritual sale orders placed this day (already inside grossSalesInr). */
  passSales: { count: number; inr: number };
  /** Cups redeemed: the cups and the rupees pass cover on orders placed this day that stand (not cancelled, rejected or fully refunded). Not part of discountInr. */
  passRedemptions: { drinks: number; inr: number };
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
  /** Cash handed to the owner this day: every cash out that is not an expense, a close's handover included. */
  cashOutInr: number;
  /** Expenses paid from the drawer this day (categorised cash outs) — apart from cashOutInr. */
  expensesInr: number;
  /** The cash days opened on this date, oldest first — usually one. */
  cashDays: CashDayRow[];
}

/**
 * The drawer over the range, from the cash days (see the header): what each
 * close recorded, added up over the CLOSED days. A day still open has nothing
 * frozen yet and only counts in `open`.
 */
export interface DrawerTotals {
  /** Cash days opened on these dates. */
  days: number;
  closed: number;
  open: number;
  cashSalesInr: number;
  cashSalesCount: number;
  cashRefundsInr: number;
  cashInInr: number;
  /** Expenses paid from the drawer. */
  expensesInr: number;
  /** Cash taken out to the owner during the day (every cash out that is not an expense). */
  cashOutInr: number;
  /** Σ over/short (negative = short). */
  overShortInr: number;
  /** Cash handed over to the owner at the closes. */
  handoverInr: number;
  /** Everything the owner got: cashOutInr + handoverInr. */
  toOwnerInr: number;
  /** What the last close in the range left in the drawer; null when none recorded it. */
  floatLeftInr: number | null;
}

export interface Report {
  from: string;
  to: string;
  days: ReportDay[];
  totals: Omit<ReportDay, 'date' | 'cashDays'> & {
    cashDaysClosed: number;
    /** Σ over/short across closed cash days (negative = short). */
    overShortInr: number;
  };
  drawer: DrawerTotals;
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
    passSales: { count: 0, inr: 0 },
    passRedemptions: { drinks: 0, inr: 0 },
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
    expensesInr: 0,
    cashDays: [],
  };
}

export function buildReport(input: ReportInput): Report {
  const days = new Map(datesBetween(input.from, input.to).map((d) => [d, emptyDay(d)]));
  const dayOf = (iso: string) => days.get(istDateOf(iso));

  // Cups spent per order, from the lines that were not voided since (a voided
  // line's cups went back to the pass).
  const cupsByOrder = new Map<string, number>();
  for (const l of input.passLines ?? []) {
    cupsByOrder.set(l.order_id, (cupsByOrder.get(l.order_id) ?? 0) + (l.pass_drinks ?? 0));
  }

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
    if (o.order_kind === 'coffee_pass') {
      // A pass SALE. Counted once it is paid (an abandoned or unpaid sale issued
      // nothing); a refunded one drops out, its refund showing under refunds.
      if (o.payment_status === 'paid') {
        day.passSales.count += 1;
        day.passSales.inr += total;
      }
    } else if (o.payment_status !== 'refunded') {
      // A menu order that used cups. A fully refunded one is left out: its cups
      // went back to the pass (CP-D14), so nothing was redeemed.
      const cover = o.pass_discount_inr ?? 0;
      if (cover > 0) {
        day.passRedemptions.inr += cover;
        day.passRedemptions.drinks += cupsByOrder.get(o.id) ?? 0;
      }
    }
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
    if (m.voided_at) continue; // an undone expense left no cash out
    const day = dayOf(m.created_at);
    if (!day) continue;
    if (m.direction === 'in') day.cashInInr += m.amount_inr ?? 0;
    else if (m.direction === 'out') {
      // An expense is money spent; any other cash out went to the owner.
      if (m.category) day.expensesInr += m.amount_inr ?? 0;
      else day.cashOutInr += m.amount_inr ?? 0;
    }
  }

  // Every cash day on its date (a date can have more than one: a day closed
  // for an afternoon break and opened again), oldest first.
  const byOpened = [...input.cashDays].sort((a, b) =>
    a.business_date !== b.business_date
      ? a.business_date.localeCompare(b.business_date)
      : (a.opened_at ?? '').localeCompare(b.opened_at ?? ''),
  );
  for (const c of byOpened) days.get(c.business_date)?.cashDays.push(c);

  const list = [...days.values()];
  for (const d of list) {
    d.netSalesInr = d.grossSalesInr - d.settleDiscountInr;
    d.receivedTotalInr = REPORT_METHODS.reduce((s, m) => s + d.received[m], 0);
    d.refundsTotalInr = REPORT_METHODS.reduce((s, m) => s + d.refunds[m], 0);
    d.netReceivedInr = d.receivedTotalInr - d.refundsTotalInr;
  }

  const { date: _date, cashDays: _cashDays, ...blank } = emptyDay('');
  void _date;
  void _cashDays;
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
    'expensesInr',
  ] as const;
  for (const d of list) {
    for (const k of numericKeys) totals[k] += d[k];
    totals.passSales.count += d.passSales.count;
    totals.passSales.inr += d.passSales.inr;
    totals.passRedemptions.drinks += d.passRedemptions.drinks;
    totals.passRedemptions.inr += d.passRedemptions.inr;
    for (const m of REPORT_METHODS) {
      totals.received[m] += d.received[m];
      totals.refunds[m] += d.refunds[m];
    }
    for (const c of d.cashDays) {
      if (c.status !== 'closed') continue;
      totals.cashDaysClosed += 1;
      totals.overShortInr += c.over_short_inr ?? 0;
    }
  }

  return { from: input.from, to: input.to, days: list, totals, drawer: drawerTotals(list.flatMap((d) => d.cashDays)) };
}

/**
 * A closed cash day's cash out, the owner's way (see the header): expenses on
 * their own, every other cash out handed to the owner during the day, plus the
 * handover at the close. A day without an expense total (closed before it was
 * kept) counts all its cash out as the owner's.
 */
export function cashDayOuts(c: CashDayRow): { expensesInr: number; cashOutInr: number; handoverInr: number; toOwnerInr: number } {
  const totalOut = c.cash_out_inr ?? 0;
  const expensesInr = Math.min(c.expenses_inr ?? 0, totalOut);
  const cashOutInr = totalOut - expensesInr;
  const handoverInr = c.handover_inr ?? 0;
  return { expensesInr, cashOutInr, handoverInr, toOwnerInr: cashOutInr + handoverInr };
}

/** The range's drawer, from its cash days (oldest first). */
export function drawerTotals(cashDays: CashDayRow[]): DrawerTotals {
  const t: DrawerTotals = {
    days: cashDays.length,
    closed: 0,
    open: 0,
    cashSalesInr: 0,
    cashSalesCount: 0,
    cashRefundsInr: 0,
    cashInInr: 0,
    expensesInr: 0,
    cashOutInr: 0,
    overShortInr: 0,
    handoverInr: 0,
    toOwnerInr: 0,
    floatLeftInr: null,
  };
  for (const c of cashDays) {
    if (c.status !== 'closed') {
      t.open += 1;
      continue;
    }
    const outs = cashDayOuts(c);
    t.closed += 1;
    t.cashSalesInr += c.cash_sales_inr ?? 0;
    t.cashSalesCount += c.cash_sales_count ?? 0;
    t.cashRefundsInr += c.cash_refunds_inr ?? 0;
    t.cashInInr += c.cash_in_inr ?? 0;
    t.expensesInr += outs.expensesInr;
    t.cashOutInr += outs.cashOutInr;
    t.overShortInr += c.over_short_inr ?? 0;
    t.handoverInr += outs.handoverInr;
    t.toOwnerInr += outs.toOwnerInr;
    if (c.float_left_total_inr !== null && c.float_left_total_inr !== undefined) t.floatLeftInr = c.float_left_total_inr;
  }
  return t;
}

// ── The closing count ────────────────────────────────────────────────────────

export interface ClosingCountRow {
  key: string;
  label: string;
  /** Notes/coins counted at the close (for the legacy lump coins row: the ₹ amount). */
  count: number;
  amountInr: number;
  /** Of `count`, left in the drawer as the float. */
  floatLeft: number;
  /** Of `count`, taken out to the owner/bank. */
  takenOut: number;
}

function denomCount(denoms: CashDenoms | null | undefined, key: string): number {
  const n = Number(denoms?.[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * A closed day's count, one row per denomination that was in the drawer
 * (highest first), with how much of it stayed as the float and how much was
 * taken out. Empty when nothing was counted.
 */
export function closingCountRows(day: Pick<CashDayRow, 'closing_denoms' | 'float_left_denoms'>): ClosingCountRow[] {
  const rows: ClosingCountRow[] = [];
  for (const d of DENOMINATIONS) {
    const count = denomCount(day.closing_denoms, d.key);
    if (count === 0) continue;
    const floatLeft = Math.min(count, denomCount(day.float_left_denoms, d.key));
    rows.push({ key: d.key, label: d.label, count, amountInr: count * d.value, floatLeft, takenOut: count - floatLeft });
  }
  // Coins counted before 2026-09 were one lump ₹ amount.
  const coins = denomCount(day.closing_denoms, LEGACY_COINS_KEY);
  if (coins > 0) {
    const floatLeft = Math.min(coins, denomCount(day.float_left_denoms, LEGACY_COINS_KEY));
    rows.push({ key: LEGACY_COINS_KEY, label: 'Coins (₹)', count: coins, amountInr: coins, floatLeft, takenOut: coins - floatLeft });
  }
  return rows;
}

/** The last CLOSED cash day of a date — the store's closing count for it — or null. */
export function closingDayOf(day: Pick<ReportDay, 'cashDays'>): CashDayRow | null {
  const closed = day.cashDays.filter((c) => c.status === 'closed');
  return closed[closed.length - 1] ?? null;
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
  // HIOC Ritual (CP-D21), for the accountant. Ritual sales are already inside
  // Gross sales (the money came in when the Ritual was sold). What a redeemed cup
  // covered is NOT a discount (it was prepaid), so it sits in its own columns
  // rather than in Discounts. Always present, zero when unused, so the sheet's
  // columns never shift with the feature flag.
  ['HIOC Ritual sales', (d) => d.passSales.count],
  ['HIOC Ritual sales (INR)', (d) => d.passSales.inr],
  ['Ritual cups served', (d) => d.passRedemptions.drinks],
  ['Ritual cups covered (INR)', (d) => d.passRedemptions.inr],
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
  ['Cash out to owner (INR)', (d) => d.cashOutInr],
  ['Expenses (INR)', (d) => d.expensesInr],
  // The drawer, by the cash day opened on the date (see the header). Additive
  // figures add up every close of the date; the count, the expected cash and
  // the float are the LAST close's — the store's closing count.
  ['Cash day', (d) => (d.cashDays.length === 0 ? '' : d.cashDays.some((c) => c.status !== 'closed') ? 'open' : 'closed')],
  ['Drawer opening float (INR)', (d) => d.cashDays[0]?.opening_total_inr ?? ''],
  ['Drawer cash sales (INR)', (d) => closedSum(d, (c) => c.cash_sales_inr)],
  ['Drawer expected (INR)', (d) => closingDayOf(d)?.expected_cash_inr ?? ''],
  ['Drawer counted (INR)', (d) => closingDayOf(d)?.counted_total_inr ?? ''],
  ['Over/short (INR)', (d) => closedSum(d, (c) => c.over_short_inr)],
  ['Handed over to owner (INR)', (d) => closedSum(d, (c) => cashDayOuts(c).toOwnerInr)],
  ['Float left (INR)', (d) => closingDayOf(d)?.float_left_total_inr ?? ''],
  ...DENOMINATIONS.map(
    (den): [string, (d: ReportDay) => string | number] => [
      `Closing count ${den.value} (pcs)`,
      (d) => {
        const c = closingDayOf(d);
        return c ? denomCount(c.closing_denoms, den.key) : '';
      },
    ],
  ),
];

/** Σ of a figure over the date's closed cash days; blank when none closed. */
function closedSum(d: ReportDay, f: (c: CashDayRow) => number | null | undefined): number | '' {
  const closed = d.cashDays.filter((c) => c.status === 'closed');
  return closed.length ? closed.reduce((s, c) => s + (f(c) ?? 0), 0) : '';
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per day plus a TOTAL row, for a spreadsheet. */
export function reportCsv(report: Report): string {
  const header = CSV_COLUMNS.map(([h]) => h).join(',');
  const rows = report.days.map((d) => CSV_COLUMNS.map(([, f]) => csvCell(f(d))).join(','));
  const t = report.totals;
  const totalDay: ReportDay = { ...t, date: 'TOTAL', cashDays: [] };
  const drawerTotal: Record<string, number> = {
    'Drawer cash sales (INR)': report.drawer.cashSalesInr,
    'Over/short (INR)': t.overShortInr,
    'Handed over to owner (INR)': report.drawer.toOwnerInr,
  };
  const totalRow = CSV_COLUMNS.map(([h, f]) => csvCell(h in drawerTotal ? drawerTotal[h] : f(totalDay))).join(',');
  return [header, ...rows, totalRow].join('\n') + '\n';
}
