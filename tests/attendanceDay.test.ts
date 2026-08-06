import { describe, it, expect } from 'vitest';
import {
  rollUpDay,
  mergeIntervals,
  dayOfWeekFor,
  type DayRules,
  type DayEmployment,
  type DaySession,
} from '@/lib/attendance/day';

const RULES: DayRules = {
  gracePeriodMin: 15,
  otThresholdMin: 0,
  autoBreakMin: 0,
  autoBreakAfterMin: 360,
  halfDayMinMinutes: 240,
  absentBelowMinutes: 120,
};

const EMPLOYMENT: DayEmployment = {
  contractedHoursPerDay: 9,
  shiftStartTime: '10:00',
  shiftEndTime: '19:00',
  weeklyOffDow: 0, // Sunday
};

// 2026-08-06 is a Thursday (dow 4). IST 10:00 = 04:30 UTC.
const DATE = '2026-08-06';
const DOW = 4;

function at(istHhMm: string): string {
  const [h, m] = istHhMm.split(':').map(Number);
  return new Date(Date.UTC(2026, 7, 6, h, m) - 5.5 * 3_600_000).toISOString();
}

function session(over: Partial<DaySession> = {}): DaySession {
  return {
    id: 's1',
    clockInAt: at('10:00'),
    clockOutAt: at('19:00'),
    status: 'closed',
    source: 'punch',
    approvedAt: null,
    flags: [],
    ...over,
  };
}

function roll(sessions: DaySession[], over: Partial<Parameters<typeof rollUpDay>[0]> = {}) {
  return rollUpDay({
    date: DATE,
    sessions,
    rules: RULES,
    employment: EMPLOYMENT,
    dayOfWeek: DOW,
    ...over,
  });
}

describe('mergeIntervals', () => {
  it('leaves disjoint intervals alone', () => {
    const { merged, hadOverlap } = mergeIntervals([
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ]);
    expect(merged).toHaveLength(2);
    expect(hadOverlap).toBe(false);
  });

  it('merges overlapping intervals and reports the overlap', () => {
    const { merged, hadOverlap } = mergeIntervals([
      { start: 0, end: 20 },
      { start: 10, end: 30 },
    ]);
    expect(merged).toEqual([{ start: 0, end: 30 }]);
    expect(hadOverlap).toBe(true);
  });

  it('joins touching intervals without calling it an overlap', () => {
    const { merged, hadOverlap } = mergeIntervals([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ]);
    expect(merged).toEqual([{ start: 0, end: 20 }]);
    expect(hadOverlap).toBe(false);
  });

  it('swallows an interval fully contained in another', () => {
    const { merged, hadOverlap } = mergeIntervals([
      { start: 0, end: 100 },
      { start: 20, end: 30 },
    ]);
    expect(merged).toEqual([{ start: 0, end: 100 }]);
    expect(hadOverlap).toBe(true);
  });

  it('handles unsorted input', () => {
    const { merged } = mergeIntervals([
      { start: 50, end: 60 },
      { start: 0, end: 10 },
    ]);
    expect(merged[0].start).toBe(0);
  });
});

describe('rollUpDay — the ordinary cases', () => {
  it('counts a clean full shift as present', () => {
    const d = roll([session()]);
    expect(d.status).toBe('present');
    expect(d.workedMinutes).toBe(540);
    expect(d.otMinutes).toBe(0);
    expect(d.isLate).toBe(false);
    expect(d.needsApproval).toBe(false);
  });

  it('sums two sessions across a punched-out break', () => {
    const d = roll([
      session({ id: 'a', clockInAt: at('10:00'), clockOutAt: at('14:00') }),
      session({ id: 'b', clockInAt: at('15:00'), clockOutAt: at('20:00') }),
    ]);
    expect(d.workedMinutes).toBe(240 + 300);
    expect(d.sessionCount).toBe(2);
  });

  it('classifies a short day as a half day', () => {
    const d = roll([session({ clockOutAt: at('13:00') })]); // 3h
    expect(d.status).toBe('half_day');
  });

  it('classifies a very short day as absent', () => {
    const d = roll([session({ clockOutAt: at('11:00') })]); // 1h
    expect(d.status).toBe('absent');
  });

  it('treats a day with no sessions as absent', () => {
    const d = roll([]);
    expect(d.status).toBe('absent');
    expect(d.workedMinutes).toBe(0);
  });

  it('reports not_employed rather than absent when nobody was employed that day', () => {
    // A month grid must show a blank before someone joined, not a wall of
    // absences that look like a disciplinary record.
    const d = roll([], { employment: null });
    expect(d.status).toBe('not_employed');
  });

  it('ignores voided sessions entirely', () => {
    const d = roll([session({ status: 'void' })]);
    expect(d.workedMinutes).toBe(0);
    expect(d.sessionCount).toBe(0);
  });
});

