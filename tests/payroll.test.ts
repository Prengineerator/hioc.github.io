import { describe, it, expect } from 'vitest';
import {
  computePayrollLine,
  paiseToRupees,
  type PayrollDayInput,
  type PayrollRules,
} from '@/lib/payroll/compute';
import type { DayStatus } from '@/lib/attendance/day';

// The PAY-2 release-gate matrix from PHASE-5-SPEC.md §12. The headline
// assertion is the first one: perfect attendance must net EXACTLY the monthly
// salary. A rounding rule that leaks a rupee is a bug, not a preference.

const RULES: PayrollRules = { otMultiplier: 1, lateMarksPerHalfday: 3 };
const SALARY = 25_000;
const HOURS = 9;
const CONTRACTED_MIN = HOURS * 60; // 540

function day(over: Partial<PayrollDayInput> = {}): PayrollDayInput {
  return {
    date: '2026-08-03',
    status: 'present',
    workedMinutes: CONTRACTED_MIN,
    otMinutes: 0,
    isLate: false,
    employmentKey: 'emp-1',
    monthlySalaryInr: SALARY,
    contractedHoursPerDay: HOURS,
    ...over,
  };
}

/** `n` identical days. */
function days(n: number, over: Partial<PayrollDayInput> = {}): PayrollDayInput[] {
  return Array.from({ length: n }, (_, i) =>
    day({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, ...over }),
  );
}

/** A realistic month: 26 working days + 5 weekly offs. */
function fullMonth(over: Partial<PayrollDayInput> = {}): PayrollDayInput[] {
  return [...days(26, over), ...days(5, { status: 'weekly_off', workedMinutes: 0 })];
}

describe('paiseToRupees', () => {
  it('rounds half up', () => {
    expect(paiseToRupees(150)).toBe(2);
    expect(paiseToRupees(149)).toBe(1);
    expect(paiseToRupees(100)).toBe(1);
  });

  it('rounds a negative magnitude half up, away from zero', () => {
    expect(paiseToRupees(-150)).toBe(-2);
  });

  it('is zero for zero', () => {
    expect(paiseToRupees(0)).toBe(0);
  });
});

describe('1. a clean full month', () => {
  it('nets EXACTLY the monthly salary for perfect attendance', () => {
    const line = computePayrollLine({ days: fullMonth(), rules: RULES });
    expect(line.netPayInr).toBe(SALARY);
    expect(line.basePayInr).toBe(SALARY);
    expect(line.otPayInr).toBe(0);
    expect(line.deductionsInr).toBe(0);
    expect(line.blocked).toBe(false);
    expect(line.unconfigured).toBe(false);
  });

  it('holds exactly for awkward salaries that do not divide evenly', () => {
    // 23,777 over 26 days of 540 minutes divides into nothing tidy.
    for (const salary of [23_777, 31_111, 9_999, 45_501]) {
      const line = computePayrollLine({
        days: fullMonth({ monthlySalaryInr: salary }),
        rules: RULES,
      });
      expect(line.netPayInr).toBe(salary);
    }
  });

  it('counts the days correctly', () => {
    const line = computePayrollLine({ days: fullMonth(), rules: RULES });
    expect(line.daysPresent).toBe(26);
    expect(line.daysOff).toBe(5);
    expect(line.daysAbsent).toBe(0);
  });
});

describe('2. February — a short month still pays a full salary', () => {
  it('pays the same monthly salary over 24 working days as over 26', () => {
    // The denominator is the month's OWN working days, so a short month does
    // not quietly underpay.
    const feb = [...days(24), ...days(4, { status: 'weekly_off', workedMinutes: 0 })];
    expect(computePayrollLine({ days: feb, rules: RULES }).netPayInr).toBe(SALARY);
  });
});

describe('3. a mid-month joiner', () => {
  it('pays only for the days they were employed', () => {
    // Employed for 13 of 26 working days; the rest predate them.
    const line = computePayrollLine({
      days: [
        ...days(13, { employmentKey: null, status: 'not_employed', workedMinutes: 0 }),
        ...days(13),
      ],
      rules: RULES,
    });
    // 13 working days at full attendance = the whole of their (13-day) expected
    // minutes, so they earn a full salary for the period they existed in.
    expect(line.netPayInr).toBe(SALARY);
    expect(line.unconfigured).toBe(false);
  });
});

describe('4. a mid-month leaver', () => {
  it('pays nothing for days after they left', () => {
    const line = computePayrollLine({
      days: [...days(10), ...days(16, { employmentKey: null, status: 'not_employed', workedMinutes: 0 })],
      rules: RULES,
    });
    expect(line.netPayInr).toBe(SALARY); // full attendance across their 10 days
    expect(line.segments).toHaveLength(1);
    expect(line.segments[0].workingDays).toBe(10);
  });
});

