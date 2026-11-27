import type { Platform } from './types';
import { addDays, bucketLabel, istDay, spreadDeduction, weekStart, type DeductionRow } from './summary';

// The Zomato strategy scorecard behind Owner → Online orders → Strategy,
// recomputed from whatever settlement reports are stored, so it moves by itself
// each time a weekly report is read. Pure, so the math is unit tested
// (tests/onlineSettlementsStrategy.test.ts) apart from the database.
//
// The targets below are the only place they are set: change a number here.
//
// Definitions:
//   window          28 days ending `end` (the latest delivered order day, or
//                   asOf), compared with the 28 days before; all IST days
//   delivered       status 'delivered'; every share and average is over these
//   marketing       'ads' bills spread evenly over the days they cover, GST
//                   included (the same spread as Owner → Online orders)
//   campaign        all ads bills sharing a campaign id: 'fixed_ads' when every
//                   bill is a whole rupee before 18% GST (a fixed-budget pack),
//                   else 'sales_linked' (a fee that moves with the week's
//                   sales: the café's Grow Maxx plan)
//   new customer    a customer whose first delivered order falls in the window
//                   (or week). The first-order day comes from `firstOrderDay`,
//                   built from every delivered order ever; without it, from the
//                   loaded orders only
//   in your bank    payout of every order in the window, any status,
//                   minus marketing

export type KpiKey =
  | 'ordersPerDay'
  | 'lowMinDealShare'
  | 'under200Share'
  | 'avgBill'
  | 'discountShare'
  | 'marketingShare'
  | 'newCustomersPerWeek'
  | 'bankPerOrder'
  | 'bankPerDay';

export const STRATEGY_TARGETS: Record<KpiKey, number> = {
  ordersPerDay: 17.5,
  lowMinDealShare: 0.2,
  under200Share: 0.15,
  avgBill: 320,
  discountShare: 0.25,
  marketingShare: 0.065,
  newCustomersPerWeek: 45,
  bankPerOrder: 155,
  bankPerDay: 2700,
};

export interface KpiDef {
  key: KpiKey;
  label: string;
  unit: 'number' | 'inr' | 'percent';
  /** 'min' = at least the target, 'max' = at most. */
  direction: 'min' | 'max';
  target: number;
}

export const KPI: KpiDef[] = [
  { key: 'ordersPerDay', label: 'Orders per day', unit: 'number', direction: 'min', target: STRATEGY_TARGETS.ordersPerDay },
  { key: 'lowMinDealShare', label: 'Orders on offers with a minimum under ₹199', unit: 'percent', direction: 'max', target: STRATEGY_TARGETS.lowMinDealShare },
  { key: 'under200Share', label: 'Orders with a bill under ₹200', unit: 'percent', direction: 'max', target: STRATEGY_TARGETS.under200Share },
  { key: 'avgBill', label: 'Average bill', unit: 'inr', direction: 'min', target: STRATEGY_TARGETS.avgBill },
  { key: 'discountShare', label: 'Discounts you fund, of menu sales', unit: 'percent', direction: 'max', target: STRATEGY_TARGETS.discountShare },
  { key: 'marketingShare', label: 'Marketing fee, of menu sales', unit: 'percent', direction: 'max', target: STRATEGY_TARGETS.marketingShare },
  { key: 'newCustomersPerWeek', label: 'New customers per week', unit: 'number', direction: 'min', target: STRATEGY_TARGETS.newCustomersPerWeek },
  { key: 'bankPerOrder', label: 'In your bank per order', unit: 'inr', direction: 'min', target: STRATEGY_TARGETS.bankPerOrder },
  { key: 'bankPerDay', label: 'In your bank per day', unit: 'inr', direction: 'min', target: STRATEGY_TARGETS.bankPerDay },
];

/** The columns of online_settlement_orders the strategy reads. */
export interface StrategyOrderRow {
  platform: Platform;
  order_id: string;
  ordered_at: string;
  status: string;
  offer: string;
  menu_sales_inr: number | string;
  packaging_inr: number | string;
  discount_inr: number | string;
  gst_from_customer_inr: number | string;
  net_order_value_inr: number | string;
  commission_inr: number | string;
  payment_fee_inr: number | string;
  gst_on_fees_inr: number | string;
  tcs_inr: number | string;
  tds_inr: number | string;
  payout_inr: number | string;
  customer_ref: string | null;
}

