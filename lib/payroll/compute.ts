// PAY-2 — the salary engine.
//
// Pure. Takes days + rules + employment and returns money. Reads nothing,
// calls nothing, so every rule below is provable in a test rather than
// arguable in a meeting — which matters because the output is what someone
// gets paid.
//
// THE MODEL (D5-2, as the owner runs it): every month carries a fixed allowance
// of paid leaves (4). The monthly salary buys `days in month − 4` days, each
// of the contracted length — so the month's expected hours are
// `(days in month − 4) × contracted hours`, and pay is the salary scaled by
// the hours actually worked against that:
//
//     expected hours = (days in month − 4) × contracted hours
//     pay            = salary × hours worked ÷ expected hours
//
// e.g. ₹19,934 on a 9-hour day in a 31-day month: 27 × 9 = 243 expected hours,
// so 230 hours worked pays 19,934 × 230 ÷ 243 = ₹18,868.
//
// The 4 leaves are not recorded or counted anywhere: they are already "paid"
// by the divisor. Work all but 4 days of the month and the result is EXACTLY
// the monthly salary; take a 5th day off and it costs one day; work through a
// leave day and it earns one more day at the same rate. That makes the
// divisor independent of the roster — a staffer with no weekly off and one
// off every Wednesday are priced identically, whether the month happens to
// have four Wednesdays or five.
//
// Time beyond the contracted day is overtime at its own multiplier, priced
// from the same per-minute rate.
//
// DEDUCTIONS ARE PROPOSALS. The late-mark half-days and an approved cash
// shortage are worked out and reported (proposedDeductions), but nothing comes
// off net pay unless the caller passes `apply` — the owner ticks each one per
// staffer before finalizing. Earnings are never touched by this.
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
// MONEY: integer paise throughout, rounded exactly once, half-up, at earnings
// (base + OT + adjustments); any chosen deductions are whole rupees off that.
// The standing assertion is that perfect attendance nets EXACTLY the monthly
// salary — which is why base pay is computed as a RATIO of the salary rather
// than by materialising a per-minute rate and multiplying back up. A rate
// rounded to the paise and multiplied by ~13,000 minutes drifts by rupees.

import type { DayStatus } from '@/lib/attendance/day';

/** Paid leaves built into every month: expected hours = (days in month − this) × contracted hours. */
export const DEFAULT_PAID_LEAVES_PER_MONTH = 4;

export interface PayrollRules {
  /** 0 = OT unpaid, 1 = normal rate, 1.5 = time and a half. */
  otMultiplier: number;
  /** This many late arrivals costs half a day's pay. */
  lateMarksPerHalfday: number;
  /**
   * Leaves the monthly salary already pays for. Expected hours are
   * `(days in month − paidLeavesPerMonth) × contracted hours`. Defaults to
   * DEFAULT_PAID_LEAVES_PER_MONTH.
   */
  paidLeavesPerMonth?: number;
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
  /** Calendar days in the month this segment falls in (28–31). */
  daysInMonth: number;
  /** Leaves the salary already covers that month. */
  paidLeaves: number;
  /** daysInMonth − paidLeaves. The salary buys this many contracted days. */
  payableDays: number;
  /** payableDays × contracted hours, in minutes — working this much earns exactly the salary. */
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
  /** The late-mark deduction ACTUALLY taken off net pay (0 unless chosen). */
  deductionsInr: number;
  adjustmentsInr: number;
  /**
   * CC-5: the approved cash-drawer shortage (docs/PHASE-5-CASH-COUNTS.md)
   * ACTUALLY taken off net pay, in whole rupees (0 unless chosen). Kept
   * separate from deductionsInr because that field is specifically lateness.
   */
  cashShortageInr: number;
  /**
   * What the rules WOULD deduct, whether or not the owner chose to. Nothing
   * is deducted on its own: these are shown, and the owner picks which ones
   * to take at finalize.
   */
  proposedDeductions: { lateInr: number; cashShortageInr: number };
  /** Which proposals were actually taken (only ever true when the amount is > 0). */
  appliedDeductions: { late: boolean; cashShortage: boolean };
  /** Base + OT + adjustments, before either deduction. */
  netBeforeDeductionsInr: number;
  /**
   * True when the chosen deductions were larger than what was left to pay, so
   * net pay was clamped at 0 rather than going negative. Carrying the
   * remainder into a future run is out of scope — this just flags it.
   */
  deductionsClamped: boolean;
  netPayInr: number;
  /** True when no employment record covered any day — report, never pay zero silently. */
  unconfigured: boolean;
  /** True while any day is unresolved; PAY-3 blocks finalizing on this. */
  blocked: boolean;
  segments: PayrollSegmentBreakdown[];
}

