// Beanies, HIOC Ritual and marketing-campaign sheets for the owner's downloads
// (Owner → Reports → Downloads → Loyalty), the numbers behind the Insights page's
// programme section, and the plain-English highlights drawn from them. Pure: the
// rows are read by loyaltyReportsServer.ts (staff and customer names, invoice
// numbers and the flags already resolved), so every rule here is unit-tested.
//
// What is reused, not re-derived:
//   • HIOC Ritual sold / refunded / redeemed / breakage / liability come from
//     buildPassSummary (lib/passes/summary.ts). "Liability at period end" runs
//     that same summary over the passes as they stood at the end of the range,
//     rebuilt from the redemption and adjustment timestamps (passesAsOf).
//   • Points expiring soon is lib/marketing/points.ts expiringWithin (the FIFO
//     rule the nightly expiry job uses); lift is lib/marketing/economics.ts
//     computeLift; phones are masked with lib/passes/summary.ts maskPhone.
//   • The ₹ cost of Beanies on an order is the dataset's beaniesDiscountInr
//     (discount − coupon discounts), because the ledger carries no rupees.
//
// Rules shared by every sheet: the Beanies ledger is the truth (a customer's
// balance is the sum of their rows, never below zero); a "valid" bill is one
// that is not cancelled or rejected; dates and times are IST; money headers end
// in "(INR)" and money is 2 dp; phones are masked to their last four digits.

import { round2, type CsvTable, type CsvValue } from '@/lib/reports/csv';
import { istDateOf, rangeBounds } from '@/lib/reports/reconcile';
import type { ExportOrder } from '@/lib/reports/exports/types';
import { beaniesLabel } from '@/lib/loyalty/brand';
import { computeLift } from '@/lib/marketing/economics';
import { expiringWithin } from '@/lib/marketing/points';
import { passValidTillIso } from '@/lib/passes/ownerUi';
import { passState } from '@/lib/passes/rules';
import { buildPassSummary, maskPhone, type SummaryPassRow } from '@/lib/passes/summary';

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** A pass holder whose earlier pass ended renews by buying another within this many days. */
export const RENEWAL_WINDOW_DAYS = 14;
/** The most sentences programmeHighlights returns. */
export const MAX_HIGHLIGHTS = 6;

// ── Small helpers ────────────────────────────────────────────────────────────