describe('rollUpDay — overlapping sessions are merged, never summed', () => {
  it('does not pay twice for the same minutes', () => {
    const d = roll([
      session({ id: 'a', clockInAt: at('10:00'), clockOutAt: at('14:00') }),
      session({ id: 'b', clockInAt: at('13:00'), clockOutAt: at('15:00') }),
    ]);
    // 10:00–15:00 is five hours of wall clock, not six.
    expect(d.workedMinutes).toBe(300);
    expect(d.flags).toContain('overlapping_sessions');
  });
});

describe('rollUpDay — the auto-break', () => {
  const withBreak: DayRules = { ...RULES, autoBreakMin: 30, autoBreakAfterMin: 360 };

  it('deducts an unpaid break from a long single-session day', () => {
    const d = roll([session()], { rules: withBreak }); // 9h, one session
    expect(d.rawMinutes).toBe(540);
    expect(d.autoBreakMinutes).toBe(30);
    expect(d.workedMinutes).toBe(510);
  });

  it('does not deduct from a short day', () => {
    const d = roll([session({ clockOutAt: at('14:00') })], { rules: withBreak }); // 4h
    expect(d.autoBreakMinutes).toBe(0);
  });

  it('does NOT deduct when the staffer punched out for their break', () => {
    // The whole point: they already lost that time by punching out. Deducting
    // a notional break on top charges them for it twice.
    const d = roll(
      [
        session({ id: 'a', clockInAt: at('10:00'), clockOutAt: at('14:00') }),
        session({ id: 'b', clockInAt: at('14:30'), clockOutAt: at('19:00') }),
      ],
      { rules: withBreak },
    );
    expect(d.autoBreakMinutes).toBe(0);
    expect(d.workedMinutes).toBe(240 + 270);
  });

  it('never drives worked minutes negative', () => {
    const d = roll([session({ clockOutAt: at('10:10') })], {
      rules: { ...withBreak, autoBreakAfterMin: 5 },
    });
    expect(d.workedMinutes).toBeGreaterThanOrEqual(0);
  });
});

describe('rollUpDay — unresolved sessions contribute nothing', () => {
  it('marks a still-open session as needs_approval and pays zero', () => {
    const d = roll([session({ clockOutAt: null, status: 'open' })]);
    expect(d.status).toBe('needs_approval');
    expect(d.workedMinutes).toBe(0);
    expect(d.needsApproval).toBe(true);
  });

  it('marks an UNAPPROVED auto-close as needs_approval and pays zero', () => {
    // D5-4: payroll must never pay a guessed number.
    const d = roll([session({ status: 'auto_closed', approvedAt: null })]);
    expect(d.status).toBe('needs_approval');
    expect(d.workedMinutes).toBe(0);
  });

  it('counts an APPROVED auto-close normally', () => {
    const d = roll([session({ status: 'auto_closed', approvedAt: at('20:00') })]);
    expect(d.status).toBe('present');
    expect(d.workedMinutes).toBe(540);
  });

  it('zeroes the WHOLE day when one of several sessions is unresolved', () => {
    // A day is approved or it is not; paying the "good half" of a day whose
    // other half is a guess is still paying a guess.
    const d = roll([
      session({ id: 'a', clockInAt: at('10:00'), clockOutAt: at('14:00') }),
      session({ id: 'b', clockInAt: at('15:00'), clockOutAt: null, status: 'open' }),
    ]);
    expect(d.status).toBe('needs_approval');
    expect(d.workedMinutes).toBe(0);
    // rawMinutes survives so the approval queue can show what the day would be
    // worth if approved — zeroing that too would make the queue useless.
    expect(d.rawMinutes).toBe(240);
  });

  it('zeroes overtime on an unresolved day too', () => {
    const d = roll([
      session({ id: 'a', clockInAt: at('08:00'), clockOutAt: at('21:00') }),
      session({ id: 'b', clockInAt: at('21:30'), clockOutAt: null, status: 'open' }),
    ]);
    expect(d.otMinutes).toBe(0);
  });
});

describe('rollUpDay — lateness', () => {
  it('is not late inside the grace period', () => {
    const d = roll([session({ clockInAt: at('10:14') })]);
    expect(d.isLate).toBe(false);
    expect(d.lateMinutes).toBe(0);
  });

  it('counts lateness only beyond the grace period', () => {
    const d = roll([session({ clockInAt: at('10:45') })]);
    expect(d.isLate).toBe(true);
    expect(d.lateMinutes).toBe(30); // 45 late − 15 grace
  });

  it('is not late when early', () => {
    const d = roll([session({ clockInAt: at('09:30') })]);
    expect(d.isLate).toBe(false);
  });

  it('does not call a post-midnight arrival on an overnight shift 21 hours late', () => {
    // Shift starts 22:00; arriving 00:30 is half an hour late in reality, but
    // raw subtraction would read it as arriving 21.5 hours after the start.
    const d = roll([session({ clockInAt: at('00:30'), clockOutAt: at('06:00') })], {
      employment: { ...EMPLOYMENT, shiftStartTime: '22:00', shiftEndTime: '06:00' },
    });
    expect(d.lateMinutes).toBe(0);
  });
});

