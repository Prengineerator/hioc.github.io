import { describe, expect, it } from 'vitest';
import {
  expectedReceivedInr,
  parseSettleAdjustment,
  shortNeedsManager,
  validateParts,
} from '@/lib/orders/payments';

// Settle for LESS or MORE than the bill: short = settlement discount, extra =
// tip, always with a reason. Pure rules — the route adds the role check.

describe('parseSettleAdjustment', () => {
  it('treats an absent adjustment as a plain settle', () => {
    expect(parseSettleAdjustment(undefined, 500)).toEqual({ ok: true, shortInr: 0, tipInr: 0, reason: '' });
    expect(parseSettleAdjustment(null, 500)).toEqual({ ok: true, shortInr: 0, tipInr: 0, reason: '' });
  });

  it('treats all-zero amounts as a plain settle and drops any reason', () => {
    expect(parseSettleAdjustment({ short_inr: 0, tip_inr: 0, reason: 'stray' }, 500)).toEqual({
      ok: true,
      shortInr: 0,
      tipInr: 0,
      reason: '',
    });
  });

  it('accepts a shortfall with a reason and trims it', () => {
    expect(parseSettleAdjustment({ short_inr: 20, reason: '  Rounded off ' }, 500)).toEqual({
      ok: true,
      shortInr: 20,
      tipInr: 0,
      reason: 'Rounded off',
    });
  });

  it('accepts a tip with a reason', () => {
    expect(parseSettleAdjustment({ tip_inr: 20, reason: 'Keep the change' }, 500)).toEqual({
      ok: true,
      shortInr: 0,
      tipInr: 20,
      reason: 'Keep the change',
    });
  });

  it('requires a reason of at least 3 characters when there is a difference', () => {
    for (const reason of [undefined, '', '  ', 'ab', '   a ', 42]) {
      const r = parseSettleAdjustment({ short_inr: 20, reason }, 500);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/reason/i);
    }
    expect(parseSettleAdjustment({ tip_inr: 10 }, 500).ok).toBe(false);
  });

  it('rejects both short and tip on one bill', () => {
    const r = parseSettleAdjustment({ short_inr: 10, tip_inr: 10, reason: 'Other' }, 500);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/not both/);
  });

  it('rejects a shortfall larger than the bill, but allows exactly the bill', () => {
    expect(parseSettleAdjustment({ short_inr: 501, reason: 'Other' }, 500).ok).toBe(false);
    expect(parseSettleAdjustment({ short_inr: 500, reason: 'Other' }, 500).ok).toBe(true);
  });

  it('rejects negative, fractional and non-numeric amounts', () => {
    for (const bad of [-5, 2.5, '20', NaN]) {
      expect(parseSettleAdjustment({ short_inr: bad, reason: 'Other' }, 500).ok).toBe(false);
      expect(parseSettleAdjustment({ tip_inr: bad, reason: 'Other' }, 500).ok).toBe(false);
    }
  });

  it('rejects a non-object adjustment and an over-long reason', () => {
    expect(parseSettleAdjustment('20', 500).ok).toBe(false);
    expect(parseSettleAdjustment([], 500).ok).toBe(false);
    expect(parseSettleAdjustment({ short_inr: 5, reason: 'x'.repeat(201) }, 500).ok).toBe(false);
  });
});

describe('shortNeedsManager', () => {
  it('lets counter staff approve up to and including ₹50', () => {
    expect(shortNeedsManager(0)).toBe(false);
    expect(shortNeedsManager(50)).toBe(false);
    expect(shortNeedsManager(51)).toBe(true);
  });
});

describe('validateParts with an adjustment', () => {
  const cash = (amount: number) => [{ method: 'cash', amount_inr: amount }];

  it('expects total - short when the customer paid less', () => {
    expect(expectedReceivedInr(500, { shortInr: 20, tipInr: 0 })).toBe(480);
    const r = validateParts(cash(480), 500, { shortInr: 20, tipInr: 0 });
    expect(r.ok).toBe(true);
  });

  it('expects total + tip when the customer paid more', () => {
    expect(expectedReceivedInr(500, { shortInr: 0, tipInr: 20 })).toBe(520);
    expect(validateParts(cash(520), 500, { shortInr: 0, tipInr: 20 }).ok).toBe(true);
  });

  it('rejects parts that still sum to the full bill when a shortfall was declared', () => {
    const r = validateParts(cash(500), 500, { shortInr: 20, tipInr: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('₹480');
  });

  it('rejects parts that do not include the tip', () => {
    expect(validateParts(cash(500), 500, { shortInr: 0, tipInr: 20 }).ok).toBe(false);
  });

  it('keeps the exact-total rule when there is no adjustment', () => {
    expect(validateParts(cash(480), 500).ok).toBe(false);
    expect(validateParts(cash(500), 500, { shortInr: 0, tipInr: 0 }).ok).toBe(true);
  });

  it('works across a split, and keeps cash change math on the received amount', () => {
    const r = validateParts(
      [
        { method: 'cash', amount_inr: 300, tendered_inr: 500 },
        { method: 'upi', amount_inr: 180 },
      ],
      500,
      { shortInr: 20, tipInr: 0 },
    );
    expect(r).toMatchObject({ ok: true, changeInr: 200 });
  });
});
