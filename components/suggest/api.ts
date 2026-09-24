'use client';

// Phase 7 (SUG-7/SUG-8/SUG-9) — client-side fetch + event helpers for the
// "Help me choose" suggestion engine. Kept dependency-free from React so it
// can be imported from both components/suggest/* and, for the one
// cross-cutting case (checkout_started), components/checkout/CheckoutForm.tsx.
//
// Contract: lib/suggest/types.ts. This file makes NO assumption about
// /api/suggest or /api/suggest/events beyond that contract; see the final
// report for the (server-side) assumptions this client was built against.

import type { ClientSuggestionEventType, SuggestRequest, SuggestResponse } from '@/lib/suggest/types';

const ANON_ID_STORAGE_KEY = 'hioc.suggest.anon';
const EVENTS_ENDPOINT = '/api/suggest/events';
const SUGGEST_ENDPOINT = '/api/suggest';

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // Last-resort fallback (very old browsers / crypto blocked) — good enough
  // for funnel-continuity purposes only, never used for anything security-sensitive.
  return `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The guest's anonymous id (§3, "anon id"), persisted in localStorage so a
 * refine or a later visit still ties back to the same funnel. Falls back to a
 * fresh, unpersisted id when storage is unavailable (private browsing, quota,
 * blocked) rather than ever throwing — this is a nice-to-have for analytics
 * continuity, never a requirement for the flow to work.
 */
export function getAnonId(): string {
  try {
    const existing = window.localStorage.getItem(ANON_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = randomId();
    window.localStorage.setItem(ANON_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return randomId();
  }
}

/** POST /api/suggest. Throws on a non-OK response or network error/abort — callers handle retry/timeout. */
export async function fetchSuggestions(
  request: SuggestRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<SuggestResponse> {
  const res = await fetch(SUGGEST_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`/api/suggest responded ${res.status}`);
  }
  return (await res.json()) as SuggestResponse;
}

/**
 * POST /api/suggest/events — fire-and-forget (§ "Events"). Never throws and
 * never blocks the caller: analytics must not get in the way of the customer
 * choosing coffee. Uses navigator.sendBeacon for the two events that
 * typically fire as the page is being left (browse_menu, dismissed) so the
 * request survives navigation; falls back to a keepalive fetch when
 * sendBeacon isn't available.
 */
export function postSuggestEvent(
  sessionId: string,
  event: ClientSuggestionEventType,
  menuItemId?: string,
): void {
  try {
    const body = JSON.stringify({ sessionId, event, menuItemId });
    const preferBeacon = event === 'browse_menu' || event === 'dismissed';
    if (preferBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      const queued = navigator.sendBeacon(EVENTS_ENDPOINT, blob);
      if (queued) return;
    }
    fetch(EVENTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // fire-and-forget
    });
  } catch {
    // Never let an events failure touch the UI.
  }
}
