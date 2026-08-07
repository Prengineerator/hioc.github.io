// WA-4 — Meta's delivery-status webhook: the only thing that can answer
// "did the customer's phone actually receive this?"
//
// Until this endpoint existed our knowledge stopped at status='sent', which
// means "the Cloud API accepted the HTTP request" and nothing more. Meta
// reports the rest — sent → delivered → read, or failed with an error code —
// by POSTing here, correlated to nothing but the message id we already keep in
// notifications.provider_ref.
//
// Setup: Meta App → WhatsApp → Configuration → Webhook →
//   Callback URL https://hioc.in/api/webhooks/whatsapp
//   Verify token = WHATSAPP_WEBHOOK_VERIFY_TOKEN (any long random string)
//   Subscribe to the `messages` field (status callbacks ride on it)
//   WHATSAPP_APP_SECRET = App → Settings → Basic → App Secret
// Requires supabase/2026-08-notify-delivery.sql to be applied first.
//
// Three rules govern everything below:
//   1. FAIL CLOSED. No app secret configured means every POST is rejected. A
//      webhook that trusts unsigned bodies is an open write endpoint into the
//      delivery log (the CRON_SECRET pattern, app/api/cron/expire-orders).
//   2. ALWAYS 200 once the signature checks out. Meta retries aggressively on
//      any non-2xx, with backoff measured in a growing queue of repeats, and an
//      unknown message id or a malformed payload is not a reason to invite that.
//   3. FORWARD ONLY. Meta does not guarantee the callbacks arrive in the order
//      the events happened, so a 'delivered' landing after a 'read' must not
//      un-read the row.

import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { replaceableBy } from '@/lib/notifications/status';
import type { NotificationStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/** Meta's status vocabulary, narrowed to the ones our column understands. */
const WEBHOOK_STATUSES: NotificationStatus[] = ['sent', 'delivered', 'read', 'failed'];

interface StatusUpdate {
  /** Meta's message id — matches notifications.provider_ref. */
  ref: string;
  status: NotificationStatus;
  /** ISO timestamp of the event as Meta reported it. */
  at: string;
  /** '' unless Meta attached an error object. */
  error: string;
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/**
 * X-Hub-Signature-256 = 'sha256=' + HMAC-SHA256(app secret, RAW request body).
 *
 * The raw body is not a detail: JSON.parse followed by JSON.stringify produces
 * different bytes (key order, whitespace, unicode escapes) and the digest would
 * then never match, for any request, forever. Hence request.text() first and
 * a parse of that same string later.
 */
function signatureOk(rawBody: string, headers: Headers): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  // Fail CLOSED: unset secret disables the endpoint rather than opening it.
  if (!secret) return false;

  const header = headers.get('x-hub-signature-256') ?? '';
  const [scheme, provided] = header.split('=');
  if (scheme !== 'sha256' || !provided) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(provided.toLowerCase());
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so the guard is required —
  // and a length difference is not secret anyway.
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Meta sends unix SECONDS as a string. Anything we can't read becomes "now" —
 * a receipt with a wrong-but-plausible timestamp is far more useful than a
 * dropped receipt, and the body is HMAC-verified so this is not attacker input.
 */
function isoFrom(raw: unknown): string {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date().toISOString();
  const ms = seconds * 1000;
  // Reject a value that is not a sane epoch (e.g. milliseconds sent by mistake,
  // which would land in the year 57000 and poison the log's ordering).
  const date = new Date(ms);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 2100) return new Date().toISOString();
  return date.toISOString();
}

/**
 * Meta's error object, flattened to `code: title`. Deliberately excludes
 * `error_data.details` and every other free-text field: this string lands in a
 * column the owner UI renders, and nothing about a delivery failure needs to
 * carry the recipient's details with it.
 */
function errorTextFrom(status: Record<string, unknown>): string {
  const first = asRecord(asArray(status.errors)[0]);
  if (!first) return '';
  const code = first.code === undefined || first.code === null ? '' : String(first.code);
  const title = typeof first.title === 'string' ? first.title : '';
  return [code, title].filter(Boolean).join(': ').slice(0, 300);
}

/**
 * Pulls every status callback out of a webhook body, ignoring everything else
 * it may carry (inbound messages, template updates, fields we never subscribed
 * to). Returns [] for anything unparseable — never throws, because a malformed
 * body still has to be answered 200.
 */
function parseStatusUpdates(rawBody: string): StatusUpdate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const body = asRecord(parsed);
  if (!body) return [];

  const updates: StatusUpdate[] = [];
  for (const entry of asArray(body.entry)) {
    for (const change of asArray(asRecord(entry)?.changes)) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      for (const raw of asArray(value.statuses)) {
        const status = asRecord(raw);
        if (!status) continue;
        const ref = typeof status.id === 'string' ? status.id : '';
        const name = typeof status.status === 'string' ? status.status : '';
        // An empty ref would match the DEFAULT '' every skipped row carries —
        // i.e. it would rewrite unrelated rows in bulk. Never look one up.
        if (!ref) continue;
        if (!WEBHOOK_STATUSES.includes(name as NotificationStatus)) continue;
        updates.push({
          ref,
          status: name as NotificationStatus,
          at: isoFrom(status.timestamp),
          error: errorTextFrom(status),
        });
      }
    }
  }
  return updates;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Meta's status vocabulary is a strict subset of ours, so the ladder for a
 * webhook status is the shared one — imported, not re-declared, because a guard
 * that keeps its own private copy of an invariant is how WA-4 broke the engine's
 * two `status === 'sent'` tests in the first place (lib/notifications/status.ts).
 */

