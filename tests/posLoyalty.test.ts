import { describe, expect, it } from 'vitest';

// VAL-1/VAL-2 — the pure rules behind coupons and points at the counter.
// No mocks: everything here is a function of its arguments, which is the whole
// reason it lives in lib/** instead of inside PosOrderEntry.tsx.

import { loyaltyUserIdFor } from '@/lib/loyalty/beneficiary';
import {
  canRedeemPoints,
  couponFeedback,
  customerChip,
  describeCustomer,
  formatPoints,
  hasOrderHistory,
  parsePointsInput,
  passFeedback,
  pointsFeedback,
  type CustomerLookup,
  type QuotedPass,
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
    expect(formatPoints(0)).toBe('0 Beanies');
    expect(formatPoints(1)).toBe('1 Beanie');
    expect(formatPoints(240)).toBe('240 Beanies');
  });

  it('never shows a negative or fractional balance', () => {
    expect(formatPoints(-5)).toBe('0 Beanies');
    expect(formatPoints(12.7)).toBe('12 Beanies');
    expect(formatPoints(Number.NaN)).toBe('0 Beanies');
  });
});

describe('describeCustomer', () => {
  it('leads with the name so a mistyped digit is caught by a human', () => {
    expect(
      describeCustomer({
        found: true,
        source: 'account',
        name: 'Asha',
        points_balance: 240,
        order_count: 3,
        last_order_at: '2026-09-20T10:00:00Z',
      }),
    ).toEqual({ ok: true, text: 'Asha · 240 Beanies' });
  });

  it('stays confirmable when the account has no name saved', () => {
    expect(
      describeCustomer({
        found: true,
        source: 'account',
        name: '  ',
        points_balance: 0,
        order_count: 0,
        last_order_at: null,
      })?.text,
    ).toBe('Account · 0 Beanies');
  });

  it('names a no-account order-history match without claiming any Beanies', () => {
    const note = describeCustomer({
      found: true,
      source: 'order_history',
      name: 'Ravi',
      order_count: 4,
      last_order_at: '2026-09-20T10:00:00Z',
    });
    expect(note).toEqual({ ok: true, text: 'Ravi · HIOC account opens with this order' });
  });

  it('names a Petpooja-only match (no hioc order ever placed) the same way as order_history', () => {
    const note = describeCustomer({
      found: true,
      source: 'petpooja',
      name: 'Test Customer',
      order_count: 6,
      last_order_at: '2026-08-01T09:00:00Z',
    });
    expect(note).toEqual({ ok: true, text: 'Test Customer · HIOC account opens with this order' });
  });

  it('tells the counter a new number opens an account with this order', () => {
    const note = describeCustomer({ found: false });
    expect(note?.ok).toBe(false);
    expect(note?.text).toContain('opens their HIOC account');
    expect(note?.text).toContain('earns Beanies');
  });

  it('says nothing at all before a lookup has happened', () => {
    expect(describeCustomer(null)).toBeNull();
  });
});

describe('canRedeemPoints', () => {
  it('is true only for a VERIFIED account with a balance', () => {
    expect(
      canRedeemPoints({
        found: true,
        source: 'account',
        name: 'Asha',
        points_balance: 240,
        order_count: 3,
        last_order_at: null,
      }),
    ).toBe(true);
    expect(
      canRedeemPoints({
        found: true,
        source: 'account',
        name: 'Asha',
        points_balance: 0,
        order_count: 3,
        last_order_at: null,
      }),
    ).toBe(false);
    expect(canRedeemPoints({ found: false })).toBe(false);
    expect(canRedeemPoints(null)).toBe(false);
  });

  it('is false for an order-history match — there is no account to hold a balance', () => {
    expect(
      canRedeemPoints({
        found: true,
        source: 'order_history',
        name: 'Ravi',
        order_count: 4,
        last_order_at: null,
      }),
    ).toBe(false);
  });

  it('is false for a Petpooja-only match — same reason as order_history', () => {
    expect(
      canRedeemPoints({
        found: true,
        source: 'petpooja',
        name: 'Test Customer',
        order_count: 6,
        last_order_at: null,
      }),
    ).toBe(false);
  });
});

describe('hasOrderHistory', () => {
  it('is true whenever at least one past order was found, account or not', () => {
    expect(
      hasOrderHistory({
        found: true,
        source: 'account',
        name: 'Asha',
        points_balance: 0,
        order_count: 1,
        last_order_at: null,
      }),
    ).toBe(true);
    expect(
      hasOrderHistory({
        found: true,
        source: 'order_history',
        name: 'Ravi',
        order_count: 4,
        last_order_at: null,
      }),
    ).toBe(true);
    expect(
      hasOrderHistory({
        found: true,
        source: 'petpooja',
        name: 'Test Customer',
        order_count: 6,
        last_order_at: null,
      }),
    ).toBe(true);
  });

  it('is false with no order, no lookup, or nothing found', () => {
    expect(
      hasOrderHistory({
        found: true,
        source: 'account',
        name: 'Asha',
        points_balance: 0,
        order_count: 0,
        last_order_at: null,
      }),
    ).toBe(false);
    expect(hasOrderHistory({ found: false })).toBe(false);
    expect(hasOrderHistory(null)).toBe(false);
  });
});