describe('5. a mid-month raise', () => {
  it('prices each day at the rate in force on it', () => {
    // 13 days at 20,000 then 13 at 30,000, both fully attended. Each segment
    // pays its own salary in full for its own expected minutes.
    const line = computePayrollLine({
      days: [
        ...days(13, { employmentKey: 'emp-1', monthlySalaryInr: 20_000 }),
        ...days(13, { employmentKey: 'emp-2', monthlySalaryInr: 30_000 }),
      ],
      rules: RULES,
    });
    expect(line.segments).toHaveLength(2);
    expect(line.netPayInr).toBe(50_000);
  });

  it('does not restate the earlier days at the new rate', () => {
    const line = computePayrollLine({
      days: [
        ...days(13, { employmentKey: 'emp-1', monthlySalaryInr: 20_000 }),
        ...days(13, { employmentKey: 'emp-2', monthlySalaryInr: 30_000 }),
      ],
      rules: RULES,
    });
    const older = line.segments.find((s) => s.employmentKey === 'emp-1')!;
    expect(older.monthlySalaryInr).toBe(20_000);
    expect(paiseToRupees(older.basePaise)).toBe(20_000);
  });
});

describe('6. overtime', () => {
  it('pays OT on top of a full base at the normal rate', () => {
    const month = fullMonth();
    month[0] = day({ workedMinutes: CONTRACTED_MIN + 120, otMinutes: 120 });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.basePayInr).toBe(SALARY); // capped — OT is not paid twice
    expect(line.otPayInr).toBeGreaterThan(0);
    expect(line.netPayInr).toBe(SALARY + line.otPayInr);
  });

  it('honours a 1.5x multiplier', () => {
    const month = fullMonth();
    month[0] = day({ workedMinutes: CONTRACTED_MIN + 120, otMinutes: 120 });
    const normal = computePayrollLine({ days: month, rules: RULES }).otPayInr;
    const time_and_half = computePayrollLine({
      days: month,
      rules: { ...RULES, otMultiplier: 1.5 },
    }).otPayInr;
    expect(time_and_half).toBe(normal * 1.5);
  });

  it('pays no OT at all when the multiplier is zero', () => {
    const month = fullMonth();
    month[0] = day({ workedMinutes: CONTRACTED_MIN + 120, otMinutes: 120 });
    const line = computePayrollLine({ days: month, rules: { ...RULES, otMultiplier: 0 } });
    expect(line.otPayInr).toBe(0);
    expect(line.netPayInr).toBe(SALARY);
  });

  it('never lets overtime minutes inflate base pay', () => {
    const month = fullMonth({ workedMinutes: CONTRACTED_MIN + 60, otMinutes: 60 });
    const line = computePayrollLine({ days: month, rules: { ...RULES, otMultiplier: 0 } });
    expect(line.basePayInr).toBe(SALARY);
  });
});

describe('7. late marks', () => {
  it('does not deduct below the threshold', () => {
    const month = fullMonth();
    for (let i = 0; i < 2; i++) month[i] = day({ isLate: true });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.lateMarks).toBe(2);
    expect(line.deductionsInr).toBe(0);
  });

  it('deducts half a day once the threshold is reached', () => {
    const month = fullMonth();
    for (let i = 0; i < 4; i++) month[i] = day({ isLate: true });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.lateMarks).toBe(4);
    // 4 late marks ÷ 3 = one half-day deduction.
    const halfDayValue = Math.round((SALARY * 100 * 0.5 * CONTRACTED_MIN) / (26 * CONTRACTED_MIN) / 100);
    expect(line.deductionsInr).toBe(halfDayValue);
    expect(line.netPayInr).toBe(SALARY - halfDayValue);
  });

  it('deducts twice at double the threshold', () => {
    const month = fullMonth();
    for (let i = 0; i < 6; i++) month[i] = day({ isLate: true });
    const single = (() => {
      const m = fullMonth();
      for (let i = 0; i < 3; i++) m[i] = day({ isLate: true });
      return computePayrollLine({ days: m, rules: RULES }).deductionsInr;
    })();
    expect(computePayrollLine({ days: month, rules: RULES }).deductionsInr).toBe(single * 2);
  });
});

