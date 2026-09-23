// POS4-4 / WA-5 — the pure logic behind the post-placement confirmation: how the
// order was paid, and whether its bill actually reached the customer.
//
// Wording for a delivery CAUSE is not decided here — every "not sent" line comes
// from describeBillOutcome (lib/notifications/reasons), so the POS confirmation,
// the order detail's Resend and the owner's delivery log describe the same cause
// the same way.
//
// WA-5 changed what this module is allowed to claim. Until now, settling an order
// with a phone number on it produced "Bill sent on WhatsApp." — asserted from the
// presence of a phone, because PATCH /api/orders/[id]/payment fires the bill but
// reports nothing about it. That is the same class of lie as the log stub (F1):
// the staffer reads a green line, the customer's phone never rings, and nobody
// finds out. Delivery is now a state, and the two honest unknowns — "we asked,
// nothing has come back" and "Meta accepted it, the handset hasn't confirmed" —
// are states of their own rather than being rounded up to success.

import { describeBillOutcome, describeSkipReason } from '@/lib/notifications/reasons';
import type { PaymentPart } from '@/lib/orders/payments';

/**
 * How far down the delivery ladder this bill is known to have got.
 *
 * - `none`      nothing was sent and nothing will be until something changes
 *               (no phone captured, channel not configured).
 * - `pending`   the send was asked for; no verdict yet.
 * - `sent`      the provider accepted it. NOT the same as "it arrived" — this is
 *               a statement about an HTTP call (spec F3).
 * - `delivered` the handset acknowledged it (Meta's status webhook, WA-4). The
 *               only state that means the customer has their bill.
 * - `failed`    it was attempted and did not go.
 */
export type BillDeliveryState = 'none' | 'pending' | 'sent' | 'delivered' | 'failed';

export interface BillStatusView {
  state: BillDeliveryState;
  /**
   * True when something reached the customer AND nothing failed on the way.
   * A partial success is not an `ok` — see `failedChannels`.
   */
  ok: boolean;
  message: string;
  /**
   * Channels that were attempted and did NOT go, even when another channel did.
   *
   * `state` can only describe the FURTHEST any channel got, so on its own it
   * hides the other half: an order carrying both a phone and an email (the POS
   * captures them on one screen) whose WhatsApp failed and whose email sent
   * reported a green "Bill sent on email" and nothing else. WhatsApp is the
   * channel the cafe runs on and the one the owner's complaint is about, so a
   * failure there has to survive a success anywhere else.
   */
  failedChannels: string[];
}

export interface ResendBillResponse {
  error?: string;
  sent?: { whatsapp: boolean; email: boolean };
  reasons?: { whatsapp: string; email: string };
}

/**
 * One `notifications` row for this order's bill, as the counter can read it
 * (the table is staff-readable by RLS). `status` is deliberately a plain string:
 * the vocabulary widens with each migration ('skipped' in BILL-3, 'delivered' /
 * 'read' in WA-4) and a POS running ahead of a migration must degrade to "don't
 * know", never crash or guess.
 */
export interface BillDeliveryRow {
  channel: string;
  status: string;
  skip_reason?: string | null;
  error?: string | null;
}

/**
 * The two channels a bill can travel on, in the order a cafe cares about. The
 * labels match describeBillOutcome's wording so the same channel is never called
 * two different things on two screens.
 */
const CHANNEL_LABELS: Record<string, string> = { whatsapp: 'WhatsApp', email: 'email' };

/**
 * Reasons that mean "this channel was never applicable", as opposed to "this
 * channel was tried and did not work".
 *
 * The distinction decides whether the confirmation strip goes red. A takeaway
 * with a phone and no email logs a skipped email row every single time — by far
 * the most common order at this counter — and treating that as a failure would
 * paint the normal case as broken, which teaches the staffer to ignore red.
 */
const NOT_APPLICABLE = new Set(['', 'no_phone', 'no_email']);

const isChannelFailure = (reason: string): boolean => !NOT_APPLICABLE.has(reason);

