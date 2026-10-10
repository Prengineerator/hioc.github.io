// COFFEY-ADDONS-PAIRINGS-SPEC §4.4 — server-only read behind the owner
// "Checkout pairings" card. Mirrors getSuggestionStats in lib/suggest/queries.ts:
// the service-role client, a row limit, and empty stats + missingTable: true
// while supabase/2026-10-coffey-addons-pairings.sql hasn't been applied. The
// arithmetic lives in lib/suggest/pairingStats.ts.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { summarisePairingEvents, type PairingEventSlice, type PairingStats } from './pairingStats';

// True when `error` means "the relation/column doesn't exist" — the migration
// isn't applied yet. Same check as queries.ts's `isMissingSuggestRelation`,
// duplicated here per the house note (mirrored across files, not imported).
function isMissingPairingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === '42703') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('schema cache') || msg.includes('does not exist');
}

const QUERY_ROW_LIMIT = 20000;

export interface PairingStatsResult {
  stats: PairingStats;
  missingTable: boolean;
}

/**
 * The checkout-pairings numbers for the window starting at `windowStart` (an
 * ISO timestamp). Reads pairing_events since then, drops 'ordered' rows whose
 * order is no longer live (an online-paid order is written before payment, the
 * same reason getSuggestionStats filters), and fetches the names of the menu
 * items the rows mention.
 */
export async function getPairingStats(windowStart: string): Promise<PairingStatsResult> {
  const admin = createAdminSupabaseClient();

  const { data, error } = await admin
    .from('pairing_events')
    .select('event, menu_item_id, anchor_item_id, value_inr, anon_id, user_id, order_id')
    .gte('created_at', windowStart)
    .limit(QUERY_ROW_LIMIT);
  if (error) {
    if (!isMissingPairingRelation(error)) console.error('getPairingStats: pairing_events failed', error);
    return { stats: summarisePairingEvents([], new Map()), missingTable: isMissingPairingRelation(error) };
  }

  const rawRows = (data ?? []) as (PairingEventSlice & { order_id: string | null })[];
  const orderedIds = [...new Set(rawRows.filter((r) => r.event === 'ordered' && r.order_id).map((r) => r.order_id as string))];
  let liveOrderIds = new Set<string>();
  if (orderedIds.length > 0) {
    const { data: liveOrders, error: liveErr } = await admin
      .from('orders')
      .select('id')
      .in('id', orderedIds)
      .not('status', 'in', '("placed","rejected","cancelled")');
    if (liveErr) console.error('getPairingStats: attributed order status failed', liveErr);
    else liveOrderIds = new Set((liveOrders ?? []).map((o) => o.id as string));
  }
  const rows = rawRows.filter((r) => r.event !== 'ordered' || (r.order_id !== null && liveOrderIds.has(r.order_id)));

  const itemIds = [
    ...new Set(rows.flatMap((r) => [r.menu_item_id, r.anchor_item_id]).filter((id): id is string => Boolean(id))),
  ];
  let names = new Map<string, string>();
  if (itemIds.length > 0) {
    const { data: menuItems, error: itemsErr } = await admin.from('menu_items').select('id, name').in('id', itemIds);
    if (itemsErr) console.error('getPairingStats: menu item names failed', itemsErr);
    else names = new Map((menuItems ?? []).map((m) => [m.id as string, m.name as string]));
  }

  return { stats: summarisePairingEvents(rows, names), missingTable: false };
}