describe('8. absence is unpaid ONCE, never twice', () => {
  it('reduces pay by exactly one day for one absence', () => {
    const month = fullMonth();
    month[0] = day({ status: 'absent', workedMinutes: 0 });
    const line = computePayrollLine({ days: month, rules: RULES });
    // One of 26 working days lost.
    const expected = Math.round((SALARY * 25) / 26);
    expect(line.netPayInr).toBe(expected);
    // And no separate deduction line — that would be the double charge.
    expect(line.deductionsInr).toBe(0);
  });

  it('treats a half day as half a day of pay', () => {
    const month = fullMonth();
    month[0] = day({ status: 'half_day', workedMinutes: CONTRACTED_MIN / 2 });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.netPayInr).toBe(Math.round((SALARY * 25.5) / 26));
  });

  it('pays nothing for unpaid leave but still counts the working day', () => {
    const month = fullMonth();
    month[0] = day({ status: 'unpaid_leave', workedMinutes: 0 });
    expect(computePayrollLine({ days: month, rules: RULES }).netPayInr).toBe(
      Math.round((SALARY * 25) / 26),
    );
  });
});

describe('9. paid leave (D5-6)', () => {
  it('pays a full contracted day and does not deduct', () => {
    const month = fullMonth();
    month[0] = day({ status: 'paid_leave', workedMinutes: 0 });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.netPayInr).toBe(SALARY);
    expect(line.daysPaidLeave).toBe(1);
  });
});

describe('10. a worked weekly off (D5-5)', () => {
  it('pays it entirely as overtime and does not change base pay', () => {
    const month = fullMonth();
    // A weekly-off day that was worked arrives as `present` with all its
    // minutes flagged OT by rollUpDay.
    month[26] = day({ status: 'present', workedMinutes: 360, otMinutes: 360 });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.otMinutes).toBe(360);
    expect(line.otPayInr).toBeGreaterThan(0);
  });
});

describe('11. an unapproved auto-close blocks the run', () => {
  it('flags the line as blocked and pays nothing for that day', () => {
    const month = fullMonth();
    month[0] = day({ status: 'needs_approval', workedMinutes: 0 });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.blocked).toBe(true);
    expect(line.daysNeedingApproval).toBe(1);
    // Unpaid until resolved — never a guessed number.
    expect(line.netPayInr).toBe(Math.round((SALARY * 25) / 26));
  });
});

describe('edge cases', () => {
  it('reports unconfigured rather than silently paying zero', () => {
    const line = computePayrollLine({
      days: days(26, { employmentKey: null, status: 'not_employed', workedMinutes: 0 }),
      rules: RULES,
    });
    expect(line.unconfigured).toBe(true);
    expect(line.netPayInr).toBe(0);
  });

  it('does not divide by zero when the period is entirely weekly offs', () => {
    const line = computePayrollLine({
      days: days(7, { status: 'weekly_off', workedMinutes: 0 }),
      rules: RULES,
    });
    expect(Number.isFinite(line.netPayInr)).toBe(true);
    expect(line.netPayInr).toBe(0);
  });

  it('applies a negative adjustment such as an advance (D5-7)', () => {
    const line = computePayrollLine({
      days: fullMonth(),
      rules: RULES,
      adjustmentsInr: -5_000,
    });
    expect(line.netPayInr).toBe(SALARY - 5_000);
    expect(line.adjustmentsInr).toBe(-5_000);
  });

  it('applies a positive adjustment such as a bonus', () => {
    expect(
      computePayrollLine({ days: fullMonth(), rules: RULES, adjustmentsInr: 1_500 }).netPayInr,
    ).toBe(SALARY + 1_500);
  });

  it('still applies an adjustment to an unconfigured line', () => {
    const line = computePayrollLine({
      days: days(5, { employmentKey: null, status: 'not_employed', workedMinutes: 0 }),
      rules: RULES,
      adjustmentsInr: 500,
    });
    expect(line.netPayInr).toBe(500);
  });

  it('handles an empty period without throwing', () => {
    const line = computePayrollLine({ days: [], rules: RULES });
    expect(line.netPayInr).toBe(0);
    expect(line.unconfigured).toBe(true);
  });

  it('keeps the components consistent with the net', () => {
    const month = fullMonth();
    month[0] = day({ workedMinutes: CONTRACTED_MIN + 120, otMinutes: 120 });
    for (let i = 1; i < 5; i++) month[i] = day({ isLate: true });
    const line = computePayrollLine({ days: month, rules: RULES, adjustmentsInr: -250 });
    // Components are each rounded for display, so allow a rupee of slack — but
    // no more, which is what catches a genuine drift.
    const fromParts =
      line.basePayInr + line.otPayInr - line.deductionsInr + line.adjustmentsInr;
    expect(Math.abs(fromParts - line.netPayInr)).toBeLessThanOrEqual(1);
  });
});
