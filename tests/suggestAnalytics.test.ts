import { describe, expect, it } from 'vitest';

// Pure — no Supabase, no 'server-only' — same posture as customerSegments.test.ts.
import { computeSuggestionStats } from '@/lib/suggest/analytics';
import type { SuggestionEventRow, SuggestionSessionRow, SuggestInputs } from '@/lib/suggest/types';

const WINDOW_START = '2026-09-17T00:00:00.000Z';

function inputs(mood: SuggestInputs['mood']): SuggestInputs {
  return { temperature: 'either', base: 'either', extras: [], needs: [], budget: 'any', mood, note: '' };
}

function session(over: Partial<SuggestionSessionRow> & { id: string }): SuggestionSessionRow {
  return {
    user_id: null,
    anon_id: null,
    inputs: inputs('boost'),
    profile_used: false,
    ordering_mood: null,
    candidate_ids: [],
    pick_ids: [],
    usual_item_id: null,
    source: 'llm',
    fallback_reason: null,
    model: 'claude-opus-5',
    latency_ms: 0,
    input_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    cost_usd_micros: 0,
    refine_of: null,
    created_at: '2026-09-18T10:00:00.000Z',
    ...over,
  };
}

function event(over: Partial<SuggestionEventRow> & { session_id: string; event: SuggestionEventRow['event'] }): SuggestionEventRow {
  return {
    id: `${over.session_id}-${over.event}-${over.menu_item_id ?? ''}`,
    menu_item_id: null,
    order_id: null,
    value_inr: null,
    created_at: '2026-09-18T10:05:00.000Z',
    ...over,
  };
}

// Hand-computed fixture (SUG-10 AC): 5 sessions, a mix of llm/fallback,
// personalised/guest, moods and outcomes — every number below is worked out
// by hand in the comments next to it.
const sessions: SuggestionSessionRow[] = [
  session({ id: 's1', user_id: 'u1', profile_used: true, source: 'llm', latency_ms: 1200, cost_usd_micros: 8000, inputs: inputs('boost') }),
  session({ id: 's2', user_id: null, anon_id: 'anon-1', profile_used: false, source: 'fallback', fallback_reason: 'timeout', latency_ms: 300, cost_usd_micros: 0, model: null, inputs: inputs('cosy') }),
  session({ id: 's3', user_id: 'u2', profile_used: true, source: 'llm', latency_ms: 1800, cost_usd_micros: 9000, inputs: inputs('boost') }),
  session({ id: 's4', user_id: null, anon_id: 'anon-2', profile_used: false, source: 'fallback', fallback_reason: 'budget', latency_ms: 250, cost_usd_micros: 0, model: null, inputs: inputs('celebrate') }),
  session({ id: 's5', user_id: 'u3', profile_used: true, source: 'llm', latency_ms: 1500, cost_usd_micros: 7000, inputs: inputs('cool') }),
];

const events: SuggestionEventRow[] = [
  // s1: picks item-a, item-b — added item-a, checked out, ordered item-a (₹180), 👍 item-a.
  event({ session_id: 's1', event: 'shown', menu_item_id: 'item-a' }),
  event({ session_id: 's1', event: 'shown', menu_item_id: 'item-b' }),
  event({ session_id: 's1', event: 'added_to_cart', menu_item_id: 'item-a' }),
  event({ session_id: 's1', event: 'checkout_started' }),
  event({ session_id: 's1', event: 'ordered', menu_item_id: 'item-a', order_id: 'order-1', value_inr: 180 }),
  event({ session_id: 's1', event: 'feedback_up', menu_item_id: 'item-a' }),

  // s2 (fallback): shown item-c, dismissed — no add.
  event({ session_id: 's2', event: 'shown', menu_item_id: 'item-c' }),
  event({ session_id: 's2', event: 'dismissed' }),

  // s3: picks item-a, item-d — added item-d, 👎 item-d, never checks out/orders.
  event({ session_id: 's3', event: 'shown', menu_item_id: 'item-a' }),
  event({ session_id: 's3', event: 'shown', menu_item_id: 'item-d' }),
  event({ session_id: 's3', event: 'added_to_cart', menu_item_id: 'item-d' }),
  event({ session_id: 's3', event: 'feedback_down', menu_item_id: 'item-d' }),

  // s4 (fallback): shown item-e, browses away.
  event({ session_id: 's4', event: 'shown', menu_item_id: 'item-e' }),
  event({ session_id: 's4', event: 'browse_menu' }),

  // s5: picks item-c — added, checked out, ordered (₹220).
  event({ session_id: 's5', event: 'shown', menu_item_id: 'item-c' }),
  event({ session_id: 's5', event: 'added_to_cart', menu_item_id: 'item-c' }),
  event({ session_id: 's5', event: 'checkout_started' }),
  event({ session_id: 's5', event: 'ordered', menu_item_id: 'item-c', order_id: 'order-2', value_inr: 220 }),
];

