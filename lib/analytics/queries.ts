// Typed analytics query layer (F5). The owner dashboard reads through these
// helpers instead of hand-rolling Supabase queries per widget. All revenue uses
// the SNAPSHOTTED order totals (via the v_* views defined in
// phase1-migration.sql §10) so historical menu edits never rewrite history.
//
// Server-only (uses the service-role client). Views enforce "valid revenue"
// (excludes rejected/cancelled) so callers don't repeat that filter.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { startOfTodayIstIso } from '@/lib/api/date';
import type {
  ChannelMixRow,
  DailySalesRow,
  HourlyOrdersRow,
  ItemSalesRow,
  OrderChannel,
  OrderDurationRow,
  RejectReasonRow,
  StaffEntryStatsRow,
  TableTurnoverRow,
} from '@/lib/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily revenue/orders/AOV (OWN-003), most recent first, limited to `days`. */
export async function getDailySales(days = 30): Promise<DailySalesRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('v_daily_sales')
    .select('*')
    .order('sale_date', { ascending: false })
    .limit(days);
  if (error) {
    console.error('getDailySales failed', error);
    return [];
  }
  return (data ?? []) as DailySalesRow[];
}

/** Item units + revenue from snapshots (OWN-005). `limit` top rows by revenue. */
export async function getItemSales(limit = 50): Promise<ItemSalesRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('v_item_sales')
    .select('*')
    .order('revenue_inr', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('getItemSales failed', error);
    return [];
  }
  return (data ?? []) as ItemSalesRow[];
}

/** Day-of-week × hour order counts for the peak-hours heatmap (OWN-007). */
export async function getHourlyOrders(): Promise<HourlyOrdersRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('v_hourly_orders').select('*');
  if (error) {
    console.error('getHourlyOrders failed', error);
    return [];
  }
  return (data ?? []) as HourlyOrdersRow[];
}

/** Per-order stage durations for SLA/prep-time metrics (OWN-008). */
export async function getOrderDurations(days = 30): Promise<OrderDurationRow[]> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const { data, error } = await admin
    .from('v_order_durations')
    .select('*')
    .gte('order_date', since);
  if (error) {
    console.error('getOrderDurations failed', error);
    return [];
  }
  return (data ?? []) as OrderDurationRow[];
}

/** Rejection/cancellation reason breakdown (OWN-004). */
export async function getRejectReasons(): Promise<RejectReasonRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('v_reject_reasons').select('*');
  if (error) {
    console.error('getRejectReasons failed', error);
    return [];
  }
  return (data ?? []) as RejectReasonRow[];
}

/**
 * Order counts by lifecycle status over the last `days` (OWN-004). Tallied in
 * JS from a single status column read — cheap at cafe volume.
 */
export async function getStatusCounts(days = 30): Promise<Record<string, number>> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { data, error } = await admin
    .from('orders')
    .select('status')
    .gte('created_at', since)
    .limit(5000);
  if (error) {
    console.error('getStatusCounts failed', error);
    return {};
  }
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { status: string }[]) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return counts;
}

export interface GlanceMetric {
  value: number;
  prior: number; // same metric, same weekday last week
  deltaPct: number | null; // null when prior is 0 (no baseline)
}

export interface TodayAtAGlance {
  revenue: GlanceMetric;
  orders: GlanceMetric;
  aov: GlanceMetric;
  inProgress: number; // live count of non-terminal orders (received..ready)
}

function metric(value: number, prior: number): GlanceMetric {
  const deltaPct = prior === 0 ? null : Math.round(((value - prior) / prior) * 100);
  return { value, prior, deltaPct };
}

/**
 * Today-at-a-glance (O1): revenue, order count, AOV — each vs. the same weekday
 * last week — plus a live in-progress count. Reads the daily-sales view for the
 * two comparison days and counts live active orders directly.
 */
