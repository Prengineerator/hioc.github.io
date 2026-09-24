// Phase 7 (SUG-8): pure helper for collecting the distinct suggestion-session
// ids carried by the current cart, so CheckoutForm can attribute an order to
// the /suggest sessions that produced its lines.
//
// Kept dependency-free (no Supabase, no React) so it's unit-testable without
// a DOM — see tests/suggestCart.test.ts.

import { SUGGEST_LIMITS } from '@/lib/suggest/types';

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
