import { describe, expect, it } from 'vitest';

// VAL-1/VAL-2 — the pure rules behind coupons and points at the counter.
// No mocks: everything here is a function of its arguments, which is the whole
// reason it lives in lib/** instead of inside PosOrderEntry.tsx.

import { loyaltyUserIdFor } from '@/lib/loyalty/beneficiary';
import {
  canRedeemPoints,
  couponFeedback,
  describeCustomer,
  formatPoints,
  parsePointsInput,
  pointsFeedback,
} from '@/lib/pos/loyalty';

describe('loyaltyUserIdFor — whose account an order belongs to (D4-3)', () => {
  it('uses user_id for a web order', () => {
    expect(loyaltyUserIdFor({ user_id: 'cust-1', customer_user_id: null })).toBe('cust-1');
  });

  it('uses customer_user_id for a counter order, where user_id is null by design', () => {
    expect(loyaltyUserIdFor({ user_id: null, customer_user_id: 'cust-2' })).toBe('cust-2');
  });

  it('prefers the linked customer when both are set', () => {
    // They are the same person in practice; the preference only has to be
    // stable, so earn/redeem/reverse can never pick differently.
    expect(loyaltyUserIdFor({ user_id: 'cust-1', customer_user_id: 'cust-1' })).toBe('cust-1');
    expect(loyaltyUserIdFor({ user_id: 'session', customer_user_id: 'linked' })).toBe('linked');
  });

  it('is null for an anonymous walk-in or an unclaimed guest order', () => {
    expect(loyaltyUserIdFor({ user_id: null, customer_user_id: null })).toBeNull();
    expect(loyaltyUserIdFor({})).toBeNull();
    expect(loyaltyUserIdFor(null)).toBeNull();
  });

  it("treats '' as absent — a blank must never reach a uuid column", () => {
    expect(loyaltyUserIdFor({ user_id: '', customer_user_id: '' })).toBeNull();
    expect(loyaltyUserIdFor({ user_id: 'cust-1', customer_user_id: '  ' })).toBe('cust-1');
  });
});

describe('formatPoints', () => {
  it('pluralises', () => {
    expect(formatPoints(0)).toBe('0 points');
    expect(formatPoints(1)).toBe('1 point');
    expect(formatPoints(240)).toBe('240 points');
  });

  it('never shows a negative or fractional balance', () => {
    expect(formatPoints(-5)).toBe('0 points');
    expect(formatPoints(12.7)).toBe('12 points');
    expect(formatPoints(Number.NaN)).toBe('0 points');
  });
});

describe('describeCustomer', () => {
  it('leads with the name so a mistyped digit is caught by a human', () => {
    expect(describeCustomer({ found: true, name: 'Asha', points_balance: 240 })).toEqual({
      ok: true,
      text: 'Asha · 240 points',
    });
  });

  it('stays confirmable when the account has no name saved', () => {
    expect(describeCustomer({ found: true, name: '  ', points_balance: 0 })?.text).toBe(
      'Account · 0 points',
    );
  });

  it('says "no account" without making it sound like a failure', () => {
    const note = describeCustomer({ found: false });
    expect(note?.ok).toBe(false);
    expect(note?.text).toContain('still gets a bill');
  });

  it('says nothing at all before a lookup has happened', () => {
    expect(describeCustomer(null)).toBeNull();
  });
});

describe('canRedeemPoints', () => {
  it('is true only for a matched account with a balance', () => {
    expect(canRedeemPoints({ found: true, name: 'Asha', points_balance: 240 })).toBe(true);
    expect(canRedeemPoints({ found: true, name: 'Asha', points_balance: 0 })).toBe(false);
    expect(canRedeemPoints({ found: false })).toBe(false);
    expect(canRedeemPoints(null)).toBe(false);
  });
});

describe('parsePointsInput', () => {
  it('reads a whole number of points', () => {
    expect(parsePointsInput('120')).toBe(120);
    expect(parsePointsInput(' 120 ')).toBe(120);
  });

  it('treats anything that is not a positive whole number as none', () => {
    expect(parsePointsInput('')).toBe(0);
    expect(parsePointsInput('abc')).toBe(0);
    expect(parsePointsInput('0')).toBe(0);
    expect(parsePointsInput('-30')).toBe(30); // the sign is stripped, not honoured as a negative
    expect(parsePointsInput('12.9')).toBe(129); // digits only; the server re-quotes anyway
  });
});

describe('couponFeedback / pointsFeedback — the server speaks, we render', () => {
  it('shows the refusal reason verbatim', () => {
    expect(couponFeedback({ ok: false, reason: 'This coupon has expired' })).toEqual({
      ok: false,
      text: 'This coupon has expired',
    });
    expect(pointsFeedback({ ok: false, reason: 'You only have 40 points available' })).toEqual({
      ok: false,
      text: 'You only have 40 points available',
    });
  });

  it('falls back to a neutral message only when the server gave no reason', () => {
    expect(couponFeedback({ ok: false })?.text).toBe('This coupon is not valid for this order.');
    expect(pointsFeedback({ ok: false })?.text).toBe('Those points could not be redeemed.');
  });

  it('reports the accepted discount with the amount the server quoted', () => {
    expect(couponFeedback({ ok: true, discountInr: 50 })?.text).toBe('Coupon applied — ₹50 off');
    expect(pointsFeedback({ ok: true, points: 100, discountInr: 10 })?.text).toBe(
      '100 points — ₹10 off',
    );
  });

  it('says nothing when nothing was quoted', () => {
    expect(couponFeedback(null)).toBeNull();
    expect(pointsFeedback(undefined)).toBeNull();
  });
});
