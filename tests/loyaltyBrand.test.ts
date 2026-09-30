import { describe, expect, it } from 'vitest';

// The loyalty currency's customer-facing name ("Beanies", formerly "points").
// Pure helpers — everything a screen, receipt or message says about a count
// goes through here, so the singular/plural rule is pinned in one place.

import { LOYALTY_UNIT, beaniesLabel, beaniesTagline, beaniesUnit } from '@/lib/loyalty/brand';

describe('LOYALTY_UNIT', () => {
  it('is Beanie / Beanies', () => {
    expect(LOYALTY_UNIT).toEqual({ one: 'Beanie', many: 'Beanies' });
  });
});

describe('beaniesLabel', () => {
  it('uses the singular for exactly one', () => {
    expect(beaniesLabel(1)).toBe('1 Beanie');
  });

  it('uses the plural for zero and for everything above one', () => {
    expect(beaniesLabel(0)).toBe('0 Beanies');
    expect(beaniesLabel(2)).toBe('2 Beanies');
    expect(beaniesLabel(24)).toBe('24 Beanies');
    expect(beaniesLabel(1250)).toBe('1250 Beanies');
  });

  it('keeps the sign of a negative amount and pluralises on its size', () => {
    expect(beaniesLabel(-5)).toBe('-5 Beanies');
    expect(beaniesLabel(-1)).toBe('-1 Beanie');
  });

  it('shows whole Beanies only — fractions are truncated, nonsense reads as zero', () => {
    expect(beaniesLabel(12.7)).toBe('12 Beanies');
    expect(beaniesLabel(1.9)).toBe('1 Beanie');
    expect(beaniesLabel(-0.4)).toBe('0 Beanies');
    expect(beaniesLabel(Number.NaN)).toBe('0 Beanies');
    expect(beaniesLabel(Number.POSITIVE_INFINITY)).toBe('0 Beanies');
  });

  it('never says "point" or "pts"', () => {
    for (const n of [-3, -1, 0, 1, 2, 100]) {
      expect(beaniesLabel(n)).not.toMatch(/point|pts/i);
    }
  });
});

describe('beaniesUnit', () => {
  it('is the bare word, singular only for ±1', () => {
    expect(beaniesUnit(1)).toBe('Beanie');
    expect(beaniesUnit(-1)).toBe('Beanie');
    expect(beaniesUnit(0)).toBe('Beanies');
    expect(beaniesUnit(10)).toBe('Beanies');
    expect(beaniesUnit(0.5)).toBe('Beanies');
  });
});

describe('beaniesTagline', () => {
  it('derives the rupee value from what it is given, not from a constant', () => {
    expect(beaniesTagline(1)).toBe('Beanies — HIOC rewards. 1 Beanie = ₹1 off.');
    expect(beaniesTagline(0.5)).toBe('Beanies — HIOC rewards. 1 Beanie = ₹0.5 off.');
  });
});
