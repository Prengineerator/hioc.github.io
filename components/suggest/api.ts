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

import type { ClientSuggestionEventType, SuggestRequest, SuggestResponse, WizardStep } from '@/lib/suggest/types';
import { trackingDeclined } from '@/lib/traffic/client';

const ANON_ID_STORAGE_KEY = 'hioc.suggest.anon';
const EVENTS_ENDPOINT = '/api/suggest/events';
const STEPS_ENDPOINT = '/api/suggest/steps';
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

// ---------------------------------------------------------------------------
// Wizard step tracking (docs/COFFEY-SPEC.md §10.7)
// ---------------------------------------------------------------------------

/**
 * POST /api/suggest/steps — one step of the wizard reached before any picks
 * exist, so there is no session id to send: only the guest id and the step.
 * Fire-and-forget like postSuggestEvent: never throws, never blocks, and the
 * answer is not read. sendBeacon first, because a customer who opens the wizard
 * and leaves at once is exactly who this is counting; a keepalive fetch when
 * the beacon is unavailable or refused.
 *
 * Sends nothing for a browser that asks not to be tracked (Global Privacy
 * Control or Do Not Track), the same rule as the traffic page views, as the
 * privacy policy says.
 */
export function postWizardStep(anonId: string, step: WizardStep): void {
  try {
    if (trackingDeclined()) return;
    const body = JSON.stringify({ anonId, step });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon(STEPS_ENDPOINT, blob)) return;
    }
    fetch(STEPS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // fire-and-forget
    });
  } catch {
    // Never let step tracking touch the UI.
  }
}

/** What the wizard calls as the customer moves through it. */
export interface WizardStepReporter {
  /** The wizard is on screen. Sent once, however often it is called. */
  opened(): void;
  /** A feeling was tapped. Sent the first time only: going Back and picking another is the same visit. */
  feelingChosen(): void;
  /** "Show my picks" was pressed. Sent on every press. */
  picksRequested(): void;
}

/**
 * One reporter per wizard on screen (SuggestWizard keeps it for as long as it is
 * mounted): it holds the two "already sent" marks. Every step carries
 * getAnonId(), the id a request for picks carries too, so a visitor's steps
 * line up with their sessions — including with storage blocked, where
 * getAnonId() keeps one id for the page.
 */
export function createWizardStepReporter(): WizardStepReporter {
  let openedSent = false;
  let feelingSent = false;
  const send = (step: WizardStep) => {
    try {
      postWizardStep(getAnonId(), step);
    } catch {
      // Never let step tracking touch the UI.
    }
  };
  return {
    opened() {
      if (openedSent) return;
      openedSent = true;
      send('opened');
    },
    feelingChosen() {
      if (feelingSent) return;
      feelingSent = true;
      send('feeling_chosen');
    },
    picksRequested() {
      send('picks_requested');
    },
  };
}
