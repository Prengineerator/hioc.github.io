// Phase 7 (SUG-8): pure helper for collecting the distinct suggestion-session
// ids carried by the current cart, so CheckoutForm can attribute an order to
// the /suggest sessions that produced its lines.
//
// Kept dependency-free (no Supabase, no React) so it's unit-testable without
// a DOM — see tests/suggestCart.test.ts.

import { PAIRING_LIMITS, SUGGEST_LIMITS } from '@/lib/suggest/types';

/**
 * Returns the distinct `suggestionSessionId`s found on the given cart lines,
 * in first-seen order, capped at `max` (default `SUGGEST_LIMITS.orderSessionIdsMax`).
 * Returns `undefined` when no line carries one, so callers can spread the
 * result straight into a request body and have the field disappear entirely
 * rather than serializing as `[]` (SUG-8 AC: "no suggested lines → field absent").
 */
export function collectSuggestionSessionIds(
  items: readonly { suggestionSessionId?: string }[],
  max: number = SUGGEST_LIMITS.orderSessionIdsMax,
): string[] | undefined {
  const distinct: string[] = [];
  for (const item of items) {
    const id = item.suggestionSessionId;
    if (id && !distinct.includes(id)) {
      distinct.push(id);
    }
  }
  if (distinct.length === 0) return undefined;
  return distinct.slice(0, max);
}

/** One entry of POST /api/orders `pairing_lines`: a cart item that was added from
 * the checkout "Pairs well with your order" card, and the cart item it was
 * suggested beside (COFFEY-ADDONS-PAIRINGS-SPEC §4.3). */
export interface PairingLinePayload {
  menu_item_id: string;
  anchor_item_id: string;
}

/**
 * The `pairing_lines` for an order: one entry per distinct menu item among the
 * cart lines that carry a `pairingAnchorId`, in first-seen order (the first line
 * of an item wins when its lines name different anchors), capped at `max`
 * (default `PAIRING_LIMITS.orderLinesMax`). One entry per ITEM because the server
 * attributes an item's whole line total to it, so two entries for one item would
 * count that money twice. Returns `undefined` when no line carries an anchor, so
 * a caller can spread the result into the request body and have the field
 * disappear entirely, like `collectSuggestionSessionIds`.
 */
export function collectPairingLines(
  items: readonly { menuItemId: string; pairingAnchorId?: string }[],
  max: number = PAIRING_LIMITS.orderLinesMax,
): PairingLinePayload[] | undefined {
  const lines: PairingLinePayload[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.pairingAnchorId || !item.menuItemId || seen.has(item.menuItemId)) continue;
    seen.add(item.menuItemId);
    lines.push({ menu_item_id: item.menuItemId, anchor_item_id: item.pairingAnchorId });
  }
  const capped = lines.slice(0, Math.max(0, max));
  return capped.length > 0 ? capped : undefined;
}
