import { describe, expect, it } from 'vitest';
import {
  billStatusFromDelivery,
  billStatusTone,
  describePaymentParts,
  parseResendResult,
  placementBillStatus,
} from '@/lib/staff/confirmation';
import type { BillStatusView } from '@/lib/staff/confirmation';
import type { PaymentPart } from '@/lib/orders/payments';

// POS4-4 / WA-5 — what the post-placement confirmation says. Pure, no mocks. The
// point of these is honesty: a bill that didn't send must never read as one that
// did, and one that hasn't answered yet must not read as either.

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
    expect(s.state).toBe('none');
    expect(s.ok).toBe(false);
    expect(s.message).toBe('Bill not sent — no phone number on this order.');
  });

  it('treats whitespace-only contact as no contact', () => {
    expect(placementBillStatus({ phone: '   ', email: null }).state).toBe('none');
  });

  it('does NOT claim a send it has no evidence for', () => {
    // WA-5: this used to read "Bill sent on WhatsApp." purely because a phone
    // had been typed. The settle route reports nothing about the bill, so the
    // only honest word is that we asked.
    const s = placementBillStatus({ phone: '9876543210' });
    expect(s.state).toBe('pending');
    expect(s.ok).toBe(false);
    expect(s.message).toBe('Sending the bill on WhatsApp…');
  });

  it('names both channels when both were captured', () => {
    const s = placementBillStatus({ phone: '9876543210', email: 'a@b.com' });
    expect(s.message).toBe('Sending the bill on WhatsApp and email…');
  });

  it('names email alone when only an email was captured', () => {
    expect(placementBillStatus({ email: 'a@b.com' }).message).toBe('Sending the bill on email…');
  });
});

