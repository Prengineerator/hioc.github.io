// WA-4 — Meta's delivery-status webhook, later widened (post-order feedback)
// to also handle INBOUND messages: the only thing that can answer both "did
// the customer's phone actually receive this?" and "what did they say back?"
//
// Until this endpoint existed our knowledge stopped at status='sent', which
// means "the Cloud API accepted the HTTP request" and nothing more. Meta
// reports the rest — sent → delivered → read, or failed with an error code —
// by POSTing here, correlated to nothing but the message id we already keep in
// notifications.provider_ref. The feedback widening reuses the SAME `messages`
// field subscription to receive the customer's side of the conversation: a
// quick-reply button tap on order_feedback_1 (sets the rating + triggers a
// follow-up), plain text (stored for the owner inbox), and STOP/UNSUBSCRIBE
// (records an opt-out). See parseInboundMessages/applyInboundMessage below and
// lib/feedback/payload.ts for the button-payload vocabulary.
//
// Setup: Meta App → WhatsApp → Configuration → Webhook →
//   Callback URL https://hioc.in/api/webhooks/whatsapp
//   Verify token = WHATSAPP_WEBHOOK_VERIFY_TOKEN (any long random string)
//   Subscribe to the `messages` field (status callbacks AND inbound messages
//   both ride on this one field — nothing extra to subscribe to)
//   WHATSAPP_APP_SECRET = App → Settings → Basic → App Secret
// Requires supabase/2026-08-notify-delivery.sql to be applied first, and
// supabase/2026-10-order-feedback.sql for the feedback tables.
//
// ⚠ WHATSAPP_APP_SECRET IS NOT SET IN PRODUCTION as of the feedback feature's
// launch. Rule 1 below means this endpoint fails EVERY inbound request closed
// (401, nothing written) until an operator sets it — so button taps, opt-outs
// and typed replies all silently bounce off until that happens. Delivery
// STATUS callbacks (what this endpoint already did) are equally blocked, so
// this is not a new gap the feedback feature introduces — it is the same gap,
// now blocking more. See docs/WHATSAPP-FEEDBACK-TEMPLATE.md §"Before this
// works at all".
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
import { whatsappAdapter } from '@/lib/notifications/adapters';
import {
  isOptOutKeyword,
  parseFeedbackButtonPayload,
  ratingFromButtonText,
  type FeedbackButtonRating,
} from '@/lib/feedback/payload';
import { getStoreSettings } from '@/lib/store/settings';
import { resolveGoogleReviewUrl } from '@/lib/feedback/reviewLink';
import type { FeedbackRequest, NotificationStatus } from '@/lib/types';

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

/** One inbound customer message, normalised out of Meta's several shapes. */
interface InboundMessage {
  waMessageId: string;
  /** E.164, '+' + Meta's digits-only `from` — matches how orders.customer_phone is stored. */
  fromPhone: string;
  at: string; // ISO
  kind: 'text' | 'button' | 'interactive' | 'other';
  text: string; // free-typed body (type 'text') or the tapped button's label
  buttonPayload: string; // the payload we originally put on the button, verbatim
}

/**
 * Pulls every inbound MESSAGE (as opposed to a delivery-status callback) out
 * of a webhook body — ignores everything else (parseStatusUpdates handles the
 * `statuses` array in the same `value` object; a real webhook delivery can
 * carry both in one POST). Never throws, same contract as parseStatusUpdates.
 *
 * Two message shapes matter here:
 *   - `type: 'button'` — a tap on one of order_feedback_1's quick-reply
 *     buttons. Carries `button.payload` (what we put there) and `button.text`
 *     (the label), which is the sturdier field on some WhatsApp client
 *     versions when the payload comes through empty.
 *   - `type: 'interactive'` with `interactive.type === 'button_reply'` — the
 *     equivalent shape for an interactive (non-template) button, handled the
 *     same way for robustness even though this template doesn't send one.
 *   - `type: 'text'` — anything typed, including "STOP".
 * Anything else (image, location, template-status echoes, …) is 'other' and
 * carries no text — recorded, never acted on.
 */
