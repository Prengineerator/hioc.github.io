// PAY-2 — the salary engine.
//
// Pure. Takes days + rules + employment and returns money. Reads nothing,
// calls nothing, so every rule below is provable in a test rather than
// arguable in a meeting — which matters because the output is what someone
// gets paid.
//
// THE MODEL (D5-2): a monthly salary plus a contracted day length. The month's
// expected minutes are `working days × contracted hours × 60`, and pay is that
// salary scaled by the fraction of those minutes actually worked. Time beyond
// the contracted day is overtime at its own multiplier.
//
// TWO THINGS THAT WOULD SILENTLY DOUBLE-CHARGE SOMEONE, avoided deliberately:
//
//   * There is NO separate deduction for absence. An absent day already
//     contributes zero paid minutes, so the salary it would have earned is
//     already gone. Deducting again on top would charge twice for one absence —
//     the single easiest bug to introduce here and the hardest to spot, because
//     the number still looks plausible.
//   * Minutes are capped at the contracted day BEFORE they reach base pay, so
//     an hour of overtime cannot be paid once as base and again as OT.
//
// MONEY: integer paise throughout, rounded exactly once, half-up, at net pay.
// The standing assertion is that perfect attendance nets EXACTLY the monthly
// salary — which is why base pay is computed as a RATIO of the salary rather
// than by materialising a per-minute rate and multiplying back up. A rate
// rounded to the paise and multiplied by ~13,000 minutes drifts by rupees.

import type { DayStatus } from '@/lib/attendance/day';

export interface PayrollRules {
  /** 0 = OT unpaid, 1 = normal rate, 1.5 = time and a half. */
  otMultiplier: number;
  /** This many late arrivals costs half a day's pay. */
  lateMarksPerHalfday: number;
}

export interface PayrollDayInput {
  date: string;
  status: DayStatus;
  /** Payable minutes — already zero for an unresolved day (PAY-1). */
  workedMinutes: number;
  otMinutes: number;
  isLate: boolean;
  /**
   * Identifies WHICH employment record priced this day. Days under different
   * records are costed separately, so a mid-month raise does not restate the
   * days before it. Null when nobody was employed on that date.
   */
  employmentKey: string | null;
  monthlySalaryInr: number;
  contractedHoursPerDay: number;
}

export interface PayrollSegmentBreakdown {
  employmentKey: string;
  monthlySalaryInr: number;
  contractedHoursPerDay: number;
  workingDays: number;
  expectedMinutes: number;
  paidMinutes: number;
  otMinutes: number;
  lateMarks: number;
  basePaise: number;
  otPaise: number;
  deductionPaise: number;
}

export interface PayrollLine {
  daysPresent: number;
  daysHalf: number;
  daysAbsent: number;
  daysOff: number;
  daysPaidLeave: number;
  daysNeedingApproval: number;
  workedMinutes: number;
  otMinutes: number;
  lateMarks: number;
  basePayInr: number;
  otPayInr: number;
  deductionsInr: number;
  adjustmentsInr: number;
  netPayInr: number;
  /** True when no employment record covered any day — report, never pay zero silently. */
  unconfigured: boolean;
  /** True while any day is unresolved; PAY-3 blocks finalizing on this. */
  blocked: boolean;
  segments: PayrollSegmentBreakdown[];
}

/** Round half-up to whole rupees. Applied exactly once, to net pay. */
export function paiseToRupees(paise: number): number {
  return Math.sign(paise) * Math.round(Math.abs(paise) / 100);
}

/** Statuses that consume one of the month's working days. */
function isWorkingDay(status: DayStatus): boolean {
  return status !== 'weekly_off' && status !== 'not_employed';
}

/**
 * Minutes this day contributes to base pay, capped at the contracted day.
 *
 * The cap is what keeps overtime out of base pay. Paid leave pays a full
 * contracted day (D5-6); unpaid leave and absence pay nothing, and an
 * unresolved day already arrived with zero.
 */
function payableMinutes(day: PayrollDayInput, contractedMinutes: number): number {
  if (day.status === 'paid_leave') return contractedMinutes;
  if (day.status === 'absent' || day.status === 'unpaid_leave') return 0;
  if (day.status === 'needs_approval' || day.status === 'not_employed') return 0;
  return Math.min(day.workedMinutes, contractedMinutes);
}

