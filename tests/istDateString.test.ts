import { describe, expect, it } from 'vitest';
import { istDateString, startOfTodayIstIso } from '@/lib/api/date';

// The owner dashboard's "Today at a glance" looks up v_daily_sales by its IST
// sale_date. It used to use startOfTodayIstIso().slice(0, 10) — the UTC date
// of IST midnight, which is always the day before — so "Today" showed
// yesterday's sales.

const at = (iso: string) => Date.parse(iso);

describe('istDateString', () => {
  it('is the IST date just after IST midnight (still the previous UTC day)', () => {
    expect(istDateString(0, at('2026-09-28T19:00:00Z'))).toBe('2026-09-29'); // 00:30 IST
  });

  it('is the IST date late in the IST evening', () => {
    expect(istDateString(0, at('2026-09-29T18:00:00Z'))).toBe('2026-09-29'); // 23:30 IST
  });

  it('goes back whole IST days, across a month boundary', () => {
    expect(istDateString(7, at('2026-10-02T08:00:00Z'))).toBe('2026-09-25');
    expect(istDateString(1, at('2026-10-01T02:00:00Z'))).toBe('2026-09-30'); // 07:30 IST, 1 Oct
  });

  it('is a day ahead of the old key during IST daytime', () => {
    const now = at('2026-09-29T08:47:00Z'); // 14:17 IST
    const realNow = Date.now;
    Date.now = () => now;
    try {
      expect(startOfTodayIstIso().slice(0, 10)).toBe('2026-09-28'); // the old, wrong key
      expect(istDateString()).toBe('2026-09-29');
    } finally {
      Date.now = realNow;
    }
  });
});