/** HH:MM (24 h, IST) of an instant. */
function istTimeOf(iso: string): string {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** [start, end) of the range as epoch ms: IST midnight of `from` to IST midnight after `to`. */
function windowOf(from: string, to: string): { start: number; end: number } {
  const { startIso, endIso } = rangeBounds(from, to);
  return { start: Date.parse(startIso), end: Date.parse(endIso) };
}

const round1 = (n: number): number => Math.round((n + Number.EPSILON) * 10) / 10;

/** part / whole as a percentage to 1 dp; null when there is no whole. */
function pctOf(part: number, whole: number): number | null {
  return whole > 0 ? round1((part / whole) * 100) : null;
}

/** Whole rupees with Indian digit grouping: ₹1,23,456. For sentences, not sheets. */
function inr(n: number): string {
  const v = Math.round(n);
  const digits = String(Math.abs(v));
  const head = digits.slice(0, -3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}` : digits;
  return `${v < 0 ? '-' : ''}₹${grouped}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── Sheet plumbing ───────────────────────────────────────────────────────────

interface Column<T> {
  header: string;
  value: (r: T) => CsvValue;
  /** Summed on the TOTAL row. */
  sum?: boolean;
}

const headersOf = <T>(columns: Column<T>[]): string[] => columns.map((c) => c.header);
const bodyRows = <T>(columns: Column<T>[], records: T[]): CsvValue[][] =>
  records.map((r) => columns.map((c) => c.value(r)));

function numeric(v: CsvValue): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 'TOTAL' in the first column, the sum of each summed column over the records `countIn` lets through, and an optional note. */
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

// ═════════════════════════════════════════════════════════════════════════════
// Beanies
// ═════════════════════════════════════════════════════════════════════════════

/** One loyalty_transactions row. `points` is signed; `order_id` is null on expiry rows. */
export interface LedgerRow {
  id: string;
  user_id: string;
  order_id: string | null;
  /** earn | redeem | adjust | reverse | expire */
  type: string;
  points: number;
  note: string | null;
  created_at: string;
}

/** What the sheets show of a customer: profiles.name ('' when none) and the phone as stored (masked on output). */
export interface LoyaltyCustomer {
  name: string;
  phone: string;
}

/** loyalty_config: what a Beanie is worth when redeemed, and how long Beanies live (0 = never expire). */
export interface LoyaltyRates {
  inrPerPoint: number;
  expiryDays: number;
}

/** The defaults supabase/phase2-migration.sql seeds, used only if the config row cannot be found. */
export const DEFAULT_LOYALTY_RATES: LoyaltyRates = { inrPerPoint: 1, expiryDays: 30 };

/** The fields of a dataset order the Beanies numbers read. */
export type BeaniesOrder = Pick<ExportOrder, 'id' | 'valid' | 'totalInr' | 'beaniesDiscountInr'>;

export interface BeaniesInput {
  from: string;
  to: string;
  /** "Today": the expiring-soon figures are as of this instant, not the period end. */
  now: Date;
  /** The WHOLE ledger (every customer, all time), in any order. Balances at the period end need all of it. */
  ledger: LedgerRow[];
  rates: LoyaltyRates;
  /** The dataset's orders for the range (loadOrderDataset). */
  orders: BeaniesOrder[];
  /** user_id → name and phone, for the sheets that name people. */
  customers?: ReadonlyMap<string, LoyaltyCustomer>;
  /** order id → printed invoice number, for ledger rows that point at a bill. */
  invoiceNos?: ReadonlyMap<string, string>;
}

export interface ExpiringBeanies {
  points: number;
  valueInr: number;
  customers: number;
}

export interface BeaniesMetrics {
  inrPerPoint: number;
  expiryDays: number;
  earnedPoints: number;
  earnedCustomers: number;
  /** Positive. */
  redeemedPoints: number;
  redeemedCustomers: number;
  /** Positive. */
  expiredPoints: number;
  /** Signed: the net of the 'reverse' rows (negative = points taken back). */
  reversalPoints: number;
  /** Signed: the 'adjust' rows. */
  adjustmentPoints: number;
  /** Signed: every ledger row in the range. */
  netChangePoints: number;
  /** ₹ taken off valid bills by Beanies (from the bills). */
  discountGivenInr: number;
  validBills: number;
  billsWithRedemption: number;
  avgBillWithRedemptionInr: number | null;
  avgBillWithoutRedemptionInr: number | null;
  /** Customers who earned or redeemed in the range. */
  activeMembers: number;
  /** Valid bills in the range that earned Beanies and were not reversed. */
  billsThatEarned: number;
  revenueFromEarningBillsInr: number;
  /** Ledger sums up to the end of the range, each customer held at 0 or more. */
  outstandingPoints: number;
  outstandingValueInr: number;
  holders: number;
  /** As of `now`, not the period end. */
  expiring7: ExpiringBeanies;
  expiring30: ExpiringBeanies;
}

/** Customers a Beanies sheet has to name: any ledger row in the range, or a balance at the end. */
export function beaniesCustomerIds(ledger: LedgerRow[], from: string, to: string): string[] {
  const { start, end } = windowOf(from, to);
  const balance = new Map<string, number>();
  const active = new Set<string>();
  for (const r of ledger) {
    const t = Date.parse(r.created_at);
    if (!(t < end)) continue;
    balance.set(r.user_id, (balance.get(r.user_id) ?? 0) + r.points);
    if (t >= start) active.add(r.user_id);
  }
  return [...balance.entries()].filter(([id, b]) => active.has(id) || b > 0).map(([id]) => id);
}

const average = (xs: BeaniesOrder[]): number | null =>
  xs.length > 0 ? round2(xs.reduce((s, o) => s + o.totalInr, 0) / xs.length) : null;

export function beaniesMetrics(input: BeaniesInput): BeaniesMetrics {
  const { start, end } = windowOf(input.from, input.to);
  const { inrPerPoint, expiryDays } = input.rates;

  const earners = new Set<string>();
  const redeemers = new Set<string>();
  const balances = new Map<string, number>();
  const history = new Map<string, LedgerRow[]>();
  const earnedOrders = new Set<string>();
  const reversedOrders = new Set<string>();
  let earned = 0;
  let redeemed = 0;
  let expired = 0;
  let reversals = 0;
  let adjustments = 0;
  let net = 0;

  for (const r of input.ledger) {
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t)) continue;
    const rows = history.get(r.user_id);
    if (rows) rows.push(r);
    else history.set(r.user_id, [r]);
    if (r.order_id) {
      if (r.type === 'earn') earnedOrders.add(r.order_id);
      if (r.type === 'reverse') reversedOrders.add(r.order_id);
    }
    if (t < end) balances.set(r.user_id, (balances.get(r.user_id) ?? 0) + r.points);
    if (t < start || t >= end) continue;
    net += r.points;
    if (r.type === 'earn') {
      earned += r.points;
      earners.add(r.user_id);
    } else if (r.type === 'redeem') {
      redeemed -= r.points;
      redeemers.add(r.user_id);
    } else if (r.type === 'expire') {
      expired -= r.points;
    } else if (r.type === 'reverse') {
      reversals += r.points;
    } else if (r.type === 'adjust') {
      adjustments += r.points;
    }
  }

  let outstanding = 0;
  let holders = 0;
  for (const b of balances.values()) {
    if (b > 0) {
      outstanding += b;
      holders += 1;
    }
  }

  const expiringIn = (days: number): ExpiringBeanies => {
    let points = 0;
    let customers = 0;
    for (const rows of history.values()) {
      const p = expiringWithin(rows, input.now, expiryDays, days);
      if (p > 0) {
        points += p;
        customers += 1;
      }
    }
    return { points, valueInr: round2(points * inrPerPoint), customers };
  };

  const valid = input.orders.filter((o) => o.valid);
  const withRedemption = valid.filter((o) => o.beaniesDiscountInr > 0);
  const withoutRedemption = valid.filter((o) => !(o.beaniesDiscountInr > 0));
  const earning = valid.filter((o) => earnedOrders.has(o.id) && !reversedOrders.has(o.id));

  return {
    inrPerPoint,
    expiryDays,
    earnedPoints: earned,
    earnedCustomers: earners.size,
    redeemedPoints: redeemed,
    redeemedCustomers: redeemers.size,
    expiredPoints: expired,
    reversalPoints: reversals,
    adjustmentPoints: adjustments,
    netChangePoints: net,
    discountGivenInr: round2(withRedemption.reduce((s, o) => s + o.beaniesDiscountInr, 0)),
    validBills: valid.length,
    billsWithRedemption: withRedemption.length,
    avgBillWithRedemptionInr: average(withRedemption),
    avgBillWithoutRedemptionInr: average(withoutRedemption),
    activeMembers: new Set([...earners, ...redeemers]).size,
    billsThatEarned: earning.length,
    revenueFromEarningBillsInr: round2(earning.reduce((s, o) => s + o.totalInr, 0)),
    outstandingPoints: outstanding,
    outstandingValueInr: round2(outstanding * inrPerPoint),
    holders,
    expiring7: expiringIn(7),
    expiring30: expiringIn(30),
  };
}

// ── Beanies summary ──────────────────────────────────────────────────────────

