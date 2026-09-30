// Customer segmentation for the marketing agent (spec §1.1, §1.2, §1.9). Pure:
// the caller loads and joins the rows, this file only does the arithmetic — so
// every boundary (a week that starts on Monday IST, a customer exactly on a lapse
// threshold) is testable without a database.
//
// The one idea worth knowing: "lapsed" is PERSONAL. A daily regular who has
// vanished for 14 days is lapsed; a monthly visitor is fine at 40. A fixed 30-day
// rule would nag the second group and miss the first, so the lapse threshold is
// derived from each customer's own median gap between visits.

import { normalizeIndianMobileHonouringPlus } from '@/lib/phone';
import type { ExpiryRow } from '@/lib/loyalty/expiry';
import { expiringWithin, expiryDateFor, pointsBalance } from './points';
import { firstName } from './templates';
import { addDaysToIstDate, DAY_MS, daysBetweenIstDates, istDate, istWeekStart, toMs } from './ist';
import {
  INSIGHT_EXPIRY_DAYS,
  INVALID_ORDER_STATUSES,
  WEEKLY_ACTIVE_WEEKS,
} from './types';
import type {
  AudienceFilter,
  ContactStats,
  DropAlert,
  LifecycleStage,
  StageThresholds,
  WeeklyPoint,
  WinbackParamsBundle,
} from './types';

// ---------------------------------------------------------------------------
// Contact stats
// ---------------------------------------------------------------------------

/** One order, as much of it as the stats need. */
export interface OrderInput {
  /** When present, the same order arriving twice (matched by user AND by phone) is counted once. */
  id?: string;
  /** ISO timestamp. */
  created_at: string;
  /** The order total, integer ₹. */
  total_inr: number;
  /** When present, cancelled/rejected orders are ignored — a safety net if the caller forgot to filter. */
  status?: string;
}

/**
 * Everything about ONE contact, already joined by the caller: the orders that
 * belong to them (matched by user id, counter-linked user id OR phone, as
 * orderMatchFilter does), the last 365 days only, and their full points ledger.
 */
export interface ContactStatsInput {
  /** E.164. */
  phone: string;
  user_id: string | null;
  /** The profile name (or the last order's customer_name); null when unknown. */
  name: string | null;
  /** profiles.role; null when the phone has no profile. */
  role: string | null;
  consent_opted_in: boolean;
  opt_out_listed: boolean;
  orders: OrderInput[];
  /** loyalty_transactions for the user, {points, created_at} — credits AND debits, including 'expire' rows. Empty when no account. */
  points_rows: ExpiryRow[];
}

export interface ContactStatsContext {
  now: Date;
  /** The three win-back playbooks' params (whatever their mode — staging does not depend on a playbook being on). */
  winback: WinbackParamsBundle;
  /** loyalty_config.points_expiry_days; 0 = points never expire. */
  points_expiry_days: number;
  /** points_expiring.params.days_ahead — the horizon behind ContactStats.expiring_points. */
  expiring_days_ahead: number;
  /** ₹ per point (loyalty_config.inr_per_point; 1 today). Defaults to 1. */
  inr_per_point?: number;
}

/** True for an order status that counts as a real order (anything but cancelled/rejected). */
export function isValidOrderStatus(status: string | undefined | null): boolean {
  return !status || !(INVALID_ORDER_STATUSES as readonly string[]).includes(status);
}

/**
 * Median gap, in whole days, between consecutive order DAYS (IST). Two orders on
 * the same day are one visit, not a zero-day gap. null when there are fewer than
 * two distinct order days — and (spec §1.1) when there are fewer than 3 orders,
 * because two orders are not a rhythm. The gap is clamped to [2, 60]: a habit
 * tighter than 2 days is treated as 2, and a sparser one is capped so an
 * occasional visitor is not given a threshold longer than the win-back window.
 */
export function typicalGapDays(orderTimestamps: readonly string[]): number | null {
  if (orderTimestamps.length < 3) return null;
  const days = [...new Set(orderTimestamps.map((t) => istDate(t)))].sort();
  if (days.length < 2) return null;

  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(daysBetweenIstDates(days[i - 1], days[i]));
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.min(60, Math.max(2, median));
}

