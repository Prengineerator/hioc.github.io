import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { isMigrationMissing } from '@/lib/marketing/server/repo';
import { endpointHash, ENDPOINT_MAX, MAX_DEVICES_PER_USER, parseSubscription } from '@/lib/push/validate';

export const dynamic = 'force-dynamic';

// (Status is POST /api/account/push/status: an endpoint is a bearer address and stays out of URLs.)
// A logged-in customer's own phone notifications (docs/WEB-PUSH-SPEC.md). The
// session user is the only identity: a customer can only ever add, read or remove
// THEIR OWN subscriptions. 404 while the webPush flag is off.

const SOURCES = ['order_page', 'profile'] as const;
const NOT_SET_UP = 'Phone notifications are not set up yet.';
const failed = (error: { code?: string; message?: string }, fallback: string) =>
  isMigrationMissing(error) ? errorResponse(409, NOT_SET_UP) : errorResponse(500, fallback);

const sourceOf = (v: unknown): string => (typeof v === 'string' && (SOURCES as readonly string[]).includes(v) ? v : 'unknown');

// POST /api/account/push — save this device. The browser's PushSubscription.toJSON()
// plus an optional `source`. An endpoint already saved for another account moves to
// this one (a shared phone belongs to whoever is signed in and said yes now).
export async function POST(request: Request) {
  if (!flags.webPush) return notFound();
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const sub = parseSubscription(body);
  if (!sub.ok) return errorResponse(400, sub.error);

  if (!(await rateLimitOk(`push-sub:${user.id}`, 20, 3600))) {
    return errorResponse(429, 'Too many attempts. Please try again later.');
  }

  const admin = createAdminSupabaseClient();

  // At most MAX_DEVICES_PER_USER phones per customer (re-saving one they already have is fine),
  // and note who the endpoint belonged to so a move can be logged for them.
  const mine = await admin.from('push_subscriptions').select('endpoint').eq('user_id', user.id);
  if (mine.error) return failed(mine.error, 'Could not turn on notifications.');
  const mineRows = (mine.data ?? []) as { endpoint: string }[];
  if (mineRows.length >= MAX_DEVICES_PER_USER && !mineRows.some((r) => r.endpoint === sub.value.endpoint)) {
    return errorResponse(409, `You already have notifications on ${MAX_DEVICES_PER_USER} devices. Turn one off on Account, Profile first.`);
  }
  const prior = await admin.from('push_subscriptions').select('user_id').eq('endpoint', sub.value.endpoint).maybeSingle();
  if (prior.error) return failed(prior.error, 'Could not turn on notifications.');
  const previousOwner = (prior.data as { user_id: string } | null)?.user_id ?? null;

  const userAgent = (request.headers.get('user-agent') ?? '').slice(0, 300);
  const { error } = await admin.from('push_subscriptions').upsert(
    { user_id: user.id, endpoint: sub.value.endpoint, p256dh: sub.value.p256dh, auth: sub.value.auth, user_agent: userAgent },
    { onConflict: 'endpoint' },
  );
  if (error) {
    console.error('push subscribe failed', error.message);
    return failed(error, 'Could not turn on notifications.');
  }

  const { error: logError } = await admin
    .from('push_consent_events')
    .insert({ user_id: user.id, action: 'subscribe', source: sourceOf(body.source), endpoint_hash: endpointHash(sub.value.endpoint) });
  if (logError) {
    // No saved yes without a record of it.
    console.error('push consent log failed', logError.message);
    await admin.from('push_subscriptions').delete().eq('endpoint', sub.value.endpoint).eq('user_id', user.id);
    return errorResponse(500, 'Could not turn on notifications.');
  }
  if (previousOwner && previousOwner !== user.id) {
    // The phone changed hands: the earlier customer's yes for it ends here, on the record.
    const { error: moveError } = await admin
      .from('push_consent_events')
      .insert({ user_id: previousOwner, action: 'unsubscribe', source: 'moved_to_other_account', endpoint_hash: endpointHash(sub.value.endpoint) });
    if (moveError) console.error('push consent log failed', moveError.message);
  }
  return NextResponse.json({ ok: true });
}

// DELETE /api/account/push — {endpoint} removes this device; {all:true} removes every
// device of the signed-in customer. Each removal is logged.
export async function DELETE(request: Request) {
  if (!flags.webPush) return notFound();
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const all = body.all === true;
  const endpoint = body.endpoint;
  if (!all && (typeof endpoint !== 'string' || endpoint === '' || endpoint.length > ENDPOINT_MAX)) {
    return errorResponse(400, 'Say which device to turn off, or send {"all": true}.');
  }

  const admin = createAdminSupabaseClient();
  let q = admin.from('push_subscriptions').delete().eq('user_id', user.id);
  if (!all) q = q.eq('endpoint', endpoint as string);
  const { data, error } = await q.select('endpoint');
  if (error) {
    console.error('push unsubscribe failed', error.message);
    return failed(error, 'Could not turn off notifications.');
  }
  const removed = (data ?? []) as { endpoint: string }[];
  if (removed.length > 0) {
    const source = sourceOf(body.source);
    // The log is append-only (a trigger), so only ever insert. One event per device
    // switched off; "all devices" is a single event with an empty endpoint_hash.
    const events = all
      ? [{ user_id: user.id, action: 'unsubscribe', source, endpoint_hash: '' }]
      : removed.map((r) => ({ user_id: user.id, action: 'unsubscribe', source, endpoint_hash: endpointHash(r.endpoint) }));
    const { error: logError } = await admin.from('push_consent_events').insert(events);
    if (logError) console.error('push consent log failed', logError.message);
  }
  return NextResponse.json({ ok: true, removed: removed.length });
}