/** Metric, Value, Note: the month's Beanies programme in one sheet. */
export function beaniesSummary(input: BeaniesInput): CsvTable {
  const m = beaniesMetrics(input);
  const today = istDateOf(input.now.toISOString());
  const never = m.expiryDays <= 0;
  const soon = (days: number, e: ExpiringBeanies): CsvValue[][] => [
    [
      `Beanies expiring in the next ${days} days (points)`,
      e.points,
      never
        ? 'Beanies never expire.'
        : `As of ${today}, not the period end. Held by ${plural(e.customers, 'customer')}.`,
    ],
    [`Beanies expiring in the next ${days} days (INR)`, e.valueInr, `At ₹${m.inrPerPoint} per Beanie.`],
  ];
  return {
    columns: ['Metric', 'Value', 'Note'],
    rows: [
      ['Beanies earned (points)', m.earnedPoints, 'Added when a bill was completed and paid.'],
      ['Customers who earned', m.earnedCustomers, ''],
      ['Beanies redeemed (points)', m.redeemedPoints, 'Spent as a discount on bills (shown as a positive number).'],
      ['Customers who redeemed', m.redeemedCustomers, ''],
      [
        'Beanies discount given (INR)',
        m.discountGivenInr,
        'Rupees taken off valid bills, read from the bills themselves (cancelled and rejected bills left out), so older redemptions show what they really cost.',
      ],
      ['Bills with a Beanies redemption', m.billsWithRedemption, `Out of ${m.validBills} valid bills.`],
      [
        'Average bill with a redemption (INR)',
        m.avgBillWithRedemptionInr ?? '',
        'Bill total after the discount. Blank when no bill used Beanies.',
      ],
      [
        'Average bill without a redemption (INR)',
        m.avgBillWithoutRedemptionInr ?? '',
        'Every other valid bill, walk-ins with no account included.',
      ],
      [
        'Beanies expired (points)',
        m.expiredPoints,
        never ? 'Beanies never expire.' : `Written off after ${m.expiryDays} days unused (shown as a positive number).`,
      ],
      [
        'Net reversals (points)',
        m.reversalPoints,
        'Points taken back (negative) or given back (positive) when a bill was cancelled or refunded; each reversal is the net of that bill’s earn and redeem.',
      ],
      ['Manual adjustments (points)', m.adjustmentPoints, 'Corrections made by hand or by a data fix.'],
      ['Net change in Beanies (points)', m.netChangePoints, 'Earned − redeemed − expired + reversals + adjustments.'],
      [
        'Outstanding Beanies at period end (points)',
        m.outstandingPoints,
        `What customers held at the end of ${input.to}: each customer’s ledger summed up to then, never below zero.`,
      ],
      [
        'Outstanding Beanies at period end (INR)',
        m.outstandingValueInr,
        `At ₹${m.inrPerPoint} per Beanie: what it would cost if every holder redeemed.`,
      ],
      ['Customers holding Beanies at period end', m.holders, ''],
      ...soon(7, m.expiring7),
      ...soon(30, m.expiring30),
      ['Members active in the period', m.activeMembers, 'Customers who earned or redeemed Beanies.'],
      [
        'Revenue from bills that earned Beanies (INR)',
        m.revenueFromEarningBillsInr,
        `${plural(m.billsThatEarned, 'valid bill')}; bills whose Beanies were later reversed are left out.`,
      ],
    ],
  };
}

// ── Beanies ledger ───────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  earn: 'Earned',
  redeem: 'Redeemed',
  adjust: 'Adjusted',
  reverse: 'Reversed',
  expire: 'Expired',
};

const byTimeThenId = (a: LedgerRow, b: LedgerRow): number =>
  Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id);

/** Every ledger row in the range, oldest first, then the net and its split by sign. */
export function beaniesLedger(input: BeaniesInput): CsvTable {
  const { start, end } = windowOf(input.from, input.to);
  const customers = input.customers ?? new Map<string, LoyaltyCustomer>();
  const invoices = input.invoiceNos ?? new Map<string, string>();
  const rows = input.ledger
    .filter((r) => {
      const t = Date.parse(r.created_at);
      return t >= start && t < end;
    })
    .sort(byTimeThenId);

  const columns: Column<LedgerRow>[] = [
    { header: 'Date', value: (r) => istDateOf(r.created_at) },
    { header: 'Time', value: (r) => istTimeOf(r.created_at) },
    { header: 'Customer', value: (r) => customers.get(r.user_id)?.name ?? '' },
    { header: 'Phone', value: (r) => maskPhone(customers.get(r.user_id)?.phone) },
    { header: 'Type', value: (r) => TYPE_LABEL[r.type] ?? r.type },
    { header: 'Points', value: (r) => r.points, sum: true },
    { header: 'Invoice no', value: (r) => (r.order_id ? (invoices.get(r.order_id) ?? '') : '') },
    { header: 'Note', value: (r) => r.note ?? '' },
  ];

  const added = rows.filter((r) => r.points > 0);
  const taken = rows.filter((r) => r.points < 0);
  const split = (label: string, part: LedgerRow[]): CsvValue[] => [
    label,
    '',
    '',
    '',
    '',
    part.reduce((s, r) => s + r.points, 0),
    '',
    plural(part.length, 'row'),
  ];
  return {
    columns: headersOf(columns),
    rows: [
      ...bodyRows(columns, rows),
      totalRow(columns, rows, { note: { header: 'Note', text: 'Net change' } }),
      split('of which added (+)', added),
      split('of which taken off (−)', taken),
    ],
  };
}

// ── Beanies by customer ──────────────────────────────────────────────────────

interface CustomerAcc {
  id: string;
  earned: number;
  redeemed: number;
  expired: number;
  reversed: number;
  balance: number;
  lastMs: number;
}

