import { describe, expect, it } from 'vitest';
import {
  clampRoundOff,
  describeSettleAdjustment,
  parseSettleAdjustment,
  ROUND_OFF_LIMIT_INR,
  roundOffAdjustment,
  roundOffReasonValid,
  shortNeedsManager,
  validateParts,
} from '@/lib/orders/payments';

// Round off (±₹5): the counter takes a rupee or two less (no change) or more
// (no change to give back) than the bill, with a reason. It is the existing
// settle adjustment (short = settlement discount, extra = tip), so what the
// panel builds must pass the server's own rules unchanged.

describe('clampRoundOff', () => {
  it('keeps whole rupees within ±₹5', () => {
    expect(ROUND_OFF_LIMIT_INR).toBe(5);
    expect(clampRoundOff(0)).toBe(0);
    expect(clampRoundOff(3)).toBe(3);
    expect(clampRoundOff(-2)).toBe(-2);
    expect(clampRoundOff(6)).toBe(5);
    expect(clampRoundOff(-9)).toBe(-5);
    expect(clampRoundOff(2.7)).toBe(2);
    expect(clampRoundOff(-2.7)).toBe(-2);
  });

  it('reads anything that is not a number as no round-off', () => {
    expect(clampRoundOff(NaN)).toBe(0);
    expect(clampRoundOff(Infinity)).toBe(0);
    expect(Object.is(clampRoundOff(-0.4), 0)).toBe(true);
  });
});

describe('roundOffAdjustment', () => {
  it('is nothing for no round-off', () => {
    expect(roundOffAdjustment(0, 'No change')).toBeNull();
  });

  it('turns a minus into a shortfall and a plus into a tip, with the reason trimmed', () => {
    expect(roundOffAdjustment(-3, ' No change ')).toEqual({ short_inr: 3, reason: 'No change' });
    expect(roundOffAdjustment(2, 'Tip')).toEqual({ tip_inr: 2, reason: 'Tip' });
  });

  it('never sends more than the limit', () => {
    expect(roundOffAdjustment(-40, 'No change')).toEqual({ short_inr: 5, reason: 'No change' });
    expect(roundOffAdjustment(40, 'Tip')).toEqual({ tip_inr: 5, reason: 'Tip' });
  });

  it('builds a body the server accepts as it is', () => {
    expect(parseSettleAdjustment(roundOffAdjustment(-3, 'No change'), 203)).toEqual({
      ok: true,
      shortInr: 3,
      tipInr: 0,
      reason: 'No change',
    });
    expect(parseSettleAdjustment(roundOffAdjustment(2, 'Rounded off'), 198)).toEqual({
      ok: true,
      shortInr: 0,
      tipInr: 2,
      reason: 'Rounded off',
    });
  });

  it('is always within what counter staff may approve alone', () => {
    expect(shortNeedsManager(ROUND_OFF_LIMIT_INR)).toBe(false);
  });
});

describe('roundOffReasonValid', () => {
  it('needs no reason without a round-off', () => {
    expect(roundOffReasonValid(0, '')).toBe(true);
  });

  it('needs the same reason the server needs (3 to 200 characters)', () => {
    expect(roundOffReasonValid(-2, '')).toBe(false);
    expect(roundOffReasonValid(-2, '  ab ')).toBe(false);
    expect(roundOffReasonValid(2, 'Tip')).toBe(true);
    expect(roundOffReasonValid(2, 'x'.repeat(201))).toBe(false);
  });
});

describe('validateParts with a round-off', () => {
  it('accepts the bill minus ₹3 when ₹3 short is declared', () => {
    const r = validateParts([{ method: 'cash', amount_inr: 200, tendered_inr: 200 }], 203, { shortInr: 3, tipInr: 0 });
    expect(r).toMatchObject({ ok: true, changeInr: 0 });
  });

  it('accepts the bill plus ₹2 when a ₹2 tip is declared', () => {
    expect(validateParts([{ method: 'upi', amount_inr: 200 }], 198, { shortInr: 0, tipInr: 2 }).ok).toBe(true);
  });

  it('still refuses a rupee off with no adjustment', () => {
    expect(validateParts([{ method: 'cash', amount_inr: 200 }], 203).ok).toBe(false);
  });

  it('works across a split sized on the rounded amount', () => {
    const r = validateParts(
      [
        { method: 'cash', amount_inr: 100, tendered_inr: 100 },
        { method: 'upi', amount_inr: 100 },
      ],
      202,
      { shortInr: 2, tipInr: 0 },
    );
    expect(r.ok).toBe(true);
  });
});

describe('describeSettleAdjustment', () => {
  it('reads as short or extra, with the reason', () => {
    expect(describeSettleAdjustment({ short_inr: 3, reason: 'No change' })).toBe('₹3 short (No change)');
    expect(describeSettleAdjustment({ tip_inr: 2, reason: 'Tip' })).toBe('₹2 extra (Tip)');
    expect(describeSettleAdjustment({ tip_inr: 2, reason: '  ' })).toBe('₹2 extra');
  });

  it('is empty when there is nothing to say', () => {
    expect(describeSettleAdjustment(undefined)).toBe('');
    expect(describeSettleAdjustment(null)).toBe('');
    expect(describeSettleAdjustment({ short_inr: 0, tip_inr: 0, reason: 'x' })).toBe('');
  });
});