/**
 * The day thresholds at which one contact changes stage:
 *
 *   stage1 = typical gap ? clamp(round(gap_multiplier × gap), min_days, max_days) : default_days
 *   stage2 = stage1 + winback_2.offset_days
 *   stage3 = stage1 + winback_3.offset_days
 *   lost   = winback_3.max_days
 */
export function stageThresholds(typicalGap: number | null, params: WinbackParamsBundle): StageThresholds {
  const w1 = params.winback_1;
  const stage1 =
    typicalGap !== null
      ? Math.min(w1.max_days, Math.max(w1.min_days, Math.round(w1.gap_multiplier * typicalGap)))
      : w1.default_days;
  return {
    stage1_days: stage1,
    stage2_days: stage1 + params.winback_2.offset_days,
    stage3_days: stage1 + params.winback_3.offset_days,
    lost_after_days: params.winback_3.max_days,
  };
}

/**
 * The lifecycle stage (spec §1.2 table, read top to bottom, first match wins):
 *
 *   no_orders   no valid orders
 *   lost        d ≥ lost_after            (checked before the lapsed bands so it wins if a
 *   lapsed_3    stage3 ≤ d < lost_after    misconfigured stage3 ever reaches past lost_after)
 *   lapsed_2    stage2 ≤ d < stage3
 *   lapsed_1    stage1 ≤ d < stage2
 *   new         exactly 1 order and d < stage1   ← beats active/at_risk: a first-timer is not
 *   at_risk     0.8 × stage1 ≤ d < stage1          "at risk" until they actually lapse
 *   active      d < 0.8 × stage1
 *
 * d is whole elapsed days since the last order. 0.8 × stage1 is compared in
 * integers (d × 5 vs stage1 × 4) so no floating-point fuzz sits on a boundary.
 */
export function lifecycleStage(
  orderCount: number,
  daysSinceLastOrder: number | null,
  t: StageThresholds,
): LifecycleStage {
  if (orderCount <= 0 || daysSinceLastOrder === null) return 'no_orders';
  const d = daysSinceLastOrder;
  if (d >= t.lost_after_days) return 'lost';
  if (d >= t.stage3_days) return 'lapsed_3';
  if (d >= t.stage2_days) return 'lapsed_2';
  if (d >= t.stage1_days) return 'lapsed_1';
  if (orderCount === 1) return 'new';
  if (d * 5 >= t.stage1_days * 4) return 'at_risk';
  return 'active';
}

/**
 * Builds one contact's stats. `vip` is left false: it depends on the whole
 * population — run applyVip() over all contacts afterwards.
 */
