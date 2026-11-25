import { describe, expect, it } from 'vitest';
import { advancesInMonthInr, outstandingAdvanceInr } from '@/lib/payroll/advances';
import {
  computePayrollLine,
  type PayrollDayInput,
  type PayrollRules,
} from '@/lib/payroll/compute';

// docs/STAFF-ADVANCES-SPEC.md — the balance maths and the engine's advance step.

const RULES: PayrollRules = { otMultiplier: 1, lateMarksPerHalfday: 3 };

function day(date: string, over: Partial<PayrollDayInput> = {}, salary = 18_000): PayrollDayInput {
  return {
    date,
    status: 'present',
    workedMinutes: 540,
    otMinutes: 0,
    isLate: false,
    employmentKey: 'emp-1',
    monthlySalaryInr: salary,
    contractedHoursPerDay: 9,
    ...over,
  };
}

/** November 2026 (30 days → 26 payable): 26 worked days + 4 weekly offs earns the full salary. */
function novemberFull(salary = 18_000): PayrollDayInput[] {
  return Array.from({ length: 30 }, (_, i) => {
    const date = `2026-11-${String(i + 1).padStart(2, '0')}`;
    return i < 26 ? day(date, {}, salary) : day(date, { status: 'weekly_off', workedMinutes: 0 }, salary);
  });
}

describe('outstandingAdvanceInr', () => {
  const adv = (over = {}) => ({ user_id: 'u1', amount_inr: 3000, given_on: '2026-11-08', removed_at: null, ...over });

  it('is the sum of advances up to the end of the month', () => {
    const advances = [adv(), adv({ amount_inr: 2000, given_on: '2026-11-20' })];
    expect(outstandingAdvanceInr({ userId: 'u1', monthEnd: '2026-11-30', advances, taken: [] })).toBe(5000);
  });

  it('ignores an advance dated after the month', () => {
    const advances = [adv(), adv({ amount_inr: 900, given_on: '2026-12-01' })];
    expect(outstandingAdvanceInr({ userId: 'u1', monthEnd: '2026-11-30', advances, taken: [] })).toBe(3000);
  });

  it('ignores a removed advance', () => {
    const advances = [adv({ removed_at: '2026-11-09T00:00:00Z' })];
    expect(outstandingAdvanceInr({ userId: 'u1', monthEnd: '2026-11-30', advances, taken: [] })).toBe(0);
  });

  it('ignores other people', () => {
    expect(outstandingAdvanceInr({ userId: 'u2', monthEnd: '2026-11-30', advances: [adv()], taken: [] })).toBe(0);
  });

  it('subtracts what finalized runs already took', () => {
    const taken = [{ user_id: 'u1', advance_inr: 1200, run_status: 'finalized' }];
    expect(outstandingAdvanceInr({ userId: 'u1', monthEnd: '2026-11-30', advances: [adv()], taken })).toBe(1800);
  });

  it('does not count a reversed run, so the advance returns to the balance', () => {
    const taken = [{ user_id: 'u1', advance_inr: 3000, run_status: 'reversed' }];
    expect(outstandingAdvanceInr({ userId: 'u1', monthEnd: '2026-11-30', advances: [adv()], taken })).toBe(3000);
  });

  it('treats a missing advance_inr as zero', () => {
    const taken = [{ user_id: 'u1', advance_inr: undefined, run_status: 'finalized' }];
    expect(outstandingAdvanceInr({ userId: 'u1', monthEnd: '2026-11-30', advances: [adv()], taken })).toBe(3000);
  });

  it('never takes the same advance twice when months are finalized out of order', () => {
    // 12,000 given 16 Nov. December was finalized FIRST and took 3,000 of it.
    const advances = [adv({ amount_inr: 12_000, given_on: '2026-11-16' })];
    const taken = [{ user_id: 'u1', advance_inr: 3000, run_status: 'finalized' }];
    // November, finalized afterwards, sees only 9,000 left — not 12,000.
    expect(outstandingAdvanceInr({ userId: 'u1', monthEnd: '2026-11-30', advances, taken })).toBe(9000);
  });

  it('clamps at zero', () => {
    const taken = [{ user_id: 'u1', advance_inr: 5000, run_status: 'finalized' }];
    expect(outstandingAdvanceInr({ userId: 'u1', monthEnd: '2026-11-30', advances: [adv()], taken })).toBe(0);
  });
});