describe('billStatusFromDelivery', () => {
  it('says nothing when the log has nothing to say', () => {
    // No rows yet → keep whatever the caller had; a missing row is not evidence
    // of a failure.
    expect(billStatusFromDelivery([])).toBeNull();
    expect(billStatusFromDelivery(null)).toBeNull();
    expect(billStatusFromDelivery([{ channel: 'push', status: 'sent' }])).toBeNull();
  });

  it('only says "delivered" when the handset confirmed it', () => {
    const s = billStatusFromDelivery([{ channel: 'whatsapp', status: 'delivered' }]);
    expect(s?.state).toBe('delivered');
    expect(s?.ok).toBe(true);
    expect(s?.message).toBe('Bill delivered on WhatsApp.');
  });

  it('treats read as delivered — being opened is the same good news', () => {
    expect(billStatusFromDelivery([{ channel: 'whatsapp', status: 'read' }])?.state).toBe(
      'delivered',
    );
  });

  it('marks a provider-accepted send as unconfirmed, not done', () => {
    // Spec F3: 'sent' is a statement about an HTTP call, not about a phone —
    // the exact gap that let "the bill never arrives" stay invisible.
    const s = billStatusFromDelivery([{ channel: 'whatsapp', status: 'sent' }]);
    expect(s?.state).toBe('sent');
    expect(s?.message).toBe('Bill sent on WhatsApp — not confirmed yet.');
  });

  it('prefers the furthest any channel got', () => {
    const s = billStatusFromDelivery([
      { channel: 'email', status: 'sent' },
      { channel: 'whatsapp', status: 'delivered' },
    ]);
    expect(s?.message).toBe('Bill delivered on WhatsApp.');
    expect(s?.failedChannels).toEqual([]);
  });

  // WA-5's AC: "Given a bill that fails, when the confirmation strip is visible,
  // then the failure and a Resend button are on it." The furthest-channel-wins
  // rule used to return before the failure tally was ever consulted, so an order
  // carrying both a phone and an email — which the POS captures on one screen —
  // rendered a green success whenever email happened to go, hiding the dead
  // WhatsApp send that the cafe and the owner's complaint are actually about.
  it('never hides a failed channel behind another channel that worked', () => {
    const s = billStatusFromDelivery([
      { channel: 'whatsapp', status: 'failed', error: 'Template paused' },
      { channel: 'email', status: 'sent' },
    ]);
    expect(s?.state).toBe('sent');
    expect(s?.failedChannels).toEqual(['whatsapp']);
    expect(s?.message).toContain('WhatsApp failed');
    // ...and it must not read as success anywhere.
    expect(s?.ok).toBe(false);
    expect(billStatusTone(s!)).toBe('bad');
  });

  it('names a failed channel even when the other one was DELIVERED', () => {
    const s = billStatusFromDelivery([
      { channel: 'whatsapp', status: 'failed' },
      { channel: 'email', status: 'delivered' },
    ]);
    expect(s?.state).toBe('delivered');
    expect(s?.message).toContain('Bill delivered on email.');
    expect(s?.message).toContain('WhatsApp failed');
    expect(billStatusTone(s!)).toBe('bad');
  });

  it('carries the fixable cause of the hidden failure, not just the fact of it', () => {
    const s = billStatusFromDelivery([
      { channel: 'whatsapp', status: 'skipped', skip_reason: 'not_configured:WHATSAPP_TPL_BILL' },
      { channel: 'email', status: 'sent' },
    ]);
    expect(s?.message).toContain('whatsapp_tpl_bill');
  });

  // The commonest order at this counter: a phone, no email. The skipped email
  // row must not paint the normal case red, or the staffer learns to ignore red.
  it('does not call a channel the order had no address for a failure', () => {
    const s = billStatusFromDelivery([
      { channel: 'whatsapp', status: 'sent' },
      { channel: 'email', status: 'skipped', skip_reason: 'no_email' },
    ]);
    expect(s?.failedChannels).toEqual([]);
    expect(s?.message).toBe('Bill sent on WhatsApp — not confirmed yet.');
    expect(billStatusTone(s!)).toBe('wait');
  });

  it('reports a skipped channel with the cause the owner can fix', () => {
    const s = billStatusFromDelivery([
      { channel: 'whatsapp', status: 'skipped', skip_reason: 'not_configured:WHATSAPP_TOKEN' },
      { channel: 'email', status: 'skipped', skip_reason: 'no_email' },
    ]);
    expect(s?.state).toBe('failed');
    expect(s?.ok).toBe(false);
    expect(s?.message).toBe('Bill not sent — channel not configured (missing whatsapp_token).');
  });

  it('reports a provider rejection when the row failed without a skip reason', () => {
    const s = billStatusFromDelivery([
      { channel: 'whatsapp', status: 'failed', error: 'Template paused' },
    ]);
    expect(s?.state).toBe('failed');
    expect(s?.message).toBe('Bill not sent — the provider rejected the message.');
  });

  it('is still waiting while a row is only queued', () => {
    const s = billStatusFromDelivery([{ channel: 'whatsapp', status: 'queued' }]);
    expect(s?.state).toBe('pending');
    expect(s?.ok).toBe(false);
  });

  it('survives a status vocabulary it has never seen', () => {
    // A POS running ahead of a migration must degrade, not guess: an unknown
    // status is treated as "did not go", which is the safe direction.
    const s = billStatusFromDelivery([{ channel: 'whatsapp', status: 'something_new' }]);
    expect(s?.ok).toBe(false);
  });
});

describe('billStatusTone', () => {
  const view = (over: Partial<BillStatusView>): BillStatusView => ({
    state: 'pending',
    ok: false,
    message: '',
    failedChannels: [],
    ...over,
  });

  it('keeps in-flight out of both green and red', () => {
    // Green tells the staffer to move on; red tells them to apologise. A bill
    // still in flight is neither.
    expect(billStatusTone(view({ state: 'delivered', ok: true }))).toBe('good');
    expect(billStatusTone(view({ state: 'sent', ok: true }))).toBe('wait');
    expect(billStatusTone(view({ state: 'pending' }))).toBe('wait');
    expect(billStatusTone(view({ state: 'failed' }))).toBe('bad');
    expect(billStatusTone(view({ state: 'none' }))).toBe('bad');
  });

  it('goes red on a partial success, however far the best channel got', () => {
    expect(billStatusTone(view({ state: 'delivered', failedChannels: ['whatsapp'] }))).toBe('bad');
    expect(billStatusTone(view({ state: 'sent', failedChannels: ['whatsapp'] }))).toBe('bad');
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
    // The route knows what the provider accepted, never what the handset got —
    // only the webhook may promote a resend to 'delivered'.
    expect(r.state).toBe('sent');
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
      state: 'failed',
      ok: false,
      message: 'Could not resend the bill.',
      failedChannels: [],
    });
    expect(parseResendResult(true, {}).ok).toBe(false);
  });
});
