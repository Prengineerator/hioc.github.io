// Server-side data the Coffey routes share: the orderable menu with its traits,
// the 30-day popularity map, and the 90-day co-order statistics
// (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.2).
//
// `loadMenuAndTraits` and `loadPopularity30d` used to live in
// app/api/suggest/route.ts; they moved here unchanged so POST /api/suggest and
// POST /api/suggest/pairings read the SAME per-instance, 60 s cache: a customer
// who has just used the wizard doesn't make the checkout rail pay for a second
// menu load. `loadCoOrderStats` is new and sits on a longer (10 min) cache of its
// own, because order history moves slowly and the query is the heaviest of the
// three.
//
// Every loader fails soft — it logs and returns an empty value — so a database
// hiccup costs a suggestion, never a checkout.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { MENU_ITEM_SELECT, shapeMenuItem, type MenuItemRow } from '@/lib/orders/lines';
import type { AddonOptionTraitsRow, AddonTraits, CoOrderStats, MenuItemTraits } from '@/lib/suggest/types';
import { PAIRING_LIMITS } from '@/lib/suggest/types';
import { buildCoOrderStats } from '@/lib/suggest/pairings';
import type { MenuItem } from '@/lib/types';
import { isInStoreOnly } from '@/lib/menu/inStore';
import { getStoreSettings } from '@/lib/store/settings';
import { applyMenuSwitches, isCategoryHidden, switchesFromSettings } from '@/lib/menu/menuSwitches';

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

// ---------------------------------------------------------------------------
// Menu + traits + popularity: in-memory, per-instance, 60s cache (§5's
// architecture diagram: "[cache 60 s]"). A stale-by-a-minute menu is a
// non-issue for a suggestion; a Supabase round trip on every keystroke of a
// wizard is.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;

export interface MenuAndTraits {
  items: MenuItem[];
  traitsById: Map<string, MenuItemTraits>;
  /** The owner's add-on trait overrides, option id → traits (COFFEY-ADDONS-PAIRINGS-SPEC §2.3). */
  addonTraitsById: Map<string, AddonTraits>;
}

let menuCache: ({ at: number } & MenuAndTraits) | null = null;
let popularityCache: { at: number; map: Map<string, number> } | null = null;

export async function loadMenuAndTraits(admin: AdminClient): Promise<MenuAndTraits> {
  if (menuCache && Date.now() - menuCache.at < CACHE_TTL_MS) return menuCache;

  const [menuResult, traitsResult, addonTraitsResult, settings] = await Promise.all([
    admin.from('menu_items').select(MENU_ITEM_SELECT).eq('is_available', true),
    admin.from('menu_item_traits').select('*'),
    admin.from('addon_option_traits').select('*'),
    getStoreSettings(),
  ]);
  if (menuResult.error) {
    console.error('suggest route: menu load failed', menuResult.error);
    return { items: [], traitsById: new Map(), addonTraitsById: new Map() };
  }
  if (traitsResult.error) {
    console.error('suggest route: traits load failed', traitsResult.error);
  }
  // The table is created by supabase/2026-10-coffey-addons-pairings.sql, so it
  // may be missing before that migration is applied: log once per cache fill and
  // carry on with the derived defaults (an empty map).
  if (addonTraitsResult.error) {
    console.error('suggest route: add-on traits load failed', addonTraitsResult.error);
  }

  // Coffey v2 (COFFEY-SPEC §4.7): MENU_ITEM_SELECT brings every item's addon
  // groups WITH their options, and shapeMenuItem keeps them on `addon_groups`.
  // Sugar detection (lib/suggest/sugar.ts) reads exactly that, both to rank a
  // sugar-adjustable coffee fairly and to preselect its sugar option, and the
  // rows come back in the response's `items` for the customise modal — so don't
  // narrow this select. applyMenuSwitches below drops switched-off options, so a
  // "No Sugar" that is out of stock can never be the preset.
  //
  // In-store-only items (water bottles…) are never suggested — not even as a
  // regular's "usual", though their counter orders and Petpooja history may be
  // full of them.
  const items = (menuResult.data ?? [])
    // Nothing switched off (category, size, add-on) is suggested either.
    .map((row) => applyMenuSwitches(shapeMenuItem(row as unknown as MenuItemRow), switchesFromSettings(settings)))
    .filter((item) => !isCategoryHidden(item.category, settings.hidden_categories))
    .filter((item) => !isInStoreOnly(item));
  const traitsById = new Map<string, MenuItemTraits>(
    ((traitsResult.data ?? []) as MenuItemTraits[]).map((t) => [t.menu_item_id, t]),
  );

  const addonTraitsById = new Map<string, AddonTraits>();
  if (!addonTraitsResult.error) {
    for (const row of (addonTraitsResult.data ?? []) as AddonOptionTraitsRow[]) {
      addonTraitsById.set(row.option_id, {
        role: row.role,
        flavour_families: row.flavour_families ?? [],
        sweetness_delta: row.sweetness_delta,
        intensity_delta: row.intensity_delta,
        indulgence_delta: row.indulgence_delta,
        textures: row.textures ?? [],
      });
    }
  }

  menuCache = { at: Date.now(), items, traitsById, addonTraitsById };
  return menuCache;
}

