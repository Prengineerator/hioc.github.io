'use client';

// Phase 7 (SUG-7/SUG-8/SUG-9) — client-side fetch + event helpers for the
// suggestion engine ("Ask Coffey", COFFEY-SPEC). Kept dependency-free from React
// so it can be imported from both components/suggest/* and, for the one
// cross-cutting case (checkout_started), components/checkout/CheckoutForm.tsx.
//
// Contract: lib/suggest/types.ts. This file makes NO assumption about
// /api/suggest or /api/suggest/events beyond that contract, and it is generic
// over it: the request/response types (v2 SuggestInputs, matchTags, sugarPreset)
// come straight from the contract, so nothing here changes when they do.

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

// The id handed out on this page while storage could not keep one. Set in the
// browser only: this module can also be evaluated on the server, where a
// module-level id would be shared across requests and visitors.
let pageAnonId: string | null = null;

/**
 * The guest's anonymous id (§3, "anon id"), persisted in localStorage so a
 * refine or a later visit still ties back to the same funnel. Never throws.
 *
 * When storage is unavailable (blocked site data, some in-app webviews,
 * private browsing, quota) the id cannot outlive the page, but it must stay the
 * same for the life of the page: /api/suggest only accepts a guest's refine
 * that carries the id its first request carried. So the id made on the first
 * call is remembered and returned on every later one, whether reading storage
 * throws or reading works and writing throws.
 *
 * While storage works, storage is the only source: the stored id is read on
 * each call and nothing is remembered here.
 */
export function getAnonId(): string {
  let created: string | null = null;
  try {
    const existing = window.localStorage.getItem(ANON_ID_STORAGE_KEY);
    if (existing) return existing;
    // Nothing stored. If an earlier call on this page could not store its id,
    // offer that same id to storage again instead of making another.
    created = pageAnonId ?? randomId();
    window.localStorage.setItem(ANON_ID_STORAGE_KEY, created);
    return created;
  } catch {
    const id = pageAnonId ?? created ?? randomId();
    if (typeof window !== 'undefined') pageAnonId = id;
    return id;
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
