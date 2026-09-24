import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { CLIENT_SUGGESTION_EVENTS, SUGGEST_LIMITS } from '@/lib/suggest/types';
import type { ClientSuggestionEventType } from '@/lib/suggest/types';

export const dynamic = 'force-dynamic';

// §5.6-style abuse guard for a public, unauthenticated, fire-and-forget
// endpoint — generous, since a normal /suggest session fires a handful of
// these, but bounded so it can't become a free insert-spam surface.
const EVENTS_RATE_LIMIT_MAX = 120;
const EVENTS_RATE_LIMIT_WINDOW_SECS = 600;

function isClientEvent(v: unknown): v is ClientSuggestionEventType {
  return typeof v === 'string' && (CLIENT_SUGGESTION_EVENTS as readonly string[]).includes(v);
}

// POST /api/suggest/events — public. Body: { sessionId, event, menuItemId? }.
// Accepts both a normal JSON fetch and navigator.sendBeacon's `text/plain`
// Blob body (components/suggest/api.ts postSuggestEvent) — Request#json()
// parses the body text regardless of Content-Type, so no special-casing is
// needed here. 'shown' and 'ordered' are server-written only (playbook S-4)
// and are rejected here like any other unknown event.
export async function POST(request: Request) {
  if (!flags.suggest) {
    return errorResponse(404, 'Not found');
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { sessionId, event, menuItemId } = body;
  if (!isUuid(sessionId)) {
    return errorResponse(400, 'sessionId must be a valid uuid');
  }
  if (!isClientEvent(event)) {
    return errorResponse(400, `event must be one of: ${CLIENT_SUGGESTION_EVENTS.join(', ')}`);
  }
  if (menuItemId !== undefined && menuItemId !== null && !isUuid(menuItemId)) {
    return errorResponse(400, 'menuItemId must be a valid uuid');
  }

  const ip = clientIp(request);
  if (!(await rateLimitOk(`suggest-event:${ip}`, EVENTS_RATE_LIMIT_MAX, EVENTS_RATE_LIMIT_WINDOW_SECS))) {
    return errorResponse(429, 'Too many requests');
  }

  const admin = createAdminSupabaseClient();
  const { data: session, error } = await admin
    .from('suggestion_sessions')
    .select('id, created_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (error) {
    console.error('suggest events route: session lookup failed', error);
    return errorResponse(404, 'Not found');
  }
  if (!session) {
    return errorResponse(404, 'Not found');
  }
  const ageMs = Date.now() - new Date(session.created_at as string).getTime();
  if (ageMs > SUGGEST_LIMITS.eventSessionMaxAgeHours * 60 * 60 * 1000) {
    return errorResponse(404, 'Not found');
  }

  const { error: insertError } = await admin.from('suggestion_events').insert({
    session_id: sessionId,
    event,
    menu_item_id: menuItemId ?? null,
  });
  if (insertError) {
    console.error('suggest events route: insert failed', insertError);
    return errorResponse(500, 'Failed to record event');
  }

  return new NextResponse(null, { status: 204 });
}