export function computePayrollLine(params: {
  days: PayrollDayInput[];
  rules: PayrollRules;
  /** Signed one-off correction in rupees (D5-7): advances, loans, fixes. */
  adjustmentsInr?: number;
}): PayrollLine {
  const { days, rules, adjustmentsInr = 0 } = params;

  const employed = days.filter((d) => d.employmentKey !== null);
  const blocked = days.some((d) => d.status === 'needs_approval');

  const counts = {
    daysPresent: days.filter((d) => d.status === 'present').length,
    daysHalf: days.filter((d) => d.status === 'half_day').length,
    daysAbsent: days.filter((d) => d.status === 'absent').length,
    daysOff: days.filter((d) => d.status === 'weekly_off').length,
    daysPaidLeave: days.filter((d) => d.status === 'paid_leave').length,
    daysNeedingApproval: days.filter((d) => d.status === 'needs_approval').length,
  };

  const totals = {
    workedMinutes: days.reduce((a, d) => a + d.workedMinutes, 0),
    otMinutes: days.reduce((a, d) => a + d.otMinutes, 0),
    lateMarks: days.filter((d) => d.isLate).length,
  };

  if (employed.length === 0) {
    return {
      ...counts,
      ...totals,
      basePayInr: 0,
      otPayInr: 0,
      deductionsInr: 0,
      adjustmentsInr,
      netPayInr: adjustmentsInr,
      unconfigured: true,
      blocked,
      segments: [],
    };
  }

  // Group by employment record so each day is priced at the rate in force on
  // it. One segment is the ordinary case; more than one means the salary or
  // shift changed mid-period.
  const byKey = new Map<string, PayrollDayInput[]>();
  for (const d of employed) {
    const list = byKey.get(d.employmentKey!) ?? [];
    list.push(d);
    byKey.set(d.employmentKey!, list);
  }

  const segments: PayrollSegmentBreakdown[] = [];
  let basePaise = 0;
  let otPaise = 0;
  let deductionPaise = 0;

  for (const [key, segDays] of byKey) {
    const salaryPaise = segDays[0].monthlySalaryInr * 100;
    const contractedMinutes = Math.round(segDays[0].contractedHoursPerDay * 60);

    const workingDays = segDays.filter((d) => isWorkingDay(d.status)).length;
    const expectedMinutes = workingDays * contractedMinutes;
    const paidMinutes = segDays
      .filter((d) => isWorkingDay(d.status))
      .reduce((a, d) => a + payableMinutes(d, contractedMinutes), 0);
    const segOtMinutes = segDays.reduce((a, d) => a + d.otMinutes, 0);
    const segLateMarks = segDays.filter((d) => d.isLate).length;

    // A period made entirely of weekly offs has no expected minutes. Guard the
    // division rather than emitting NaN money.
    const segBasePaise =
      expectedMinutes > 0 ? (salaryPaise * paidMinutes) / expectedMinutes : 0;

    // OT is priced from the same ratio, so it stays consistent with base pay
    // and needs no separately-rounded rate.
    const perMinutePaise = expectedMinutes > 0 ? salaryPaise / expectedMinutes : 0;
    const segOtPaise = segOtMinutes * perMinutePaise * rules.otMultiplier;

    // Late marks: every Nth one costs half a contracted day. This is the ONLY
    // deduction — absence is already unpaid by virtue of contributing no
    // minutes, and deducting for it again would charge twice.
    const halfDays =
      rules.lateMarksPerHalfday > 0 ? Math.floor(segLateMarks / rules.lateMarksPerHalfday) : 0;
    const segDeductionPaise = halfDays * 0.5 * contractedMinutes * perMinutePaise;

    basePaise += segBasePaise;
    otPaise += segOtPaise;
    deductionPaise += segDeductionPaise;

    segments.push({
      employmentKey: key,
      monthlySalaryInr: segDays[0].monthlySalaryInr,
      contractedHoursPerDay: segDays[0].contractedHoursPerDay,
      workingDays,
      expectedMinutes,
      paidMinutes,
      otMinutes: segOtMinutes,
      lateMarks: segLateMarks,
      basePaise: Math.round(segBasePaise),
      otPaise: Math.round(segOtPaise),
      deductionPaise: Math.round(segDeductionPaise),
    });
  }

  // Components are rounded for DISPLAY, but net pay is computed from the
  // unrounded paise so the components cannot drift a rupee away from the total.
  const netPaise = basePaise + otPaise - deductionPaise + adjustmentsInr * 100;

  return {
    ...counts,
    ...totals,
    basePayInr: paiseToRupees(basePaise),
    otPayInr: paiseToRupees(otPaise),
    deductionsInr: paiseToRupees(deductionPaise),
    adjustmentsInr,
    netPayInr: paiseToRupees(netPaise),
    unconfigured: false,
    blocked,
    segments,
  };
}