/** Which proposed deductions the owner has chosen to take. Both default to NO. */
export interface DeductionChoices {
  /** Take the late-mark deduction off net pay. */
  late?: boolean;
  /** Take the approved cash shortage off net pay. */
  cashShortage?: boolean;
}

/**
 * Take the CHOSEN whole-rupee deductions off net pay, clamping at 0. Shared by
 * the unconfigured and employed branches so the clamp rule cannot drift
 * between them.
 *
 * Works in whole rupees on purpose: the screen previews "net if I tick this"
 * as netBeforeDeductions − the ticked amounts, and that preview must be the
 * exact number finalize then freezes — not a rupee off from rounding.
 */
function settleDeductions(
  netBeforeDeductionsInr: number,
  proposed: { lateInr: number; cashShortageInr: number },
  choices: DeductionChoices,
): Pick<
  PayrollLine,
  'deductionsInr' | 'cashShortageInr' | 'appliedDeductions' | 'netPayInr' | 'deductionsClamped'
> {
  const late = Boolean(choices.late) && proposed.lateInr > 0;
  const cash = Boolean(choices.cashShortage) && proposed.cashShortageInr > 0;
  const deductionsInr = late ? proposed.lateInr : 0;
  const cashShortageInr = cash ? proposed.cashShortageInr : 0;
  const taken = deductionsInr + cashShortageInr;
  const raw = netBeforeDeductionsInr - taken;
  const deductionsClamped = taken > 0 && raw < 0;
  return {
    deductionsInr,
    cashShortageInr,
    appliedDeductions: { late, cashShortage: cash },
    netPayInr: deductionsClamped ? 0 : raw,
    deductionsClamped,
  };
}

/** Round half-up to whole rupees. */
export function paiseToRupees(paise: number): number {
  return Math.sign(paise) * Math.round(Math.abs(paise) / 100);
}

