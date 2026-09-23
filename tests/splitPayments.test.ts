import { describe, expect, it } from 'vitest';
import {
  cashPortionInr,
  changeDueInr,
  dominantMethod,
  validateParts,
  type PaymentPart,
} from '@/lib/orders/payments';

// POS4-1 — counter settlement math. Pure, no mocks: these are the rules that
// decide what lands in the drawer, so they're tested against plain fixtures.

describe('changeDueInr', () => {
  it('returns the difference on an over-tender', () => {
    expect(changeDueInr(500, 380)).toBe(120);
  });

  it('is zero on an exact tender', () => {
    expect(changeDueInr(380, 380)).toBe(0);
  });

  it('never goes negative on an under-tender', () => {
    // An under-tender is a validation failure upstream; a customer must never
    // be shown "change: -₹80".
    expect(changeDueInr(300, 380)).toBe(0);
  });
});

describe('validateParts', () => {
  const cash = (amount: number, tendered?: number) => ({
    method: 'cash',
    amount_inr: amount,
    ...(tendered === undefined ? {} : { tendered_inr: tendered }),
  });

  it('accepts a single part covering the bill', () => {
    const r = validateParts([{ method: 'upi', amount_inr: 480 }], 480);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parts).toHaveLength(1);
  });

  it('accepts a two-way split that sums exactly', () => {
    const r = validateParts([cash(200), { method: 'upi', amount_inr: 280 }], 480);
    expect(r.ok).toBe(true);
  });

  it('REJECTS parts that do not sum to the bill', () => {
    // A ₹1 gap would surface later as an unexplained cash-day variance.
    const r = validateParts([cash(200), { method: 'upi', amount_inr: 279 }], 480);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('must match exactly');
  });

  it('rejects an over-sum too', () => {
    expect(validateParts([cash(500)], 480).ok).toBe(false);
  });

  it('rejects an empty or non-array parts value', () => {
    expect(validateParts([], 480).ok).toBe(false);
    expect(validateParts(null, 480).ok).toBe(false);
    expect(validateParts('cash', 480).ok).toBe(false);
  });

  it('rejects more than four parts', () => {
    const many = Array.from({ length: 5 }, () => ({ method: 'cash', amount_inr: 100 }));
    const r = validateParts(many, 500);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('at most 4');
  });

  it('rejects a non-integer, zero or negative amount', () => {
    expect(validateParts([{ method: 'cash', amount_inr: 480.5 }], 480.5).ok).toBe(false);
    expect(validateParts([{ method: 'cash', amount_inr: 0 }], 0).ok).toBe(false);
    expect(validateParts([{ method: 'cash', amount_inr: -480 }], -480).ok).toBe(false);
  });

  it('rejects an unknown method', () => {
    expect(validateParts([{ method: 'crypto', amount_inr: 480 }], 480).ok).toBe(false);
  });

  it('rejects cash tendered below its own part', () => {
    const r = validateParts([cash(480, 400)], 480);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cannot be less than');
  });

  it('accumulates change across cash parts', () => {
    const r = validateParts([cash(200, 500), { method: 'card', amount_inr: 280 }], 480);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changeInr).toBe(300);
  });

  it('drops tendered on a non-cash method — nothing is "tendered" on a card', () => {
    const r = validateParts([{ method: 'card', amount_inr: 480, tendered_inr: 500 }], 480);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parts[0].tendered_inr).toBeNull();
      expect(r.changeInr).toBe(0);
    }
  });
});

describe('dominantMethod', () => {
  const parts = (a: number, b: number): PaymentPart[] => [
    { method: 'cash', amount_inr: a },
    { method: 'upi', amount_inr: b },
  ];

  it('picks the larger part', () => {
    expect(dominantMethod(parts(300, 180))).toBe('cash');
    expect(dominantMethod(parts(180, 300))).toBe('upi');
  });

  it('resolves a tie deterministically to the first part', () => {
    expect(dominantMethod(parts(240, 240))).toBe('cash');
  });
});

describe('cashPortionInr', () => {
  it('counts ONLY the cash parts — the drawer never sees the UPI half', () => {
    // This is the bug the parts table exists to prevent: before it, a ₹480 order
    // split ₹200 cash / ₹280 UPI would have counted ₹480 as cash and read the
    // drawer ₹280 over.
    expect(
      cashPortionInr([
        { method: 'cash', amount_inr: 200 },
        { method: 'upi', amount_inr: 280 },
      ]),
    ).toBe(200);
  });

  it('is zero for a fully non-cash settlement', () => {
    expect(cashPortionInr([{ method: 'card', amount_inr: 480 }])).toBe(0);
  });

  it('sums multiple cash parts', () => {
    expect(
      cashPortionInr([
        { method: 'cash', amount_inr: 100 },
        { method: 'cash', amount_inr: 150 },
        { method: 'upi', amount_inr: 230 },
      ]),
    ).toBe(250);
  });
});