export interface StrategyDeductionRow extends DeductionRow {
  label: string;
  ref: string;
  period_text: string;
  settlement_status: string;
}

export type CampaignClass = 'fixed_ads' | 'sales_linked';
export type KpiStatus = 'met' | 'close' | 'off';

export interface KpiResult extends KpiDef {
  current: number | null;
  previous: number | null;
  status: KpiStatus;
}

/** Rupees per delivered order. `other` is what the lines above leave: GST from the customer, GST paid by the platform, adjustments. */
export interface Anatomy {
  menu: number;
  packaging: number;
  discount: number;
  platformFees: number;
  taxWithheld: number;
  marketingSalesLinked: number;
  marketingFixed: number;
  other: number;
  inBank: number;
}

export type TierKey = 'none' | 'under199' | 't199' | 't349' | 't499' | 'other';

export const TIERS: { key: TierKey; label: string }[] = [
  { key: 'none', label: 'No offer' },
  { key: 'under199', label: 'Minimum order under ₹199' },
  { key: 't199', label: '₹199–299' },
  { key: 't349', label: '₹349–449' },
  { key: 't499', label: '₹499 and up' },
  { key: 'other', label: 'Other offer codes' },
];

export interface LadderRow {
  key: TierKey;
  label: string;
  orders: number;
  share: number | null;
  avgBill: number | null;
  discountShare: number | null;
  payoutPerOrder: number | null;
}

export interface WeekRow {
  start: string; // Monday
  label: string;
  /** Marketing fee incl. GST. */
  fee: number;
  salesLinked: number;
  fixedAds: number;
  netSales: number;
  /** Sales-linked fee before GST ÷ net sales; null with no sales. */
  effectiveRate: number | null;
  orders: number;
  newCustomers: number;
  /** False for a final week whose Sunday is after the window's end: the billing rules skip it. */
  full: boolean;
}

/** What the scorecard would show if the under-billed weeks in the current window were billed at the usual rate. */
export interface OpenBilling {
  /** Labels of the under-billed full weeks inside the current window. */
  weeks: string[];
  /** Fee incl. GST that would still be due. */
  extraFee: number;
  marketingShare: number | null;
  bankPerOrder: number | null;
  bankPerDay: number;
}

export interface Action {
  key: string;
  title: string;
  detail: string;
}

export interface StrategyResult {
  hasData: boolean;
  end: string | null;
  current: { from: string; to: string } | null;
  previous: { from: string; to: string } | null;
  kpis: KpiResult[];
  anatomy: Anatomy | null;
  ladder: LadderRow[];
  weeks: WeekRow[];
  billingNotes: string[];
  openBilling: OpenBilling | null;
  actions: Action[];
}