/** Per customer with ledger activity in the range or a balance at its end, biggest balance first. */
export function beaniesCustomers(input: BeaniesInput): CsvTable {
  const { start, end } = windowOf(input.from, input.to);
  const customers = input.customers ?? new Map<string, LoyaltyCustomer>();
  const accs = new Map<string, CustomerAcc>();
  const active = new Set<string>();

  for (const r of input.ledger) {
    const t = Date.parse(r.created_at);
    if (!(t < end)) continue;
    const a = accs.get(r.user_id) ?? { id: r.user_id, earned: 0, redeemed: 0, expired: 0, reversed: 0, balance: 0, lastMs: t };
    a.balance += r.points;
    a.lastMs = Math.max(a.lastMs, t);
    if (t >= start) {
      active.add(r.user_id);
      if (r.type === 'earn') a.earned += r.points;
      else if (r.type === 'redeem') a.redeemed -= r.points;
      else if (r.type === 'expire') a.expired -= r.points;
      else if (r.type === 'reverse') a.reversed += r.points;
    }
    accs.set(r.user_id, a);
  }

  const nameOf = (a: CustomerAcc) => customers.get(a.id)?.name ?? '';
  const held = (a: CustomerAcc) => Math.max(0, a.balance);
  const people = [...accs.values()]
    .filter((a) => active.has(a.id) || a.balance > 0)
    .sort((a, b) => held(b) - held(a) || nameOf(a).localeCompare(nameOf(b)) || a.id.localeCompare(b.id));

  const columns: Column<CustomerAcc>[] = [
    { header: 'Customer', value: nameOf },
    { header: 'Phone', value: (a) => maskPhone(customers.get(a.id)?.phone) },
    { header: 'Earned', value: (a) => a.earned, sum: true },
    { header: 'Redeemed', value: (a) => a.redeemed, sum: true },
    { header: 'Expired', value: (a) => a.expired, sum: true },
    { header: 'Reversed', value: (a) => a.reversed, sum: true },
    { header: 'Balance at period end', value: held, sum: true },
    { header: 'Last activity', value: (a) => istDateOf(new Date(a.lastMs).toISOString()) },
  ];
  return { columns: headersOf(columns), rows: [...bodyRows(columns, people), totalRow(columns, people)] };
}

// ═════════════════════════════════════════════════════════════════════════════
// HIOC Ritual
// ═════════════════════════════════════════════════════════════════════════════

/** A pass as v_coffee_pass_balances shows it, with the columns the sheets add to SummaryPassRow. */
export interface RitualPass extends SummaryPassRow {
  /** The sale order. */
  order_id: string | null;
  /** "Cappuccino · Large"; '' on a pass sold before per-drink pricing. */
  drink_label: string;
  /** Cups used to date (the view's drinks_used). */
  drinks_used: number;
}

/** coffee_pass_redemptions. Reversed ones are kept: the sheet flags them, the sums skip them. */
export interface RitualRedemption {
  pass_id: string;
  order_id: string;
  drinks: number;
  covered_inr: number;
  created_at: string;
  reversed_at: string | null;
}

/** coffee_pass_adjustments: a 'void' row is the date of the refund. */
export interface RitualAdjustment {
  pass_id: string;
  kind: 'extend' | 'credit' | 'void' | 'unvoid';
  days: number | null;
  drinks: number | null;
  created_at: string;
}

/** An order a pass touched: the sale, or a bill a cup was served on. */
export interface RitualOrder {
  invoiceNo: string;
  totalInr: number;
  valid: boolean;
}

export interface RitualInput {
  from: string;
  to: string;
  now: Date;
  /** Every pass ever sold. */
  passes: RitualPass[];
  /** Every redemption ever made. */
  redemptions: RitualRedemption[];
  /** Every adjustment ever made. */
  adjustments: RitualAdjustment[];
  /** pass holder user_id → name and phone. */
  holders?: ReadonlyMap<string, LoyaltyCustomer>;
  /** order id → invoice number and total, for the sale and redemption orders. */
  orders?: ReadonlyMap<string, RitualOrder>;
}

/** The passes whose holders, and the orders whose invoice numbers, the Ritual sheets show. */
export function ritualReferences(
  input: Pick<RitualInput, 'from' | 'to' | 'passes' | 'redemptions'>,
): { userIds: string[]; orderIds: string[] } {
  const { start, end } = windowOf(input.from, input.to);
  const inRange = (iso: string) => {
    const t = Date.parse(iso);
    return t >= start && t < end;
  };
  const byId = new Map(input.passes.map((p) => [p.id, p]));
  const users = new Set<string>();
  const orders = new Set<string>();
  for (const p of input.passes) {
    if (!inRange(p.created_at)) continue;
    users.add(p.user_id);
    if (p.order_id) orders.add(p.order_id);
  }
  for (const r of input.redemptions) {
    if (!inRange(r.created_at)) continue;
    orders.add(r.order_id);
    const holder = byId.get(r.pass_id)?.user_id;
    if (holder) users.add(holder);
  }
  return { userIds: [...users], orderIds: [...orders] };
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k);
    if (list) list.push(x);
    else out.set(k, [x]);
  }
  return out;
}

/**
 * The passes as they stood at `asOfMs`, in the shape buildPassSummary reads, so
 * its "active" liability can be asked of any past instant. Passes bought later
 * are left out. A pass's state then is rebuilt from the history, newest first:
 *   • cups left = cups sold + credits given before, minus cups redeemed before
 *     and not reversed by then;
 *   • expiry = today's expiry less any extension made after;
 *   • refunded / void = a 'void' adjustment (the refund date) not yet undone by
 *     an 'unvoid'. A pass that is void now with no 'void' row to date it is
 *     treated as void throughout.
 */
export function passesAsOf(
  passes: RitualPass[],
  redemptions: RitualRedemption[],
  adjustments: RitualAdjustment[],
  asOfMs: number,
): SummaryPassRow[] {
  const adjustmentsOf = groupBy(adjustments, (a) => a.pass_id);
  const redemptionsOf = groupBy(redemptions, (r) => r.pass_id);
  const out: SummaryPassRow[] = [];
  for (const p of passes) {
    if (!(Date.parse(p.created_at) < asOfMs)) continue;
    const adj = adjustmentsOf.get(p.id) ?? [];

    let expires = Date.parse(p.expires_at);
    let credited = 0;
    for (const a of adj) {
      const t = Date.parse(a.created_at);
      if (a.kind === 'extend' && t >= asOfMs) expires -= (a.days ?? 0) * DAY_MS;
      if (a.kind === 'credit' && t < asOfMs) credited += a.drinks ?? 0;
    }

    let used = 0;
    for (const r of redemptionsOf.get(p.id) ?? []) {
      const reversedAt = r.reversed_at ? Date.parse(r.reversed_at) : null;
      if (Date.parse(r.created_at) < asOfMs && (reversedAt === null || reversedAt >= asOfMs)) used += r.drinks;
    }

    const flips = adj
      .filter((a) => (a.kind === 'void' || a.kind === 'unvoid') && Date.parse(a.created_at) < asOfMs)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const voidNow = p.status !== 'active';
    // Void now with no dated 'void' row: nothing says when, so it is void throughout.
    const voided = voidNow && !adj.some((a) => a.kind === 'void') ? true : flips[flips.length - 1]?.kind === 'void';

    out.push({
      ...p,
      status: voided ? (voidNow ? p.status : 'void') : 'active',
      expires_at: new Date(expires).toISOString(),
      drinks_remaining: Math.max(0, p.drinks_total + credited - used),
    });
  }
  return out;
}

