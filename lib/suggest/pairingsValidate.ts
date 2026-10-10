// Checkout pairings — validating the two request bodies
// (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.2, §4.3). Same shape as
// lib/suggest/validate.ts: a body in, a parsed value or a short error string out,
// so the routes answer `errorResponse(400, parsed)` for a string.
//
// Pure: no Supabase, no 'server-only', no React.

import { isUuid } from '@/lib/api/constants';
import { CLIENT_PAIRING_EVENTS, PAIRING_LIMITS } from './types';
import type { ClientPairingEventType, PairingRequest } from './types';

/** `anonId` is the browser's localStorage id (components/suggest/api.ts getAnonId):
 * a UUID, or `anon-<time>-<random>` when crypto is unavailable. Both fit well inside this. */
export const PAIRING_ANON_ID_MAX_CHARS = 64;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * POST /api/suggest/pairings: `{ itemIds: string[] }`. The ids are de-duplicated
 * (first-seen order kept, lower-cased), each must be a UUID, and at most
 * PAIRING_LIMITS.cartItemsMax distinct ones are allowed. An empty list is valid
 * (the rail simply has nothing to pair).
 */
export function validatePairingRequest(body: unknown): PairingRequest | string {
  if (!isRecord(body)) return 'request body must be an object';
  const { itemIds } = body;
  if (!Array.isArray(itemIds)) return 'itemIds must be an array';

  const distinct: string[] = [];
  for (const id of itemIds) {
    if (!isUuid(id)) return 'itemIds must all be valid uuids';
    // UUIDs are case-insensitive but the menu is keyed by the lower-case form.
    const normal = id.toLowerCase();
    if (!distinct.includes(normal)) distinct.push(normal);
  }
  if (distinct.length > PAIRING_LIMITS.cartItemsMax) {
    return `itemIds must have at most ${PAIRING_LIMITS.cartItemsMax} distinct items`;
  }
  return { itemIds: distinct };
}

/** One 'shown' / 'added' event as the browser reports it. */
export interface ClientPairingEvent {
  event: ClientPairingEventType;
  /** The item Coffey suggested. */
  menuItemId: string;
  /** The cart item it was suggested beside. */
  anchorItemId: string;
}

export interface PairingEventsRequest {
  /** The browser's anonymous id; null when it sent none. */
  anonId: string | null;
  events: ClientPairingEvent[];
}

function isClientPairingEvent(v: unknown): v is ClientPairingEventType {
  return typeof v === 'string' && (CLIENT_PAIRING_EVENTS as readonly string[]).includes(v);
}

/**
 * POST /api/suggest/pairings/events:
 * `{ anonId?, events: [{ event, menuItemId, anchorItemId }] }`.
 * One to PAIRING_LIMITS.eventsPerRequest events; `event` must be on the browser
 * whitelist (CLIENT_PAIRING_EVENTS: 'ordered' is server-written only) and both ids
 * must be UUIDs. A `user_id` in the body is not read at all: the route takes it
 * from the session.
 */
export function validatePairingEventsRequest(body: unknown): PairingEventsRequest | string {
  if (!isRecord(body)) return 'request body must be an object';

  let anonId: string | null = null;
  if (body.anonId !== undefined && body.anonId !== null) {
    if (typeof body.anonId !== 'string' || body.anonId.length > PAIRING_ANON_ID_MAX_CHARS) {
      return `anonId must be a string of at most ${PAIRING_ANON_ID_MAX_CHARS} characters`;
    }
    anonId = body.anonId === '' ? null : body.anonId;
  }

  const { events } = body;
  if (!Array.isArray(events) || events.length === 0) return 'events must be a non-empty array';
  if (events.length > PAIRING_LIMITS.eventsPerRequest) {
    return `events must have at most ${PAIRING_LIMITS.eventsPerRequest} entries`;
  }

  const parsed: ClientPairingEvent[] = [];
  for (const e of events) {
    if (!isRecord(e)) return 'each event must be an object';
    if (!isClientPairingEvent(e.event)) return `event must be one of: ${CLIENT_PAIRING_EVENTS.join(', ')}`;
    if (!isUuid(e.menuItemId)) return 'menuItemId must be a valid uuid';
    if (!isUuid(e.anchorItemId)) return 'anchorItemId must be a valid uuid';
    parsed.push({ event: e.event, menuItemId: e.menuItemId, anchorItemId: e.anchorItemId });
  }
  return { anonId, events: parsed };
}
