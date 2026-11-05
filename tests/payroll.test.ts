import { describe, it, expect } from 'vitest';
import {
  computePayrollLine,
  daysInMonthOf,
  paiseToRupees,
  type PayrollDayInput,
  type PayrollRules,
} from '@/lib/payroll/compute';
import type { DayStatus } from '@/lib/attendance/day';

// The PAY-2 release-gate matrix from PHASE-5-SPEC.md §12. The headline
// assertion is the first one: perfect attendance must net EXACTLY the monthly
// salary. A rounding rule that leaks a rupee is a bug, not a preference.
//
// "Perfect attendance" means every day but the month's 4 paid leaves: expected
// hours are (days in month − 4) × contracted hours. The fixtures are dated in
// August 2026 (31 days), so the salary buys 27 days of 9 hours.

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

/** Days the salary buys in an August (31 days − 4 paid leaves). */
const PAYABLE_DAYS = 27;

/** A full month: 27 worked days + the 4 paid leaves (here, weekly offs). */
function fullMonth(over: Partial<PayrollDayInput> = {}): PayrollDayInput[] {
  return [...days(27, over), ...days(4, { status: 'weekly_off', workedMinutes: 0 })];
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
    // 23,777 over 27 days of 540 minutes divides into nothing tidy.
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
    expect(line.daysPresent).toBe(27);
    expect(line.daysOff).toBe(4);
    expect(line.daysAbsent).toBe(0);
  });
});

describe('2. February — a short month still pays a full salary', () => {
  it('pays the full salary for 24 days in a 28-day February', () => {
    // The divisor is the month's OWN length − 4, so a short month does not
    // quietly underpay.
    const feb = [
      ...days(24, { date: '2026-02-10' }),
      ...days(4, { date: '2026-02-11', status: 'weekly_off', workedMinutes: 0 }),
    ];
    const line = computePayrollLine({ days: feb, rules: RULES });
    expect(line.netPayInr).toBe(SALARY);
    expect(line.segments[0].payableDays).toBe(24);
  });

  it('divides a leap-year February by 25', () => {
    const feb = days(25, { date: '2028-02-10' });
    const line = computePayrollLine({ days: feb, rules: RULES });
    expect(line.segments[0].daysInMonth).toBe(29);
    expect(line.netPayInr).toBe(SALARY);
  });

  it('pays the same 24 days as 24/27 of a salary in a 31-day month', () => {
    expect(computePayrollLine({ days: days(24), rules: RULES }).netPayInr).toBe(
      Math.round((SALARY * 24) / PAYABLE_DAYS),
    );
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
    // Each day is still worth salary ÷ 27 — joining late does not make the
    // remaining days worth more.
    expect(line.netPayInr).toBe(Math.round((SALARY * 13) / PAYABLE_DAYS));
    expect(line.unconfigured).toBe(false);
  });
});

describe('4. a mid-month leaver', () => {
  it('pays nothing for days after they left', () => {
    const line = computePayrollLine({
      days: [...days(10), ...days(16, { employmentKey: null, status: 'not_employed', workedMinutes: 0 })],
      rules: RULES,
    });
    expect(line.netPayInr).toBe(Math.round((SALARY * 10) / PAYABLE_DAYS));
    expect(line.segments).toHaveLength(1);
    expect(line.segments[0].payableDays).toBe(PAYABLE_DAYS);
  });
});

describe('5. a mid-month raise', () => {
  it('prices each day at the rate in force on it', () => {
    // 13 days at 20,000 then 13 at 30,000, both fully attended. Each day is
    // worth its own record's salary ÷ 27.
    const line = computePayrollLine({
      days: [
        ...days(13, { employmentKey: 'emp-1', monthlySalaryInr: 20_000 }),
        ...days(13, { employmentKey: 'emp-2', monthlySalaryInr: 30_000 }),
      ],
      rules: RULES,
    });
    expect(line.segments).toHaveLength(2);
    expect(line.netPayInr).toBe(Math.round(((20_000 + 30_000) * 13) / PAYABLE_DAYS));
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
    expect(paiseToRupees(older.basePaise)).toBe(Math.round((20_000 * 13) / PAYABLE_DAYS));
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
    const halfDayValue = Math.round(
      (SALARY * 100 * 0.5 * CONTRACTED_MIN) / (PAYABLE_DAYS * CONTRACTED_MIN) / 100,
    );
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
    // One of the 27 paid days lost.
    const expected = Math.round((SALARY * 26) / PAYABLE_DAYS);
    expect(line.netPayInr).toBe(expected);
    // And no separate deduction line — that would be the double charge.
    expect(line.deductionsInr).toBe(0);
  });

  it('treats a half day as half a day of pay', () => {
    const month = fullMonth();
    month[0] = day({ status: 'half_day', workedMinutes: CONTRACTED_MIN / 2 });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.netPayInr).toBe(Math.round((SALARY * 26.5) / PAYABLE_DAYS));
  });

  it('pays nothing for unpaid leave but still counts the working day', () => {
    const month = fullMonth();
    month[0] = day({ status: 'unpaid_leave', workedMinutes: 0 });
    expect(computePayrollLine({ days: month, rules: RULES }).netPayInr).toBe(
      Math.round((SALARY * 26) / PAYABLE_DAYS),
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
    month[27] = day({ status: 'present', workedMinutes: 360, otMinutes: 360 });
    const line = computePayrollLine({ days: month, rules: RULES });
    expect(line.otMinutes).toBe(360);
    expect(line.basePayInr).toBe(SALARY);
    // Paid ONCE, as OT at the normal rate — not again as base.
    const otValue = Math.round((SALARY * 360) / (PAYABLE_DAYS * CONTRACTED_MIN));
    expect(line.otPayInr).toBe(otValue);
    expect(line.netPayInr).toBe(SALARY + otValue);
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
    expect(line.netPayInr).toBe(Math.round((SALARY * 26) / PAYABLE_DAYS));
  });
});

