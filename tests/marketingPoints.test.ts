import { describe, expect, it } from 'vitest';
import { expiryCutoff, pointsToExpire } from '@/lib/loyalty/expiry';
import { expiringWithin, expiryDateFor, pointsBalance } from '@/lib/marketing/points';

// Points that will be gone within the next k days = what a real expiry run would
// write off if it ran k days from now. Reuses loyalty/expiry's FIFO rule unchanged.

const NOW = new Date('2026-09-30T06:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();
const EXPIRY = 30;

describe('expiringWithin', () => {
  it('is 0 with no rows', () => {
    expect(expiringWithin([], NOW, EXPIRY, 5)).toBe(0);
  });

  it('counts a credit that reaches its 30-day life inside the horizon', () => {
    const rows = [{ points: 40, created_at: daysAgo(27) }]; // expires in 3 days
    expect(expiringWithin(rows, NOW, EXPIRY, 5)).toBe(40);
    expect(expiringWithin(rows, NOW, EXPIRY, 3.5)).toBe(40);
  });

  it('does not count a credit that outlives the horizon', () => {
    const rows = [{ points: 40, created_at: daysAgo(20) }]; // expires in 10 days
    expect(expiringWithin(rows, NOW, EXPIRY, 5)).toBe(0);
    expect(expiringWithin(rows, NOW, EXPIRY, 10)).toBe(0); // exactly at the line is not yet expired (pointsToExpire is strict)
    expect(expiringWithin(rows, NOW, EXPIRY, 11)).toBe(40);
  });

  it('is exactly pointsToExpire with the cutoff pushed k days forward (spec §1.3)', () => {
    const rows = [
      { points: 30, created_at: daysAgo(28) },
      { points: 20, created_at: daysAgo(12) },
      { points: -10, created_at: daysAgo(3) },
    ];
    for (const k of [0, 1, 2, 5, 18, 40]) {
      const cutoff = new Date(NOW.getTime() + k * DAY - EXPIRY * DAY);
      expect(expiringWithin(rows, NOW, EXPIRY, k)).toBe(pointsToExpire(rows, cutoff));
    }
    expect(expiringWithin(rows, NOW, EXPIRY, 0)).toBe(pointsToExpire(rows, expiryCutoff(NOW, EXPIRY)!));
  });

  it('a redemption eats the oldest credits first, so it shrinks what is expiring', () => {
    const rows = [
      { points: 40, created_at: daysAgo(27) }, // expiring
      { points: 30, created_at: daysAgo(5) },
      { points: -25, created_at: daysAgo(1) }, // FIFO: consumes 25 of the oldest 40
    ];
    expect(expiringWithin(rows, NOW, EXPIRY, 5)).toBe(15);
  });

  it('a redemption larger than the expiring credit leaves nothing to warn about', () => {
    const rows = [
      { points: 40, created_at: daysAgo(27) },
      { points: 30, created_at: daysAgo(5) },
      { points: -45, created_at: daysAgo(1) },
    ];
    expect(expiringWithin(rows, NOW, EXPIRY, 5)).toBe(0);
  });

  it("prior 'expire' rows count as spent, so already written-off points are not re-announced", () => {
    const rows = [
      { points: 40, created_at: daysAgo(45) },
      { points: -40, created_at: daysAgo(15) }, // an 'expire' row
      { points: 20, created_at: daysAgo(27) },
    ];
    expect(expiringWithin(rows, NOW, EXPIRY, 5)).toBe(20);
  });

  it('includes credits already past their expiry that the expire job has not written off yet', () => {
    expect(expiringWithin([{ points: 40, created_at: daysAgo(40) }], NOW, EXPIRY, 5)).toBe(40);
  });

  it('is 0 when points never expire', () => {
    const rows = [{ points: 40, created_at: daysAgo(400) }];
    expect(expiringWithin(rows, NOW, 0, 5)).toBe(0);
    expect(expiringWithin(rows, NOW, -1, 5)).toBe(0);
  });

  it('a negative or non-finite horizon is 0', () => {
    const rows = [{ points: 40, created_at: daysAgo(400) }];
    expect(expiringWithin(rows, NOW, EXPIRY, -1)).toBe(0);
    expect(expiringWithin(rows, NOW, EXPIRY, Number.NaN)).toBe(0);
  });

  it('never exceeds the balance', () => {
    const rows = [
      { points: 100, created_at: daysAgo(40) },
      { points: -80, created_at: daysAgo(2) },
    ];
    expect(expiringWithin(rows, NOW, EXPIRY, 5)).toBeLessThanOrEqual(pointsBalance(rows));
  });
});

describe('expiryDateFor', () => {
  it('is the oldest credit + expiry days', () => {
    const rows = [
      { points: 30, created_at: daysAgo(20) },
      { points: 40, created_at: daysAgo(27) },
    ];
    expect(expiryDateFor(rows, EXPIRY)?.toISOString()).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
  });

  it('skips a credit fully consumed by redemptions (FIFO) and lands on the next', () => {
    const rows = [
      { points: 40, created_at: daysAgo(27) },
      { points: 30, created_at: daysAgo(20) },
      { points: -40, created_at: daysAgo(1) }, // exactly the oldest credit
    ];
    expect(expiryDateFor(rows, EXPIRY)?.toISOString()).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
  });

  it('a partly consumed credit is still the next to expire', () => {
    const rows = [
      { points: 40, created_at: daysAgo(27) },
      { points: 30, created_at: daysAgo(20) },
      { points: -39, created_at: daysAgo(1) },
    ];
    expect(expiryDateFor(rows, EXPIRY)?.toISOString()).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
  });

  it('a redemption spanning several credits carries over', () => {
    const rows = [
      { points: 10, created_at: daysAgo(28) },
      { points: 10, created_at: daysAgo(25) },
      { points: 10, created_at: daysAgo(10) },
      { points: -25, created_at: daysAgo(1) }, // eats 10 + 10 + 5 of the third
    ];
    expect(expiryDateFor(rows, EXPIRY)?.toISOString()).toBe(new Date(NOW.getTime() + 20 * DAY).toISOString());
  });

  it('is null when everything has been spent or expired', () => {
    expect(expiryDateFor([{ points: 40, created_at: daysAgo(5) }, { points: -40, created_at: daysAgo(1) }], EXPIRY)).toBeNull();
    expect(expiryDateFor([], EXPIRY)).toBeNull();
  });

  it('is null when points never expire', () => {
    expect(expiryDateFor([{ points: 40, created_at: daysAgo(5) }], 0)).toBeNull();
  });

  it('does not depend on the order the rows arrive in', () => {
    const rows = [
      { points: -10, created_at: daysAgo(1) },
      { points: 30, created_at: daysAgo(20) },
      { points: 40, created_at: daysAgo(27) },
    ];
    expect(expiryDateFor(rows, EXPIRY)?.toISOString()).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
  });

  it('ignores a credit with an unparseable date', () => {
    const rows = [
      { points: 40, created_at: 'nope' },
      { points: 30, created_at: daysAgo(20) },
    ];
    expect(expiryDateFor(rows, EXPIRY)?.toISOString()).toBe(new Date(NOW.getTime() + 10 * DAY).toISOString());
  });
});

describe('pointsBalance', () => {
  it('is the ledger sum', () => {
    expect(pointsBalance([{ points: 40, created_at: daysAgo(3) }, { points: -15, created_at: daysAgo(1) }])).toBe(25);
  });

  it('is never below zero and is 0 for an empty ledger', () => {
    expect(pointsBalance([])).toBe(0);
    expect(pointsBalance([{ points: -5, created_at: daysAgo(1) }])).toBe(0);
  });
});