/** 30-day units sold, across the whole menu (§5.3 popularity term). */
export async function loadPopularity30d(admin: AdminClient): Promise<Map<string, number>> {
  if (popularityCache && Date.now() - popularityCache.at < CACHE_TTL_MS) return popularityCache.map;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('order_items')
    .select('menu_item_id, quantity, voided, orders!inner(status, created_at)')
    .gte('orders.created_at', since)
    .not('orders.status', 'in', '("rejected","cancelled")');
  if (error) {
    console.error('suggest route: popularity load failed', error);
    return new Map();
  }

  const map = new Map<string, number>();
  for (const row of (data ?? []) as { menu_item_id: string | null; quantity: number; voided: boolean }[]) {
    if (!row.menu_item_id || row.voided) continue;
    map.set(row.menu_item_id, (map.get(row.menu_item_id) ?? 0) + row.quantity);
  }
  popularityCache = { at: Date.now(), map };
  return map;
}

// ---------------------------------------------------------------------------
// Co-order statistics (COFFEY-ADDONS-PAIRINGS-SPEC §4.2): which items real
// customers buy together. 10 min cache — yesterday's baskets barely move in ten
// minutes, and this is the one loader that reads thousands of orders.
// ---------------------------------------------------------------------------

const CO_ORDER_TTL_MS = 10 * 60_000;
/** After a failed load, try again after this long rather than on every request. */
const CO_ORDER_FAILURE_TTL_MS = 60_000;
/** Orders per query. Supabase caps a response (1000 rows by default), so the
 * history is read a page at a time. */
const CO_ORDER_PAGE_SIZE = 1000;

let coOrderCache: { at: number; ttlMs: number; stats: CoOrderStats } | null = null;
let coOrderInFlight: Promise<CoOrderStats> | null = null;

function emptyCoOrderStats(): CoOrderStats {
  return buildCoOrderStats([]);
}

interface OrderWithLinesRow {
  order_items: { menu_item_id: string | null; voided: boolean | null }[] | null;
}

async function fetchCoOrderStats(admin: AdminClient): Promise<CoOrderStats> {
  const since = new Date(Date.now() - PAIRING_LIMITS.historyDays * 24 * 60 * 60 * 1000).toISOString();
  const orders: { itemIds: string[] }[] = [];

  // Newest first, so the cap keeps the most recent baskets. `id` breaks ties
  // between orders created in the same instant, which keeps the pages from
  // overlapping or skipping a row.
  for (let from = 0; from < PAIRING_LIMITS.historyMaxOrders; from += CO_ORDER_PAGE_SIZE) {
    const to = Math.min(from + CO_ORDER_PAGE_SIZE, PAIRING_LIMITS.historyMaxOrders) - 1;
    const { data, error } = await admin
      .from('orders')
      .select('order_items(menu_item_id, voided)')
      .gte('created_at', since)
      .not('status', 'in', '("rejected","cancelled")')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to);
    if (error) {
      console.error('suggest route: co-order history load failed', error);
      return emptyCoOrderStats();
    }

    const rows = (data ?? []) as unknown as OrderWithLinesRow[];
    for (const row of rows) {
      const itemIds: string[] = [];
      for (const line of row.order_items ?? []) {
        if (line.menu_item_id && !line.voided) itemIds.push(line.menu_item_id);
      }
      orders.push({ itemIds });
    }
    if (rows.length < to - from + 1) break; // a short page is the last page
  }

  return buildCoOrderStats(orders);
}

/**
 * How often each item, and each pair of items, appears in the same order over
 * the last PAIRING_LIMITS.historyDays days (at most PAIRING_LIMITS.historyMaxOrders
 * orders, newest first). Rejected and cancelled orders and voided lines are left
 * out. Cached for 10 minutes; concurrent callers share one load. On any error it
 * logs and answers empty stats, so the ranker falls back to its other terms.
 */
export async function loadCoOrderStats(admin: AdminClient): Promise<CoOrderStats> {
  if (coOrderCache && Date.now() - coOrderCache.at < coOrderCache.ttlMs) return coOrderCache.stats;
  if (coOrderInFlight) return coOrderInFlight;

  coOrderInFlight = (async () => {
    try {
      const stats = await fetchCoOrderStats(admin);
      // An empty answer is either a quiet shop or a failed load; retry it sooner.
      coOrderCache = { at: Date.now(), ttlMs: stats.orders > 0 ? CO_ORDER_TTL_MS : CO_ORDER_FAILURE_TTL_MS, stats };
      return stats;
    } catch (err) {
      console.error('suggest route: co-order history load threw', err);
      const stats = emptyCoOrderStats();
      coOrderCache = { at: Date.now(), ttlMs: CO_ORDER_FAILURE_TTL_MS, stats };
      return stats;
    } finally {
      coOrderInFlight = null;
    }
  })();
  return coOrderInFlight;
}