export function buildContactStats(input: ContactStatsInput, ctx: ContactStatsContext): ContactStats {
  const nowMs = ctx.now.getTime();
  const seen = new Set<string>();
  const orders: { at: number; iso: string; total: number }[] = [];
  for (const o of input.orders) {
    if (!isValidOrderStatus(o.status)) continue;
    if (o.id !== undefined) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
    }
    const at = toMs(o.created_at);
    if (!Number.isFinite(at)) continue;
    orders.push({ at, iso: o.created_at, total: Number.isFinite(o.total_inr) ? o.total_inr : 0 });
  }
  orders.sort((a, b) => a.at - b.at);

  const orderCount = orders.length;
  const totalSpend = orders.reduce((sum, o) => sum + o.total, 0);
  const firstAt = orderCount ? new Date(orders[0].at).toISOString() : null;
  const lastMs = orderCount ? orders[orderCount - 1].at : null;
  const lastAt = lastMs !== null ? new Date(lastMs).toISOString() : null;
  const daysSince = lastMs !== null ? Math.max(0, Math.floor((nowMs - lastMs) / DAY_MS)) : null;

  const gap = typicalGapDays(orders.map((o) => o.iso));
  const thresholds = stageThresholds(gap, ctx.winback);

  const rate = ctx.inr_per_point ?? 1;
  const balance = pointsBalance(input.points_rows);
  const expiring = expiringWithin(input.points_rows, ctx.now, ctx.points_expiry_days, ctx.expiring_days_ahead);
  const expiring7 = expiringWithin(input.points_rows, ctx.now, ctx.points_expiry_days, INSIGHT_EXPIRY_DAYS);

  // The oldest unspent points may already be past their expiry if the nightly
  // expire job is behind; never tell a customer they expire "yesterday".
  const expiryAt = expiryDateFor(input.points_rows, ctx.points_expiry_days);
  const expiryDate = expiryAt ? istDate(new Date(Math.max(expiryAt.getTime(), nowMs))) : null;

  return {
    phone: input.phone,
    user_id: input.user_id,
    first_name: firstName(input.name),
    role: input.role,
    consent_opted_in: input.consent_opted_in,
    opt_out_listed: input.opt_out_listed,

    order_count: orderCount,
    total_spend_inr: totalSpend,
    aov_inr: orderCount ? Math.round(totalSpend / orderCount) : 0,
    first_order_at: firstAt,
    last_order_at: lastAt,
    days_since_last_order: daysSince,
    typical_gap_days: gap,
    stage1_days: thresholds.stage1_days,
    stage: lifecycleStage(orderCount, daysSince, thresholds),

    points_balance: balance,
    points_value_inr: Math.floor(balance * rate),
    expiring_points: expiring,
    expiring_value_inr: Math.floor(expiring * rate),
    expiry_date: expiryDate,
    expiring_points_7d: expiring7,
    expiring_value_7d_inr: Math.floor(expiring7 * rate),

    vip: false,
  };
}

// ---------------------------------------------------------------------------
// VIP
// ---------------------------------------------------------------------------

/** A VIP needs at least this many orders — a one-off big bill is not loyalty. */
export const VIP_MIN_ORDERS = 3;
/** ...and a spend in the top this-fraction of such customers. */
export const VIP_TOP_FRACTION = 0.2;

/**
 * The spend a customer must reach to be a VIP: the spend of the ceil(20% × n)-th
 * biggest spender among contacts with ≥ 3 orders. null when nobody has 3 orders.
 * Ties at the line are all in — "top 20%" is a target, and two people who spent
 * the same are either both VIPs or neither.
 */
export function vipThreshold(contacts: readonly Pick<ContactStats, 'order_count' | 'total_spend_inr'>[]): number | null {
  const spends = contacts
    .filter((c) => c.order_count >= VIP_MIN_ORDERS)
    .map((c) => c.total_spend_inr)
    .sort((a, b) => b - a);
  if (spends.length === 0) return null;
  const k = Math.max(1, Math.ceil(spends.length * VIP_TOP_FRACTION));
  return spends[k - 1];
}

/**
 * Returns the contacts with `vip` set from the population's spend distribution. `inPopulation`
 * says whose spend sets the bar (default: everyone given); the flag itself is then decided by
 * that bar for every contact. The server passes "messageable" (opted in, not opted out, not
 * staff) so the top 20% means the top 20% of the people a campaign can reach (spec §1.1).
 */
export function applyVip(
  contacts: readonly ContactStats[],
  inPopulation: (c: ContactStats) => boolean = () => true,
): ContactStats[] {
  const threshold = vipThreshold(contacts.filter(inPopulation));
  return contacts.map((c) => ({
    ...c,
    vip: threshold !== null && c.order_count >= VIP_MIN_ORDERS && c.total_spend_inr >= threshold,
  }));
}

// ---------------------------------------------------------------------------
// Audience filters (manual campaigns)
// ---------------------------------------------------------------------------

