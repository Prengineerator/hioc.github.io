import { describe, expect, it } from 'vitest';
import {
  BUSINESS_DAY_3AM_FROM,
  addBusinessDays,
  businessDateDaysAgo,
  businessDateOf,
  businessDayRange,
  businessRangeBounds,
  businessToday,
  endOfBusinessDayIso,
  startOfBusinessDayIso,
} from '@/lib/businessDay';
import { istBusinessDate } from '@/lib/cash/date';
import { cashDayEndsAt } from '@/lib/cash/autoEnd';

// The café's business day (lib/businessDay.ts): 3:00 am to 3:00 am IST from
// 29 Oct 2026 on, midnight to midnight before — so nothing already reported
// moves. IST = UTC+5:30, so 3:00 am IST is 21:30 UTC the day before.

/** An IST wall-clock time as a UTC instant. */
const ist = (local: string) => new Date(`${local}+05:30`);

describe('businessDateOf', () => {
  it('keeps the small hours on the evening before, until 3 am', () => {
    expect(businessDateOf(ist('2026-11-05T23:50:00'))).toBe('2026-11-05');
    expect(businessDateOf(ist('2026-11-06T00:00:00'))).toBe('2026-11-05');
    expect(businessDateOf(ist('2026-11-06T00:40:00'))).toBe('2026-11-05');
    expect(businessDateOf(ist('2026-11-06T02:59:59.999'))).toBe('2026-11-05');
    expect(businessDateOf(ist('2026-11-06T03:00:00'))).toBe('2026-11-06');
    expect(businessDateOf(ist('2026-11-06T10:00:00'))).toBe('2026-11-06');
  });

  it('takes an ISO string, a Date or epoch ms', () => {
    const t = ist('2026-11-06T00:40:00');
    expect(businessDateOf(t.toISOString())).toBe('2026-11-05');
    expect(businessDateOf(t.getTime())).toBe('2026-11-05');
  });

  it('leaves the days before the change on their calendar date', () => {
    expect(businessDateOf(ist('2026-10-28T00:40:00'))).toBe('2026-10-28');
    expect(businessDateOf(ist('2026-10-27T23:59:00'))).toBe('2026-10-27');
    expect(businessDateOf(ist('2026-09-29T01:15:00'))).toBe('2026-09-29');
  });

  it('starts with the night of the 29th: its first day runs from midnight to 3 am on the 30th', () => {
    expect(BUSINESS_DAY_3AM_FROM).toBe('2026-10-29');
    expect(businessDateOf(ist('2026-10-28T23:59:59'))).toBe('2026-10-28');
    expect(businessDateOf(ist('2026-10-29T00:30:00'))).toBe('2026-10-29');
    expect(businessDateOf(ist('2026-10-30T00:32:00'))).toBe('2026-10-29');
    expect(businessDateOf(ist('2026-10-30T03:00:00'))).toBe('2026-10-30');
  });
});

describe('business day bounds', () => {
  it('runs 3 am to 3 am IST', () => {
    expect(businessDayRange('2026-11-05')).toEqual({
      startIso: '2026-11-04T21:30:00.000Z',
      endIso: '2026-11-05T21:30:00.000Z',
    });
    expect(businessRangeBounds('2026-11-01', '2026-11-07')).toEqual({
      startIso: '2026-10-31T21:30:00.000Z',
      endIso: '2026-11-07T21:30:00.000Z',
    });
  });

  it('keeps midnight bounds before the change, and the first 3 am day 27 hours long', () => {
    expect(businessDayRange('2026-10-28')).toEqual({
      startIso: '2026-10-27T18:30:00.000Z',
      endIso: '2026-10-28T18:30:00.000Z',
    });
    expect(businessDayRange('2026-10-29')).toEqual({
      startIso: '2026-10-28T18:30:00.000Z',
      endIso: '2026-10-29T21:30:00.000Z',
    });
    expect(businessDayRange('2026-10-30').startIso).toBe('2026-10-29T21:30:00.000Z');
  });

  it('agrees with businessDateOf at every quarter hour across the change, with no gap or overlap', () => {
    const start = ist('2026-10-26T00:00:00').getTime();
    const end = ist('2026-11-03T00:00:00').getTime();
    for (let t = start; t < end; t += 15 * 60 * 1000) {
      const date = businessDateOf(t);
      const { startIso, endIso } = businessDayRange(date);
      expect(t >= Date.parse(startIso) && t < Date.parse(endIso)).toBe(true);
    }
    for (let d = '2026-10-25'; d < '2026-11-03'; d = addBusinessDays(d, 1)) {
      expect(businessDayRange(d).endIso).toBe(businessDayRange(addBusinessDays(d, 1)).startIso);
    }
  });
});

describe('today', () => {
  const now = ist('2026-11-06T00:40:00'); // 12:40 am on the 6th

  it('is still yesterday until 3 am', () => {
    expect(businessToday(now)).toBe('2026-11-05');
    expect(businessDateDaysAgo(0, now)).toBe('2026-11-05');
    expect(businessDateDaysAgo(1, now)).toBe('2026-11-04');
    expect(businessDateDaysAgo(7, now)).toBe('2026-10-29');
  });

  it('started at 3 am and ends at the next 3 am', () => {
    expect(startOfBusinessDayIso(now)).toBe('2026-11-04T21:30:00.000Z');
    expect(endOfBusinessDayIso(now)).toBe('2026-11-05T21:30:00.000Z');
    // At 10 pm "until end of day" means 3 am, not midnight.
    expect(endOfBusinessDayIso(ist('2026-11-05T22:00:00'))).toBe('2026-11-05T21:30:00.000Z');
  });
});

describe('the cash day follows the same day', () => {
  it('dates a day opened after midnight on the evening before; it ends at the 3 am that follows', () => {
    const openedAt = ist('2026-11-06T01:10:00').getTime();
    expect(istBusinessDate(openedAt)).toBe('2026-11-05');
    expect(cashDayEndsAt(istBusinessDate(openedAt))).toBe('2026-11-05T21:30:00.000Z');
    expect(cashDayEndsAt('2026-11-05')).toBe(businessDayRange('2026-11-05').endIso);
  });
});