describe('rollUpDay — overtime and the weekly off', () => {
  it('counts minutes beyond the contracted day as overtime', () => {
    const d = roll([session({ clockOutAt: at('21:00') })]); // 11h against a 9h day
    expect(d.workedMinutes).toBe(660);
    expect(d.otMinutes).toBe(120);
  });

  it('honours an overtime threshold before OT starts accruing', () => {
    const d = roll([session({ clockOutAt: at('19:30') })], {
      rules: { ...RULES, otThresholdMin: 60 },
    });
    expect(d.otMinutes).toBe(0); // 30 min over, but the threshold is 60
  });

  it('reports an unworked weekly off as weekly_off, not absent', () => {
    const d = roll([], { dayOfWeek: 0 }); // Sunday
    expect(d.status).toBe('weekly_off');
  });

  it('treats every minute worked on a weekly off as overtime (D5-5)', () => {
    const d = roll([session({ clockInAt: at('10:00'), clockOutAt: at('16:00') })], {
      dayOfWeek: 0,
    });
    expect(d.status).toBe('present');
    expect(d.workedMinutes).toBe(360);
    expect(d.otMinutes).toBe(360);
  });

  it('has no weekly off when none is configured', () => {
    const d = roll([], { employment: { ...EMPLOYMENT, weeklyOffDow: null }, dayOfWeek: 0 });
    expect(d.status).toBe('absent');
  });
});

describe('rollUpDay — owner day marks (D5-6)', () => {
  it('reports a paid-leave day', () => {
    const d = roll([], { mark: 'paid_leave' });
    expect(d.status).toBe('paid_leave');
  });

  it('reports an unpaid-leave day distinctly from an unexplained absence', () => {
    const d = roll([], { mark: 'unpaid_leave' });
    expect(d.status).toBe('unpaid_leave');
  });

  it('lets an unresolved session outrank a day mark', () => {
    // If the numbers are not trustworthy, that is the more important fact.
    const d = roll([session({ status: 'open', clockOutAt: null })], { mark: 'paid_leave' });
    expect(d.status).toBe('needs_approval');
  });
});

describe('rollUpDay — malformed data', () => {
  it('ignores a session whose clock-out precedes its clock-in', () => {
    const d = roll([session({ clockInAt: at('19:00'), clockOutAt: at('10:00') })]);
    expect(d.workedMinutes).toBe(0);
  });

  it('ignores an unparseable timestamp rather than producing NaN minutes', () => {
    const d = roll([session({ clockInAt: 'nonsense', clockOutAt: at('19:00') })]);
    expect(Number.isFinite(d.workedMinutes)).toBe(true);
    expect(d.workedMinutes).toBe(0);
  });

  it('carries session flags through to the day', () => {
    const d = roll([session({ flags: ['low_confidence'] })]);
    expect(d.flags).toContain('low_confidence');
  });
});

describe('dayOfWeekFor', () => {
  it('maps a known date to the right weekday', () => {
    expect(dayOfWeekFor('2026-08-06')).toBe(4); // Thursday
    expect(dayOfWeekFor('2026-08-09')).toBe(0); // Sunday
  });
});

describe('rollUpDay — approved leave overrides the fixed rostered day (LEAVE)', () => {
  it('treats an approved leave day as the weekly off', () => {
    // Thursday is not the fixed weekly off (Sunday is), but the manager
    // approved it — so it must not read as an absence.
    const d = roll([], { scheduledOff: true });
    expect(d.status).toBe('weekly_off');
  });

  it('does NOT treat the fixed rostered day as off once a plan exists that excludes it', () => {
    // Sunday is the fixed weekly off, but this week's plan put the day
    // elsewhere. With scheduledOff supplied, the plan wins.
    const d = roll([], { dayOfWeek: 0, scheduledOff: false });
    expect(d.status).toBe('absent');
  });

  it('falls back to the fixed rostered day when no plan was supplied', () => {
    // Weeks predating the leave feature must keep computing as they always did.
    const d = roll([], { dayOfWeek: 0 });
    expect(d.status).toBe('weekly_off');
  });

  it('pays work on an approved leave day entirely as overtime (D5-5)', () => {
    const d = roll([session({ clockInAt: at('10:00'), clockOutAt: at('16:00') })], {
      scheduledOff: true,
    });
    expect(d.status).toBe('present');
    expect(d.otMinutes).toBe(360);
  });
});