/** Epoch ms of the last 'void' adjustment per pass: the day a refunded pass ended. */
function voidDates(adjustments: RitualAdjustment[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of adjustments) {
    if (a.kind !== 'void') continue;
    const t = Date.parse(a.created_at);
    if (!(t <= (out.get(a.pass_id) ?? -Infinity))) out.set(a.pass_id, t);
  }
  return out;
}

/**
 * When a pass ended, or null while it is still usable (or a refund cannot be
 * dated): refunded at the refund, used up at its last cup, expired at its expiry.
 */
function endedAt(
  p: RitualPass,
  nowMs: number,
  voidedAt: Map<string, number>,
  lastCup: Map<string, number>,
): number | null {
  if (p.status !== 'active') return voidedAt.get(p.id) ?? null;
  const expires = Date.parse(p.expires_at);
  if (p.drinks_remaining <= 0) {
    const used = lastCup.get(p.id);
    return used === undefined ? expires : Math.min(used, expires);
  }
  return expires <= nowMs ? expires : null;
}

export interface PlanSales {
  plan_name: string;
  count: number;
  inr: number;
}

export interface RitualMetrics {
  soldCount: number;
  soldInr: number;
  soldByPlan: PlanSales[];
  refundedCount: number;
  refundedInr: number;
  cupsServed: number;
  coveredInr: number;
  /** Holders who bought a pass in the range. */
  uniqueBuyers: number;
  /** Of those, holders with two or more passes by the end of the range. */
  repeatBuyers: number;
  /** Passes bought in the range within RENEWAL_WINDOW_DAYS of the buyer's earlier pass ending. */
  renewals: number;
  /** Passes that ended in the range and whose renewal window has closed. */
  endedPasses: number;
  /** Of those, followed by another purchase within the window. */
  renewedPasses: number;
  renewalRatePct: number | null;
  passesWithCup: number;
  avgDaysToFirstCup: number | null;
  holdersServed: number;
  /** Bills a cup was served on in the range. */
  ritualBills: number;
  visitsPerHolder: number | null;
  /** Bill totals of those bills: what customers paid on top of the cups. */
  extraSpendInr: number;
  cupsOutstandingAtEnd: number;
  liabilityAtEndInr: number;
  cupsOutstandingToday: number;
  liabilityTodayInr: number;
  breakageCups: number;
  breakageInr: number;
}