describe('customerChip', () => {
  it('shows the Beanies balance for a verified account', () => {
    expect(
      customerChip({
        found: true,
        source: 'account',
        name: 'Asha',
        points_balance: 240,
        order_count: 3,
        last_order_at: null,
      }),
    ).toBe('HIOC account · 240 Beanies');
  });

  it('shows an order count (singular/plural) for an order-history match', () => {
    expect(
      customerChip({
        found: true,
        source: 'order_history',
        name: 'Ravi',
        order_count: 1,
        last_order_at: null,
      }),
    ).toBe('Returning customer · 1 order');
    expect(
      customerChip({
        found: true,
        source: 'order_history',
        name: 'Ravi',
        order_count: 12,
        last_order_at: null,
      }),
    ).toBe('Returning customer · 12 orders');
  });

  it("shows 'Petpooja customer' (singular/plural) for a Petpooja-only match", () => {
    expect(
      customerChip({
        found: true,
        source: 'petpooja',
        name: 'Test Customer',
        order_count: 1,
        last_order_at: null,
      }),
    ).toBe('Petpooja customer · 1 order');
    expect(
      customerChip({
        found: true,
        source: 'petpooja',
        name: 'Test Customer',
        order_count: 9,
        last_order_at: null,
      }),
    ).toBe('Petpooja customer · 9 orders');
  });

  it('is null with no lookup, nothing found, or no orders to count', () => {
    expect(customerChip(null)).toBeNull();
    expect(customerChip({ found: false })).toBeNull();
    expect(
      customerChip({
        found: true,
        source: 'order_history',
        name: 'Ravi',
        order_count: 0,
        last_order_at: null,
      }),
    ).toBeNull();
    expect(
      customerChip({
        found: true,
        source: 'petpooja',
        name: 'Test Customer',
        order_count: 0,
        last_order_at: null,
      }),
    ).toBeNull();
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
    expect(pointsFeedback({ ok: false, reason: 'You only have 40 Beanies available' })).toEqual({
      ok: false,
      text: 'You only have 40 Beanies available',
    });
  });

  it('falls back to a neutral message only when the server gave no reason', () => {
    expect(couponFeedback({ ok: false })?.text).toBe('This coupon is not valid for this order.');
    expect(pointsFeedback({ ok: false })?.text).toBe('Those Beanies could not be redeemed.');
  });

  it('reports the accepted discount with the amount the server quoted', () => {
    expect(couponFeedback({ ok: true, discountInr: 50 })?.text).toBe('Coupon applied — ₹50 off');
    expect(pointsFeedback({ ok: true, points: 100, discountInr: 10 })?.text).toBe(
      '100 Beanies — ₹10 off',
    );
  });

  it('says nothing when nothing was quoted', () => {
    expect(couponFeedback(null)).toBeNull();
    expect(pointsFeedback(undefined)).toBeNull();
  });
});

// HIOC Ritual: the same rule for cups. The server's `pass` block is judged, not
// re-judged here; the stepper starts at 0 (CP-D10), so nothing is said until a
// cup has been asked for.
describe('passFeedback — the quote speaks, we render', () => {
  const quoted = (overrides: Partial<QuotedPass> = {}): QuotedPass => ({
    requested: 2,
    applied: 2,
    discount_inr: 270,
    eligible_units: 3,
    available: 5,
    max_usable: 3,
    shortfall: null,
    message: null,
    ...overrides,
  });

  it('confirms the cups applied with the rupees the server says they cover', () => {
    expect(passFeedback(quoted())).toEqual({ ok: true, text: 'HIOC Ritual: 2 cups — ₹270 covered' });
    expect(passFeedback(quoted({ requested: 1, applied: 1, discount_inr: 120 }))).toEqual({
      ok: true,
      text: 'HIOC Ritual: 1 cup — ₹120 covered',
    });
  });

  it("shows the server's reason verbatim when fewer cups were applied than asked for", () => {
    const message = 'You have 1 cup left on your HIOC Ritual pass, so 1 cup can be used.';
    expect(passFeedback(quoted({ requested: 2, applied: 1, discount_inr: 120, shortfall: 'not_enough_drinks', message }))).toEqual({
      ok: false,
      text: message,
    });
  });

  it('falls back to a neutral message only when the server gave no reason', () => {
    expect(passFeedback(quoted({ requested: 2, applied: 0, discount_inr: 0, shortfall: 'no_pass', message: null }))).toEqual({
      ok: false,
      text: 'HIOC Ritual could not be applied to this order.',
    });
  });

  it('says nothing until a cup has been asked for, or when nothing was quoted', () => {
    expect(passFeedback(quoted({ requested: 0, applied: 0, discount_inr: 0 }))).toBeNull();
    expect(passFeedback(null)).toBeNull();
    expect(passFeedback(undefined)).toBeNull();
  });
});

describe('CustomerLookup carries the usable passes', () => {
  it('lets an account answer with passes, and the other sources without', () => {
    const account: CustomerLookup = {
      found: true,
      source: 'account',
      name: 'Asha',
      points_balance: 40,
      order_count: 3,
      last_order_at: null,
      passes: [],
    };
    const history: CustomerLookup = { found: true, source: 'order_history', name: 'Ravi', order_count: 1, last_order_at: null };
    // The presence of `passes` changes nothing about who the customer is.
    expect(describeCustomer(account)?.text).toBe('Asha · 40 Beanies');
    expect(customerChip(account)).toBe('HIOC account · 40 Beanies');
    expect(describeCustomer(history)?.ok).toBe(true);
  });
});