export async function getTodayAtAGlance(): Promise<TodayAtAGlance> {
  const admin = createAdminSupabaseClient();

  const todayIso = startOfTodayIstIso().slice(0, 10);
  const lastWeekIso = new Date(Date.parse(startOfTodayIstIso()) - 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);

  const [{ data: sales }, { count: inProgress }] = await Promise.all([
    admin.from('v_daily_sales').select('*').in('sale_date', [todayIso, lastWeekIso]),
    admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .in('status', ['received', 'accepted', 'preparing', 'ready']),
  ]);

  const rows = (sales ?? []) as DailySalesRow[];
  const today = rows.find((r) => r.sale_date === todayIso);
  const prior = rows.find((r) => r.sale_date === lastWeekIso);

  return {
    revenue: metric(today?.revenue_inr ?? 0, prior?.revenue_inr ?? 0),
    orders: metric(today?.orders ?? 0, prior?.orders ?? 0),
    aov: metric(today?.aov_inr ?? 0, prior?.aov_inr ?? 0),
    inProgress: inProgress ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Channel & dine-in analytics (OPS-1). Reads the Phase-3 views defined in
// supabase/phase3-migration.sql §9 — v_channel_mix, v_table_turnover,
// v_staff_entry_stats — plus v_valid_orders for the dine-in peak-hours bucket.
// Same "views do the aggregation, helpers just shape/window it" pattern as the
// Phase-1/2 functions above.
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** One row per channel after rolling up its order-type split (OPS-1). */
export interface ChannelSummaryRow {
  channel: OrderChannel;
  orders: number;
  revenue_inr: number;
  avg_ticket_inr: number;
}

/** Dine-in order count for a single IST hour-of-day slot (0..23). */
export interface HourlyDineInRow {
  hour: number;
  orders: number;
}

/** A staff member's order-entry totals over the window, name resolved. */
export interface StaffLeaderboardRow {
  staff_id: string;
  name: string;
  orders_entered: number;
  revenue_inr: number;
}

/**
 * Roll the channel×order-type mix up to one row per channel and derive the
 * average ticket per channel (OPS-1 "average ticket per channel"). Pure so the
 * arithmetic is unit-testable without a DB.
 */
export function summariseChannels(rows: ChannelMixRow[]): ChannelSummaryRow[] {
  const byChannel = new Map<OrderChannel, { orders: number; revenue_inr: number }>();
  for (const r of rows) {
    const acc = byChannel.get(r.channel) ?? { orders: 0, revenue_inr: 0 };
    acc.orders += r.orders;
    acc.revenue_inr += r.revenue_inr;
    byChannel.set(r.channel, acc);
  }
  return [...byChannel.entries()]
    .map(([channel, a]) => ({
      channel,
      orders: a.orders,
      revenue_inr: a.revenue_inr,
      avg_ticket_inr: a.orders ? Math.round(a.revenue_inr / a.orders) : 0,
    }))
    .sort((x, y) => y.revenue_inr - x.revenue_inr);
}

/**
 * Bucket dine-in order timestamps (UTC ISO strings) into 24 IST hour slots.
 * Always returns all 24 slots (zero-filled) so the chart axis is stable. Pure.
 */
export function bucketDineInHours(timestamps: string[]): HourlyDineInRow[] {
  const buckets: HourlyDineInRow[] = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0 }));
  for (const ts of timestamps) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    const istHour = new Date(ms + IST_OFFSET_MS).getUTCHours();
    buckets[istHour].orders += 1;
  }
  return buckets;
}

/** Orders + revenue by channel × order type (OPS-1), highest revenue first. */
export async function getChannelMix(): Promise<ChannelMixRow[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('v_channel_mix')
    .select('*')
    .order('revenue_inr', { ascending: false });
  if (error) {
    console.error('getChannelMix failed', error);
    return [];
  }
  return (data ?? []) as ChannelMixRow[];
}

/** Table turnover — settled orders per table per IST day (OPS-1), recent window. */
export async function getTableTurnover(days = 30): Promise<TableTurnoverRow[]> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const { data, error } = await admin
    .from('v_table_turnover')
    .select('*')
    .gte('business_date', since)
    .order('business_date', { ascending: false })
    .order('settled_orders', { ascending: false });
  if (error) {
    console.error('getTableTurnover failed', error);
    return [];
  }
  return (data ?? []) as TableTurnoverRow[];
}

/**
 * Dine-in peak hours (OPS-1): valid dine-in orders over the window bucketed by
 * IST hour-of-day. Reads created_at from v_valid_orders (rejected/cancelled
 * already excluded) and buckets in JS — cheap at cafe volume, same precedent as
 * getStatusCounts.
 */
export async function getDineInPeakHours(days = 30): Promise<HourlyDineInRow[]> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString();
  const { data, error } = await admin
    .from('v_valid_orders')
    .select('created_at')
    .eq('order_type', 'dine_in')
    .gte('created_at', since)
    .limit(10000);
  if (error) {
    console.error('getDineInPeakHours failed', error);
    return bucketDineInHours([]);
  }
  return bucketDineInHours((data ?? []).map((r) => (r as { created_at: string }).created_at));
}

/**
 * Staff order-entry leaderboard (OPS-1): staff_pos orders keyed by created_by,
 * aggregated across the window and joined to profile names. v_staff_entry_stats
 * is per-staff-per-day, so we sum the days here, then resolve names via profiles.
 */
export async function getStaffLeaderboard(days = 30): Promise<StaffLeaderboardRow[]> {
  const admin = createAdminSupabaseClient();
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const { data, error } = await admin
    .from('v_staff_entry_stats')
    .select('*')
    .gte('business_date', since);
  if (error) {
    console.error('getStaffLeaderboard failed', error);
    return [];
  }

  const byStaff = new Map<string, { orders_entered: number; revenue_inr: number }>();
  for (const r of (data ?? []) as StaffEntryStatsRow[]) {
    if (!r.staff_id) continue;
    const acc = byStaff.get(r.staff_id) ?? { orders_entered: 0, revenue_inr: 0 };
    acc.orders_entered += r.orders_entered;
    acc.revenue_inr += r.revenue_inr;
    byStaff.set(r.staff_id, acc);
  }

  const ids = [...byStaff.keys()];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profs, error: pErr } = await admin
      .from('profiles')
      .select('id, name')
      .in('id', ids);
    if (pErr) {
      console.error('getStaffLeaderboard profiles lookup failed', pErr);
    } else {
      for (const p of (profs ?? []) as { id: string; name: string | null }[]) {
        if (p.name) names.set(p.id, p.name);
      }
    }
  }

  return [...byStaff.entries()]
    .map(([staff_id, a]) => ({
      staff_id,
      name: names.get(staff_id) || 'Unknown staff',
      orders_entered: a.orders_entered,
      revenue_inr: a.revenue_inr,
    }))
    .sort((x, y) => y.orders_entered - x.orders_entered);
}
