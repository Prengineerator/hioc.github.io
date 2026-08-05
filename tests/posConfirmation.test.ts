import { describe, expect, it } from 'vitest';
import {
  describePaymentParts,
  parseResendResult,
  placementBillStatus,
} from '@/lib/staff/confirmation';
import type { PaymentPart } from '@/lib/orders/payments';

// POS4-4 — what the post-placement confirmation says. Pure, no mocks. The point
// of these is honesty: a bill that didn't send must never read as one that did.

const cash = (amount: number): PaymentPart => ({ method: 'cash', amount_inr: amount });
const upi = (amount: number): PaymentPart => ({ method: 'upi', amount_inr: amount });

describe('describePaymentParts', () => {
  it('names the method only for a single tender', () => {
    // The total is already on the card above it — repeating it is noise.
    expect(describePaymentParts([cash(480)])).toBe('CASH');
  });

  it('breaks a split down by amount', () => {
    expect(describePaymentParts([cash(200), upi(280)])).toBe('₹200 CASH + ₹280 UPI');
  });

  it('is empty with no parts', () => {
    expect(describePaymentParts([])).toBe('');
  });
});

describe('placementBillStatus', () => {
  it('flags the fixable failure when no contact was captured', () => {
    const s = placementBillStatus({ phone: '', email: '' });
    expect(s.ok).toBe(false);
    expect(s.message).toBe('Bill not sent — no phone number on this order.');
  });

  it('treats whitespace-only contact as no contact', () => {
    expect(placementBillStatus({ phone: '   ', email: null }).ok).toBe(false);
  });

  it('reports WhatsApp when a phone was captured', () => {
    const s = placementBillStatus({ phone: '9876543210' });
    expect(s.ok).toBe(true);
    expect(s.message).toBe('Bill sent on WhatsApp.');
  });

  it('reports both channels when both were captured', () => {
    const s = placementBillStatus({ phone: '9876543210', email: 'a@b.com' });
    expect(s.message).toBe('Bill sent on WhatsApp and email.');
  });

  it('reports email alone when only an email was captured', () => {
    expect(placementBillStatus({ email: 'a@b.com' }).message).toBe('Bill sent on email.');
  });
});

describe('parseResendResult', () => {
  it('reports which channels actually sent', () => {
    const r = parseResendResult(true, {
      sent: { whatsapp: true, email: false },
      reasons: { whatsapp: '', email: 'no_email' },
    });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Bill sent on WhatsApp.');
  });

  it('treats a 200 where NOTHING sent as a failure, with the cause', () => {
    // The exact bug BILL-3/4 exist to remove: a false success.
    const r = parseResendResult(true, {
      sent: { whatsapp: false, email: false },
      reasons: { whatsapp: 'not_configured:WHATSAPP_TPL_BILL', email: 'no_email' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toBe(
      'Bill not sent — channel not configured (missing whatsapp_tpl_bill).',
    );
  });

  it('shows the route message on a non-2xx, e.g. the rate limit', () => {
    const r = parseResendResult(false, {
      error: 'Too many bill resends for this order — please wait a moment.',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Too many bill resends for this order — please wait a moment.');
  });

  it('degrades to a plain message when the body is unreadable', () => {
    expect(parseResendResult(false, null)).toEqual({
      ok: false,
      message: 'Could not resend the bill.',
    });
    expect(parseResendResult(true, {}).ok).toBe(false);
  });
});
