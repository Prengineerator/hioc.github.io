import { describe, it, expect } from 'vitest';
import {
  istBusinessDate,
  istMinutesOfDay,
  parseTimeToMinutes,
  shiftCrossesMidnight,
  shiftEndInstant,
} from '@/lib/attendance/businessDate';

describe('istBusinessDate', () => {
  it('reads the IST date off a mid-afternoon UTC instant', () => {
    // 09:00 UTC = 14:30 IST on the same day.
    expect(istBusinessDate('2026-08-06T09:00:00Z')).toBe('2026-08-06');
  });

  it('rolls forward across the IST day boundary', () => {
    // 18:29 UTC = 23:59 IST, still the 6th. One minute later it is the 7th.
    expect(istBusinessDate('2026-08-06T18:29:00Z')).toBe('2026-08-06');
    expect(istBusinessDate('2026-08-06T18:30:00Z')).toBe('2026-08-07');
  });

  it('puts a late-evening shift on the day it started, not the next one', () => {
    // 20:00 IST on the 6th — the cafe is open until midnight, so this is the
    // 6th's shift even though it is 14:30 UTC.
    expect(istBusinessDate('2026-08-06T14:30:00Z')).toBe('2026-08-06');
  });

  it('agrees with the DB trigger arithmetic on a post-midnight IST instant', () => {
    // 00:30 IST on the 7th is 19:00 UTC on the 6th. The trigger computes
    // (clock_in_at + 5h30m)::date — the 7th. A shift that STARTS then belongs
    // to the 7th; a shift that started at 20:00 IST on the 6th and is still
    // running does not move, because business_date is set from clock_in_at.
    expect(istBusinessDate('2026-08-06T19:00:00Z')).toBe('2026-08-07');
  });

  it('handles a year boundary', () => {
    expect(istBusinessDate('2026-12-31T18:30:00Z')).toBe('2027-01-01');
    expect(istBusinessDate('2026-12-31T18:29:59Z')).toBe('2026-12-31');
  });

  it('handles a leap day', () => {
    expect(istBusinessDate('2028-02-29T06:00:00Z')).toBe('2028-02-29');
  });

  it('accepts a Date, a string, and an epoch number identically', () => {
    const iso = '2026-08-06T09:00:00Z';
    const ms = Date.parse(iso);
    expect(istBusinessDate(new Date(iso))).toBe('2026-08-06');
    expect(istBusinessDate(ms)).toBe('2026-08-06');
    expect(istBusinessDate(iso)).toBe('2026-08-06');
  });

  it('throws on an unparseable instant rather than returning a NaN date', () => {
    expect(() => istBusinessDate('not a date')).toThrow(TypeError);
  });
});

describe('istMinutesOfDay', () => {
  it('converts a UTC instant to IST minutes since midnight', () => {
    // 04:30 UTC = 10:00 IST = 600 minutes.
    expect(istMinutesOfDay('2026-08-06T04:30:00Z')).toBe(600);
  });

  it('wraps correctly just after IST midnight', () => {
    expect(istMinutesOfDay('2026-08-06T18:30:00Z')).toBe(0);
    expect(istMinutesOfDay('2026-08-06T18:45:00Z')).toBe(15);
  });
});

describe('parseTimeToMinutes', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(parseTimeToMinutes('10:00')).toBe(600);
    expect(parseTimeToMinutes('10:00:00')).toBe(600);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
    expect(parseTimeToMinutes('9:05')).toBe(545);
  });

  it('returns null for nonsense rather than a wrong number', () => {
    expect(parseTimeToMinutes('25:00')).toBeNull();
    expect(parseTimeToMinutes('10:60')).toBeNull();
    expect(parseTimeToMinutes('')).toBeNull();
    expect(parseTimeToMinutes('lunchtime')).toBeNull();
  });
});

describe('shiftCrossesMidnight', () => {
  it('is false for a normal day shift', () => {
    expect(shiftCrossesMidnight('10:00', '19:00')).toBe(false);
  });

  it('is true for a shift ending after midnight', () => {
    expect(shiftCrossesMidnight('16:00', '01:30')).toBe(true);
  });

  it('treats an equal start and end as crossing (a 24h shift, not a 0h one)', () => {
    expect(shiftCrossesMidnight('10:00', '10:00')).toBe(true);
  });
});

describe('shiftEndInstant', () => {
  it('resolves a same-day shift end', () => {
    // Clock in 10:05 IST on the 6th (04:35 UTC), shift ends 19:00 IST (13:30 UTC).
    const end = shiftEndInstant('2026-08-06T04:35:00Z', '10:00', '19:00');
    expect(end?.toISOString()).toBe('2026-08-06T13:30:00.000Z');
  });

  it('rolls an overnight shift end into the next day rather than computing a negative duration', () => {
    // Clock in 16:05 IST on the 6th (10:35 UTC); shift ends 01:30 IST on the
    // 7th, which is 20:00 UTC on the 6th. Resolving it against the clock-in's
    // own date would put the end nine hours BEFORE the start.
    const clockIn = new Date('2026-08-06T10:35:00Z');
    const end = shiftEndInstant(clockIn, '16:00', '01:30');
    expect(end?.toISOString()).toBe('2026-08-06T20:00:00.000Z');
    expect(end!.getTime()).toBeGreaterThan(clockIn.getTime());
  });

  it('handles a shift ending exactly at midnight IST', () => {
    const end = shiftEndInstant('2026-08-06T10:35:00Z', '16:00', '00:00');
    expect(end?.toISOString()).toBe('2026-08-06T18:30:00.000Z');
  });

  it('returns null on unparseable shift times instead of guessing', () => {
    expect(shiftEndInstant('2026-08-06T04:35:00Z', 'morning', '19:00')).toBeNull();
    expect(shiftEndInstant('2026-08-06T04:35:00Z', '10:00', '99:99')).toBeNull();
  });

  it('returns null on an invalid clock-in instant', () => {
    expect(shiftEndInstant('nonsense', '10:00', '19:00')).toBeNull();
  });
});
