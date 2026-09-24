// Phase 7 · SUG-10 — pure aggregation for the owner Suggestions dashboard
// (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §7). Mirrors the house split (F6):
// this file does the arithmetic and is unit-tested with a hand-computed
// fixture (tests/suggestAnalytics.test.ts); lib/suggest/queries.ts fetches the
// rows. No Supabase, no 'server-only' — safe to import from tests and, if it
// is ever needed, from a client component.

import { MOODS, type FallbackReason, type SuggestionEventRow, type SuggestionSessionRow, type SuggestionStats } from './types';

export interface ComputeSuggestionStatsArgs {
  sessions: SuggestionSessionRow[];
  events: SuggestionEventRow[];
  /** Web (customer_web) orders in the same window, not rejected/cancelled. */
  webOrders: { total_inr: number | null; subtotal_inr: number }[];
  /** menu_item_id → display name, for the top-picks table. */
  itemNames: Map<string, string>;
  windowStart: string;
}

/** Nearest-rank percentile over an ASCENDING-sorted array. Same convention as
 * app/owner/page.tsx's local `percentile()` helper. */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

type ItemTally = { suggested: number; added: number; ordered: number; up: number; down: number };

/**
 * Turns raw session + event rows into the dashboard's numbers. Funnel counts
 * are DISTINCT sessions (a session with two `added_to_cart` events still
 * counts once). Events are scoped to the sessions passed in — `sessions` is
 * assumed to already be the windowed set (lib/suggest/queries.ts filters by
 * `created_at >= windowStart`), so an event is counted here iff its
 * `session_id` belongs to one of those sessions.
 */
export function computeSuggestionStats(args: ComputeSuggestionStatsArgs): SuggestionStats {
  const { sessions, events, webOrders, itemNames, windowStart } = args;

  const sessionIds = new Set(sessions.map((s) => s.id));
  const scopedEvents = events.filter((e) => sessionIds.has(e.session_id));

  const sessionsWithEvent = (type: SuggestionEventRow['event']): Set<string> => {
    const set = new Set<string>();
    for (const e of scopedEvents) if (e.event === type) set.add(e.session_id);
    return set;
  };
  const addedSet = sessionsWithEvent('added_to_cart');
  const checkoutSet = sessionsWithEvent('checkout_started');
  const orderedSet = sessionsWithEvent('ordered');

  const orderedEvents = scopedEvents.filter((e) => e.event === 'ordered');
  const attributedRevenueInr = orderedEvents.reduce((sum, e) => sum + (e.value_inr ?? 0), 0);
  const orderedOrderIds = new Set(orderedEvents.map((e) => e.order_id).filter((id): id is string => Boolean(id)));
  const suggestionAovInr = orderedOrderIds.size > 0 ? Math.round(attributedRevenueInr / orderedOrderIds.size) : null;

  const webTotal = webOrders.reduce((sum, o) => sum + (o.total_inr ?? o.subtotal_inr), 0);
  const webAovInr = webOrders.length > 0 ? Math.round(webTotal / webOrders.length) : null;

  // Zero-filled across all six moods (like bucketDineInHours zero-fills 24
  // hours) so the bar chart's axis never jumps around window to window.
  const moodMix = MOODS.map((mood) => {
    const moodSessions = sessions.filter((s) => s.inputs?.mood === mood);
    const ordered = moodSessions.filter((s) => orderedSet.has(s.id)).length;
    return { mood, sessions: moodSessions.length, ordered };
  });

  const itemAgg = new Map<string, ItemTally>();
  const bump = (id: string | null, field: keyof ItemTally) => {
    if (!id) return;
    const acc = itemAgg.get(id) ?? { suggested: 0, added: 0, ordered: 0, up: 0, down: 0 };
    acc[field] += 1;
    itemAgg.set(id, acc);
  };
  for (const e of scopedEvents) {
    if (e.event === 'shown') bump(e.menu_item_id, 'suggested');
    else if (e.event === 'added_to_cart') bump(e.menu_item_id, 'added');
    else if (e.event === 'ordered') bump(e.menu_item_id, 'ordered');
    else if (e.event === 'feedback_up') bump(e.menu_item_id, 'up');
    else if (e.event === 'feedback_down') bump(e.menu_item_id, 'down');
  }
  const topItems = [...itemAgg.entries()]
    .map(([menuItemId, a]) => ({ menuItemId, name: itemNames.get(menuItemId) ?? menuItemId, ...a }))
    .sort((x, y) => y.suggested - x.suggested || x.name.localeCompare(y.name));

  const personalisedSessions = sessions.filter((s) => s.profile_used);
  const guestSessions = sessions.filter((s) => !s.profile_used);
  const personalised = {
    sessions: personalisedSessions.length,
    ordered: personalisedSessions.filter((s) => orderedSet.has(s.id)).length,
  };
  const guest = {
    sessions: guestSessions.length,
    ordered: guestSessions.filter((s) => orderedSet.has(s.id)).length,
  };

  const llmShare = sessions.length > 0 ? sessions.filter((s) => s.source === 'llm').length / sessions.length : 0;

  const fallbackCounts = new Map<FallbackReason, number>();
  for (const s of sessions) {
    if (s.source === 'fallback' && s.fallback_reason) {
      fallbackCounts.set(s.fallback_reason, (fallbackCounts.get(s.fallback_reason) ?? 0) + 1);
    }
  }
  const fallbackReasons = [...fallbackCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const latencies = sessions
    .map((s) => s.latency_ms)
    .filter((n): n is number => Number.isFinite(n))
    .sort((a, b) => a - b);
  const latencyP50Ms = percentile(latencies, 50);
  const latencyP90Ms = percentile(latencies, 90);

  const costUsd = sessions.reduce((sum, s) => sum + s.cost_usd_micros, 0) / 1_000_000;

  return {
    windowStart,
    sessions: sessions.length,
    sessionsWithAdd: addedSet.size,
    sessionsCheckout: checkoutSet.size,
    sessionsOrdered: orderedSet.size,
    attributedRevenueInr,
    suggestionAovInr,
    webAovInr,
    moodMix,
    topItems,
    personalised,
    guest,
    llmShare,
    fallbackReasons,
    latencyP50Ms,
    latencyP90Ms,
    costUsd,
  };
}
