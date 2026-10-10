// COFFEY-ADDONS-PAIRINGS-SPEC §4.4 — the arithmetic behind the owner's
// "Checkout pairings" card. Pure (no Supabase, no 'server-only'), so the tests
// import it directly. lib/suggest/pairingStatsQuery.ts fetches the rows and
// hands them here, the same split as lib/suggest/analytics.ts and queries.ts.

import type { PairingEventRow } from './types';

/** The pairing_events columns the summary reads. */
export type PairingEventSlice = Pick<
  PairingEventRow,
  'event' | 'menu_item_id' | 'anchor_item_id' | 'value_inr' | 'anon_id' | 'user_id'
>;

/** How many (anchor, suggested item) pairs the card lists. */
const TOP_PAIRS = 5;

/** Shown in place of a name the menu no longer has (the item was removed). */
const REMOVED_ITEM_LABEL = 'Removed item';

export interface PairingTopPair {
  anchorItemId: string;
  anchorName: string;
  menuItemId: string;
  name: string;
  added: number;
  ordered: number;
}

export interface PairingStats {
  /** Distinct (viewer, suggested item) pairs shown in the window. */
  shown: number;
  /** 'added' rows (every add-to-cart counts, not just the first). */
  added: number;
  /** 'ordered' rows: orders that carried a pairing line. */
  ordered: number;
  /** added ÷ shown, or null when nothing was shown. */
  addRate: number | null;
  /** Sum of value_inr over 'ordered' rows; a null value counts as 0. */
  revenueInr: number;
  /** Up to five pairs, most added first. Pairs with no add or order are left out. */
  topPairs: PairingTopPair[];
}

/**
 * Summarises pairing_events rows. `names` maps menu item id → name; an id it
 * does not hold shows as "Removed item".
 *
 * - shown: distinct (viewer, menu_item_id) over 'shown' rows, where the viewer
 *   is user_id, else anon_id, else one shared 'anon' bucket.
 * - top pairs are ordered by added desc, ordered desc, then the anchor name,
 *   the suggested item's name, and finally the ids, all ascending, so the
 *   order is stable.
 */
export function summarisePairingEvents(rows: PairingEventSlice[], names: Map<string, string>): PairingStats {
  const shownKeys = new Set<string>();
  let added = 0;
  let ordered = 0;
  let revenueInr = 0;
  const pairs = new Map<string, { anchorItemId: string; menuItemId: string; added: number; ordered: number }>();

  for (const row of rows) {
    if (row.event === 'shown') {
      const viewer = row.user_id ?? row.anon_id ?? 'anon';
      shownKeys.add(JSON.stringify([viewer, row.menu_item_id]));
      continue;
    }
    if (row.event !== 'added' && row.event !== 'ordered') continue;
    if (row.event === 'added') {
      added += 1;
    } else {
      ordered += 1;
      revenueInr += row.value_inr ?? 0;
    }

    if (!row.anchor_item_id || !row.menu_item_id) continue;
    const key = `${row.anchor_item_id}|${row.menu_item_id}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { anchorItemId: row.anchor_item_id, menuItemId: row.menu_item_id, added: 0, ordered: 0 };
      pairs.set(key, pair);
    }
    if (row.event === 'added') pair.added += 1;
    else pair.ordered += 1;
  }

  const label = (id: string) => names.get(id) ?? REMOVED_ITEM_LABEL;
  const topPairs: PairingTopPair[] = [...pairs.values()]
    .map((p) => ({
      anchorItemId: p.anchorItemId,
      anchorName: label(p.anchorItemId),
      menuItemId: p.menuItemId,
      name: label(p.menuItemId),
      added: p.added,
      ordered: p.ordered,
    }))
    .sort(
      (a, b) =>
        b.added - a.added ||
        b.ordered - a.ordered ||
        a.anchorName.localeCompare(b.anchorName, 'en') ||
        a.name.localeCompare(b.name, 'en') ||
        a.anchorItemId.localeCompare(b.anchorItemId) ||
        a.menuItemId.localeCompare(b.menuItemId),
    )
    .slice(0, TOP_PAIRS);

  const shown = shownKeys.size;
  return {
    shown,
    added,
    ordered,
    addRate: shown > 0 ? added / shown : null,
    revenueInr,
    topPairs,
  };
}