const WINDOW_DAYS = 28;
const WEEKS_SHOWN = 8;
const GST = 1.18;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const n = (v: number | string | null | undefined) => {
  const x = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const fmtDay = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const rupees = (x: number) => `₹${Math.round(x).toLocaleString('en-IN')}`;
const percent = (x: number) => `${(x * 100).toFixed(1)}%`;

const isWholeRupee = (x: number) => Math.abs(x - Math.round(x)) < 0.006;
const rowClass = (rows: StrategyDeductionRow[]): CampaignClass =>
  rows.every((d) => isWholeRupee(n(d.amount_inr) / GST)) ? 'fixed_ads' : 'sales_linked';

/**
 * Zomato labels every marketing charge ADS with a campaign id (`ref`). A
 * campaign whose bills are all whole rupees before GST is a fixed-budget pack;
 * any other is a fee that moves with sales. Only campaigns with an id are in
 * the map: a bill with an empty id is its own campaign (see classOf).
 */
export function classifyCampaigns(deductions: StrategyDeductionRow[]): Map<string, CampaignClass> {
  const byRef = new Map<string, StrategyDeductionRow[]>();
  for (const d of deductions) {
    if (d.kind !== 'ads' || !d.ref) continue;
    byRef.set(d.ref, [...(byRef.get(d.ref) ?? []), d]);
  }
  const out = new Map<string, CampaignClass>();
  for (const [ref, rows] of byRef) out.set(ref, rowClass(rows));
  return out;
}

const classOf = (d: StrategyDeductionRow, classes: Map<string, CampaignClass>): CampaignClass =>
  d.ref ? classes.get(d.ref) ?? rowClass([d]) : rowClass([d]);

/** Marketing fee (incl. GST) over [from, to], spread evenly over the days each bill covers. */
function marketingIn(ads: StrategyDeductionRow[], classes: Map<string, CampaignClass>, from: string, to: string) {
  const out = { salesLinked: 0, fixedAds: 0, total: 0 };
  for (const d of ads) {
    let sum = 0;
    for (const amt of spreadDeduction(d, from, to).values()) sum += amt;
    if (classOf(d, classes) === 'sales_linked') out.salesLinked += sum;
    else out.fixedAds += sum;
    out.total += sum;
  }
  return out;
}

/** The minimum order of an offer like 'SmartPromos GETOFF120ON199' (199); null for an offer without one. */
function minOrder(offer: string): number | null {
  const m = /ON(\d+)$/.exec(offer);
  return m ? Number(m[1]) : null;
}

function tierOf(offer: string): TierKey {
  if (offer === '') return 'none';
  const m = minOrder(offer);
  if (m === null) return 'other';
  return m < 199 ? 'under199' : m < 349 ? 't199' : m < 499 ? 't349' : 't499';
}

export function kpiStatus(def: Pick<KpiDef, 'direction' | 'target'>, value: number | null): KpiStatus {
  if (value === null) return 'off';
  const eps = 1e-9;
  if (def.direction === 'min') {
    if (value >= def.target - eps) return 'met';
    return value >= def.target * 0.95 - eps ? 'close' : 'off';
  }
  if (value <= def.target + eps) return 'met';
  return value <= def.target * 1.05 + eps ? 'close' : 'off';
}

const inWindow = (day: string, from: string, to: string) => day >= from && day <= to;

interface WindowStats {
  values: Record<KpiKey, number | null>;
  delivered: number;
  menuSales: number;
  marketing: { salesLinked: number; fixedAds: number; total: number };
  newCustomers: number;
  /** Payout of every order in the window, less marketing. */
  bank: number;
}

function windowStats(
  orders: StrategyOrderRow[],
  days: Map<StrategyOrderRow, string>,
  ads: StrategyDeductionRow[],
  classes: Map<string, CampaignClass>,
  firstSeen: ReadonlyMap<string, string>,
  from: string,
  to: string,
): WindowStats {
  let delivered = 0;
  let menu = 0;
  let discount = 0;
  let low = 0;
  let under200 = 0;
  let payout = 0;
  for (const o of orders) {
    if (!inWindow(days.get(o) as string, from, to)) continue;
    payout += n(o.payout_inr);
    if (o.status !== 'delivered') continue;
    delivered++;
    menu += n(o.menu_sales_inr);
    discount += n(o.discount_inr);
    if (n(o.menu_sales_inr) < 200) under200++;
    if (tierOf(o.offer) === 'under199') low++;
  }
  let newCustomers = 0;
  for (const day of firstSeen.values()) if (inWindow(day, from, to)) newCustomers++;

  const marketing = marketingIn(ads, classes, from, to);
  const bank = payout - marketing.total;
  const values: Record<KpiKey, number | null> = {
    ordersPerDay: delivered / WINDOW_DAYS,
    lowMinDealShare: delivered > 0 ? low / delivered : null,
    under200Share: delivered > 0 ? under200 / delivered : null,
    avgBill: delivered > 0 ? menu / delivered : null,
    discountShare: menu > 0 ? discount / menu : null,
    marketingShare: menu > 0 ? marketing.total / menu : null,
    newCustomersPerWeek: newCustomers / (WINDOW_DAYS / 7),
    bankPerOrder: delivered > 0 ? bank / delivered : null,
    bankPerDay: bank / WINDOW_DAYS,
  };
  return { values, delivered, menuSales: menu, marketing, newCustomers, bank };
}

const EMPTY: StrategyResult = {
  hasData: false,
  end: null,
  current: null,
  previous: null,
  kpis: [],
  anatomy: null,
  ladder: [],
  weeks: [],
  billingNotes: [],
  openBilling: null,
  actions: [],
};

export function buildStrategy(input: {
  orders: StrategyOrderRow[];
  deductions: StrategyDeductionRow[];
  /** The last IST day of the current window; default the latest delivered order's day. */
  asOf?: string;
  /** customer_ref → IST day of that customer's first delivered order ever. Without it, derived from `orders`. */
  firstOrderDay?: ReadonlyMap<string, string>;
}): StrategyResult {
  const orders = input.orders.filter((o) => o.platform === 'zomato');
  const ads = input.deductions.filter((d) => d.platform === 'zomato' && d.kind === 'ads');
  const days = new Map(orders.map((o) => [o, istDay(o.ordered_at)]));
  const deliveredDays = orders.filter((o) => o.status === 'delivered').map((o) => days.get(o) as string);
  if (!deliveredDays.length) return EMPTY;
  const end = input.asOf ?? deliveredDays.reduce((m, d) => (d > m ? d : m));

  const current = { from: addDays(end, -(WINDOW_DAYS - 1)), to: end };
  const previous = { from: addDays(end, -(2 * WINDOW_DAYS - 1)), to: addDays(end, -WINDOW_DAYS) };
  const classes = classifyCampaigns(ads);

  // First delivered day of each customer, so a regular whose first order predates the
  // window is not counted as new. The loader passes it over all history; otherwise it is
  // derived from the loaded orders.
  let firstSeen: ReadonlyMap<string, string>;
  if (input.firstOrderDay) firstSeen = input.firstOrderDay;
  else {
    const derived = new Map<string, string>();
    for (const o of orders) {
      if (o.status !== 'delivered' || !o.customer_ref) continue;
      const day = days.get(o) as string;
      const seen = derived.get(o.customer_ref);
      if (seen === undefined || day < seen) derived.set(o.customer_ref, day);
    }
    firstSeen = derived;
  }

  const cur = windowStats(orders, days, ads, classes, firstSeen, current.from, current.to);
  const prev = windowStats(orders, days, ads, classes, firstSeen, previous.from, previous.to);
  const kpis: KpiResult[] = KPI.map((def) => {
    const value = cur.values[def.key];
    return { ...def, current: value, previous: prev.values[def.key], status: kpiStatus(def, value) };
  });

  // payout = menu + packaging − discount + GST from customer − fees − TCS/TDS
  //          − GST paid by platform − other deductions + additions
  // so `other` is what is left once the lines shown are taken out.
  const ladderAcc = new Map<TierKey, { orders: number; menu: number; discount: number; payout: number }>(
    TIERS.map((t) => [t.key, { orders: 0, menu: 0, discount: 0, payout: 0 }]),
  );
  const sum = { menu: 0, packaging: 0, discount: 0, fees: 0, tax: 0 };
  for (const o of orders) {
    if (!inWindow(days.get(o) as string, current.from, current.to) || o.status !== 'delivered') continue;
    sum.menu += n(o.menu_sales_inr);
    sum.packaging += n(o.packaging_inr);
    sum.discount += n(o.discount_inr);
    sum.fees += n(o.commission_inr) + n(o.payment_fee_inr) + n(o.gst_on_fees_inr);
    sum.tax += n(o.tcs_inr) + n(o.tds_inr);
    const t = ladderAcc.get(tierOf(o.offer)) as { orders: number; menu: number; discount: number; payout: number };
    t.orders++;
    t.menu += n(o.menu_sales_inr);
    t.discount += n(o.discount_inr);
    t.payout += n(o.payout_inr);
  }
  const d = cur.delivered;
  let anatomy: Anatomy | null = null;
  if (d > 0) {
    const inBank = cur.values.bankPerOrder as number;
    const salesLinked = cur.marketing.salesLinked / d;
    const fixedAds = cur.marketing.fixedAds / d;
    const shown = (sum.menu + sum.packaging - sum.discount - sum.fees - sum.tax) / d - salesLinked - fixedAds;
    anatomy = {
      menu: sum.menu / d,
      packaging: sum.packaging / d,
      discount: sum.discount / d,
      platformFees: sum.fees / d,
      taxWithheld: sum.tax / d,
      marketingSalesLinked: salesLinked,
      marketingFixed: fixedAds,
      other: inBank - shown,
      inBank,
    };
  }
  const ladder: LadderRow[] = TIERS.map((t) => {
    const a = ladderAcc.get(t.key) as { orders: number; menu: number; discount: number; payout: number };
    return {
      key: t.key,
      label: t.label,
      orders: a.orders,
      share: d > 0 ? a.orders / d : null,
      avgBill: a.orders > 0 ? a.menu / a.orders : null,
      discountShare: a.menu > 0 ? a.discount / a.menu : null,
      payoutPerOrder: a.orders > 0 ? a.payout / a.orders : null,
    };
  });

  // Marketing fee by Monday–Sunday week, the last 8 ending with the week that holds `end`.
  const lastMonday = weekStart(end);
  const weeks: WeekRow[] = [];
  const billingNotes: string[] = [];
  const netByDay = new Map<string, number>();
  for (const o of orders) {
    if (o.status !== 'delivered') continue;
    const day = days.get(o) as string;
    netByDay.set(day, (netByDay.get(day) ?? 0) + n(o.net_order_value_inr) - n(o.gst_from_customer_inr));
  }
  const spanFrom = addDays(lastMonday, -7 * (WEEKS_SHOWN - 1));
  for (let k = WEEKS_SHOWN - 1; k >= 0; k--) {
    const start = addDays(lastMonday, -7 * k);
    const stop = addDays(start, 6);
    const to = stop < end ? stop : end;
    let netSales = 0;
    let delivered = 0;
    for (const o of orders) {
      if (o.status !== 'delivered' || !inWindow(days.get(o) as string, start, to)) continue;
      delivered++;
      netSales += n(o.net_order_value_inr) - n(o.gst_from_customer_inr);
    }
    let newCustomers = 0;
    for (const day of firstSeen.values()) if (inWindow(day, start, to)) newCustomers++;
    const m = marketingIn(ads, classes, start, to);
    weeks.push({
      start,
      label: bucketLabel(start, 'week'),
      fee: r2(m.total),
      salesLinked: r2(m.salesLinked),
      fixedAds: r2(m.fixedAds),
      netSales: r2(netSales),
      effectiveRate: netSales > 0 ? m.salesLinked / GST / netSales : null,
      orders: delivered,
      newCustomers,
      full: stop <= end,
    });
  }

  // Billing rules, full weeks only. `usual` is the median sales-linked rate of the full weeks
  // at 3% or more (needs three); a full week with orders billed under half of it gets one note.
  const fullWeeks = weeks.filter((w) => w.full);
  const rates = fullWeeks
    .map((w) => w.effectiveRate)
    .filter((x): x is number => x !== null && x >= 0.03)
    .sort((a, b) => a - b);
  const usual = rates.length >= 3 ? (rates.length % 2 ? rates[(rates.length - 1) / 2] : (rates[rates.length / 2 - 1] + rates[rates.length / 2]) / 2) : null;
  const underBilled: WeekRow[] = [];
  for (const w of fullWeeks) {
    if (w.orders === 0) continue;
    if (usual !== null && w.effectiveRate !== null && w.effectiveRate < usual / 2) {
      underBilled.push(w);
      billingNotes.push(
        `The week of ${w.label} was billed ${rupees(w.salesLinked)}, ${percent(w.effectiveRate)} of net sales against a usual ${percent(usual)}. Ask Zomato whether the plan was off for part of that week`,
      );
    } else if (w.fee === 0) billingNotes.push(`No marketing fee billed for ${w.label}`);
  }
  let openBilling: OpenBilling | null = null;
  const inCurrent = underBilled.filter((w) => w.start >= current.from && addDays(w.start, 6) <= current.to);
  if (usual !== null && inCurrent.length) {
    const extraFee = inCurrent.reduce((t, w) => t + Math.max(0, usual * w.netSales * GST - w.salesLinked), 0);
    const marketing = cur.marketing.total + extraFee;
    const bank = cur.bank - extraFee;
    openBilling = {
      weeks: inCurrent.map((w) => w.label),
      extraFee: r2(extraFee),
      marketingShare: cur.menuSales > 0 ? marketing / cur.menuSales : null,
      bankPerOrder: cur.delivered > 0 ? bank / cur.delivered : null,
      bankPerDay: bank / WINDOW_DAYS,
    };
  }
  // A sales-linked bill labelled as one day that is a big slice of that day's sales is probably
  // a bill for several days written with one date.
  for (const a of ads) {
    if (classOf(a, classes) !== 'sales_linked' || !a.period_start || a.period_start !== a.period_end) continue;
    if (!inWindow(a.period_start, spanFrom, end)) continue;
    if (n(a.amount_inr) / GST > 0.25 * (netByDay.get(a.period_start) ?? 0)) {
      billingNotes.push(
        `Bill dated ${fmtDay(a.period_start)} is labelled as one day but is ${rupees(n(a.amount_inr))}: confirm with Zomato which days it covers`,
      );
    }
  }

  const result: StrategyResult = { hasData: true, end, current, previous, kpis, anatomy, ladder, weeks, billingNotes, openBilling, actions: [] };
  result.actions = buildActions(result, cur, orders, days);
  return result;
}

function buildActions(
  r: StrategyResult,
  cur: WindowStats,
  orders: StrategyOrderRow[],
  days: Map<StrategyOrderRow, string>,
): Action[] {
  const k = (key: KpiKey) => r.kpis.find((x) => x.key === key) as KpiResult;
  const actions: Action[] = [];
  const low = k('lowMinDealShare');
  if (low.current !== null && low.status !== 'met') {
    const win = r.current as { from: string; to: string };
    const tier = r.ladder.find((t) => t.key === 'under199') as LadderRow;
    let otherPay = 0;
    let other = 0;
    for (const o of orders) {
      if (o.status !== 'delivered' || !inWindow(days.get(o) as string, win.from, win.to) || tierOf(o.offer) === 'under199') continue;
      other++;
      otherPay += n(o.payout_inr);
    }
    const vs =
      tier.payoutPerOrder !== null && other > 0
        ? ` Each pays you ${rupees(tier.payoutPerOrder)} an order, against ${rupees(otherPay / other)} for all other delivered orders.`
        : '';
    actions.push({
      key: 'lowMinDeals',
      title: 'Stop small-order offers',
      detail: `${percent(low.current)} of delivered orders used an offer with a minimum order under ₹199 (target: at most ${percent(low.target)}).${vs} Ask Zomato to raise the SmartPromos minimum order to ₹199.`,
    });
  }
  const bill = k('avgBill');
  if (bill.current !== null && bill.status !== 'met') {
    actions.push({
      key: 'avgBill',
      title: 'Raise the average bill',
      detail: `The average bill is ${rupees(bill.current)}, under the ${rupees(bill.target)} target. Combos and add-ons at checkout lift it.`,
    });
  }
  const disc = k('discountShare');
  if (disc.current !== null && disc.status !== 'met') {
    actions.push({
      key: 'discount',
      title: 'Cut the discounts you fund',
      detail: `Discounts you fund are ${percent(disc.current)} of menu sales (target: at most ${percent(disc.target)}). Fewer or smaller offers bring this down.`,
    });
  }
  const mkt = k('marketingShare');
  const fresh = k('newCustomersPerWeek');
  if ((mkt.current !== null && mkt.status !== 'met') || fresh.status !== 'met') {
    const weekly = `${(fresh.current ?? 0).toFixed(1)} a week, target ${fresh.target}`;
    const first =
      cur.newCustomers > 0
        ? `${cur.newCustomers} ${cur.newCustomers === 1 ? 'customer' : 'customers'} ordered for the first time in the same 4 weeks (${weekly}): ${rupees(cur.marketing.total / cur.newCustomers)} of marketing fee per new customer if every one is credited to it.`
        : `No customers ordered for the first time in the same 4 weeks (${weekly}), so there is no new customer to credit the fee to.`;
    actions.push({
      key: 'marketing',
      title: 'Check what marketing is buying',
      detail:
        `Marketing cost ${rupees(cur.marketing.total)} in the last 4 weeks` +
        `${mkt.current !== null ? `, ${percent(mkt.current)} of menu sales (target: at most ${percent(mkt.target)})` : ''}. ` +
        first,
    });
  }
  if (r.billingNotes.length) {
    actions.push({ key: 'billing', title: 'Check Zomato’s bills', detail: `${r.billingNotes.join('. ')}.` });
  }
  if (!actions.length) {
    const missed = r.kpis.filter((x) => x.status !== 'met');
    actions.push(
      missed.length
        ? { key: 'other', title: 'Other measures are off target', detail: `${missed.map((x) => x.label).join(', ')}: see the scorecard.` }
        : { key: 'allMet', title: 'All targets met', detail: 'Every measure on the scorecard is at or better than its target. Keep going.' },
    );
  }
  return actions.slice(0, 5);
}
