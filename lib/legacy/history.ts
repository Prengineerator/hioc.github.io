// Petpooja history — the read side of the imported legacy tables
// (legacy_orders / legacy_order_items / legacy_customers; see
// supabase/2026-09-petpooja-history.sql and the shared import spec). The
// owner ran Petpooja until 25 Sep 2026 and this app never touches that data —
// it lives in separate, read-only tables so a stale import can't pollute
// `orders` or the loyalty ledger — but the counter POS still benefits from
// being able to SEE it: a regular who only ever ordered through Petpooja
// should not look like a stranger the day this app goes live.
//
// Same privacy discipline as lib/loyalty/customerLink.ts and the routes that
// use it: every query here is scoped to one phone in its stored
// '+91XXXXXXXXXX' form (that's the ONLY form legacy tables store — no bare
// 10-digit fallback to reconcile, unlike orders.customer_phone), and nothing
// beyond name/bill totals/item names is ever read — no email, address, DOB,
// or GSTIN, matching what GET /api/customers/lookup and GET /api/customers/
// orders already refuse to expose about an `orders` customer.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LegacyCustomerOrderResponse, LegacyOrderItemResponse } from '@/lib/api/customerOrders';

export interface LegacyOrderStats {
  count: number;
  lastOrderAt: string | null;
}

/**
 * Completed-bill count + most recent bill date for a phone — what GET
 * /api/customers/lookup folds into `order_count`/`last_order_at` for both
 * the 'account' and 'order_history' sources. Cancelled bills don't count as
 * a past order here any more than a cancelled hioc order does (the same
 * `status` distinction legacy_customers.order_count itself is built from —
 * see refresh_legacy_customer_stats() in the migration).
 */
export async function legacyOrderStatsForPhone(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<LegacyOrderStats> {
  const { data, count, error } = await admin
    .from('legacy_orders')
    .select('ordered_at', { count: 'exact' })
    .eq('customer_phone', phoneE164)
    .eq('status', 'completed')
    .order('ordered_at', { ascending: false })
    .limit(1);
  if (error) {
    console.error('legacyOrderStatsForPhone: query failed', error);
    return { count: 0, lastOrderAt: null };
  }
  return { count: count ?? 0, lastOrderAt: (data?.[0] as { ordered_at: string } | undefined)?.ordered_at ?? null };
}

export interface LegacyCustomerRow {
  name: string;
  order_count: number;
  last_order_at: string | null;
}

/**
 * The legacy_customers row for a phone — used ONLY as the lookup route's last
 * fallback, for a phone Petpooja saw that never placed a single hioc order.
 * `order_count`/`last_order_at` come straight from that row's own precomputed
 * stats (kept current by refresh_legacy_customer_stats(), completed bills
 * only) rather than a second aggregate query — legacy_customers exists
 * precisely so nothing here has to re-derive them from legacy_orders.
 */
export async function legacyCustomerByPhone(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<LegacyCustomerRow | null> {
  const { data, error } = await admin
    .from('legacy_customers')
    .select('name, order_count, last_order_at')
    .eq('phone', phoneE164)
    .maybeSingle();
  if (error) {
    console.error('legacyCustomerByPhone: query failed', error);
    return null;
  }
  return (data as LegacyCustomerRow | null) ?? null;
}

interface LegacyOrderWithItemsRow {
  id: string;
  bill_no: string;
  ordered_at: string;
  total_inr: number;
  legacy_order_items:
    | {
        position: number;
        item_name: string;
        variant_label: string;
        menu_item_id: string | null;
        variant_id: string | null;
      }[]
    | null;
}

/**
 * The latest `limit` legacy bills for a phone, with their items — the
 * Petpooja half of GET /api/customers/orders' merge. One query
 * (legacy_order_items embedded), the same "no N+1" discipline as the hioc
 * side (ORDERS_SELECT in app/api/customers/orders/route.ts). No status
 * filter: a cancelled hioc order still shows up in "Last orders" today, so a
 * cancelled legacy bill is kept for the same reason (this is a history list,
 * not a stats query).
 */
export async function latestLegacyBillsForPhone(
  admin: SupabaseClient,
  phoneE164: string,
  limit: number,
): Promise<LegacyCustomerOrderResponse[]> {
  const { data, error } = await admin
    .from('legacy_orders')
    .select(
      'id, bill_no, ordered_at, total_inr, legacy_order_items(position, item_name, variant_label, menu_item_id, variant_id)',
    )
    .eq('customer_phone', phoneE164)
    .order('ordered_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('latestLegacyBillsForPhone: query failed', error);
    return [];
  }
  return ((data ?? []) as unknown as LegacyOrderWithItemsRow[]).map(toLegacyCustomerOrderResponse);
}

function toLegacyCustomerOrderResponse(row: LegacyOrderWithItemsRow): LegacyCustomerOrderResponse {
  const items: LegacyOrderItemResponse[] = (row.legacy_order_items ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      name_snapshot: item.item_name,
      variant_label_snapshot: item.variant_label,
      menu_item_id: item.menu_item_id,
      variant_id: item.variant_id,
      quantity: null,
    }));
  return {
    source: 'petpooja',
    id: row.id,
    bill_no: row.bill_no,
    created_at: row.ordered_at,
    total_inr: row.total_inr,
    items,
  };
}
