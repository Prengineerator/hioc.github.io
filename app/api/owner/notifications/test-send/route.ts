import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { normalizeIndianMobile } from '@/lib/phone';
import { sendBillNotification } from '@/lib/notifications/engine';
import { describeSkipReason } from '@/lib/notifications/reasons';
import type { BillChannel } from '@/lib/notifications/health';
import type { Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

// WA-3 — the owner's ten-second answer to "is the bill working RIGHT NOW?".
//
// It fires the real bill through the real engine (sendBillNotification) with
// sample data, to a number the owner types. Deliberately not a parallel send
// path: a test that exercises its own code proves only that its own code works,
// and the failures we are hunting live in the shared path (template name,
// token, category, header image).
//
// WHAT THIS PROVES, EXACTLY: that Meta accepted the request. That is a statement
// about an HTTP call — the same statement `status='sent'` has always made, and
// the same one that let "the bill never arrives" stay invisible for weeks. It
// clears the template name, the token, the phone id and the parameter count. It
// does NOT clear a MARKETING-categorised template, which Meta accepts and then
// throttles. Every line of copy below is written to keep those two apart.
//
// NOT CHECKED HERE, deliberately: the development stub. WA-1 removed getAdapter()
// from the bill path — sendBillNotification passes whatsappAdapter directly and
// only after whatsappBillHealth() reports configured, so a channel that reports
// `sent` provably reached a real provider. The stub-detection this route used to
// carry could not fire for any input and has been removed rather than left
// standing as a guard that reviewers would keep counting as protection.

const TESTS_PER_HOUR = 5;
const RATE_WINDOW_SECS = 3600;

interface ChannelVerdict {
  channel: BillChannel;
  /** A real provider accepted the message. Not "the handset has it". */
  sent: boolean;
  /** Machine cause, '' when sent. */
  reason: string;
  /** One line the owner can act on. */
  detail: string;
  /**
   * The provider's verbatim complaint, '' unless it rejected the send. This is
   * the field that separates an expired token from a paused template — the two
   * failures that look identical through `reason` and need opposite remedies.
   */
  provider_error: string;
}

/**
 * The sample order the test bill is rendered from.
 *
 * It is deliberately NOT a row in `orders`:
 *   - the notifications idempotency key is (order_id, event, channel), so
 *     borrowing a real order's id would overwrite that customer's genuine bill
 *     log row with a test result;
 *   - inventing an order row would burn an order number and land in every
 *     revenue report.
 * The engine's own log write therefore fails harmlessly (FK) and a test send
 * leaves nothing behind — which is exactly why the verdict below cannot be read
 * off the log, and why the provider's error has to travel back in BillResult
 * rather than via `notifications.error`.
 *
 * KNOWN GAP (left for a human): because no row is written, WA-3's "the row
 * appears in the log below, marked as a test" is not met, and WA-4's webhook
 * cannot correlate the receipts Meta will send for this message — it looks up
 * provider_ref and finds nothing, so a test send can never show `delivered`.
 * Closing that needs `notifications.order_id` to become nullable plus an
 * `is_test` flag, which changes the meaning of the (order_id, event, channel)
 * idempotency key for the whole table. That is a schema decision, not an
 * integration fix.
 *
 * 'TEST' is the first word of the name because the bill template's {{1}} is the
 * first name, so the message the owner receives announces itself as a test; the
 * HIOC-000000 order number is the second tell.
 */
function sampleOrder(phoneE164: string): Order {
  const now = new Date().toISOString();
  const order: Order & { items: { id: string }[] } = {
    id: crypto.randomUUID(),
    order_number: 0,
    customer_name: 'TEST (owner check)',
    customer_phone: phoneE164,
    customer_email: null,
    pickup_time: '',
    status: 'completed',
    subtotal_inr: 100,
    notes: '',
    created_at: now,
    updated_at: now,
    order_type: 'takeaway',
    promised_ready_at: null,
    pickup_code: null,
    pickup_slot_start: null,
    pickup_slot_label: '',
    tax_inr: 0,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: 100,
    payment_status: 'paid',
    payment_method: 'cash',
    reject_reason: '',
    version: 1,
    user_id: null,
    channel: 'staff_pos',
    table_id: null,
    table_label: '',
    created_by: null,
    customer_user_id: null,
    // The bill quotes a line count ({{4}}); an order with no `items` renders 0,
    // which reads as a broken template rather than a test.
    items: [{ id: 'sample-line' }],
  };
  return order;
}

/**
 * Turns the engine's per-channel result into something the owner can act on.
 *
 * The important case is `send_failed`. That token is the engine's entire
 * vocabulary for "the provider said no", and on its own it is nearly useless
 * here: an expired System User token and a template paused by Meta both arrive
 * as `send_failed`, and the fixes are "regenerate the token" and "resubmit the
 * template as UTILITY" respectively. So the provider's own sentence is appended
 * verbatim — it is the shortest path from this screen to the right remedy, and
 * it is the one thing scripts/verify-notifications.mjs prints that this button
 * previously threw away.
 */
function verdictFor(
  channel: BillChannel,
  engineSent: boolean,
  engineReason: string,
  providerError: string,
): ChannelVerdict {
  if (!engineSent) {
    // 'no_email' can only mean the sample order (which deliberately carries no
    // address) — never a customer's missing email, so say what actually
    // happened instead of describeSkipReason's order-shaped wording.
    if (engineReason === 'no_email') {
      return {
        channel,
        sent: false,
        reason: engineReason,
        detail: 'Not part of this test — the sample bill carries no email address.',
        provider_error: '',
      };
    }
    // A reasonless failure means the engine itself threw before it decided
    // anything; claiming "the provider rejected it" would send the owner
    // hunting in the wrong place.
    if (!engineReason) {
      return {
        channel,
        sent: false,
        reason: 'unknown',
        detail: 'The notification engine returned no result — check the server logs.',
        provider_error: '',
      };
    }
    const base = describeSkipReason(engineReason);
    return {
      channel,
      sent: false,
      reason: engineReason,
      detail: providerError ? `${base} — ${providerError}` : base,
      provider_error: providerError,
    };
  }

  return {
    channel,
    sent: true,
    reason: '',
    detail:
      channel === 'whatsapp'
        ? // Precisely worded. Meta accepting the request proves the token, the
          // phone id, the template name and the parameter count are all right.
          // It does not prove the handset rang: a template categorised MARKETING
          // is accepted here and throttled afterwards, which is the single most
          // likely cause of the complaint this feature was built for.
          'Accepted by Meta — token, template name and parameters are all valid. ' +
          'That is not proof of arrival: check the handset, and if nothing lands, ' +
          'the template is almost certainly categorised MARKETING rather than UTILITY.'
        : 'Accepted by Resend — the mail should be in the inbox shortly.',
    provider_error: '',
  };
}

function summarise(verdicts: ChannelVerdict[]): string {
  const accepted = verdicts.filter((v) => v.sent).map((v) => (v.channel === 'whatsapp' ? 'WhatsApp' : 'email'));
  if (accepted.length > 0) {
    // "accepted", never "sent" or "delivered". The whole phase exists because
    // those three words were being used interchangeably.
    return `Test bill accepted by ${accepted.join(' and ')} — now check the handset.`;
  }
  // Nothing sent: lead with WhatsApp, the channel the cafe runs on.
  const wa = verdicts.find((v) => v.channel === 'whatsapp');
  const cause = wa?.detail || verdicts[0]?.detail || '';
  if (!cause) return 'Nothing sent.';
  const line = `${cause.charAt(0).toLowerCase()}${cause.slice(1)}`;
  return `Nothing sent — ${line.endsWith('.') ? line : `${line}.`}`;
}

export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  const rawPhone = typeof body?.phone === 'string' ? body.phone : '';
  const digits = normalizeIndianMobile(rawPhone);
  // Validated before the limiter so a mistyped number doesn't burn one of the
  // five attempts that exist to protect Meta's quota.
  if (!digits) {
    return errorResponse(400, 'Enter a valid 10-digit Indian mobile number');
  }

  const allowed = await rateLimitOk(`notify-test:${owner.id}`, TESTS_PER_HOUR, RATE_WINDOW_SECS);
  if (!allowed) {
    return errorResponse(429, `Only ${TESTS_PER_HOUR} test sends per hour — try again shortly.`);
  }

  // Orders store phones in E.164 (app/api/orders/route.ts); the engine hands
  // `customer_phone` to the adapter untouched, so the test must match.
  const phoneE164 = `+91${digits}`;
  const order = sampleOrder(phoneE164);

  const result = await sendBillNotification(order);

  const verdicts: ChannelVerdict[] = [
    verdictFor('whatsapp', result.whatsapp, result.reasons.whatsapp, result.errors.whatsapp),
    verdictFor('email', result.email, result.reasons.email, result.errors.email),
  ];

  return NextResponse.json({
    ok: true,
    to: phoneE164,
    // The field a caller should branch on: a real provider accepted the request.
    // Named `accepted` rather than `real_send` because "sent" is the word this
    // phase is trying to stop people reading as "arrived".
    accepted: verdicts.some((v) => v.sent),
    summary: summarise(verdicts),
    channels: verdicts,
  });
}
