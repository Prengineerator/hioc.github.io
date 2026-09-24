// Phase 7 · SUG-10/SUG-2 — server-only reads backing the owner Suggestions
// dashboard (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §7). Mirrors the house
// split (F6): lib/suggest/analytics.ts does the arithmetic, this file fetches
// the rows through the service-role client and degrades gracefully — empty
// stats + `missingTables: true` — when supabase/2026-09-suggestion-engine.sql
// hasn't been applied yet, the same posture lib/analytics/queries.ts and
// lib/cash/checkpoints.ts take toward a pending migration.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { computeSuggestionStats } from './analytics';
import type { MenuItemTraits, SuggestionDigestRow, SuggestionEventRow, SuggestionSessionRow, SuggestionStats } from './types';

// True when `error` means "the relation/column doesn't exist" — the migration
// isn't applied yet. Same check as lib/cash/checkpoints.ts's
// `isMissingRelation`, duplicated locally per that file's own note (mirrored
// across feature boundaries rather than imported).
function isMissingSuggestRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205' || error.code === '42703') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('schema cache') || msg.includes('does not exist');
}

const QUERY_ROW_LIMIT = 20000;

export interface SuggestionStatsResult {
  stats: SuggestionStats;
  missingTables: boolean;
}

function emptyStats(windowStart: string): SuggestionStats {
  return computeSuggestionStats({ sessions: [], events: [], webOrders: [], itemNames: new Map(), windowStart });
}

/**
 * The dashboard's numbers for the window starting at `windowStart` (an ISO
 * timestamp). Reads suggestion_sessions, the window-bounded
 * suggestion_events for those sessions, 'customer_web' orders in the window
 * (not rejected/cancelled, for the web-AOV comparison), and the menu-item
 * names the top-picks table needs.
 */
export async function getSuggestionStats(windowStart: string): Promise<SuggestionStatsResult> {
  const admin = createAdminSupabaseClient();

  const { data: sessions, error: sessionsErr } = await admin
    .from('suggestion_sessions')
    .select('*')
    .gte('created_at', windowStart)
    .limit(QUERY_ROW_LIMIT);
  if (sessionsErr) {
    if (!isMissingSuggestRelation(sessionsErr)) console.error('getSuggestionStats: suggestion_sessions failed', sessionsErr);
    return { stats: emptyStats(windowStart), missingTables: isMissingSuggestRelation(sessionsErr) };
  }
  const sessionRows = (sessions ?? []) as SuggestionSessionRow[];
  const sessionIds = sessionRows.map((s) => s.id);

  const [eventsResult, webOrdersResult] = await Promise.all([
    sessionIds.length > 0
      ? admin.from('suggestion_events').select('*').gte('created_at', windowStart).in('session_id', sessionIds).limit(QUERY_ROW_LIMIT)
      : Promise.resolve({ data: [] as SuggestionEventRow[], error: null }),
    admin
      .from('orders')
      .select('total_inr, subtotal_inr')
      .eq('channel', 'customer_web')
      .not('status', 'in', '("rejected","cancelled")')
      .gte('created_at', windowStart)
      .limit(QUERY_ROW_LIMIT),
  ]);

  if (eventsResult.error) {
    if (isMissingSuggestRelation(eventsResult.error)) {
      return {
        stats: computeSuggestionStats({ sessions: sessionRows, events: [], webOrders: [], itemNames: new Map(), windowStart }),
        missingTables: true,
      };
    }
    console.error('getSuggestionStats: suggestion_events failed', eventsResult.error);
  }
  if (webOrdersResult.error) console.error('getSuggestionStats: web orders failed', webOrdersResult.error);

  const eventRows = (eventsResult.data ?? []) as SuggestionEventRow[];
  const webOrderRows = (webOrdersResult.data ?? []) as { total_inr: number | null; subtotal_inr: number }[];

  const itemIds = [...new Set(eventRows.map((e) => e.menu_item_id).filter((id): id is string => Boolean(id)))];
  let itemNames = new Map<string, string>();
  if (itemIds.length > 0) {
    const { data: menuItems, error: itemsErr } = await admin.from('menu_items').select('id, name').in('id', itemIds);
    if (itemsErr) console.error('getSuggestionStats: menu item names failed', itemsErr);
    else itemNames = new Map((menuItems ?? []).map((m) => [m.id as string, m.name as string]));
  }

  return {
    stats: computeSuggestionStats({ sessions: sessionRows, events: eventRows, webOrders: webOrderRows, itemNames, windowStart }),
    missingTables: false,
  };
}

/** The most recent weekly digest row (SUG-12), or null when none exist yet
 * (including "table not migrated"). */
export async function getLatestDigest(): Promise<SuggestionDigestRow | null> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('suggestion_digests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (!isMissingSuggestRelation(error)) console.error('getLatestDigest failed', error);
    return null;
  }
  return (data as SuggestionDigestRow | null) ?? null;
}

export interface TraitsOverviewRow {
  menuItemId: string;
  name: string;
  category: string;
  parentCategory: string;
  isVeg: boolean;
  isAvailable: boolean;
  traits: MenuItemTraits | null;
}

export interface TraitsOverview {
  rows: TraitsOverviewRow[];
  /** Items with a traits row that isn't confirmed yet. */
  unconfirmedCount: number;
  /** Items with NO traits row at all (never suggested — §5.1). */
  missingCount: number;
  missingTables: boolean;
}

/** Every menu item joined with its traits row (Traits tab, SUG-2). An item
 * with no row shows `traits: null` — it stays on the menu but the engine
 * never suggests it until it's tagged. */
export async function getTraitsOverview(): Promise<TraitsOverview> {
  const admin = createAdminSupabaseClient();

  const [itemsResult, traitsResult] = await Promise.all([
    admin
      .from('menu_items')
      .select('id, name, category, parent_category, is_veg, is_available')
      .order('category', { ascending: true })
      .order('sort_order', { ascending: true }),
    admin.from('menu_item_traits').select('*'),
  ]);

  if (itemsResult.error) {
    console.error('getTraitsOverview: menu_items failed', itemsResult.error);
    return { rows: [], unconfirmedCount: 0, missingCount: 0, missingTables: false };
  }
  if (traitsResult.error) {
    if (isMissingSuggestRelation(traitsResult.error)) {
      return { rows: [], unconfirmedCount: 0, missingCount: 0, missingTables: true };
    }
    console.error('getTraitsOverview: menu_item_traits failed', traitsResult.error);
    return { rows: [], unconfirmedCount: 0, missingCount: 0, missingTables: false };
  }

  const traitsById = new Map(((traitsResult.data ?? []) as MenuItemTraits[]).map((t) => [t.menu_item_id, t]));

  let unconfirmedCount = 0;
  let missingCount = 0;
  const rows: TraitsOverviewRow[] = (itemsResult.data ?? []).map((i) => {
    const traits = traitsById.get(i.id as string) ?? null;
    if (!traits) missingCount += 1;
    else if (!traits.confirmed) unconfirmedCount += 1;
    return {
      menuItemId: i.id as string,
      name: i.name as string,
      category: i.category as string,
      parentCategory: i.parent_category as string,
      isVeg: i.is_veg as boolean,
      isAvailable: i.is_available as boolean,
      traits,
    };
  });

  return { rows, unconfirmedCount, missingCount, missingTables: false };
}
