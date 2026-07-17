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
  DailySalesRow,
  HourlyOrdersRow,
  ItemSalesRow,
  OrderDurationRow,
  RejectReasonRow,
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