/** Calendar days in the month of an ISO date ('2026-10-02' → 31). */
export function daysInMonthOf(isoDate: string): number {
  const [y, m] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Minutes this day contributes to base pay, capped at the contracted day.
 *
 * Overtime minutes are taken out FIRST, then the cap applies — which is what
 * keeps overtime out of base pay. That matters most on a worked weekly off,
 * where rollUpDay marks every minute as OT (D5-5): those minutes are paid once,
 * as OT, and not a second time here. Paid leave pays a full contracted day
 * (D5-6); unpaid leave and absence pay nothing, and an unresolved day already
 * arrived with zero.
 */
function payableMinutes(day: PayrollDayInput, contractedMinutes: number): number {
  if (day.status === 'paid_leave') return contractedMinutes;
  if (day.status === 'absent' || day.status === 'unpaid_leave') return 0;
  if (day.status === 'needs_approval' || day.status === 'not_employed') return 0;
  if (day.status === 'weekly_off') return 0;
  return Math.min(Math.max(0, day.workedMinutes - day.otMinutes), contractedMinutes);
}

export function computePayrollLine(params: {
  days: PayrollDayInput[];
  rules: PayrollRules;
  /** Signed one-off correction in rupees (D5-7): advances, loans, fixes. */
  adjustmentsInr?: number;
  /** CC-5: approved, unconsumed cash-drawer shortages for the month, whole rupees. */
  cashShortageInr?: number;
  /**
   * Which proposed deductions to actually take. Omitted = take NONE: every
   * deduction is a proposal the owner confirms per staffer at finalize.
   */
  apply?: DeductionChoices;
}): PayrollLine {
  const { days, rules, adjustmentsInr = 0, apply = {} } = params;
  const proposedCashShortageInr = Math.max(0, Math.round(params.cashShortageInr ?? 0));

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
    const proposedDeductions = { lateInr: 0, cashShortageInr: proposedCashShortageInr };
    return {
      ...counts,
      ...totals,
      basePayInr: 0,
      otPayInr: 0,
      adjustmentsInr,
      proposedDeductions,
      netBeforeDeductionsInr: adjustmentsInr,
      ...settleDeductions(adjustmentsInr, proposedDeductions, apply),
      unconfigured: true,
      blocked,
      segments: [],
    };
  }

  const paidLeaves = Math.max(
    0,
    Math.floor(rules.paidLeavesPerMonth ?? DEFAULT_PAID_LEAVES_PER_MONTH),
  );

  // Group by employment record AND calendar month, so each day is priced at
  // the rate in force on it and against its own month's divisor. One segment
  // is the ordinary case; more than one means the salary or shift changed
  // mid-period.
  //
  // Because expected hours come from the WHOLE month's payable days (not just
  // the days a record covered), a mid-month joiner or raise needs no special
  // handling: 10 full days at ₹27,000 in a 31-day month is 27,000 × 10 ÷ 27.
  const byKey = new Map<string, PayrollDayInput[]>();
  for (const d of employed) {
    const groupKey = `${d.employmentKey!}|${d.date.slice(0, 7)}`;
    const list = byKey.get(groupKey) ?? [];
    list.push(d);
    byKey.set(groupKey, list);
  }

  const segments: PayrollSegmentBreakdown[] = [];
  let basePaise = 0;
  let otPaise = 0;
  let deductionPaise = 0;

  for (const segDays of byKey.values()) {
    const key = segDays[0].employmentKey!;
    const salaryPaise = segDays[0].monthlySalaryInr * 100;
    const contractedMinutes = Math.round(segDays[0].contractedHoursPerDay * 60);

    const daysInMonth = daysInMonthOf(segDays[0].date);
    const payableDays = Math.max(0, daysInMonth - paidLeaves);
    const expectedMinutes = payableDays * contractedMinutes;
    const paidMinutes = segDays.reduce((a, d) => a + payableMinutes(d, contractedMinutes), 0);
    const segOtMinutes = segDays.reduce((a, d) => a + d.otMinutes, 0);
    const segLateMarks = segDays.filter((d) => d.isLate).length;

    // Only reachable with a nonsensical leave allowance (≥ the month's days) or
    // a zero-hour contract. Guard the division rather than emitting NaN money.
    const segBasePaise =
      expectedMinutes > 0 ? (salaryPaise * paidMinutes) / expectedMinutes : 0;

    // OT is priced from the same ratio, so it stays consistent with base pay
    // and needs no separately-rounded rate.
    const perMinutePaise = expectedMinutes > 0 ? salaryPaise / expectedMinutes : 0;
    const segOtPaise = segOtMinutes * perMinutePaise * rules.otMultiplier;

    // Late marks: every Nth one PROPOSES half a contracted day's deduction —
    // taken only if the owner chooses to at finalize. It is the only rule
    // deduction: absence is already unpaid by virtue of contributing no
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
      daysInMonth,
      paidLeaves,
      payableDays,
      expectedMinutes,
      paidMinutes,
      otMinutes: segOtMinutes,
      lateMarks: segLateMarks,
      basePaise: Math.round(segBasePaise),
      otPaise: Math.round(segOtPaise),
      deductionPaise: Math.round(segDeductionPaise),
    });
  }

  // Earnings are summed in unrounded paise and rounded once, so base + OT
  // cannot drift a rupee away from the total. The deductions are then whole
  // rupees taken off that — see settleDeductions for why.
  const netBeforeDeductionsInr = paiseToRupees(basePaise + otPaise + adjustmentsInr * 100);
  const proposedDeductions = {
    lateInr: paiseToRupees(deductionPaise),
    cashShortageInr: proposedCashShortageInr,
  };

  return {
    ...counts,
    ...totals,
    basePayInr: paiseToRupees(basePaise),
    otPayInr: paiseToRupees(otPaise),
    adjustmentsInr,
    proposedDeductions,
    netBeforeDeductionsInr,
    ...settleDeductions(netBeforeDeductionsInr, proposedDeductions, apply),
    unconfigured: false,
    blocked,
    segments,
  };
}