const webOrders = [
  { total_inr: 300, subtotal_inr: 300 },
  { total_inr: 500, subtotal_inr: 500 },
  { total_inr: null, subtotal_inr: 250 }, // falls back to subtotal_inr
];

const itemNames = new Map<string, string>([
  ['item-a', 'Latte'],
  ['item-b', 'Cappuccino'],
  ['item-c', 'Iced Americano'],
  ['item-d', 'Mocha'],
  ['item-e', 'Croissant'],
]);

describe('computeSuggestionStats', () => {
  const stats = computeSuggestionStats({ sessions, events, webOrders, itemNames, windowStart: WINDOW_START });

  it('counts DISTINCT sessions through the funnel', () => {
    expect(stats.windowStart).toBe(WINDOW_START);
    expect(stats.sessions).toBe(5);
    expect(stats.sessionsWithAdd).toBe(3); // s1, s3, s5
    expect(stats.sessionsCheckout).toBe(2); // s1, s5
    expect(stats.sessionsOrdered).toBe(2); // s1, s5
  });

  it('sums attributed revenue and computes suggestion AOV over distinct ordered orders', () => {
    expect(stats.attributedRevenueInr).toBe(400); // 180 + 220
    expect(stats.suggestionAovInr).toBe(200); // 400 / 2 distinct orders
  });

  it('computes web AOV using total_inr, falling back to subtotal_inr', () => {
    expect(stats.webAovInr).toBe(350); // (300 + 500 + 250) / 3
  });

  it('builds a zero-filled mood mix with per-mood conversion', () => {
    expect(stats.moodMix).toEqual([
      { mood: 'boost', sessions: 2, ordered: 1 }, // s1 (ordered), s3 (not)
      { mood: 'cosy', sessions: 1, ordered: 0 }, // s2
      { mood: 'celebrate', sessions: 1, ordered: 0 }, // s4
      { mood: 'comfort', sessions: 0, ordered: 0 },
      { mood: 'cool', sessions: 1, ordered: 1 }, // s5
      { mood: 'surprise', sessions: 0, ordered: 0 },
    ]);
  });

  it('tallies per-item suggested/added/ordered/feedback, sorted by suggested desc then name', () => {
    expect(stats.topItems).toEqual([
      { menuItemId: 'item-c', name: 'Iced Americano', suggested: 2, added: 1, ordered: 1, up: 0, down: 0 },
      { menuItemId: 'item-a', name: 'Latte', suggested: 2, added: 1, ordered: 1, up: 1, down: 0 },
      { menuItemId: 'item-b', name: 'Cappuccino', suggested: 1, added: 0, ordered: 0, up: 0, down: 0 },
      { menuItemId: 'item-e', name: 'Croissant', suggested: 1, added: 0, ordered: 0, up: 0, down: 0 },
      { menuItemId: 'item-d', name: 'Mocha', suggested: 1, added: 1, ordered: 0, up: 0, down: 1 },
    ]);
  });

  it('splits personalised vs guest sessions and their conversion', () => {
    expect(stats.personalised).toEqual({ sessions: 3, ordered: 2 }); // s1, s3, s5 → s1 & s5 ordered
    expect(stats.guest).toEqual({ sessions: 2, ordered: 0 }); // s2, s4
  });

  it('computes the LLM share and fallback reason counts', () => {
    expect(stats.llmShare).toBe(0.6); // 3 of 5
    expect(stats.fallbackReasons).toEqual([
      { reason: 'budget', count: 1 },
      { reason: 'timeout', count: 1 },
    ]);
  });

  it('computes p50/p90 latency by nearest rank over all sessions', () => {
    // sorted latencies: 250, 300, 1200, 1500, 1800 (n=5)
    // p50 idx = floor(0.5*5) = 2 → 1200; p90 idx = floor(0.9*5) = 4 → 1800
    expect(stats.latencyP50Ms).toBe(1200);
    expect(stats.latencyP90Ms).toBe(1800);
  });

  it('sums cost_usd_micros into dollars', () => {
    expect(stats.costUsd).toBeCloseTo(0.024, 6); // (8000+0+9000+0+7000) / 1e6
  });

  it('scopes events to the sessions passed in — an event for an unknown session is ignored', () => {
    const out = computeSuggestionStats({
      sessions: [session({ id: 'only', inputs: inputs('surprise') })],
      events: [event({ session_id: 'not-in-window', event: 'shown', menu_item_id: 'item-x' })],
      webOrders: [],
      itemNames: new Map(),
      windowStart: WINDOW_START,
    });
    expect(out.topItems).toEqual([]);
    expect(out.sessionsWithAdd).toBe(0);
  });

  it('returns null AOVs and zero share when there is nothing in the window', () => {
    const empty = computeSuggestionStats({ sessions: [], events: [], webOrders: [], itemNames: new Map(), windowStart: WINDOW_START });
    expect(empty.suggestionAovInr).toBeNull();
    expect(empty.webAovInr).toBeNull();
    expect(empty.llmShare).toBe(0);
    expect(empty.latencyP50Ms).toBeNull();
    expect(empty.latencyP90Ms).toBeNull();
  });
});