/** Which set-once timestamp column this status is evidence for, if any. */
function stampColumn(status: NotificationStatus): 'delivered_at' | 'read_at' | null {
  if (status === 'delivered') return 'delivered_at';
  if (status === 'read') return 'read_at';
  return null;
}

function patchFor(update: StatusUpdate): Record<string, unknown> {
  const patch: Record<string, unknown> = { status: update.status };
  const column = stampColumn(update.status);
  if (column) patch[column] = update.at;
  // Only a failure touches `error`. A 'delivered' must not blank out the reason
  // an earlier attempt failed — that text is the whole story of the row.
  if (update.status === 'failed' && update.error) patch.error = update.error;
  return patch;
}

/**
 * A wamid base64-encodes the RECIPIENT'S PHONE NUMBER in its leading segment,
 * so logging one whole is logging a customer's number. The tail is the message
 * hash and identifies the row for debugging without carrying anyone's details.
 */
const refTail = (ref: string) => `…${ref.slice(-10)}`;

/**
 * 'failed' is NOT 'ignored'. A database write that errors and a benign
 * already-at-a-higher-rung callback are opposite facts, and this tally is the
 * only machine-readable thing the endpoint emits — anyone curling it or
 * aggregating the bodies to answer "are receipts landing?" would otherwise get
 * a green answer while every write was being rejected by the CHECK constraint
 * (which is exactly what happens if 2026-08-notify-delivery.sql is not applied).
 */
type Outcome = 'applied' | 'ignored' | 'unknown' | 'failed';

/**
 * Moves one row up the ladder. The rank guard is part of the UPDATE statement
 * rather than a read-then-write in this process: two callbacks for the same
 * message can be in flight at once (Meta fans out), and a check followed by a
 * separate write would let the loser of that race overwrite the winner.
 */
async function applyStatusUpdate(admin: Admin, update: StatusUpdate): Promise<Outcome> {
  const { data: moved, error } = await admin
    .from('notifications')
    .update(patchFor(update))
    .eq('provider_ref', update.ref)
    .in('status', replaceableBy(update.status))
    .select('id');

  if (error) {
    console.error(`[whatsapp:webhook] update failed for ${refTail(update.ref)}`, error.message);
    return 'failed';
  }
  if ((moved ?? []).length > 0) return 'applied';

  // Nothing moved, which means either "we never sent this message" or "the row
  // is already at or above this rung". Those need different answers, so ask.
  const { data: row } = await admin
    .from('notifications')
    .select('id, status, delivered_at, read_at')
    .eq('provider_ref', update.ref)
    .limit(1)
    .maybeSingle();

  if (!row) return 'unknown';

  // The out-of-order case: a 'delivered' arriving after 'read'. The status must
  // not regress, but the timestamp is a fact we didn't have and the row has an
  // empty column waiting for it. Set-once, guarded by `is null` so a duplicate
  // callback can't rewrite the first receipt with a later one.
  const column = stampColumn(update.status);
  if (column && row[column] === null) {
    await admin
      .from('notifications')
      .update({ [column]: update.at })
      .eq('id', row.id)
      .is(column, null);
  }
  return 'ignored';
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET — Meta's subscription handshake. It calls this once when the webhook is
 * saved (and again whenever the callback URL changes) and expects the
 * hub.challenge value echoed back as a bare body.
 *
 * Fails CLOSED: with no verify token configured there is no way to tell Meta's
 * handshake from anyone else's, and echoing unconditionally would let a
 * stranger point their own Meta app at our endpoint and have it confirmed.
 */
export async function GET(request: Request) {
  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!expected) return errorResponse(403, 'Forbidden');

  const params = new URL(request.url).searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token') ?? '';
  const challenge = params.get('hub.challenge');

  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  const matches = a.length === b.length && timingSafeEqual(a, b);
  if (mode !== 'subscribe' || !matches) return errorResponse(403, 'Forbidden');
  if (!challenge) return errorResponse(400, 'Missing hub.challenge');

  // Bare text, not JSON — Meta compares the response body to the challenge.
  return new Response(challenge, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * POST — status callbacks.
 *
 * The work happens before the response rather than after it, despite "answer
 * 200 fast": on a serverless runtime nothing is guaranteed to run once the
 * response is returned, so "process after" would mean "sometimes don't
 * process". The work is one or two indexed queries per status, and every
 * failure path inside it is swallowed — what must never happen is a non-2xx,
 * not a few extra milliseconds.
 */
export async function POST(request: Request) {
  // RAW body first. Parsing here and re-stringifying for the digest would break
  // signature verification permanently (see signatureOk).
  const raw = await request.text();
  if (!signatureOk(raw, request.headers)) return errorResponse(401, 'Unauthorized');

  const tally: Record<Outcome, number> = { applied: 0, ignored: 0, unknown: 0, failed: 0 };
  try {
    const updates = parseStatusUpdates(raw);
    if (updates.length > 0) {
      const admin = createAdminSupabaseClient();
      for (const update of updates) {
        const outcome = await applyStatusUpdate(admin, update);
        tally[outcome] += 1;
        if (outcome === 'unknown') {
          // Not an error: Meta also delivers receipts for messages sent by
          // other tools on the same number, and for anything sent before this
          // endpoint existed. Log it and drop it.
          console.info(
            `[whatsapp:webhook] no notification for ${refTail(update.ref)} (status ${update.status}) — dropped`,
          );
        }
      }
    }
  } catch (err) {
    // Includes a missing Supabase config: still a 200, because a retry storm
    // would not fix it and would bury the log entry that will.
    console.error('[whatsapp:webhook] processing failed', err);
  }

  return NextResponse.json({ received: true, ...tally });
}
