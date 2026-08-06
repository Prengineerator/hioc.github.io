import { describe, it, expect } from 'vitest';
import {
  leaveWeekFor,
  plannableWeek,
  isMonday,
  isRequestableDate,
  isWindowOpen,
  daysUntilDeadline,
} from '@/lib/leave/week';

// Reference calendar (2026):
//   Mon 2026-08-10 .. Sun 2026-08-16   ← the week under test
//   Its deadline is Sat 2026-08-08 23:59:59.999 IST = 18:29:59.999Z on the 8th.
const WEEK = '2026-08-10';

/** A UTC instant for a given IST wall-clock time. */
function ist(dateIso: string, hh = 12, mm = 0): Date {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - 5.5 * 3_600_000);
}

describe('isMonday', () => {
  it('recognises a Monday', () => {
    expect(isMonday('2026-08-10')).toBe(true);
  });

  it('rejects every other day', () => {
    expect(isMonday('2026-08-09')).toBe(false); // Sunday
    expect(isMonday('2026-08-11')).toBe(false); // Tuesday
    expect(isMonday('2026-08-15')).toBe(false); // Saturday
  });

  it('rejects malformed input', () => {
    expect(isMonday('nonsense')).toBe(false);
    expect(isMonday('2026-8-10')).toBe(false);
  });
});

describe('leaveWeekFor', () => {
  it('returns null unless given a Monday', () => {
    expect(leaveWeekFor('2026-08-11')).toBeNull();
    expect(leaveWeekFor('not-a-date')).toBeNull();
  });

  it('exposes exactly the five weekdays as requestable', () => {
    const w = leaveWeekFor(WEEK)!;
    expect(w.requestableDates).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
    ]);
  });

  it('never offers Saturday or Sunday — the cafe is busiest then', () => {
    const w = leaveWeekFor(WEEK)!;
    expect(w.requestableDates).not.toContain('2026-08-15'); // Sat
    expect(w.requestableDates).not.toContain('2026-08-16'); // Sun
    expect(isRequestableDate(w, '2026-08-15')).toBe(false);
    expect(isRequestableDate(w, '2026-08-16')).toBe(false);
  });

  it('ends the week on the Sunday', () => {
    expect(leaveWeekFor(WEEK)!.weekEnd).toBe('2026-08-16');
  });

  it('puts the deadline at the end of the preceding Saturday, IST', () => {
    const w = leaveWeekFor(WEEK)!;
    // Sat 2026-08-08 23:59:59.999 IST === 2026-08-08T18:29:59.999Z
    expect(w.deadline).toBe('2026-08-08T18:29:59.999Z');
  });

  it('computes the deadline correctly across a month boundary', () => {
    // Mon 2026-09-07 → deadline Sat 2026-09-05.
    const w = leaveWeekFor('2026-09-07')!;
    expect(w.deadline.slice(0, 10)).toBe('2026-09-05');
    // Mon 2026-06-01 → deadline Sat 2026-05-30, in the previous month.
    expect(leaveWeekFor('2026-06-01')!.deadline.slice(0, 10)).toBe('2026-05-30');
  });

  it('computes the deadline correctly across a year boundary', () => {
    // Mon 2027-01-04 → deadline Sat 2027-01-02.
    expect(leaveWeekFor('2027-01-04')!.deadline.slice(0, 10)).toBe('2027-01-02');
  });
});

describe('plannableWeek — which week am I planning today', () => {
  it('on Monday, plans the week starting next Monday', () => {
    expect(plannableWeek(ist('2026-08-03')).weekStart).toBe('2026-08-10');
  });

  it('on Wednesday, still plans the same coming week', () => {
    expect(plannableWeek(ist('2026-08-05')).weekStart).toBe('2026-08-10');
  });

  it('on Friday, still the same week', () => {
    expect(plannableWeek(ist('2026-08-07')).weekStart).toBe('2026-08-10');
  });

  it('on Saturday — deadline day — still that week', () => {
    expect(plannableWeek(ist('2026-08-08', 9)).weekStart).toBe('2026-08-10');
  });

  it('late on Saturday night, before the deadline, still that week', () => {
    expect(plannableWeek(ist('2026-08-08', 23, 30)).weekStart).toBe('2026-08-10');
  });

  it('on SUNDAY jumps a week, because the coming Monday is already locked', () => {
    // Showing a locked week with no way to act reads as a broken screen.
    expect(plannableWeek(ist('2026-08-09')).weekStart).toBe('2026-08-17');
  });

  it('always returns a Monday', () => {
    for (const d of ['2026-08-03', '2026-08-05', '2026-08-08', '2026-08-09', '2026-12-31']) {
      expect(isMonday(plannableWeek(ist(d)).weekStart)).toBe(true);
    }
  });

  it('the returned week is always still open', () => {
    for (const d of ['2026-08-03', '2026-08-08', '2026-08-09']) {
      const w = plannableWeek(ist(d));
      expect(isWindowOpen(w, ist(d))).toBe(true);
    }
  });
});

describe('isWindowOpen', () => {
  const week = leaveWeekFor(WEEK)!;

  it('is open the week before', () => {
    expect(isWindowOpen(week, ist('2026-08-05'))).toBe(true);
  });

  it('is open right up to the last moment of Saturday', () => {
    expect(isWindowOpen(week, new Date('2026-08-08T18:29:59.000Z'))).toBe(true);
  });

  it('is closed one millisecond after', () => {
    expect(isWindowOpen(week, new Date('2026-08-08T18:30:00.000Z'))).toBe(false);
  });

  it('is closed on the Sunday before the week starts', () => {
    expect(isWindowOpen(week, ist('2026-08-09'))).toBe(false);
  });

  it('is closed once the week itself has begun', () => {
    expect(isWindowOpen(week, ist('2026-08-10'))).toBe(false);
  });
});

describe('daysUntilDeadline', () => {
  const week = leaveWeekFor(WEEK)!;

  it('counts down to the Saturday', () => {
    expect(daysUntilDeadline(week, ist('2026-08-03'))).toBe(5); // Monday
    expect(daysUntilDeadline(week, ist('2026-08-07'))).toBe(1); // Friday
  });

  it('is zero on the deadline day itself', () => {
    expect(daysUntilDeadline(week, ist('2026-08-08'))).toBe(0);
  });

  it('goes negative once the deadline has passed', () => {
    expect(daysUntilDeadline(week, ist('2026-08-09'))).toBe(-1);
  });

  it('is unaffected by the time of day', () => {
    expect(daysUntilDeadline(week, ist('2026-08-07', 0, 5))).toBe(1);
    expect(daysUntilDeadline(week, ist('2026-08-07', 23, 55))).toBe(1);
  });
});
