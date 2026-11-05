import { describe, it, expect } from 'vitest';
import {
  countedClockInMs,
  rollUpDay,
  type DayEmployment,
  type DayRules,
  type DaySession,
} from '@/lib/attendance/day';

// The owner's rule: an early clock-in counts from the shift start. Before the
// 10:00 opening always counts from 10:00; up to 30 minutes before the 14:00 or
// 15:00 shift counts from that start; anything earlier counts from the punch.

const RULES: DayRules = {
  gracePeriodMin: 15,
  otThresholdMin: 0,
  autoBreakMin: 0,
  autoBreakAfterMin: 360,
  halfDayMinMinutes: 240,
  absentBelowMinutes: 120,
};

const DATE = '2026-10-15';
const DOW = 4; // Thursday

/** An IST wall-clock time on DATE (or the next day with `nextDay`), as ISO. */
function at(istHhMm: string, nextDay = false): string {
  const [h, m] = istHhMm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 15 + (nextDay ? 1 : 0), h, m) - 5.5 * 3_600_000).toISOString();
}

function counted(clockIn: string, ownShiftStart: string | null, clockOut: string | null = at('23:59')) {
  return new Date(countedClockInMs({ clockInAt: clockIn, clockOutAt: clockOut, ownShiftStart })).toISOString();
}

const MORNING: DayEmployment = { contractedHoursPerDay: 10, shiftStartTime: '10:00', shiftEndTime: '20:00', weeklyOffDow: null };
const TEN_HOUR_EVENING: DayEmployment = { contractedHoursPerDay: 10, shiftStartTime: '14:00', shiftEndTime: '00:00', weeklyOffDow: null };
const NINE_HOUR_EVENING: DayEmployment = { contractedHoursPerDay: 9, shiftStartTime: '15:00', shiftEndTime: '00:00', weeklyOffDow: 3 };

function session(over: Partial<DaySession> = {}): DaySession {
  return {
    id: 's1',
    clockInAt: at('15:00'),
    clockOutAt: at('00:00', true),
    status: 'closed',
    source: 'punch',
    approvedAt: null,
    flags: [],
    ...over,
  };
}

function roll(sessions: DaySession[], employment: DayEmployment) {
  return rollUpDay({ date: DATE, sessions, rules: RULES, employment, dayOfWeek: DOW });
}

describe('countedClockInMs — the owner examples', () => {
  it('9:58 for the morning shift counts from 10:00', () => {
    expect(counted(at('09:58'), '10:00')).toBe(at('10:00'));
  });

  it('1:58 pm for the 10-hour 2 pm shift counts from 2 pm', () => {
    expect(counted(at('13:58'), '14:00')).toBe(at('14:00'));
  });

  it('2:58 pm for the 9-hour 3 pm shift counts from 3 pm', () => {
    expect(counted(at('14:58'), '15:00')).toBe(at('15:00'));
  });
});

describe('countedClockInMs — the edges', () => {
  it('anything before 10:00 counts from 10:00, however early', () => {
    expect(counted(at('08:30'), '10:00')).toBe(at('10:00'));
  });

  it('rounds to the CAFÉ shift start, so a 3 pm staffer covering the morning counts from 10:00', () => {
    expect(counted(at('09:57'), '15:00')).toBe(at('10:00'));
  });

  it('rounds up to 30 minutes early, and no earlier', () => {
    expect(counted(at('14:30'), '15:00')).toBe(at('15:00'));
    expect(counted(at('13:29'), '15:00')).toBe(at('13:29'));
  });

  it('counts a genuinely early call-in from the punch (1:06 pm for a 3 pm shift)', () => {
    expect(counted(at('13:06'), '15:00')).toBe(at('13:06'));
  });

  it('leaves an on-time or later punch alone', () => {
    expect(counted(at('10:00'), '10:00')).toBe(at('10:00'));
    expect(counted(at('15:04'), '15:00')).toBe(at('15:04'));
    expect(counted(at('11:20'), '10:00')).toBe(at('11:20'));
  });

  it('does not push someone already LATE for their own shift on to the next start', () => {
    // A 2 pm staffer at 2:40 is marked late; rounding them to 3 pm would also
    // dock 20 minutes they did work.
    expect(counted(at('14:40'), '14:00')).toBe(at('14:40'));
  });

  it('never rounds past the clock-out', () => {
    expect(counted(at('09:00'), '10:00', at('09:45'))).toBe(at('09:00'));
  });
});

describe('rollUpDay — rounding feeds the hours that are paid', () => {
  it('counts a 9:58 → 20:00 morning shift as exactly 10 hours, no overtime', () => {
    const r = roll([session({ clockInAt: at('09:58'), clockOutAt: at('20:00') })], MORNING);
    expect(r.rawMinutes).toBe(602);
    expect(r.earlyMinutes).toBe(2);
    expect(r.workedMinutes).toBe(600);
    expect(r.otMinutes).toBe(0);
    expect(r.isLate).toBe(false);
  });

  it('counts a 1:58 pm → midnight 10-hour shift from 2 pm', () => {
    const r = roll([session({ clockInAt: at('13:58'), clockOutAt: at('00:00', true) })], TEN_HOUR_EVENING);
    expect(r.workedMinutes).toBe(600);
    expect(r.earlyMinutes).toBe(2);
  });

  it('counts a 2:58 pm → midnight 9-hour shift from 3 pm', () => {
    const r = roll([session({ clockInAt: at('14:58'), clockOutAt: at('00:00', true) })], NINE_HOUR_EVENING);
    expect(r.workedMinutes).toBe(540);
    expect(r.otMinutes).toBe(0);
  });

  it('rounds only the FIRST clock-in of the day, not the return from a break', () => {
    const r = roll(
      [
        session({ id: 'a', clockInAt: at('09:55'), clockOutAt: at('14:00') }),
        session({ id: 'b', clockInAt: at('14:50'), clockOutAt: at('20:00') }),
      ],
      MORNING,
    );
    // 10:00–14:00 (4h, rounded from 9:55) + 14:50–20:00 (5h10m, untouched).
    expect(r.workedMinutes).toBe(240 + 310);
    expect(r.earlyMinutes).toBe(5);
  });

  it('keeps the literal punch time for display and lateness', () => {
    const r = roll([session({ clockInAt: at('14:58') })], NINE_HOUR_EVENING);
    expect(r.firstIn).toBe(at('14:58'));
    expect(r.rawMinutes).toBe(542);
  });
});
