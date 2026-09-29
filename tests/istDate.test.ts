import { describe, expect, it } from 'vitest';
import { istDateDaysAgo, istDateIso } from '@/lib/api/date';

describe('istDateIso', () => {
  it('returns the IST calendar day, not the UTC one, just after IST midnight', () => {
    // 03:00 IST on 29 Sep is 21:30 UTC on 28 Sep — the old
    // startOfTodayIstIso().slice(0, 10) gave 2026-09-28 here.
    const d = new Date('2026-09-29T03:00:00+05:30');
    expect(d.toISOString().slice(0, 10)).toBe('2026-09-28');
    expect(istDateIso(d)).toBe('2026-09-29');
  });

  it('flips exactly at IST midnight (18:30 UTC)', () => {
    expect(istDateIso(new Date('2026-09-28T18:29:59Z'))).toBe('2026-09-28');
    expect(istDateIso(new Date('2026-09-28T18:30:00Z'))).toBe('2026-09-29');
  });

  it('matches the UTC date during the rest of the IST day', () => {
    expect(istDateIso(new Date('2026-09-29T14:00:00+05:30'))).toBe('2026-09-29');
    expect(istDateIso(new Date('2026-09-29T23:59:59+05:30'))).toBe('2026-09-29');
  });
});

describe('istDateDaysAgo', () => {
  const now = new Date('2026-09-29T03:00:00+05:30');
  it('0 is today, 7 is the same weekday last week', () => {
    expect(istDateDaysAgo(0, now)).toBe('2026-09-29');
    expect(istDateDaysAgo(7, now)).toBe('2026-09-22');
  });
  it('crosses month and year boundaries', () => {
    expect(istDateDaysAgo(30, now)).toBe('2026-08-30');
    expect(istDateDaysAgo(1, new Date('2026-01-01T00:10:00+05:30'))).toBe('2025-12-31');
  });
});
