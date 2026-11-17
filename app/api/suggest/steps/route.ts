import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { validateWizardStepRequest } from '@/lib/suggest/wizardSteps';
import { insertWizardStep } from '@/lib/suggest/wizardStepsStore';
import { isBotUserAgent } from '@/lib/traffic/classify';

export const dynamic = 'force-dynamic';

// Abuse guard for a public, unauthenticated, fire-and-forget endpoint — the same
// ceiling as /api/suggest/events and /api/suggest/pairings/events, in a bucket
// of its own: a wizard visit sends an open, a feeling and a press or two, but
// it must not become a free insert-spam surface.
const STEPS_RATE_LIMIT_MAX = 120;
const STEPS_RATE_LIMIT_WINDOW_SECS = 600;

// POST /api/suggest/steps — public. Body: { anonId, step }, where step is one of
// WIZARD_STEPS ('opened', 'feeling_chosen', 'picks_requested'). Sent by the
// /suggest wizard (components/suggest/api.ts) so the owner can see where
// customers leave before any picks exist (docs/COFFEY-SPEC.md §10.7). Unlike
// /api/suggest/events there is no session to attach to: a session row is only
// created when picks are requested.
//
// What is stored is the step, the time, the browser's guest id and, when signed
// in, the user id from the session — never from the body. Nothing the customer
// chose or typed has a field here. The IP address and User-Agent are read for
// the rate limit and the crawler check and dropped.
//
// Best-effort: a valid request answers 204 whatever happens to the insert,
// including before supabase/2026-11-coffey-wizard-steps.sql is applied.
// Crawlers that run the page's script get 204 and nothing is written — they
// would otherwise read as visitors who opened the wizard and left.
export async function POST(request: Request) {
  if (!flags.suggest) {
    return errorResponse(404, 'Not found');
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }
  const parsed = validateWizardStepRequest(body);
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }

  if (isBotUserAgent(request.headers.get('user-agent'))) {
    return new NextResponse(null, { status: 204 });
  }

  const ip = clientIp(request);
  if (!(await rateLimitOk(`suggest-step:${ip}`, STEPS_RATE_LIMIT_MAX, STEPS_RATE_LIMIT_WINDOW_SECS))) {
    return errorResponse(429, 'Too many requests');
  }

  try {
    // A signed-out visitor, or a session lookup that fails, is just a guest.
    let userId: string | null = null;
    try {
      userId = (await getAuthUser())?.id ?? null;
    } catch {
      userId = null;
    }
    await insertWizardStep(createAdminSupabaseClient(), { anonId: parsed.anonId, userId, step: parsed.step });
  } catch (err) {
    console.error('suggest steps route: insert threw (best-effort)', err);
  }

  return new NextResponse(null, { status: 204 });
}
