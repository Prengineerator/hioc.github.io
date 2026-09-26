import { describe, expect, it } from 'vitest';
import { PAYMENT_BADGE, amountDueInr, isPaymentDue } from '@/lib/orders/staffPayment';

// What staff screens call "unpaid" — highlighted on the Orders page, and why a
// ready order can't be completed yet.

describe('isPaymentDue', () => {
  it('is true for an open or completed order not yet paid', () => {
    expect(isPaymentDue({ status: 'ready', payment_status: 'unpaid' })).toBe(true);
    expect(isPaymentDue({ status: 'accepted', payment_status: 'payment_pending' })).toBe(true);
    expect(isPaymentDue({ status: 'completed', payment_status: 'unpaid' })).toBe(true);
  });

  it('is false once paid or refunded, and for orders that will never be paid', () => {
    expect(isPaymentDue({ status: 'ready', payment_status: 'paid' })).toBe(false);
    expect(isPaymentDue({ status: 'completed', payment_status: 'refunded' })).toBe(false);
    expect(isPaymentDue({ status: 'cancelled', payment_status: 'unpaid' })).toBe(false);
    expect(isPaymentDue({ status: 'rejected', payment_status: 'unpaid' })).toBe(false);
  });
});

describe('amountDueInr', () => {
  it('adds up what is still to collect, using the total (or subtotal before billing)', () => {
    expect(
      amountDueInr([
        { status: 'ready', payment_status: 'unpaid', total_inr: 220, subtotal_inr: 210 },
        { status: 'accepted', payment_status: 'unpaid', total_inr: null, subtotal_inr: 90 },
        { status: 'completed', payment_status: 'paid', total_inr: 500, subtotal_inr: 480 },
        { status: 'cancelled', payment_status: 'unpaid', total_inr: 100, subtotal_inr: 100 },
      ]),
    ).toBe(310);
  });
});

describe('PAYMENT_BADGE', () => {
  it('labels every payment status', () => {
    expect(PAYMENT_BADGE.paid.label).toBe('Paid');
    expect(PAYMENT_BADGE.unpaid.label).toBe('Unpaid');
    expect(Object.keys(PAYMENT_BADGE).sort()).toEqual(
      ['paid', 'partially_refunded', 'payment_pending', 'refunded', 'unpaid'].sort(),
    );
  });
});