function parseInboundMessages(rawBody: string): InboundMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }
  const body = asRecord(parsed);
  if (!body) return [];

  const messages: InboundMessage[] = [];
  for (const entry of asArray(body.entry)) {
    for (const change of asArray(asRecord(entry)?.changes)) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      for (const raw of asArray(value.messages)) {
        const msg = asRecord(raw);
        if (!msg) continue;
        const id = typeof msg.id === 'string' ? msg.id : '';
        const from = typeof msg.from === 'string' ? msg.from.replace(/^\+/, '') : '';
        // Never act on a message we can't dedup or can't reply to.
        if (!id || !from) continue;
        const type = typeof msg.type === 'string' ? msg.type : '';
        const at = isoFrom(msg.timestamp);

        if (type === 'text') {
          const text = typeof asRecord(msg.text)?.body === 'string' ? (asRecord(msg.text)!.body as string) : '';
          messages.push({ waMessageId: id, fromPhone: `+${from}`, at, kind: 'text', text, buttonPayload: '' });
          continue;
        }
        if (type === 'button') {
          const btn = asRecord(msg.button);
          const payload = typeof btn?.payload === 'string' ? btn.payload : '';
          const text = typeof btn?.text === 'string' ? btn.text : '';
          messages.push({ waMessageId: id, fromPhone: `+${from}`, at, kind: 'button', text, buttonPayload: payload });
          continue;
        }
        if (type === 'interactive') {
          const interactive = asRecord(msg.interactive);
          const reply = asRecord(interactive?.button_reply);
          const payload = typeof reply?.id === 'string' ? reply.id : '';
          const text = typeof reply?.title === 'string' ? reply.title : '';
          messages.push({
            waMessageId: id,
            fromPhone: `+${from}`,
            at,
            kind: 'interactive',
            text,
            buttonPayload: payload,
          });
          continue;
        }
        messages.push({ waMessageId: id, fromPhone: `+${from}`, at, kind: 'other', text: '', buttonPayload: '' });
      }
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Feedback thread — button taps, opt-outs, and plain replies
// ---------------------------------------------------------------------------

const SORRY_FOLLOWUP = 'Sorry to hear that — what could we do better? Just reply here.';
const STOP_CONFIRMATION = "You're unsubscribed from HIOC feedback messages. Reply START any time to opt back in.";

/** Fire-and-forget free-text WhatsApp send + its own feedback_messages row. Never throws. */
async function sendFollowUp(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  phone: string,
  body: string,
  requestId: string | null,
  orderId: string | null,
): Promise<void> {
  try {
    const result = await whatsappAdapter.send({ to: phone, channel: 'whatsapp', body });
    await admin.from('feedback_messages').insert({
      request_id: requestId,
      order_id: orderId,
      phone,
      direction: 'out',
      body,
      wa_message_id: result.providerRef || null,
      status: result.ok ? 'sent' : 'failed',
      error: result.ok ? '' : result.error,
    });
  } catch (err) {
    console.error('[whatsapp:webhook] follow-up send failed', err);
  }
}

/**
 * Resolves which feedback_requests row (if any) an inbound message belongs
 * to. A button tap's payload names one explicitly — but the payload is
 * attacker-shaped input the moment it leaves our own template (nothing stops
 * a client from sending an arbitrary `button.payload` string, even though
 * this endpoint only accepts HMAC-signed bodies FROM META), so it is only
 * trusted when the request it names actually belongs to the phone that sent
 * it. Every other case (unparseable payload, plain text, a payload for
 * someone else's phone) falls back to the customer's most recent request —
 * a phone with no request at all gets `null`, a phone-only thread.
 */
async function resolveFeedbackRequest(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  phone: string,
  payloadRequestId: string | null,
): Promise<FeedbackRequest | null> {
  if (payloadRequestId) {
    const { data } = await admin.from('feedback_requests').select('*').eq('id', payloadRequestId).maybeSingle();
    if (data && (data as FeedbackRequest).phone === phone) return data as FeedbackRequest;
  }
  const { data } = await admin
    .from('feedback_requests')
    .select('*')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as FeedbackRequest | null) ?? null;
}

/**
 * Applies one inbound message: records it in the thread, and reacts (rating +
 * follow-up, opt-out + confirmation) exactly once per message — dedup on
 * wa_message_id happens in the caller before this runs. Never throws.
 */
