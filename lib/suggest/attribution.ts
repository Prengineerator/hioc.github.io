// Phase 7 · SUG-9 — order attribution (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §7). Split in two, same house pattern as everywhere else in lib/suggest:
// a PURE matcher (unit-testable, no DB) and a thin 'server-only' writer that
// calls it. `'ordered'` is written ONLY here, server-side, never by the
// client events route (playbook S-4).

import { isUuid } from '@/lib/api/constants';
import { SUGGEST_LIMITS } from './types';

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
