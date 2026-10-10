// Phase 7 · SUG-9 — order attribution (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §7). Split in two, same house pattern as everywhere else in lib/suggest:
// a PURE matcher (unit-testable, no DB) and a thin 'server-only' writer that
// calls it. `'ordered'` is written ONLY here, server-side, never by the
// client events route (playbook S-4).

import { isUuid } from '@/lib/api/constants';
import { PAIRING_LIMITS, SUGGEST_LIMITS } from './types';

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** Keeps up to `max` distinct, valid uuids from an arbitrary request body
 * value — never throws, never causes a 400 (SUG-9 AC: a malformed
 * `suggestion_session_ids` is simply ignored, the order still succeeds). */
export function parseSuggestionSessionIds(raw: unknown, max: number = SUGGEST_LIMITS.orderSessionIdsMax): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (out.length >= max) break;
    if (isUuid(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

export interface AttributionLine {
  menu_item_id: string | null;
  line_total_inr: number;
}

export interface AttributionSession {
  id: string;
  pick_ids: string[];
  usual_item_id: string | null;
  created_at: string;
}

export interface AttributedEvent {
  session_id: string;
  event: 'ordered';
  menu_item_id: string;
  order_id: string;
  value_inr: number;
}

/**
 * §7: one 'ordered' event per order LINE whose `menu_item_id` was a pick or
 * the usual in that session, `value_inr = line_total_inr`. Only sessions
 * younger than `maxAgeHours`. A session id the caller couldn't resolve (bad
 * id, wrong owner, too old — filtered out before this runs) simply isn't in
 * `sessions` and contributes nothing; that's the whole mechanism behind
 * "unknown session id → order still succeeds, nothing written for it".
 */
export function matchAttributionEvents(args: {
  orderId: string;
  lines: AttributionLine[];
  sessions: AttributionSession[];
  now: Date;
  maxAgeHours?: number;
}): AttributedEvent[] {
  const { orderId, lines, sessions, now, maxAgeHours = SUGGEST_LIMITS.eventSessionMaxAgeHours } = args;
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const events: AttributedEvent[] = [];

  for (const session of sessions) {
    const ageMs = now.getTime() - new Date(session.created_at).getTime();
    if (!(ageMs >= 0 && ageMs <= maxAgeMs)) continue;

    const attributable = new Set<string>(session.pick_ids);
    if (session.usual_item_id) attributable.add(session.usual_item_id);
    if (attributable.size === 0) continue;

    for (const line of lines) {
      if (!line.menu_item_id || !attributable.has(line.menu_item_id)) continue;
      events.push({
        session_id: session.id,
        event: 'ordered',
        menu_item_id: line.menu_item_id,
        order_id: orderId,
        value_inr: line.line_total_inr,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Checkout pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.3) — same shape as
// the suggestion attribution above: a lenient parser and a pure matcher here, a
// best-effort writer below.
// ---------------------------------------------------------------------------

/** One entry of POST /api/orders `pairing_lines`. */
export interface PairingLine {
  menu_item_id: string;
  anchor_item_id: string;
}

/**
 * Keeps up to `max` valid, distinct pairing lines from an arbitrary request body
 * value. Lenient by design — never throws, never causes a 400: anything that is
 * not an object with two UUIDs is dropped, a repeat of an item already kept is
 * dropped (the first anchor wins: the server attributes an item's whole line
 * total to it, so a second entry would count the same money twice), and so is an
 * item "paired" with itself. A checkout must never fail over an analytics field.
 */
export function parsePairingLines(raw: unknown, max: number = PAIRING_LIMITS.orderLinesMax): PairingLine[] {
  if (!Array.isArray(raw)) return [];
  const out: PairingLine[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= max) break;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const { menu_item_id, anchor_item_id } = entry as Record<string, unknown>;
    if (!isUuid(menu_item_id) || !isUuid(anchor_item_id)) continue;
    // UUIDs are case-insensitive; order lines carry the lower-case form.
    const itemId = menu_item_id.toLowerCase();
    const anchorId = anchor_item_id.toLowerCase();
    if (itemId === anchorId || seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({ menu_item_id: itemId, anchor_item_id: anchorId });
  }
  return out;
}

export interface PairingOrderedEvent {
  user_id: string | null;
  event: 'ordered';
  menu_item_id: string;
  anchor_item_id: string;
  order_id: string;
  value_inr: number;
}

/**
 * §4.3: one 'ordered' event per pairing line whose `menu_item_id` is actually on
 * the created order. `value_inr` is the summed `line_total_inr` of that item's
 * lines in the order (the same numbers the order was priced with), so an item
 * ordered on two lines counts both. A pairing line for an item that is not in the
 * order contributes nothing: a client cannot claim revenue for something that was
 * not bought.
 */
export function matchPairingEvents(args: {
  orderId: string;
  userId: string | null;
  lines: AttributionLine[];
  pairingLines: PairingLine[];
}): PairingOrderedEvent[] {
  const { orderId, userId, lines, pairingLines } = args;

  const totalByItem = new Map<string, number>();
  for (const line of lines) {
    if (!line.menu_item_id) continue;
    totalByItem.set(line.menu_item_id, (totalByItem.get(line.menu_item_id) ?? 0) + line.line_total_inr);
  }

  const events: PairingOrderedEvent[] = [];
  for (const pairing of pairingLines) {
    const total = totalByItem.get(pairing.menu_item_id);
    if (total === undefined) continue;
    events.push({
      user_id: userId,
      event: 'ordered',
      menu_item_id: pairing.menu_item_id,
      anchor_item_id: pairing.anchor_item_id,
      order_id: orderId,
      value_inr: total,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Server writer
// ---------------------------------------------------------------------------

import 'server-only';
import type { createAdminSupabaseClient } from '@/lib/supabase-server';

type AdminClient = ReturnType<typeof createAdminSupabaseClient>;

/**
 * Best-effort: reads the named sessions, matches them against the order's
 * lines, and inserts the resulting 'ordered' events. NEVER throws — called
 * after the order is fully committed (§7), so nothing here may affect the
 * response the customer already has.
 */
export async function writeOrderAttribution(
  admin: AdminClient,
  args: { orderId: string; sessionIds: string[]; lines: AttributionLine[]; now?: Date },
): Promise<void> {
  const { orderId, sessionIds, lines } = args;
  const now = args.now ?? new Date();
  if (sessionIds.length === 0) return;

  try {
    const { data, error } = await admin
      .from('suggestion_sessions')
      .select('id, pick_ids, usual_item_id, created_at')
      .in('id', sessionIds);
    if (error) {
      console.error('writeOrderAttribution: could not load sessions (best-effort, order unaffected)', error);
      return;
    }

    const events = matchAttributionEvents({ orderId, lines, sessions: (data ?? []) as AttributionSession[], now });
    if (events.length === 0) return;

    const { error: insertError } = await admin.from('suggestion_events').insert(events);
    if (insertError) {
      console.error('writeOrderAttribution: insert failed (best-effort, order unaffected)', insertError);
    }
  } catch (err) {
    console.error('writeOrderAttribution threw (best-effort, order unaffected)', err);
  }
}

/**
 * Best-effort: inserts the 'ordered' pairing_events rows for an order that has
 * just been created (§4.3). `userId` is the order's own `user_id`, never anything
 * the client sent. NEVER throws, and an insert error (including the table not
 * existing before supabase/2026-10-coffey-addons-pairings.sql is applied) is only
 * logged — the order is already committed and nothing here may touch the response.
 */
export async function writePairingAttribution(
  admin: AdminClient,
  args: { orderId: string; userId: string | null; lines: AttributionLine[]; pairingLines: PairingLine[] },
): Promise<void> {
  const { orderId, userId, lines, pairingLines } = args;
  if (pairingLines.length === 0) return;

  try {
    const events = matchPairingEvents({ orderId, userId, lines, pairingLines });
    if (events.length === 0) return;

    const { error } = await admin.from('pairing_events').insert(events);
    if (error) {
      console.error('writePairingAttribution: insert failed (best-effort, order unaffected)', error);
    }
  } catch (err) {
    console.error('writePairingAttribution threw (best-effort, order unaffected)', err);
  }
}
