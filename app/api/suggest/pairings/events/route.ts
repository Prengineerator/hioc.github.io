import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { validatePairingEventsRequest } from '@/lib/suggest/pairingsValidate';

export const dynamic = 'force-dynamic';

// Abuse guard for a public, unauthenticated, fire-and-forget endpoint — the same
// ceiling as /api/suggest/events: a checkout fires a handful of these, but it
// must not become a free insert-spam surface.
const EVENTS_RATE_LIMIT_MAX = 120;
const EVENTS_RATE_LIMIT_WINDOW_SECS = 600;

// POST /api/suggest/pairings/events — public. Body: { anonId?, events: [{ event,
// menuItemId, anchorItemId }] }, at most PAIRING_LIMITS.eventsPerRequest events
// (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.3). Only the CLIENT_PAIRING_EVENTS
// ('shown', 'added') are accepted: 'ordered' is written by POST /api/orders.
//
// `user_id` comes from the session and is never read from the body. The insert is
// best-effort: whatever happens to it — including the table not existing yet,
// before supabase/2026-10-coffey-addons-pairings.sql is applied — a valid request
// answers 204, because analytics must never get in the way of the checkout.
export async function POST(request: Request) {
  if (!flags.checkoutPairings) {
    return errorResponse(404, 'Not found');
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }
  const parsed = validatePairingEventsRequest(body);
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }

  const ip = clientIp(request);
  if (!(await rateLimitOk(`suggest-pairing-event:${ip}`, EVENTS_RATE_LIMIT_MAX, EVENTS_RATE_LIMIT_WINDOW_SECS))) {
    return errorResponse(429, 'Too many requests');
  }

  try {
    // A signed-out visitor, or a session lookup that fails, is just anonymous.
    let userId: string | null = null;
    try {
      userId = (await getAuthUser())?.id ?? null;
    } catch {
      userId = null;
    }

    const admin = createAdminSupabaseClient();
    const { error } = await admin.from('pairing_events').insert(
      parsed.events.map((e) => ({
        anon_id: parsed.anonId,
        user_id: userId,
        event: e.event,
        menu_item_id: e.menuItemId,
        anchor_item_id: e.anchorItemId,
      })),
    );
    if (error) console.error('suggest pairings events route: insert failed (best-effort)', error);
  } catch (err) {
    console.error('suggest pairings events route: insert threw (best-effort)', err);
  }

  return new NextResponse(null, { status: 204 });
}