function joinChannels(channels: string[]): string {
  const labels = channels.map((c) => CHANNEL_LABELS[c] ?? c);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * How the money came in, for the confirmation line. A single tender needs no
 * amount — the total is already on the card right above it; a split does, since
 * "how much cash is in the drawer" is the whole reason the split was recorded.
 */
export function describePaymentParts(parts: PaymentPart[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].method.toUpperCase();
  return parts.map((p) => `₹${p.amount_inr} ${p.method.toUpperCase()}`).join(' + ');
}

/**
 * What the POS knows about the bill the instant the settle returns, from the
 * contact it captured and nothing else.
 *
 * No contact is the one certainty, and the one a staffer can still fix while the
 * customer is standing there. Where contact WAS captured this is `pending` — the
 * send was asked for and no answer has come back yet — which is the truth, and is
 * replaced by billStatusFromDelivery() a moment later when the delivery log is
 * read, or by parseResendResult() when the staffer taps Resend.
 */
export function placementBillStatus(contact: {
  phone?: string | null;
  email?: string | null;
}): BillStatusView {
  const phone = (contact.phone ?? '').trim();
  const email = (contact.email ?? '').trim();

  if (!phone && !email) {
    return {
      state: 'none',
      ok: false,
      message: describeBillOutcome(
        { whatsapp: false, email: false },
        { whatsapp: 'no_phone', email: 'no_email' },
      ),
      failedChannels: [],
    };
  }

  const channels = [...(phone ? ['whatsapp'] : []), ...(email ? ['email'] : [])];
  return {
    state: 'pending',
    ok: false,
    message: `Sending the bill on ${joinChannels(channels)}…`,
    failedChannels: [],
  };
}

/**
 * The delivery log's own word, which is as close to the customer's handset as
 * this screen can get: the engine writes a row per channel at settle (sent /
 * failed / skipped-with-reason) and Meta's status webhook (WA-4) later moves the
 * WhatsApp row to 'delivered' or 'read'.
 *
 * Returns null when there is nothing to say yet — no rows at all — so the caller
 * keeps whatever it already had rather than downgrading to a worse guess.
 */
export function billStatusFromDelivery(
  rows: BillDeliveryRow[] | null | undefined,
): BillStatusView | null {
  const relevant = (rows ?? []).filter((r) => r.channel === 'whatsapp' || r.channel === 'email');
  if (relevant.length === 0) return null;

  const delivered: string[] = [];
  const sent: string[] = [];
  const pending: string[] = [];
  const failed: string[] = [];
  const failedReasons: { whatsapp: string; email: string } = { whatsapp: '', email: '' };

  for (const row of relevant) {
    // 'read' is further along the same ladder — for a bill, being opened and
    // being received are the same good news.
    if (row.status === 'delivered' || row.status === 'read') delivered.push(row.channel);
    else if (row.status === 'sent') sent.push(row.channel);
    else if (row.status === 'queued') pending.push(row.channel);
    else {
      // 'failed' carries the provider's error; 'skipped' carries the machine
      // reason BILL-3 recorded. Both become a cause describeBillOutcome knows.
      const reason = (row.skip_reason ?? '') || 'send_failed';
      failedReasons[row.channel as 'whatsapp' | 'email'] = reason;
      // "No email on this order" is not a channel that failed — see NOT_APPLICABLE.
      if (isChannelFailure(reason)) failed.push(row.channel);
    }
  }

  /**
   * The failure clause that rides along with a partial success. Without it the
   * furthest-channel-wins rule silently deletes the other outcome, which is the
   * one the staffer can still do something about while the customer is present.
   */
  const failureNote = (): string => {
    if (failed.length === 0) return '';
    const cause =
      describeSkipReason(failedReasons.whatsapp) || describeSkipReason(failedReasons.email) || '';
    const who = joinChannels(failed);
    return cause ? ` ${who} failed — ${cause.toLowerCase()}.` : ` ${who} failed.`;
  };

  if (delivered.length > 0) {
    return {
      state: 'delivered',
      ok: failed.length === 0,
      message: `Bill delivered on ${joinChannels(delivered)}.${failureNote()}`,
      failedChannels: failed,
    };
  }
  if (sent.length > 0) {
    return {
      state: 'sent',
      ok: failed.length === 0,
      // Said plainly, because "sent" has been the word covering a bill that never
      // arrived — the counter should know it isn't confirmed yet.
      message: `Bill sent on ${joinChannels(sent)} — not confirmed yet.${failureNote()}`,
      failedChannels: failed,
    };
  }
  if (pending.length > 0) {
    return {
      state: 'pending',
      ok: false,
      message: `Sending the bill on ${joinChannels(pending)}…${failureNote()}`,
      failedChannels: failed,
    };
  }

  return {
    state: 'failed',
    ok: false,
    message: describeBillOutcome({ whatsapp: false, email: false }, failedReasons),
    failedChannels: failed,
  };
}

/**
 * Reads POST /api/orders/[id]/resend-bill. A response where NOTHING sent is a
 * failure, not a success — rendering it as "done" is the silent failure BILL-3/4
 * exist to remove. A non-2xx (including the 429 rate limit) shows the route's
 * own message, which is already staff-readable.
 */
export function parseResendResult(
  httpOk: boolean,
  data: ResendBillResponse | null | undefined,
): BillStatusView {
  if (!httpOk) {
    return {
      state: 'failed',
      ok: false,
      message: data?.error ?? 'Could not resend the bill.',
      failedChannels: [],
    };
  }
  const sent = data?.sent ?? { whatsapp: false, email: false };
  const reasons = data?.reasons ?? { whatsapp: '', email: '' };
  const anySent = sent.whatsapp || sent.email;
  // A channel that was ATTEMPTED and did not send is a failure, even when the
  // other one worked. A channel the order gave no address for is not.
  const failedChannels = (['whatsapp', 'email'] as const).filter(
    (c) => !sent[c] && isChannelFailure(reasons[c] ?? ''),
  );
  return {
    // The route reports what the provider accepted, not what the handset got —
    // 'sent', never 'delivered'. Only the webhook may promote it.
    state: anySent ? 'sent' : 'failed',
    ok: anySent && failedChannels.length === 0,
    message: describeBillOutcome(sent, reasons),
    failedChannels,
  };
}

/**
 * How loudly to render a status. Delivery has three meaningful tones, not two:
 * a bill still in flight must not be green (it may yet fail) and must not be red
 * (nothing is wrong yet) — the staffer's cue to wait rather than apologise.
 */
export function billStatusTone(view: BillStatusView): 'good' | 'wait' | 'bad' {
  // A channel that failed makes the whole line red no matter how far another
  // one got. "Bill delivered on email" in green, with the WhatsApp send dead,
  // is the reading this phase exists to stop.
  if (view.failedChannels.length > 0) return 'bad';
  if (view.state === 'delivered') return 'good';
  if (view.state === 'sent' || view.state === 'pending') return 'wait';
  return 'bad';
}
