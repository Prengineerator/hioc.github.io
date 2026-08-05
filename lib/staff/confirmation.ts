// POS4-4 — the pure logic behind the post-placement confirmation: how the order
// was paid, and whether its bill reached the customer.
//
// Wording for a delivery outcome is NOT decided here — every line comes from
// describeBillOutcome (lib/notifications/reasons), so the POS confirmation, the
// order detail's Resend and the owner's delivery log describe the same cause the
// same way.

import { describeBillOutcome } from '@/lib/notifications/reasons';
import type { PaymentPart } from '@/lib/orders/payments';

export interface BillStatusView {
  /** True only when something actually reached the customer. */
  ok: boolean;
  message: string;
}

export interface ResendBillResponse {
  error?: string;
  sent?: { whatsapp: boolean; email: boolean };
  reasons?: { whatsapp: string; email: string };
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
 * The bill's delivery state as the POS can honestly know it at settle.
 *
 * PATCH /api/orders/[id]/payment fires the bill (BILL-1) but returns only the
 * order and the change due — it doesn't report which channels went out. So the
 * one thing the POS knows for certain is whether there was anywhere to send to,
 * and that is the case worth catching: no number captured is the failure a
 * staffer can still fix while the customer is standing there. Where contact WAS
 * captured this states the attempt; tapping Resend replaces it with the server's
 * authoritative answer.
 */
export function placementBillStatus(contact: {
  phone?: string | null;
  email?: string | null;
}): BillStatusView {
  const phone = (contact.phone ?? '').trim();
  const email = (contact.email ?? '').trim();

  if (!phone && !email) {
    return {
      ok: false,
      message: describeBillOutcome(
        { whatsapp: false, email: false },
        { whatsapp: 'no_phone', email: 'no_email' },
      ),
    };
  }

  return {
    ok: true,
    message: describeBillOutcome(
      { whatsapp: phone.length > 0, email: email.length > 0 },
      { whatsapp: '', email: '' },
    ),
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
    return { ok: false, message: data?.error ?? 'Could not resend the bill.' };
  }
  const sent = data?.sent ?? { whatsapp: false, email: false };
  const reasons = data?.reasons ?? { whatsapp: '', email: '' };
  return { ok: sent.whatsapp || sent.email, message: describeBillOutcome(sent, reasons) };
}
