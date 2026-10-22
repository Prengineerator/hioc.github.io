import type { Platform } from './types';

// Everything Owner → Online orders shows, worked out from the stored rows
// (supabase/2026-10-online-settlements.sql). Pure, so the money math is unit
// tested (tests/onlineSettlementsSummary.test.ts) apart from the database.
//
// Definitions (the same as the Apr–Sep analysis the owner already uses):
//   orders          delivered orders
//   menu sales      item total before discount, delivered orders
//   discount        restaurant-funded discounts, delivered orders
//   platform fees   commission + payment gateway fee + 18% GST on both
//   payout          the platform's order-level payout, EVERY status — a
//                   cancelled order can refund the café, a rejected or
//                   timed-out one can cost a penalty
//   ads             ad bills, spread evenly over the days each bill covers,
//                   so a week or month gets its own share
//   in your bank    payout − ads
//   kept per ₹100   in your bank ÷ menu sales × 100

export interface OrderRow {
  platform: Platform;
  order_id: string;
  ordered_at: string;
  status: string;
  offer: string;
  cancel_reason: string;
  cancel_stage: string;
  menu_sales_inr: number | string;
  discount_inr: number | string;
  commission_inr: number | string;
  payment_fee_inr: number | string;
  gst_on_fees_inr: number | string;
  tcs_inr: number | string;
  tds_inr: number | string;
  payout_inr: number | string;
  unsettled_inr: number | string;
  settlement_status: string;
  settlement_date: string | null;
  utr: string;
  customer_ref: string | null;
}

export interface DeductionRow {
  platform: Platform;
  kind: string;
  amount_inr: number | string;
  period_start: string | null;
  period_end: string | null;
  report_period_end: string | null;
}

export interface Metrics {
  orders: number;
  notDelivered: number;
  menuSales: number;
  discount: number;
  fees: number;
  tcsTds: number;
  payout: number;
  ads: number;
  inBank: number;
  unsettled: number;
  customers: number;
  /** Shares are 0–1; null when there were no sales to divide by. */
  discountShare: number | null;
  feesShare: number | null;
  keptPer100: number | null;
  avgBill: number | null;
}

export interface Bucket {
  key: string; // 'YYYY-MM-DD' (week's Monday) or 'YYYY-MM'
  label: string;
  all: Metrics;
  byPlatform: Partial<Record<Platform, Metrics>>;
}

export interface TransferRow {
  platform: Platform;
  utr: string;
  settlementDate: string | null;
  orders: number;
  payout: number;
}

export interface OfferRow {
  platform: Platform;
  offer: string;
  orders: number;
  menuSales: number;
  discountShare: number | null;
  payoutShare: number | null;
}

export interface ProblemRow {
  platform: Platform;
  orderId: string;
  orderedAt: string;
  status: string;
  reason: string;
  stage: string;
  menuSales: number;
  payout: number;
}

