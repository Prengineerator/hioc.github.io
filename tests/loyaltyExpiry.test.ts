import { describe, expect, it } from 'vitest';
import { expiryCutoff, pointsToExpire } from '@/lib/loyalty/expiry';

// Pure FIFO expiry rule: oldest credits are spent first, so a redemption eats
// old points before new ones, and prior 'expire' rows count as spent (which is
// what makes re-runs idempotent).

const NOW = new Date('2026-09-29T12:00:00Z');
const cutoff = expiryCutoff(NOW, 30)!;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('expiryCutoff', () => {
  it('is null when expiry is off (days <= 0)', () => {
    expect(expiryCutoff(NOW, 0)).toBeNull();
    expect(expiryCutoff(NOW, -5)).toBeNull();
  });

  it('is `days` before now otherwise', () => {
    expect(cutoff.toISOString()).toBe('2026-08-30T12:00:00.000Z');
  });
});

describe('pointsToExpire', () => {
  it('is 0 with no rows', () => {
    expect(pointsToExpire([], cutoff)).toBe(0);
  });

  it('is 0 when nothing is older than the cutoff', () => {
    expect(pointsToExpire([{ points: 50, created_at: daysAgo(5) }], cutoff)).toBe(0);
  });

  it('expires an old, fully unspent earn in full', () => {
    expect(pointsToExpire([{ points: 40, created_at: daysAgo(45) }], cutoff)).toBe(40);
  });

  it('a credit exactly at the cutoff is not yet expired', () => {
    expect(pointsToExpire([{ points: 40, created_at: cutoff.toISOString() }], cutoff)).toBe(0);
  });

  it('redemption consumes the oldest credits first (old 30, new 20, redeemed 25 → expire 5)', () => {
    const rows = [
      { points: 30, created_at: daysAgo(60) },
      { points: 20, created_at: daysAgo(3) },
      { points: -25, created_at: daysAgo(2) },
    ];
    expect(pointsToExpire(rows, cutoff)).toBe(5);
  });

  it('a redemption larger than the old credits leaves nothing to expire', () => {
    const rows = [
      { points: 30, created_at: daysAgo(60) },
      { points: 20, created_at: daysAgo(3) },
      { points: -35, created_at: daysAgo(2) },
    ];
    expect(pointsToExpire(rows, cutoff)).toBe(0);
  });

  it('prior expire rows count as spent, so a re-run returns 0', () => {
    const rows = [
      { points: 30, created_at: daysAgo(60) },
      { points: 20, created_at: daysAgo(3) },
      { points: -25, created_at: daysAgo(2) },
    ];
    const first = pointsToExpire(rows, cutoff);
    const rerun = pointsToExpire([...rows, { points: -first, created_at: NOW.toISOString() }], cutoff);
    expect(first).toBe(5);
    expect(rerun).toBe(0);
  });

  it('never exceeds the current balance', () => {
    const rows = [
      { points: 100, created_at: daysAgo(60) },
      { points: -90, created_at: daysAgo(1) },
    ];
    const balance = rows.reduce((sum, r) => sum + r.points, 0);
    expect(pointsToExpire(rows, cutoff)).toBe(10);
    expect(pointsToExpire(rows, cutoff)).toBeLessThanOrEqual(balance);
  });

  it('spends old credits first, so newer credits still cover a partial spend', () => {
    // 50 old + 10 new − 55 spent: the spend eats the old 50 and 5 of the new.
    const rows = [
      { points: 50, created_at: daysAgo(60) },
      { points: 10, created_at: daysAgo(2) },
      { points: -55, created_at: daysAgo(1) },
    ];
    expect(pointsToExpire(rows, cutoff)).toBe(0);
  });

  it('is never negative (over-spent ledger)', () => {
    const rows = [
      { points: 10, created_at: daysAgo(60) },
      { points: -30, created_at: daysAgo(1) },
    ];
    expect(pointsToExpire(rows, cutoff)).toBe(0);
  });

  it('a positive reverse/adjust counts as a credit at its own date', () => {
    const oldAdjust = [{ points: 15, created_at: daysAgo(90) }];
    const freshAdjust = [{ points: 15, created_at: daysAgo(1) }];
    expect(pointsToExpire(oldAdjust, cutoff)).toBe(15);
    expect(pointsToExpire(freshAdjust, cutoff)).toBe(0);
  });

  it('a negative reverse/adjust is a debit', () => {
    const rows = [
      { points: 40, created_at: daysAgo(60) },
      { points: -15, created_at: daysAgo(10) },
    ];
    expect(pointsToExpire(rows, cutoff)).toBe(25);
  });
});
