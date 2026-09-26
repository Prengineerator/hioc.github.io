// Phase 7 · SUG-5 — Petpooja history feeding the taste profile
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.5). The owner ran Petpooja until
// 25 Sep 2026; that history lives in the read-only legacy_orders/
// legacy_order_items tables (supabase/2026-09-petpooja-history.sql) and this
// app never writes to them — but a regular who only ever ordered through
// Petpooja shouldn't look like a stranger to "Your usual" the day this app
// goes live.
//
// Same split as lib/suggest/profile.ts / profileStore.ts: the mapping/merge
// below is pure (no Supabase) so it's unit-testable without a database; the
// two query functions at the bottom are the 'server-only' half, called from
// profileStore.ts alongside its own `orders` reads. Same privacy discipline
// as lib/legacy/history.ts: only status/ordered_at/totals/menu_item_id are
// ever read here — never name, address, GSTIN, raw, payments or
// customer_phone_raw.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderStatus } from '@/lib/types';

/** Raw shape for `.select(LEGACY_PROFILE_SELECT)` below. */
export interface LegacyProfileOrderRow {
  status: string; // legacy_orders.status — DB check constraint: 'completed' | 'cancelled'
  ordered_at: string;
  total_inr: number | null;
  subtotal_inr: number;
  legacy_order_items: { menu_item_id: string | null }[] | null;
}

/**
 * The shape profileStore.ts builds its own `orders` rows into before the
 * category/traits join — Petpooja bills are mapped to this SAME shape so the
 * two sources can be windowed, merged and capped as one list before that
 * join happens, with no separate code path downstream.
 */
export interface ProfileRawOrder {
  status: OrderStatus;
  created_at: string;
  total_inr: number | null;
  subtotal_inr: number;
  order_items: { menu_item_id: string | null; quantity: number; voided: boolean }[] | null;
}

/**
 * Petpooja bill → taste-profile input. Pure, DB-free.
 *
 *  - status: legacy_orders.status is only ever 'completed' or 'cancelled'
 *    (DB check constraint); anything else maps to 'cancelled' so an
 *    unrecognised value is excluded the same way buildTasteProfile excludes
 *    a genuinely cancelled order, rather than silently counting toward the
 *    profile.
 *  - created_at: the bill's `ordered_at`.
 *  - quantity: always 1 — the Petpooja export never recorded a line
 *    quantity (legacy_order_items.quantity is always NULL; see
 *    supabase/2026-09-petpooja-history.sql).
 *  - voided: always false — Petpooja has no void concept in this export;
 *    every imported line is treated as having happened.
 *  - a line with `menu_item_id: null` (unmatched to this app's menu) is
 *    KEPT, exactly like an app order line whose menu_item_id came back null
 *    — buildTasteProfile still counts it toward totalLines/category (as
 *    '') even though it can't contribute to topItems or traits.
 */
export function mapLegacyOrderForProfile(row: LegacyProfileOrderRow): ProfileRawOrder {
  return {
    status: row.status === 'completed' ? 'completed' : 'cancelled',
    created_at: row.ordered_at,
    total_inr: row.total_inr,
    subtotal_inr: row.subtotal_inr,
    order_items: (row.legacy_order_items ?? []).map((item) => ({
      menu_item_id: item.menu_item_id,
      quantity: 1,
      voided: false,
    })),
  };
}

/**
 * Orders with `created_at` on/after `windowStartMs` — the same 90-day cut
 * buildTasteProfile itself re-applies (belt and braces). Exported so
 * profileStore.ts can apply it identically to both sources BEFORE merging:
 * an order just outside the window must never occupy a cap slot a newer,
 * in-window order from the OTHER source could have used.
 */
export function filterOrdersInWindow<T extends { created_at: string }>(orders: T[], windowStartMs: number): T[] {
  return orders.filter((o) => new Date(o.created_at).getTime() >= windowStartMs);
}

/**
 * App orders + Petpooja bills, newest first, capped to `cap` total. Same
 * fetch-up-to-`cap`-from-each-side-then-merge shape as GET /api/customers/
 * orders (app/api/customers/orders/route.ts): each side already brought at
 * most `cap` rows, but the cap has to apply to the MERGED list — capping
 * either side first, before merging, could drop a real row that's newer
 * than the other source's Nth.
 */
export function mergeProfileOrders(appOrders: ProfileRawOrder[], legacyOrders: ProfileRawOrder[], cap: number): ProfileRawOrder[] {
  return [...appOrders, ...legacyOrders]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, cap);
}

const LEGACY_PROFILE_SELECT = 'status, ordered_at, total_inr, subtotal_inr, legacy_order_items(menu_item_id)';

/**
 * This phone's Petpooja bills, mapped to the taste-profile shape, newest
 * first, at most `limit` — the Petpooja half of profileStore.ts's rebuild.
 * Never throws: a query failure logs and degrades to `[]`, the same
 * never-throws/degrade-on-error contract every other read in that file
 * keeps.
 */
export async function legacyOrdersForProfile(
  admin: SupabaseClient,
  phoneE164: string,
  limit: number,
): Promise<ProfileRawOrder[]> {
  const { data, error } = await admin
    .from('legacy_orders')
    .select(LEGACY_PROFILE_SELECT)
    .eq('customer_phone', phoneE164)
    .order('ordered_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('legacyOrdersForProfile: query failed', error);
    return [];
  }
  return ((data ?? []) as unknown as LegacyProfileOrderRow[]).map(mapLegacyOrderForProfile);
}

/**
 * The newest completed Petpooja bill's `ordered_at` for this phone — feeds
 * profileStore.ts's cheap staleness probe alongside its own `orders` side,
 * so a customer whose most recent activity for this profile is a Petpooja
 * bill still gets an accurate `source_order_at`/`isStale`. Cancelled bills
 * are excluded, matching the app-orders probe's own
 * `.not('status', 'in', '("rejected","cancelled")')`. Never throws.
 */
export async function newestLegacyOrderAt(admin: SupabaseClient, phoneE164: string): Promise<string | null> {
  const { data, error } = await admin
    .from('legacy_orders')
    .select('ordered_at')
    .eq('customer_phone', phoneE164)
    .eq('status', 'completed')
    .order('ordered_at', { ascending: false })
    .limit(1);
  if (error) {
    console.error('newestLegacyOrderAt: query failed', error);
    return null;
  }
  return (data?.[0] as { ordered_at: string } | undefined)?.ordered_at ?? null;
}