export interface OnlineSummary {
  from: string;
  to: string;
  group: 'week' | 'month';
  platforms: Platform[];
  totals: Metrics;
  byPlatform: Partial<Record<Platform, Metrics>>;
  buckets: Bucket[];
  transfers: TransferRow[];
  offers: OfferRow[];
  problems: ProblemRow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 330 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const n = (v: number | string | null | undefined) => {
  const x = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** The IST calendar day of a timestamp ('2026-04-01T05:35:31+00:00' → '2026-04-01'). */
export function istDay(ts: string): string {
  return new Date(new Date(ts).getTime() + IST_MS).toISOString().slice(0, 10);
}

function addDays(day: string, k: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + k * DAY_MS).toISOString().slice(0, 10);
}

/** Monday of the week a day falls in. */
export function weekStart(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

export function bucketKey(day: string, group: 'week' | 'month'): string {
  return group === 'week' ? weekStart(day) : day.slice(0, 7);
}

export function bucketLabel(key: string, group: 'week' | 'month'): string {
  if (group === 'month') return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  const end = addDays(key, 6);
  const d = (s: string) => `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]}`;
  return `${d(key)} – ${d(end)}`;
}

/**
 * An ad bill spread evenly over its dates, clipped to [from, to]: day → ₹.
 * A bill without readable dates lands on its report's last day.
 */
export function spreadDeduction(d: DeductionRow, from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  const start = d.period_start ?? d.period_end ?? d.report_period_end;
  const end = d.period_end ?? d.period_start ?? d.report_period_end;
  if (!start || !end || end < start) return out;
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  const per = n(d.amount_inr) / days;
  for (let day = start; day <= end; day = addDays(day, 1)) {
    if (day >= from && day <= to) out.set(day, (out.get(day) ?? 0) + per);
  }
  return out;
}

interface Acc {
  orders: number;
  notDelivered: number;
  menuSales: number;
  discount: number;
  fees: number;
  tcsTds: number;
  payout: number;
  ads: number;
  unsettled: number;
  customers: Set<string>;
}

const emptyAcc = (): Acc => ({
  orders: 0,
  notDelivered: 0,
  menuSales: 0,
  discount: 0,
  fees: 0,
  tcsTds: 0,
  payout: 0,
  ads: 0,
  unsettled: 0,
  customers: new Set(),
});

function addOrder(a: Acc, o: OrderRow) {
  a.payout += n(o.payout_inr);
  a.unsettled += n(o.unsettled_inr);
  if (o.status !== 'delivered') {
    a.notDelivered++;
    return;
  }
  a.orders++;
  a.menuSales += n(o.menu_sales_inr);
  a.discount += n(o.discount_inr);
  a.fees += n(o.commission_inr) + n(o.payment_fee_inr) + n(o.gst_on_fees_inr);
  a.tcsTds += n(o.tcs_inr) + n(o.tds_inr);
  if (o.customer_ref) a.customers.add(`${o.platform}:${o.customer_ref}`);
}

const r2 = (x: number) => Math.round(x * 100) / 100;

function finish(a: Acc): Metrics {
  const inBank = a.payout - a.ads;
  const sales = a.menuSales;
  return {
    orders: a.orders,
    notDelivered: a.notDelivered,
    menuSales: r2(sales),
    discount: r2(a.discount),
    fees: r2(a.fees),
    tcsTds: r2(a.tcsTds),
    payout: r2(a.payout),
    ads: r2(a.ads),
    inBank: r2(inBank),
    unsettled: r2(a.unsettled),
    customers: a.customers.size,
    discountShare: sales > 0 ? a.discount / sales : null,
    feesShare: sales > 0 ? a.fees / sales : null,
    keptPer100: sales > 0 ? (inBank / sales) * 100 : null,
    avgBill: a.orders > 0 ? sales / a.orders : null,
  };
}

export function buildOnlineSummary(input: {
  orders: OrderRow[];
  deductions: DeductionRow[];
  from: string;
  to: string;
  group: 'week' | 'month';
  platform: Platform | 'all';
}): OnlineSummary {
  const { from, to, group } = input;
  const want = (p: Platform) => input.platform === 'all' || input.platform === p;
  const orders = input.orders.filter((o) => want(o.platform) && istDay(o.ordered_at) >= from && istDay(o.ordered_at) <= to);
  const deductions = input.deductions.filter((d) => want(d.platform) && d.kind === 'ads');

  const total = emptyAcc();
  const perPlatform = new Map<Platform, Acc>();
  const buckets = new Map<string, { all: Acc; byPlatform: Map<Platform, Acc> }>();
  const bucketOf = (key: string) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { all: emptyAcc(), byPlatform: new Map() }));
    return b;
  };
  const platAcc = (m: Map<Platform, Acc>, p: Platform) => {
    let a = m.get(p);
    if (!a) m.set(p, (a = emptyAcc()));
    return a;
  };

  for (const o of orders) {
    const b = bucketOf(bucketKey(istDay(o.ordered_at), group));
    for (const a of [total, platAcc(perPlatform, o.platform), b.all, platAcc(b.byPlatform, o.platform)]) addOrder(a, o);
  }
  for (const d of deductions) {
    for (const [day, amt] of spreadDeduction(d, from, to)) {
      const b = bucketOf(bucketKey(day, group));
      for (const a of [total, platAcc(perPlatform, d.platform), b.all, platAcc(b.byPlatform, d.platform)]) a.ads += amt;
    }
  }

  const finishMap = (m: Map<Platform, Acc>) => {
    const out: Partial<Record<Platform, Metrics>> = {};
    for (const [p, a] of m) out[p] = finish(a);
    return out;
  };

  // Bank transfers: delivered-or-not, every order with a UTR, grouped per transfer.
  const transfers = new Map<string, TransferRow>();
  for (const o of orders) {
    if (!o.utr) continue;
    const k = `${o.platform}|${o.utr}`;
    const t = transfers.get(k) ?? { platform: o.platform, utr: o.utr, settlementDate: o.settlement_date, orders: 0, payout: 0 };
    t.orders++;
    t.payout += n(o.payout_inr);
    if (o.settlement_date && (!t.settlementDate || o.settlement_date > t.settlementDate)) t.settlementDate = o.settlement_date;
    transfers.set(k, t);
  }

  const offers = new Map<string, { platform: Platform; offer: string; orders: number; menu: number; disc: number; pay: number }>();
  for (const o of orders) {
    if (o.status !== 'delivered') continue;
    const offer = o.offer || 'No offer';
    const k = `${o.platform}|${offer}`;
    const x = offers.get(k) ?? { platform: o.platform, offer, orders: 0, menu: 0, disc: 0, pay: 0 };
    x.orders++;
    x.menu += n(o.menu_sales_inr);
    x.disc += n(o.discount_inr);
    x.pay += n(o.payout_inr);
    offers.set(k, x);
  }

  const platforms = [...perPlatform.keys()].sort();
  return {
    from,
    to,
    group,
    platforms,
    totals: finish(total),
    byPlatform: finishMap(perPlatform),
    buckets: [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([key, b]) => ({ key, label: bucketLabel(key, group), all: finish(b.all), byPlatform: finishMap(b.byPlatform) })),
    transfers: [...transfers.values()]
      .map((t) => ({ ...t, payout: r2(t.payout) }))
      .sort((a, b) => ((a.settlementDate ?? '') < (b.settlementDate ?? '') ? 1 : -1)),
    offers: [...offers.values()]
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 15)
      .map((x) => ({
        platform: x.platform,
        offer: x.offer,
        orders: x.orders,
        menuSales: r2(x.menu),
        discountShare: x.menu > 0 ? x.disc / x.menu : null,
        payoutShare: x.menu > 0 ? x.pay / x.menu : null,
      })),
    problems: orders
      .filter((o) => o.status !== 'delivered')
      .sort((a, b) => (a.ordered_at < b.ordered_at ? 1 : -1))
      .map((o) => ({
        platform: o.platform,
        orderId: o.order_id,
        orderedAt: o.ordered_at,
        status: o.status,
        reason: o.cancel_reason,
        stage: o.cancel_stage,
        menuSales: n(o.menu_sales_inr),
        payout: n(o.payout_inr),
      })),
  };
}

/** The periods Owner → Online orders offers. Weeks group by week, months by month. */
export const RANGES = {
  '4w': { label: '4 weeks', weeks: 4 },
  '12w': { label: '12 weeks', weeks: 12 },
  '6m': { label: '6 months', months: 6 },
  '12m': { label: '12 months', months: 12 },
} as const;
export type RangeKey = keyof typeof RANGES;

/** A period ending today (IST): N whole weeks from a Monday, or N calendar months from the 1st. */
export function resolveRange(key: RangeKey, today: string): { from: string; to: string; group: 'week' | 'month' } {
  const r = RANGES[key];
  if ('weeks' in r) return { from: weekStart(addDays(today, -(r.weeks - 1) * 7)), to: today, group: 'week' };
  const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - r.months, 1));
  return { from: d.toISOString().slice(0, 10), to: today, group: 'month' };
}