describe('12. cash shortage (approved, unconsumed) — CC-5', () => {
  it('defaults to zero shortage and no clamp when none is passed', () => {
    const line = computePayrollLine({ days: fullMonth(), rules: RULES });
    expect(line.cashShortageInr).toBe(0);
    expect(line.cashShortageClamped).toBe(false);
    expect(line.netPayInr).toBe(SALARY);
  });

  it('deducts an approved cash shortage from net pay', () => {
    const line = computePayrollLine({ days: fullMonth(), rules: RULES, cashShortageInr: 1_000 });
    expect(line.cashShortageInr).toBe(1_000);
    expect(line.netPayInr).toBe(SALARY - 1_000);
    expect(line.cashShortageClamped).toBe(false);
  });

  it('clamps net pay at zero and flags it when the shortage exceeds what is left to pay', () => {
    const line = computePayrollLine({
      days: fullMonth(),
      rules: RULES,
      cashShortageInr: SALARY + 5_000,
    });
    expect(line.netPayInr).toBe(0);
    expect(line.cashShortageClamped).toBe(true);
    // The full approved figure is still reported — the owner sees what was
    // actually owed, not a truncated number.
    expect(line.cashShortageInr).toBe(SALARY + 5_000);
  });

  it('does not flag a clamp when the shortage exactly consumes net pay', () => {
    const line = computePayrollLine({ days: fullMonth(), rules: RULES, cashShortageInr: SALARY });
    expect(line.netPayInr).toBe(0);
    expect(line.cashShortageClamped).toBe(false);
  });

  it('combines with a signed adjustment before clamping', () => {
    const line = computePayrollLine({
      days: fullMonth(),
      rules: RULES,
      adjustmentsInr: 1_000,
      cashShortageInr: 2_000,
    });
    expect(line.netPayInr).toBe(SALARY + 1_000 - 2_000);
  });

  it('still reports and applies a shortage on an unconfigured line rather than dropping it', () => {
    const line = computePayrollLine({
      days: days(5, { employmentKey: null, status: 'not_employed', workedMinutes: 0 }),
      rules: RULES,
      cashShortageInr: 300,
    });
    expect(line.unconfigured).toBe(true);
    expect(line.cashShortageInr).toBe(300);
    expect(line.netPayInr).toBe(0);
    expect(line.cashShortageClamped).toBe(true);
  });

  it('perfect attendance still nets EXACTLY the monthly salary when there is no shortage', () => {
    // The CC-5 release gate: adding cash-shortage support must not disturb
    // the standing invariant from test 1 above.
    const line = computePayrollLine({ days: fullMonth(), rules: RULES, cashShortageInr: 0 });
    expect(line.netPayInr).toBe(SALARY);
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

describe('13. 4 paid leaves a month: expected hours = (days in month − 4) × contracted hours', () => {
  it('works the owner example: ₹19,934, 9h day, 31-day month, 230 hours worked', () => {
    // 27 × 9 = 243 expected hours; 19,934 × 230 ÷ 243 = 18,867.57 → ₹18,868.
    const october = [
      ...days(25, { date: '2026-10-05', monthlySalaryInr: 19_934 }),
      day({ date: '2026-10-30', monthlySalaryInr: 19_934, workedMinutes: 5 * 60 }),
    ];
    const line = computePayrollLine({ days: october, rules: RULES });
    expect(line.segments[0].expectedMinutes).toBe(243 * 60);
    expect(line.segments[0].paidMinutes).toBe(230 * 60);
    expect(line.netPayInr).toBe(18_868);
  });

  it('pays every day worked beyond the 27 at the same rate', () => {
    const line = computePayrollLine({ days: days(31), rules: RULES });
    expect(line.netPayInr).toBe(Math.round((SALARY * 31) / PAYABLE_DAYS));
  });

  it('charges a 5th day off as one day', () => {
    const month = [...days(26), ...days(5, { status: 'weekly_off', workedMinutes: 0 })];
    expect(computePayrollLine({ days: month, rules: RULES }).netPayInr).toBe(
      Math.round((SALARY * 26) / PAYABLE_DAYS),
    );
  });

  it('prices a staffer with no weekly off exactly like one with a fixed off day', () => {
    // No roster: the 4 days not worked arrive as absences, not weekly offs.
    const noRoster = [...days(27), ...days(4, { status: 'absent', workedMinutes: 0 })];
    expect(computePayrollLine({ days: noRoster, rules: RULES }).netPayInr).toBe(SALARY);
  });

  it('divides a 30-day month by 26', () => {
    const line = computePayrollLine({ days: days(26, { date: '2026-11-10' }), rules: RULES });
    expect(line.segments[0].payableDays).toBe(26);
    expect(line.netPayInr).toBe(SALARY);
  });

  it('honours a different leave allowance', () => {
    const line = computePayrollLine({ days: days(31), rules: { ...RULES, paidLeavesPerMonth: 0 } });
    expect(line.segments[0].payableDays).toBe(31);
    expect(line.netPayInr).toBe(SALARY);
  });

  it('knows the length of every month', () => {
    expect(daysInMonthOf('2026-10-02')).toBe(31);
    expect(daysInMonthOf('2026-11-30')).toBe(30);
    expect(daysInMonthOf('2026-02-01')).toBe(28);
    expect(daysInMonthOf('2028-02-29')).toBe(29);
  });
});