describe('advancesInMonthInr', () => {
  it('sums only live advances dated within the month', () => {
    const advances = [
      { user_id: 'u1', amount_inr: 1000, given_on: '2026-10-31' },
      { user_id: 'u1', amount_inr: 2000, given_on: '2026-11-01' },
      { user_id: 'u1', amount_inr: 500, given_on: '2026-11-30', removed_at: 'x' },
      { user_id: 'u1', amount_inr: 300, given_on: '2026-11-30' },
    ];
    expect(advancesInMonthInr('u1', { from: '2026-11-01', to: '2026-11-30' }, advances)).toBe(2300);
  });
});

describe('computePayrollLine — salary advance', () => {
  it('no advance leaves every number as before', () => {
    const l = computePayrollLine({ days: novemberFull(), rules: RULES });
    expect(l.netBeforeDeductionsInr).toBe(18_000);
    expect(l.netPayInr).toBe(18_000);
    expect(l.advanceOutstandingInr).toBe(0);
    expect(l.advanceInr).toBe(0);
    expect(l.advanceCarriedInr).toBe(0);
  });

  it('example 1: ₹18,000 earned − ₹3,000 − ₹2,000 → ₹13,000', () => {
    const l = computePayrollLine({ days: novemberFull(), rules: RULES, advanceOutstandingInr: 5000 });
    expect(l.advanceInr).toBe(5000);
    expect(l.advanceCarriedInr).toBe(0);
    expect(l.netPayInr).toBe(13_000);
  });

  it('example 2: ₹9,000 earned, ₹12,000 advance → net 0, ₹3,000 carries; next month 18,000 − 3,000 = 15,000', () => {
    // Joined 15 Nov: 12 payable days of 26 at 18,000 is not 9,000, so use 13 of 26 days.
    const half = Array.from({ length: 30 }, (_, i) => {
      const date = `2026-11-${String(i + 1).padStart(2, '0')}`;
      return i >= 17 && i < 30 ? day(date) : day(date, { employmentKey: null, status: 'not_employed', workedMinutes: 0 });
    });
    const nov = computePayrollLine({ days: half, rules: RULES, advanceOutstandingInr: 12_000 });
    expect(nov.netBeforeDeductionsInr).toBe(9000);
    expect(nov.advanceInr).toBe(9000);
    expect(nov.advanceCarriedInr).toBe(3000);
    expect(nov.netPayInr).toBe(0);

    // December: the balance helper gives 12,000 − 9,000 = 3,000.
    const outstanding = outstandingAdvanceInr({
      userId: 'u1',
      monthEnd: '2026-12-31',
      advances: [{ user_id: 'u1', amount_inr: 12_000, given_on: '2026-11-16' }],
      taken: [{ user_id: 'u1', advance_inr: nov.advanceInr, run_status: 'finalized' }],
    });
    expect(outstanding).toBe(3000);
    const dec = Array.from({ length: 31 }, (_, i) => {
      const date = `2026-12-${String(i + 1).padStart(2, '0')}`;
      return i < 27 ? day(date) : day(date, { status: 'weekly_off', workedMinutes: 0 });
    });
    const decLine = computePayrollLine({ days: dec, rules: RULES, advanceOutstandingInr: outstanding });
    expect(decLine.netBeforeDeductionsInr).toBe(18_000);
    expect(decLine.netPayInr).toBe(15_000);
  });

  it('example 3: ₹16,000 earned, ticked cash shortage ₹500, advance ₹4,000 → ₹11,500', () => {
    const l = computePayrollLine({
      days: novemberFull(16_000),
      rules: RULES,
      cashShortageInr: 500,
      apply: { cashShortage: true },
      advanceOutstandingInr: 4000,
    });
    expect(l.cashShortageInr).toBe(500);
    expect(l.advanceInr).toBe(4000);
    expect(l.netPayInr).toBe(11_500);
  });

  it('an unticked cash shortage is not deducted before the advance', () => {
    const l = computePayrollLine({
      days: novemberFull(16_000),
      rules: RULES,
      cashShortageInr: 500,
      advanceOutstandingInr: 4000,
    });
    expect(l.netPayInr).toBe(12_000);
  });

  it('takes the advance out of what the deductions left, and carries the rest', () => {
    const l = computePayrollLine({
      days: novemberFull(1000),
      rules: RULES,
      cashShortageInr: 400,
      apply: { cashShortage: true },
      advanceOutstandingInr: 2000,
    });
    expect(l.netPayInr).toBe(0);
    expect(l.advanceInr).toBe(600);
    expect(l.advanceCarriedInr).toBe(1400);
  });

  it('a deduction larger than the pay leaves nothing for the advance', () => {
    const l = computePayrollLine({
      days: novemberFull(1000),
      rules: RULES,
      cashShortageInr: 5000,
      apply: { cashShortage: true },
      advanceOutstandingInr: 700,
    });
    expect(l.deductionsClamped).toBe(true);
    expect(l.advanceInr).toBe(0);
    expect(l.advanceCarriedInr).toBe(700);
    expect(l.netPayInr).toBe(0);
  });

  it('example 4: an advance added after the month was finalized lands on the next month', () => {
    const outstandingForNov = outstandingAdvanceInr({
      userId: 'u1',
      monthEnd: '2026-11-30',
      advances: [{ user_id: 'u1', amount_inr: 1000, given_on: '2026-11-28' }],
      // November was finalized earlier with no advance.
      taken: [{ user_id: 'u1', advance_inr: 0, run_status: 'finalized' }],
    });
    // November's frozen line is untouched; December sees the 1,000 as carried.
    expect(outstandingForNov).toBe(1000);
    const dec = Array.from({ length: 31 }, (_, i) => {
      const date = `2026-12-${String(i + 1).padStart(2, '0')}`;
      return i < 27 ? day(date) : day(date, { status: 'weekly_off', workedMinutes: 0 });
    });
    const l = computePayrollLine({ days: dec, rules: RULES, advanceOutstandingInr: outstandingForNov });
    expect(l.netPayInr).toBe(17_000);
  });

  it('works for an unconfigured staffer with an adjustment only', () => {
    const l = computePayrollLine({ days: [day('2026-11-01', { employmentKey: null })], rules: RULES, adjustmentsInr: 500, advanceOutstandingInr: 800 });
    expect(l.unconfigured).toBe(true);
    expect(l.advanceInr).toBe(500);
    expect(l.advanceCarriedInr).toBe(300);
    expect(l.netPayInr).toBe(0);
  });
});

import { isAdvanceCounted } from '@/lib/payroll/advances';

describe('isAdvanceCounted (lock rule)', () => {
  const a = { user_id: 'u1', given_on: '2026-11-10', created_at: '2026-11-10T06:00:00Z' };
  const run = { user_id: 'u1', period_end: '2026-11-30', finalized_at: '2026-12-01T00:00:00Z' };

  it('is locked when created before the run was finalized and dated in the month', () => {
    expect(isAdvanceCounted(a, [run])).toBe(true);
  });
  it('is not locked when created after the finalize', () => {
    expect(isAdvanceCounted({ ...a, given_on: '2026-11-28', created_at: '2026-12-02T00:00:00Z' }, [run])).toBe(false);
  });
  it('is not locked when dated after the period end', () => {
    expect(isAdvanceCounted({ ...a, given_on: '2026-12-02' }, [run])).toBe(false);
  });
  it('is not locked with no finalized run (a reversed run is simply not passed)', () => {
    expect(isAdvanceCounted(a, [])).toBe(false);
  });
  it('ignores another person’s run', () => {
    expect(isAdvanceCounted(a, [{ ...run, user_id: 'u2' }])).toBe(false);
  });
});