/** Does this contact match a manual campaign's filter? An empty filter matches everyone. */
export function matchesAudience(c: ContactStats, f: AudienceFilter): boolean {
  if (f.stages && f.stages.length > 0 && !f.stages.includes(c.stage)) return false;
  if (f.vip_only && !c.vip) return false;
  if (f.min_orders !== undefined && c.order_count < f.min_orders) return false;
  if (f.min_spend_inr !== undefined && c.total_spend_inr < f.min_spend_inr) return false;
  if (f.min_points !== undefined && c.points_balance < f.min_points) return false;
  if (f.last_order_from_days !== undefined || f.last_order_to_days !== undefined) {
    const d = c.days_since_last_order;
    if (d === null) return false;
    if (f.last_order_from_days !== undefined && d < f.last_order_from_days) return false;
    if (f.last_order_to_days !== undefined && d > f.last_order_to_days) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Weekly active customers and the drop alert (spec §1.9)
// ---------------------------------------------------------------------------

/** An order for the weekly chart. Identity is user id, else counter-linked user id, else the normalised phone. */
export interface WeeklyOrderInput {
  created_at: string;
  user_id?: string | null;
  customer_user_id?: string | null;
  customer_phone?: string | null;
}

/** The identity an order counts under for "distinct customers"; null for an anonymous walk-in. */
export function customerKey(o: Pick<WeeklyOrderInput, 'user_id' | 'customer_user_id' | 'customer_phone'>): string | null {
  const account = o.user_id || o.customer_user_id;
  if (account) return `u:${account}`;
  const phone = o.customer_phone ? normalizeIndianMobileHonouringPlus(o.customer_phone) : null;
  return phone ? `p:${phone}` : null;
}

/**
 * Distinct identified customers and total orders per IST Mon–Sun week, for the
 * last `weeks` COMPLETE weeks (the week containing `now` is still in progress and
 * excluded). Oldest first, always `weeks` points — a week with no orders is a
 * zero, not a gap. The caller passes valid orders only.
 *
 * `orders` counts every order; `customers` counts only orders that identify
 * someone, so anonymous walk-ins show in the orders line but not the customers.
 */
export function weeklyActive(
  orders: readonly WeeklyOrderInput[],
  now: Date,
  weeks: number = WEEKLY_ACTIVE_WEEKS,
): WeeklyPoint[] {
  const currentWeek = istWeekStart(now);
  const starts: string[] = [];
  for (let i = weeks; i >= 1; i--) starts.push(addDaysToIstDate(currentWeek, -7 * i));

  const buckets = new Map<string, { customers: Set<string>; orders: number }>();
  for (const start of starts) buckets.set(start, { customers: new Set(), orders: 0 });

  for (const o of orders) {
    if (!Number.isFinite(toMs(o.created_at))) continue;
    const bucket = buckets.get(istWeekStart(o.created_at));
    if (!bucket) continue; // an older week, or the week still in progress
    bucket.orders += 1;
    const key = customerKey(o);
    if (key) bucket.customers.add(key);
  }

  return starts.map((week_start) => {
    const b = buckets.get(week_start)!;
    return { week_start, customers: b.customers.size, orders: b.orders };
  });
}

/**
 * The customer-drop alert: fires when the last complete week's active customers
 * fall below (1 − drop_alert_pct/100) × the mean of the 4 weeks before it.
 * null when there is no drop, fewer than 5 weeks of series, or no baseline (a
 * mean of 0 means there was nothing to drop from). Compared in integers, so a
 * week exactly on the line is not an alert.
 */
export function detectDrop(series: readonly WeeklyPoint[], dropAlertPct: number): DropAlert | null {
  if (series.length < 5) return null;
  const last = series[series.length - 1];
  const previous = series.slice(series.length - 5, series.length - 1);
  const sum = previous.reduce((s, p) => s + p.customers, 0);
  if (sum <= 0) return null;

  // last < (1 − pct/100) × sum/4   ⇔   last × 400 < (100 − pct) × sum
  if (!(last.customers * 400 < (100 - dropAlertPct) * sum)) return null;

  const baseline = sum / 4;
  return {
    week_start: last.week_start,
    last_week_customers: last.customers,
    baseline_customers: Math.round(baseline * 10) / 10,
    drop_pct: Math.round(100 * (1 - last.customers / baseline)),
    drop_customers: Math.round(baseline - last.customers),
  };
}