async function applyInboundMessage(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  msg: InboundMessage,
): Promise<void> {
  try {
    if (msg.kind === 'text' && isOptOutKeyword(msg.text)) {
      const request = await resolveFeedbackRequest(admin, msg.fromPhone, null);
      const { error: insertError } = await admin.from('feedback_messages').insert({
        request_id: request?.id ?? null,
        order_id: request?.order_id ?? null,
        phone: msg.fromPhone,
        direction: 'in',
        body: msg.text,
        wa_message_id: msg.waMessageId,
      });
      // 23505 = unique_violation on wa_message_id: a race with another
      // delivery of the SAME message already recorded it. Stop here —
      // proceeding would opt the customer out and send a second confirmation
      // for one inbound message.
      if (insertError) {
        if ((insertError as { code?: string }).code !== '23505') {
          console.error('[whatsapp:webhook] inbound insert failed', insertError);
        }
        return;
      }
      await admin
        .from('whatsapp_opt_outs')
        .upsert({ phone: msg.fromPhone, source: 'stop_keyword' }, { onConflict: 'phone' });
      if (request) {
        await admin
          .from('feedback_requests')
          .update({ unread: true, last_inbound_at: msg.at })
          .eq('id', request.id);
      }
      await sendFollowUp(admin, msg.fromPhone, STOP_CONFIRMATION, request?.id ?? null, request?.order_id ?? null);
      return;
    }

    // A button tap (template quick-reply or interactive equivalent): resolve
    // the rating from the payload we put there, falling back to matching the
    // tapped label when the payload didn't come through.
    let rating: FeedbackButtonRating | null = null;
    let payloadRequestId: string | null = null;
    if (msg.kind === 'button' || msg.kind === 'interactive') {
      const parsed = parseFeedbackButtonPayload(msg.buttonPayload);
      if (parsed) {
        rating = parsed.rating;
        payloadRequestId = parsed.requestId;
      } else {
        rating = ratingFromButtonText(msg.text);
      }
    }

    const request = await resolveFeedbackRequest(admin, msg.fromPhone, payloadRequestId);

    const { error: insertError } = await admin.from('feedback_messages').insert({
      request_id: request?.id ?? null,
      order_id: request?.order_id ?? null,
      phone: msg.fromPhone,
      direction: 'in',
      body: msg.kind === 'text' ? msg.text : msg.text || msg.buttonPayload,
      button_payload: msg.buttonPayload,
      wa_message_id: msg.waMessageId,
    });
    // Same race guard as the STOP branch above — a duplicate delivery of this
    // message must not set the rating or send the follow-up twice.
    if (insertError) {
      if ((insertError as { code?: string }).code !== '23505') {
        console.error('[whatsapp:webhook] inbound insert failed', insertError);
      }
      return;
    }

    if (request) {
      const patch: Record<string, unknown> = { unread: true, last_inbound_at: msg.at };
      if (rating !== null) {
        patch.rating = rating;
        patch.rating_source = 'whatsapp_button';
        patch.responded_at = msg.at;
      }
      await admin.from('feedback_requests').update(patch).eq('id', request.id);
    }

    if (rating === 5) {
      const settings = await getStoreSettings();
      const reviewUrl = resolveGoogleReviewUrl(settings.google_review_url);
      await sendFollowUp(
        admin,
        msg.fromPhone,
        `So glad you loved it! If you have a moment, a Google review means a lot to us: ${reviewUrl}`,
        request?.id ?? null,
        request?.order_id ?? null,
      );
    } else if (rating === 3 || rating === 1) {
      await sendFollowUp(admin, msg.fromPhone, SORRY_FOLLOWUP, request?.id ?? null, request?.order_id ?? null);
    }
    // Plain text (no rating resolved) is just stored above — the owner reads
    // and replies from /owner/feedback; no automated follow-up.
  } catch (err) {
    console.error('[whatsapp:webhook] applyInboundMessage failed', err);
  }
}

/**
 * Dedup on wa_message_id (Meta retries on anything but a clean 2xx, so the
 * same inbound message can arrive twice) and apply each new one. Returns how
 * many were new vs already-seen, for the response tally.
 */
async function processInboundMessages(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  messages: InboundMessage[],
): Promise<{ applied: number; duplicate: number }> {
  let applied = 0;
  let duplicate = 0;
  for (const msg of messages) {
    const { data: existing } = await admin
      .from('feedback_messages')
      .select('id')
      .eq('wa_message_id', msg.waMessageId)
      .maybeSingle();
    if (existing) {
      duplicate++;
      continue;
    }
    await applyInboundMessage(admin, msg);
    applied++;
  }
  return { applied, duplicate };
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
  let messages = { applied: 0, duplicate: 0 };
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

  // Inbound feedback replies — a separate try/catch so a fault in one never
  // stops the other from being processed (both still answer 200 either way).
  try {
    const inbound = parseInboundMessages(raw);
    if (inbound.length > 0) {
      const admin = createAdminSupabaseClient();
      messages = await processInboundMessages(admin, inbound);
    }
  } catch (err) {
    console.error('[whatsapp:webhook] inbound message processing failed', err);
  }

  return NextResponse.json({ received: true, ...tally, messages });
}