export function ritualMetrics(input: RitualInput): RitualMetrics {
  const { from, to, now, passes, redemptions, adjustments } = input;
  const { start, end } = windowOf(from, to);
  const nowMs = now.getTime();
  const inRange = (iso: string) => {
    const t = Date.parse(iso);
    return t >= start && t < end;
  };
  const summaryOf = (rows: SummaryPassRow[], reds: RitualRedemption[], at: Date) =>
    buildPassSummary({ passes: rows, redemptions: reds, recent: [], holders: {}, from, to, now: at });

  const summary = summaryOf(passes, redemptions, now);
  const atEnd = summaryOf(passesAsOf(passes, redemptions, adjustments, end), [], new Date(end)).active;

  const byId = new Map(passes.map((p) => [p.id, p]));
  const live = redemptions.filter((r) => !r.reversed_at);
  const sold = passes.filter((p) => p.status === 'active' && inRange(p.created_at));
  const buyers = new Set(sold.map((p) => p.user_id));

  // Genuine purchases per holder (refunded and void passes are not purchases that stuck).
  const boughtBy = groupBy(passes.filter((p) => p.status === 'active'), (p) => p.user_id);
  const allBy = groupBy(passes, (p) => p.user_id);
  let repeatBuyers = 0;
  for (const u of buyers) {
    if ((boughtBy.get(u) ?? []).filter((p) => Date.parse(p.created_at) < end).length >= 2) repeatBuyers += 1;
  }

  // Renewals: a holder's earlier pass ended, and they bought another within the window.
  const windowMs = RENEWAL_WINDOW_DAYS * DAY_MS;
  const voidedAt = voidDates(adjustments);
  const lastCup = new Map<string, number>();
  for (const r of live) {
    const t = Date.parse(r.created_at);
    if (!(t <= (lastCup.get(r.pass_id) ?? -Infinity))) lastCup.set(r.pass_id, t);
  }
  const ends = new Map<string, number | null>(passes.map((p) => [p.id, endedAt(p, nowMs, voidedAt, lastCup)]));
  const followUp = (q: RitualPass, p: RitualPass): boolean => {
    const e = ends.get(q.id);
    const bought = Date.parse(p.created_at);
    return p.id !== q.id && e != null && bought > Date.parse(q.created_at) && bought >= e && bought - e <= windowMs;
  };
  const renewals = sold.filter((p) => (allBy.get(p.user_id) ?? []).some((q) => followUp(q, p))).length;
  let endedPasses = 0;
  let renewedPasses = 0;
  for (const q of passes) {
    const e = ends.get(q.id);
    if (e == null || e < start || e >= end || e + windowMs > nowMs) continue;
    endedPasses += 1;
    if ((boughtBy.get(q.user_id) ?? []).some((p) => followUp(q, p))) renewedPasses += 1;
  }

  // Days from sale to first cup, in IST calendar days, over this range's passes that have been used.
  const firstCup = new Map<string, number>();
  for (const r of live) {
    const t = Date.parse(r.created_at);
    const seen = firstCup.get(r.pass_id);
    if (seen === undefined || t < seen) firstCup.set(r.pass_id, t);
  }
  const gaps: number[] = [];
  for (const p of sold) {
    const first = firstCup.get(p.id);
    if (first === undefined) continue;
    const day = (iso: string) => Date.parse(`${istDateOf(iso)}T00:00:00Z`);
    gaps.push((day(new Date(first).toISOString()) - day(p.created_at)) / DAY_MS);
  }

  // Visits and spend on the bills cups were served on in the range.
  const holders = new Set<string>();
  const bills = new Set<string>();
  for (const r of live) {
    const holder = byId.get(r.pass_id)?.user_id;
    if (!holder || !inRange(r.created_at)) continue;
    holders.add(holder);
    bills.add(r.order_id);
  }
  let extra = 0;
  for (const id of bills) {
    const o = input.orders?.get(id);
    if (o?.valid) extra += o.totalInr;
  }

  return {
    soldCount: summary.sold.count,
    soldInr: summary.sold.inr,
    soldByPlan: summary.sold_by_plan,
    refundedCount: summary.refunded.count,
    refundedInr: summary.refunded.inr,
    cupsServed: summary.redeemed.cups,
    coveredInr: summary.redeemed.covered_inr,
    uniqueBuyers: buyers.size,
    repeatBuyers,
    renewals,
    endedPasses,
    renewedPasses,
    renewalRatePct: pctOf(renewedPasses, endedPasses),
    passesWithCup: gaps.length,
    avgDaysToFirstCup: gaps.length > 0 ? round1(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null,
    holdersServed: holders.size,
    ritualBills: bills.size,
    visitsPerHolder: holders.size > 0 ? round1(bills.size / holders.size) : null,
    extraSpendInr: round2(extra),
    cupsOutstandingAtEnd: atEnd.cups_outstanding,
    liabilityAtEndInr: atEnd.liability_inr,
    cupsOutstandingToday: summary.active.cups_outstanding,
    liabilityTodayInr: summary.active.liability_inr,
    breakageCups: summary.expired_unused.cups,
    breakageInr: summary.expired_unused.inr,
  };
}

// ── Ritual summary ───────────────────────────────────────────────────────────

/** Metric, Value, Note: the month's HIOC Ritual programme in one sheet. */
export function ritualSummary(input: RitualInput): CsvTable {
  const m = ritualMetrics(input);
  const today = istDateOf(input.now.toISOString());
  return {
    columns: ['Metric', 'Value', 'Note'],
    rows: [
      ['Rituals sold', m.soldCount, 'Passes bought in the period; refunded ones are left out.'],
      [
        'Ritual sales (INR)',
        m.soldInr,
        'What customers paid for the passes, before GST (GST is charged on the sale itself).',
      ],
      ...m.soldByPlan.map((p): CsvValue[] => [`Sold: ${p.plan_name}`, p.count, `${inr(p.inr)} before GST.`]),
      [
        'Rituals refunded',
        m.refundedCount,
        `${inr(m.refundedInr)} given back, counted in the period the pass was sold.`,
      ],
      ['Customers who bought a Ritual', m.uniqueBuyers, ''],
      ['Repeat buyers', m.repeatBuyers, 'Of those customers, how many have bought two or more passes by the end of the period.'],
      [
        'Renewals',
        m.renewals,
        `Passes bought within ${RENEWAL_WINDOW_DAYS} days of the buyer’s earlier pass ending (used up, expired or refunded).`,
      ],
      [
        'Renewal rate (%)',
        m.renewalRatePct ?? '',
        m.endedPasses > 0
          ? `${m.renewedPasses} of the ${m.endedPasses} passes that ended in the period were followed by a new one within ${RENEWAL_WINDOW_DAYS} days. Passes that ended in the last ${RENEWAL_WINDOW_DAYS} days are left out until that window closes.`
          : 'No pass ended in the period with its renewal window closed.',
      ],
      [
        'Average days from sale to first cup',
        m.avgDaysToFirstCup ?? '',
        `Calendar days, over the ${plural(m.passesWithCup, 'pass', 'passes')} sold in the period that have been used.`,
      ],
      ['Cups served', m.cupsServed, 'Cups redeemed in the period; reversed ones are not counted.'],
      ['Menu value of cups served (INR)', m.coveredInr, 'What the cups covered at menu prices.'],
      [
        'Visits per holder',
        m.visitsPerHolder ?? '',
        `${plural(m.ritualBills, 'bill')} with a Ritual cup, from ${plural(m.holdersServed, 'holder')}.`,
      ],
      [
        'Extra spend on Ritual bills (INR)',
        m.extraSpendInr,
        'Bill totals of the bills that used a cup: what customers paid on top of it.',
      ],
      [
        'Cups still to serve at period end',
        m.cupsOutstandingAtEnd,
        'Cups on passes that were still in date and not refunded at the end of the period.',
      ],
      [
        'Liability at period end (INR)',
        m.liabilityAtEndInr,
        'Those cups at what the customer paid per cup. Rebuilt from the redemption, extension, credit and refund dates, so it does not change as later cups are served.',
      ],
      [
        'Liability today (INR)',
        m.liabilityTodayInr,
        `As of ${today}: ${plural(m.cupsOutstandingToday, 'cup')} on live passes.`,
      ],
      [
        'Cups expired unused',
        m.breakageCups,
        'Cups left on passes whose expiry fell in the period (breakage).',
      ],
      ['Breakage (INR)', m.breakageInr, 'Those cups at what the customer paid per cup.'],
    ],
  };
}

// ── Passes sold ──────────────────────────────────────────────────────────────

const PASS_STATE_LABEL = {
  active: 'Active',
  used_up: 'Used up',
  expired: 'Expired',
  refunded: 'Refunded',
  void: 'Void',
} as const;

/** Every pass sold in the range, oldest first; refunded and void passes are listed but not totalled. */
export function ritualPasses(input: RitualInput): CsvTable {
  const { start, end } = windowOf(input.from, input.to);
  const holders = input.holders ?? new Map<string, LoyaltyCustomer>();
  const orders = input.orders ?? new Map<string, RitualOrder>();
  const refundedOn = voidDates(input.adjustments);
  const rows = input.passes
    .filter((p) => {
      const t = Date.parse(p.created_at);
      return t >= start && t < end;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  const counted = (p: RitualPass) => p.status === 'active';

  const columns: Column<RitualPass>[] = [
    { header: 'Sold on', value: (p) => istDateOf(p.created_at) },
    { header: 'Invoice no', value: (p) => (p.order_id ? (orders.get(p.order_id)?.invoiceNo ?? '') : '') },
    { header: 'Customer', value: (p) => holders.get(p.user_id)?.name ?? '' },
    { header: 'Phone', value: (p) => maskPhone(holders.get(p.user_id)?.phone) },
    { header: 'Plan', value: (p) => p.plan_name },
    { header: 'Drink', value: (p) => p.drink_label },
    { header: 'Cups', value: (p) => p.drinks_total, sum: true },
    { header: 'Price (INR)', value: (p) => round2(p.price_inr), sum: true },
    // expires_at is the instant the next day starts; the owner reads the last day it works.
    { header: 'Expires', value: (p) => istDateOf(passValidTillIso(p.expires_at)) },
    { header: 'Cups used (to date)', value: (p) => p.drinks_used, sum: true },
    { header: 'Cups left', value: (p) => p.drinks_remaining, sum: true },
    { header: 'State', value: (p) => PASS_STATE_LABEL[passState(p, input.now)] },
    {
      header: 'Refunded on',
      value: (p) => {
        const t = p.status === 'refunded' ? refundedOn.get(p.id) : undefined;
        return t === undefined ? '' : istDateOf(new Date(t).toISOString());
      },
    },
  ];
  return {
    columns: headersOf(columns),
    rows: [
      ...bodyRows(columns, rows),
      totalRow(columns, rows, {
        countIn: counted,
        note: { header: 'State', text: 'Refunded and void passes not counted' },
      }),
    ],
  };
}

// ── Cups served ──────────────────────────────────────────────────────────────

/** Every redemption in the range, reversed ones flagged and left out of the TOTAL. */
export function ritualRedemptions(input: RitualInput): CsvTable {
  const { start, end } = windowOf(input.from, input.to);
  const holders = input.holders ?? new Map<string, LoyaltyCustomer>();
  const orders = input.orders ?? new Map<string, RitualOrder>();
  const byId = new Map(input.passes.map((p) => [p.id, p]));
  const rows = input.redemptions
    .filter((r) => {
      const t = Date.parse(r.created_at);
      return t >= start && t < end;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.order_id.localeCompare(b.order_id));

  const columns: Column<RitualRedemption>[] = [
    { header: 'Date', value: (r) => istDateOf(r.created_at) },
    { header: 'Invoice no', value: (r) => orders.get(r.order_id)?.invoiceNo ?? '' },
    {
      header: 'Customer',
      value: (r) => {
        const holder = byId.get(r.pass_id)?.user_id;
        return holder ? (holders.get(holder)?.name ?? '') : '';
      },
    },
    { header: 'Plan', value: (r) => byId.get(r.pass_id)?.plan_name ?? '' },
    { header: 'Cups', value: (r) => r.drinks, sum: true },
    { header: 'Covered (INR)', value: (r) => round2(r.covered_inr), sum: true },
    { header: 'Bill total (INR)', value: (r) => (orders.has(r.order_id) ? round2(orders.get(r.order_id)?.totalInr ?? 0) : '') },
    { header: 'Reversed', value: (r) => (r.reversed_at ? 'Yes' : 'No') },
  ];
  return {
    columns: headersOf(columns),
    rows: [
      ...bodyRows(columns, rows),
      totalRow(columns, rows, {
        countIn: (r) => !r.reversed_at,
        note: { header: 'Reversed', text: 'Reversed cups not counted' },
      }),
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Marketing campaigns
// ═════════════════════════════════════════════════════════════════════════════

/** One campaign's results, as the server folds them from its recipients (lib/marketing/server/campaigns.ts). */
export interface CampaignRecord {
  name: string;
  /** The playbook's owner-facing name, or 'Manual campaign'. */
  kind: string;
  /** offerText(): '' when the offer is Beanies or nothing. */
  offer: string;
  startedAt: string | null;
  sent: number;
  delivered: number;
  read: number;
  clicked: number;
  conversions: number;
  revenueInr: number;
  /** Treated recipients sent a message who came back (the lift numerator). */
  treatedConverted: number;
  holdoutN: number;
  holdoutConverted: number;
  /** What the messages cost. */
  costInr: number;
  /** Coupon discount on this campaign's codes, valid bills only. */
  couponDiscountInr: number;
}

export interface CampaignResult extends CampaignRecord {
  conversionPct: number | null;
  holdoutConversionPct: number | null;
  /** Percentage points; null until the holdout is big enough to mean anything. */
  liftPp: number | null;
}

export interface CampaignMetrics {
  campaigns: CampaignResult[];
  totals: {
    sent: number;
    delivered: number;
    read: number;
    clicked: number;
    conversions: number;
    conversionPct: number | null;
    revenueInr: number;
    costInr: number;
    couponDiscountInr: number;
  };
}

export function campaignMetrics(records: CampaignRecord[]): CampaignMetrics {
  const campaigns = [...records]
    .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || a.name.localeCompare(b.name))
    .map((c): CampaignResult => {
      const lift = computeLift({
        treated_delivered: c.sent,
        treated_converted: c.treatedConverted,
        holdout_n: c.holdoutN,
        holdout_converted: c.holdoutConverted,
      });
      return {
        ...c,
        conversionPct: pctOf(c.conversions, c.sent),
        holdoutConversionPct: pctOf(c.holdoutConverted, c.holdoutN),
        liftPp: lift.lift_pp === null ? null : round1(lift.lift_pp),
      };
    });
  const sum = (f: (c: CampaignResult) => number) => campaigns.reduce((s, c) => s + f(c), 0);
  const sent = sum((c) => c.sent);
  const conversions = sum((c) => c.conversions);
  return {
    campaigns,
    totals: {
      sent,
      delivered: sum((c) => c.delivered),
      read: sum((c) => c.read),
      clicked: sum((c) => c.clicked),
      conversions,
      conversionPct: pctOf(conversions, sent),
      revenueInr: round2(sum((c) => c.revenueInr)),
      costInr: round2(sum((c) => c.costInr)),
      couponDiscountInr: round2(sum((c) => c.couponDiscountInr)),
    },
  };
}

/** One row per campaign that was running in the range, with a TOTAL row. Empty (header only) with no campaigns. */
export function campaignPerformance(records: CampaignRecord[]): CsvTable {
  const { campaigns, totals } = campaignMetrics(records);
  const columns = [
    'Campaign',
    'Kind',
    'Offer',
    'Started',
    'Sent',
    'Delivered',
    'Read',
    'Clicked',
    'Conversions',
    'Conversion %',
    'Revenue (INR)',
    'Holdout conversion %',
    'Lift (pp)',
    'Cost (INR)',
    'Coupon discount given (INR)',
  ];
  if (campaigns.length === 0) return { columns, rows: [] };
  return {
    columns,
    rows: [
      ...campaigns.map((c): CsvValue[] => [
        c.name,
        c.kind,
        c.offer,
        c.startedAt ? istDateOf(c.startedAt) : '',
        c.sent,
        c.delivered,
        c.read,
        c.clicked,
        c.conversions,
        c.conversionPct ?? '',
        round2(c.revenueInr),
        c.holdoutConversionPct ?? '',
        c.liftPp ?? '',
        round2(c.costInr),
        round2(c.couponDiscountInr),
      ]),
      [
        'TOTAL',
        '',
        '',
        '',
        totals.sent,
        totals.delivered,
        totals.read,
        totals.clicked,
        totals.conversions,
        totals.conversionPct ?? '',
        totals.revenueInr,
        '',
        '',
        totals.costInr,
        totals.couponDiscountInr,
      ],
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Insights
// ═════════════════════════════════════════════════════════════════════════════

/** What the Insights page renders for Beanies, HIOC Ritual and campaigns (loyaltyReportsServer.loadProgrammeInsights). */
export interface ProgrammeInsights {
  range: { from: string; to: string };
  beanies: BeaniesMetrics;
  /** null while the HIOC Ritual flag is off, or its tables are missing. */
  ritual: RitualMetrics | null;
  /** null while the marketing flag is off, or its tables are missing. */
  campaigns: CampaignMetrics | null;
  highlights: string[];
  /** A section that was switched on but failed to load, in plain words (the section is then null). */
  problems: { ritual?: string; campaigns?: string };
}

/**
 * Up to MAX_HIGHLIGHTS plain-English sentences from the numbers, most useful
 * first. A sentence appears only when its numbers exist: nothing is said about a
 * ratio whose denominator is 0, a section that is off, or a figure of 0.
 */
export function programmeHighlights(
  p: Pick<ProgrammeInsights, 'beanies' | 'ritual' | 'campaigns'>,
): string[] {
  const { beanies: b, ritual: r, campaigns: c } = p;
  const out: string[] = [];

  if (b.billsWithRedemption > 0 && b.avgBillWithRedemptionInr !== null && b.avgBillWithoutRedemptionInr !== null) {
    out.push(
      `Bills where customers redeemed Beanies averaged ${inr(b.avgBillWithRedemptionInr)} vs ${inr(b.avgBillWithoutRedemptionInr)} without.`,
    );
  }

  if (b.outstandingPoints > 0 && b.holders > 0) {
    out.push(
      `${inr(b.outstandingValueInr)} of Beanies (${plural(b.holders, 'customer')}) is outstanding at the end of the period — your liability if all are redeemed.`,
    );
  }

  if (b.expiring7.points > 0) {
    out.push(
      `${beaniesLabel(b.expiring7.points)} (${inr(b.expiring7.valueInr)}) held by ${plural(b.expiring7.customers, 'customer')} ${b.expiring7.points === 1 ? 'expires' : 'expire'} in the next 7 days — a reminder could bring them back.`,
    );
  }

  if (r && (r.visitsPerHolder !== null || r.renewalRatePct !== null)) {
    const visits =
      r.visitsPerHolder === null
        ? ''
        : `Ritual holders came in ${r.visitsPerHolder} ${r.visitsPerHolder === 1 ? 'time' : 'times'} on average`;
    const renewed =
      r.renewalRatePct === null
        ? ''
        : `${r.renewalRatePct}% of Ritual passes that ended were renewed within ${RENEWAL_WINDOW_DAYS} days`;
    out.push(`${[visits, renewed].filter(Boolean).join('; ')}.`);
  }

  const best = c?.campaigns
    .filter((x) => x.sent > 0 && x.conversions > 0)
    .sort((x, y) => y.revenueInr - x.revenueInr || x.name.localeCompare(y.name))[0];
  if (best) {
    const cost = best.costInr > 0 ? ` for ${inr(best.costInr)} of messages` : '';
    const lift = best.liftPp !== null && best.liftPp > 0 ? `, ${best.liftPp} points more than the holdout` : '';
    out.push(
      `“${best.name}” brought back ${plural(best.conversions, 'customer')} worth ${inr(best.revenueInr)}${cost}${lift}.`,
    );
  }

  if (r && r.liabilityAtEndInr > 0) {
    out.push(
      `${inr(r.liabilityAtEndInr)} of Ritual cups (${plural(r.cupsOutstandingAtEnd, 'cup')}) are still owed to customers at the end of the period.`,
    );
  }

  if (b.billsWithRedemption > 0 && b.validBills > 0 && b.discountGivenInr > 0) {
    out.push(
      `${b.billsWithRedemption} of ${b.validBills} bills (${round1((b.billsWithRedemption / b.validBills) * 100)}%) used Beanies, taking ${inr(b.discountGivenInr)} off.`,
    );
  }

  if (r && r.breakageInr > 0) {
    out.push(`${inr(r.breakageInr)} of Ritual cups (${plural(r.breakageCups, 'cup')}) expired unused in the period.`);
  }

  return out.slice(0, MAX_HIGHLIGHTS);
}
