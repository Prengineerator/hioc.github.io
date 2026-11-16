// First-party traffic tracking: reading traffic_events for Owner → Traffic.
//
// Server-only (service role). Reads the rows of a date range a page at a time,
// then asks orders and shop_orders which of the recorded orders really went
// through, and hands both to lib/traffic/summary.ts.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { isMissingTrafficTable } from '@/lib/traffic/record';
import { summarizeTraffic, trafficRange, type TrafficEventRow, type TrafficSummary } from '@/lib/traffic/summary';

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

const PAGE_SIZE = 1000;
/** 100,000 rows. Far past this cafe's traffic; the page says so if it is ever reached. */
const MAX_PAGES = 100;
const ID_CHUNK = 150;

const COLUMNS =
  'created_at, event, session_id, page_group, route, landing, source, referrer_host, utm_source, utm_medium, utm_campaign, device, country, city, order_id, shop_order_id, value_inr';

/** Order statuses that mean the order did not go through: still waiting for payment, or refused. */
const NOT_COUNTED_ORDER_STATUSES = new Set(['placed', 'rejected', 'cancelled']);

export type TrafficLoad =
  | { ok: true; summary: TrafficSummary }
  | { ok: false; missingTable: boolean; error: string };

async function readRows(admin: AdminClient, sinceIso: string): Promise<{ rows: TrafficEventRow[]; truncated: boolean; error: unknown }> {
  const rows: TrafficEventRow[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await admin
      .from('traffic_events')
      .select(COLUMNS)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) return { rows, truncated: false, error };
    const batch = (data ?? []) as unknown as TrafficEventRow[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, truncated: false, error: null };
  }
  return { rows, truncated: true, error: null };
}

async function idsWhere(
  admin: AdminClient,
  table: 'orders' | 'shop_orders',
  ids: string[],
  columns: string,
  keep: (row: Record<string, unknown>) => boolean,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await admin.from(table).select(columns).in('id', chunk);
    if (error) {
      console.error(`traffic load: reading ${table} failed`, error);
      continue;
    }
    for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
      if (keep(row)) out.add(String(row.id));
    }
  }
  return out;
}

export async function loadTraffic(days: number, now: Date = new Date()): Promise<TrafficLoad> {
  const range = trafficRange(days, now);
  try {
    const admin = createAdminSupabaseClient();
    const read = await readRows(admin, range.sinceIso);
    if (read.error) {
      const err = read.error as { code?: string; message?: string };
      if (isMissingTrafficTable(err)) return { ok: false, missingTable: true, error: 'traffic_events does not exist yet' };
      console.error('traffic load: reading traffic_events failed', err);
      return { ok: false, missingTable: false, error: err.message ?? 'Could not read traffic' };
    }

    const orderIds = [...new Set(read.rows.filter((r) => r.event === 'order' && r.order_id).map((r) => r.order_id as string))];
    const shopIds = [
      ...new Set(read.rows.filter((r) => r.event === 'shop_order' && r.shop_order_id).map((r) => r.shop_order_id as string)),
    ];
    const [countedOrders, countedShop] = await Promise.all([
      idsWhere(admin, 'orders', orderIds, 'id, status', (r) => !NOT_COUNTED_ORDER_STATUSES.has(String(r.status))),
      idsWhere(admin, 'shop_orders', shopIds, 'id, status, paid_at', (r) => r.paid_at != null && r.status !== 'cancelled'),
    ]);

    return {
      ok: true,
      summary: summarizeTraffic({
        rows: read.rows,
        counted: { orderIds: countedOrders, shopOrderIds: countedShop },
        range: { sinceDay: range.sinceDay, untilDay: range.untilDay, days },
        truncated: read.truncated,
      }),
    };
  } catch (err) {
    console.error('traffic load threw', err);
    return { ok: false, missingTable: false, error: 'Could not read traffic' };
  }
}
