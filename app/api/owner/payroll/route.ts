import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import { loadEmploymentRows, employmentOnDate, toDayEmployment } from '@/lib/attendance/employment';
import { rollUpDay, dayOfWeekFor, type DaySession, type DayMark } from '@/lib/attendance/day';
import {
  computePayrollLine,
  DEFAULT_PAID_LEAVES_PER_MONTH,
  type PayrollDayInput,
} from '@/lib/payroll/compute';
import { sendPayslipsForRun } from '@/lib/payroll/payslipEmail';
import { canPayrollRunTransition } from '@/lib/payroll/runState';
import {
  loadUnconsumedApprovedShortages,
  markShortagesConsumed,
  releaseShortagesForRun,
  sumShortagesByUser,
} from '@/lib/payroll/shortages';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import type { AttendanceSession, PayrollRun, PayrollRunLine, StaffEmployment } from '@/lib/types';

export const dynamic = 'force-dynamic';

// PAY-3 / PAY-4 — compute a payroll month, and finalize it ONE STAFFER AT A TIME.
//
// OWNER ONLY (D5-8). Managers run the floor and clear the attendance queue;
// only the owner sees money. This route is deliberately absent from the
// permission matrix — there is no key that could widen it by accident.
//
// A draft is computed FRESH on every request from attendance + rules, never
// cached. A finalized staffer is the opposite: read back from their frozen run
// and never recomputed, so a later rule change cannot restate a month somebody
// has already been paid for.
//
// Deductions (late-mark half-days, approved cash shortages) are PROPOSED on
// the draft and taken only when the owner ticks them for that person at
// finalize (lib/payroll/compute.ts).

function monthBounds(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.UTC(fy, fm - 1, fd); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// CC-5 (docs/PHASE-5-CASH-COUNTS.md) — cash-drawer shortages the owner has
// APPROVED but that no active payroll run has consumed yet. Loading, marking
// and releasing them lives in lib/payroll/shortages.ts (the consume/release
// half of the shortage state machine in lib/cash/counts.ts). A missing
// cash-counts table yields no rows, so the month simply shows zero shortages.

/** A priced day plus the clock times the payslip's day-by-day table shows. */
type PayrollDay = PayrollDayInput & { firstIn: string | null; lastOut: string | null };

async function computePeriod(month: string) {
  const bounds = monthBounds(month)!;
  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();

  const [{ data: profileRows }, { data: sessionRows }, { data: markRows }, { data: leaveRows }, employment, shortageRows] =
    await Promise.all([
      admin.from('profiles').select('id, name, role').in('role', ['staff', 'manager', 'owner']),
      admin
        .from('attendance_sessions')
        .select('*')
        .gte('business_date', bounds.from)
        .lte('business_date', bounds.to),
      admin
        .from('attendance_day_marks')
        .select('user_id, business_date, mark')
        .gte('business_date', bounds.from)
        .lte('business_date', bounds.to),
      admin
        .from('leave_requests')
        .select('user_id, leave_date')
        .eq('status', 'approved')
        .gte('leave_date', bounds.from)
        .lte('leave_date', bounds.to),
      loadEmploymentRows(bounds.from, bounds.to),
      loadUnconsumedApprovedShortages(admin, bounds),
    ]);

  const people = (profileRows ?? []) as { id: string; name: string; role: string }[];
  const sessions = (sessionRows ?? []) as AttendanceSession[];
  const marks = (markRows ?? []) as { user_id: string; business_date: string; mark: DayMark }[];
  const leave = (leaveRows ?? []) as { user_id: string; leave_date: string }[];
  const employmentRows = employment as StaffEmployment[];
  const shortageByUser = sumShortagesByUser(shortageRows);

  // Same resolution as the attendance sheet: profiles.name is usually empty
  // (staff sign in as <name>@hioc.in), so both what's shown and the sort order
  // below come from the resolved name, not the raw column.
  const displayNames = await getStaffDisplayNames(
    admin,
    people.map((p) => p.id),
  );
  people.sort((a, b) =>
    (displayNames.get(a.id) ?? '').localeCompare(displayNames.get(b.id) ?? ''),
  );

  const rules = {
    gracePeriodMin: settings.grace_period_min,
    otThresholdMin: settings.ot_threshold_min,
    autoBreakMin: settings.auto_break_min,
    autoBreakAfterMin: settings.auto_break_after_min,
    halfDayMinMinutes: settings.half_day_min_minutes,
    absentBelowMinutes: settings.absent_below_minutes,
  };

  const key = (u: string, d: string) => `${u}|${d}`;
  const byUserDate = new Map<string, AttendanceSession[]>();
  for (const s of sessions) {
    const list = byUserDate.get(key(s.user_id, s.business_date)) ?? [];
    list.push(s);
    byUserDate.set(key(s.user_id, s.business_date), list);
  }
  const markMap = new Map(marks.map((m) => [key(m.user_id, m.business_date), m.mark]));
  const approvedLeave = new Set(leave.map((l) => key(l.user_id, l.leave_date)));
  const leaveMonths = new Set(leave.map((l) => `${l.user_id}|${l.leave_date.slice(0, 7)}`));

  const dates = eachDate(bounds.from, bounds.to);

  const lines = people.map((person) => {
    const dayInputs: PayrollDay[] = dates.map((date) => {
      const raw = byUserDate.get(key(person.id, date)) ?? [];
      const daySessions: DaySession[] = raw.map((s) => ({
        id: s.id,
        clockInAt: s.clock_in_at,
        clockOutAt: s.clock_out_at,
        status: s.status,
        source: s.source,
        approvedAt: s.approved_at,
        flags: s.flags ?? [],
      }));
      const record = employmentOnDate(employmentRows, person.id, date);
      const rollup = rollUpDay({
        date,
        sessions: daySessions,
        rules,
        employment: toDayEmployment(record),
        mark: markMap.get(key(person.id, date)) ?? null,
        scheduledOff: leaveMonths.has(`${person.id}|${date.slice(0, 7)}`)
          ? approvedLeave.has(key(person.id, date))
          : undefined,
        dayOfWeek: dayOfWeekFor(date),
      });

      return {
        date,
        status: rollup.status,
        workedMinutes: rollup.workedMinutes,
        otMinutes: rollup.otMinutes,
        isLate: rollup.isLate,
        // The employment ROW id is the grouping key, which is what makes a
        // mid-month raise price each day at the rate in force on it.
        employmentKey: record?.id ?? null,
        monthlySalaryInr: record?.monthly_salary_inr ?? 0,
        contractedHoursPerDay: record ? Number(record.contracted_hours_per_day) : 0,
        // For the payslip's day-by-day table: when the day started counting
        // (after early-clock-in rounding) and the last clock-out.
        firstIn: rollup.countedFirstIn,
        lastOut: rollup.lastOut,
      };
    });

    const line = computePayrollLine({
      days: dayInputs,
      rules: {
        otMultiplier: Number(settings.ot_multiplier),
        lateMarksPerHalfday: settings.late_marks_per_halfday,
        paidLeavesPerMonth: DEFAULT_PAID_LEAVES_PER_MONTH,
      },
      cashShortageInr: shortageByUser.get(person.id) ?? 0,
    });

    return {
      user_id: person.id,
      name: displayNames.get(person.id) ?? 'Unknown staff',
      role: person.role,
      ...line,
      days: dayInputs,
    };
  });

  return {
    month,
    bounds,
    lines,
    blocked: lines.some((l) => l.blocked),
    // Internal bookkeeping for POST's finalize step (which rows to mark
    // consumed) — not part of the public GET shape, see the GET handler.
    shortageRows,
    rulesSnapshot: {
      // Expected hours = (days in month − this) × contracted hours.
      paid_leaves_per_month: DEFAULT_PAID_LEAVES_PER_MONTH,
      ot_multiplier: Number(settings.ot_multiplier),
      late_marks_per_halfday: settings.late_marks_per_halfday,
      grace_period_min: settings.grace_period_min,
      ot_threshold_min: settings.ot_threshold_min,
      auto_break_min: settings.auto_break_min,
      auto_break_after_min: settings.auto_break_after_min,
      half_day_min_minutes: settings.half_day_min_minutes,
      absent_below_minutes: settings.absent_below_minutes,
    },
  };
}

type ComputedPeriod = Awaited<ReturnType<typeof computePeriod>>;
type DraftLine = ComputedPeriod['lines'][number];

function rulesFromSnapshot(snapshot: ComputedPeriod['rulesSnapshot']) {
  return {
    otMultiplier: snapshot.ot_multiplier,
    lateMarksPerHalfday: snapshot.late_marks_per_halfday,
    paidLeavesPerMonth: snapshot.paid_leaves_per_month,
  };
}

/**
 * A FROZEN payroll_run_lines row, reshaped into the same fields a draft line
 * carries, so the screen renders draft and finalized staff in one table. Every
 * number comes from the frozen row — nothing here is recomputed.
 */
function frozenLine(row: PayrollRunLine, run: PayrollRun, liveName: string | undefined) {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  const days = Array.isArray(d.days)
    ? (d.days as { date: string; status: string; worked: number; ot: number; late: boolean }[])
    : [];
  return {
    user_id: row.user_id,
    name: liveName ?? (typeof d.name === 'string' ? d.name : 'Unknown staff'),
    finalized: true as const,
    run: { id: run.id, finalized_at: run.finalized_at },
    daysPresent: row.days_present,
    daysHalf: row.days_half,
    daysAbsent: row.days_absent,
    daysOff: row.days_off,
    daysPaidLeave: row.days_paid_leave,
    daysNeedingApproval: 0,
    workedMinutes: row.worked_minutes,
    otMinutes: row.ot_minutes,
    lateMarks: row.late_marks,
    basePayInr: row.base_pay_inr,
    otPayInr: row.ot_pay_inr,
    deductionsInr: row.deductions_inr,
    cashShortageInr: row.cash_shortage_inr,
    adjustmentsInr: row.adjustments_inr,
    proposedDeductions:
      (d.proposed_deductions as { lateInr: number; cashShortageInr: number } | undefined) ?? {
        lateInr: row.deductions_inr,
        cashShortageInr: row.cash_shortage_inr,
      },
    appliedDeductions:
      (d.applied_deductions as { late: boolean; cashShortage: boolean } | undefined) ?? {
        late: row.deductions_inr > 0,
        cashShortage: row.cash_shortage_inr > 0,
      },
    netBeforeDeductionsInr:
      typeof d.net_before_deductions_inr === 'number'
        ? d.net_before_deductions_inr
        : row.net_pay_inr + row.deductions_inr + row.cash_shortage_inr,
    deductionsClamped: Boolean(d.deductions_clamped ?? d.cash_shortage_clamped),
    adjustmentReason: typeof d.adjustment_reason === 'string' ? d.adjustment_reason : '',
    netPayInr: row.net_pay_inr,
    unconfigured: false,
    blocked: false,
    segments: Array.isArray(d.segments) ? d.segments : [],
    days: days.map((x) => ({
      date: x.date,
      status: x.status,
      workedMinutes: x.worked,
      otMinutes: x.ot,
      isLate: x.late,
    })),
  };
}

export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const url = new URL(request.url);
  const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
  const bounds = monthBounds(month);
  if (!bounds) return errorResponse(400, 'month must look like 2026-08');

  const admin = createAdminSupabaseClient();

  // Payroll is finalized per staffer. A finalized person is served from their
  // FROZEN snapshot, never recomputed — otherwise a rule changed in November
  // would silently restate an October someone has already been paid for.
  // Everyone else is a draft, computed fresh, with every deduction proposed
  // but none taken until the owner chooses.
  const [{ data: runRows }, computed] = await Promise.all([
    admin
      .from('payroll_runs')
      .select('*')
      .eq('period_start', bounds.from)
      .eq('period_end', bounds.to)
      .eq('status', 'finalized'),
    computePeriod(month),
  ]);
  const runs = ((runRows ?? []) as PayrollRun[]).filter((r) => r.user_id);

  const frozenByUser = new Map<string, ReturnType<typeof frozenLine>>();
  if (runs.length > 0) {
    const { data: lineRows } = await admin
      .from('payroll_run_lines')
      .select('*')
      .in(
        'run_id',
        runs.map((r) => r.id),
      );
    const runById = new Map(runs.map((r) => [r.id, r]));
    const liveNames = new Map(computed.lines.map((l) => [l.user_id, l.name]));
    for (const row of (lineRows ?? []) as PayrollRunLine[]) {
      const run = runById.get(row.run_id);
      if (run) frozenByUser.set(row.user_id, frozenLine(row, run, liveNames.get(row.user_id)));
    }
  }

  const lines = [
    ...computed.lines.map((l) => {
      const frozen = frozenByUser.get(l.user_id);
      if (frozen) return frozen;
      return { ...l, finalized: false as const, run: null, adjustmentReason: '' };
    }),
    // Someone finalized this month who is no longer on the staff list (role
    // changed) must still show — what they were paid doesn't go away.
    ...[...frozenByUser.values()].filter((f) => !computed.lines.some((l) => l.user_id === f.user_id)),
  ];

  return NextResponse.json({
    month: computed.month,
    bounds: computed.bounds,
    lines,
    finalizedCount: lines.filter((l) => l.finalized).length,
    blocked: lines.some((l) => !l.finalized && l.blocked),
    rulesSnapshot: computed.rulesSnapshot,
  });
}

/** The frozen payroll_run_lines row for one staffer's finalized run. */
function runLineRow(
  runId: string,
  draft: DraftLine,
  line: ReturnType<typeof computePayrollLine>,
  adjustmentReason: string,
) {
  const seg = line.segments[0];
  return {
    run_id: runId,
    user_id: draft.user_id,
    monthly_salary_inr: seg?.monthlySalaryInr ?? 0,
    contracted_hours_per_day: seg?.contractedHoursPerDay ?? 0,
    per_minute_paise: seg && seg.expectedMinutes > 0 ? (seg.monthlySalaryInr * 100) / seg.expectedMinutes : 0,
    days_present: line.daysPresent,
    days_half: line.daysHalf,
    days_absent: line.daysAbsent,
    days_off: line.daysOff,
    days_paid_leave: line.daysPaidLeave,
    worked_minutes: line.workedMinutes,
    ot_minutes: line.otMinutes,
    late_marks: line.lateMarks,
    base_pay_inr: line.basePayInr,
    ot_pay_inr: line.otPayInr,
    // Only what the owner CHOSE to deduct reaches these columns — and so the
    // payslip. What was proposed but let go is kept in `detail`.
    deductions_inr: line.deductionsInr,
    cash_shortage_inr: line.cashShortageInr,
    adjustments_inr: line.adjustmentsInr,
    net_pay_inr: line.netPayInr,
    // The day-by-day derivation is frozen with the run. PAY-3 renders it, and
    // it is what makes the number trusted rather than re-checked.
    detail: {
      name: draft.name,
      segments: line.segments,
      adjustment_reason: adjustmentReason,
      proposed_deductions: line.proposedDeductions,
      applied_deductions: line.appliedDeductions,
      net_before_deductions_inr: line.netBeforeDeductionsInr,
      deductions_clamped: line.deductionsClamped,
      days: draft.days.map((d) => ({
        date: d.date,
        status: d.status,
        worked: d.workedMinutes,
        ot: d.otMinutes,
        late: d.isLate,
        // ISO instants; the payslip renders them in IST.
        in: d.firstIn,
        out: d.lastOut,
      })),
    },
  };
}

type Admin = ReturnType<typeof createAdminSupabaseClient>;

const INCOMPLETE_RUN_REASON = 'Finalize did not complete — no payroll line was written.';

/** finalized → reversed for a run that never got its line (compare-and-set). */
async function reverseIncompleteRun(admin: Admin, runId: string): Promise<boolean> {
  const rule = canPayrollRunTransition('finalized', 'reverse', { reason: INCOMPLETE_RUN_REASON }).rule!;
  const { data, error } = await admin
    .from('payroll_runs')
    .update({ status: rule.to, reversed_at: new Date().toISOString(), reversal_reason: INCOMPLETE_RUN_REASON })
    .eq('id', runId)
    .eq('status', rule.from!)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('payroll: could not retire an incomplete run', runId, error);
    return false;
  }
  return Boolean(data);
}

/**
 * Removes the run a failed line insert left behind: delete (retried once),
 * else reverse it — a reversed run blocks no re-finalize. False only when
 * neither worked, which the caller reports.
 */
async function discardIncompleteRun(admin: Admin, runId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await admin.from('payroll_runs').delete().eq('id', runId);
    if (!error) return true;
    console.error('payroll: could not delete an incomplete run', runId, error);
  }
  return reverseIncompleteRun(admin, runId);
}

/** How long a line-less run is left alone — a concurrent finalize may be mid-write. */
const INCOMPLETE_RUN_GRACE_MS = 2 * 60_000;

/**
 * True when `run` (finalized) turned out to be debris — no line, and old
 * enough that no finalize can still be writing one — and is now retired.
 * Anything uncertain (an unreadable line table, a run with no timestamp) is
 * left standing: blocking a re-run is recoverable, double payroll is not.
 */
async function retireIncompleteRun(admin: Admin, run: { id: string; generated_at?: string | null }): Promise<boolean> {
  const age = run.generated_at ? Date.now() - Date.parse(run.generated_at) : NaN;
  if (!Number.isFinite(age) || age < INCOMPLETE_RUN_GRACE_MS) return false;
  const { data: lines, error } = await admin.from('payroll_run_lines').select('id').eq('run_id', run.id).limit(1);
  if (error || (lines ?? []).length > 0) return false;
  return reverseIncompleteRun(admin, run.id);
}

// POST { month, user_id, apply?: { late?, cash_shortage? }, adjustment?: { amount_inr, reason } }
// — finalize ONE staffer's month, taking only the deductions the owner ticked.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const month = typeof body.month === 'string' ? body.month : '';
  const bounds = monthBounds(month);
  if (!bounds) return errorResponse(400, 'month must look like 2026-08');
  const userId = typeof body.user_id === 'string' ? body.user_id : '';
  if (!userId) {
    return errorResponse(400, 'user_id is required — payroll is finalized one staffer at a time.');
  }

  // Both default to NO: a deduction is taken only when the owner ticked it.
  const applyRaw = (body.apply ?? {}) as { late?: unknown; cash_shortage?: unknown };
  const apply = { late: applyRaw.late === true, cashShortage: applyRaw.cash_shortage === true };

  let adjustment: { amount: number; reason: string } | null = null;
  if (body.adjustment !== undefined && body.adjustment !== null) {
    const a = body.adjustment as { amount_inr?: unknown; reason?: unknown };
    if (typeof a.amount_inr !== 'number' || !Number.isInteger(a.amount_inr)) {
      return errorResponse(400, 'Adjustments must be whole rupees.');
    }
    const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
    if (!reason) return errorResponse(400, 'Every adjustment needs a reason.');
    if (a.amount_inr !== 0) adjustment = { amount: a.amount_inr, reason };
  }

  const admin = createAdminSupabaseClient();

  const { data: existingRows } = await admin
    .from('payroll_runs')
    .select('id, generated_at')
    .eq('period_start', bounds.from)
    .eq('period_end', bounds.to)
    .eq('user_id', userId)
    .eq('status', 'finalized')
    .limit(1);
  const existingRun = ((existingRows ?? []) as { id: string; generated_at?: string | null }[])[0] ?? null;
  // A finalized run with NO line is the debris of a finalize that failed
  // half-way and could not clean up after itself. It would block this person's
  // month forever (the one-active-run index) while the screen showed them as a
  // draft with nothing to reverse — so retire it here and carry on.
  const stillActive = existingRun ? !(await retireIncompleteRun(admin, existingRun)) : false;
  const finalizeCheck = canPayrollRunTransition(stillActive ? 'finalized' : null, 'finalize');
  if (!finalizeCheck.ok) return errorResponse(409, finalizeCheck.message!);

  const computed = await computePeriod(month);
  const draft = computed.lines.find((l) => l.user_id === userId);
  if (!draft) return errorResponse(404, "That person isn't on this month's payroll.");

  // Refusing to finalize over unresolved days is the point of the whole
  // approval queue — a run that included a guessed day would freeze the guess.
  // Only THIS person's days matter now.
  if (draft.blocked) {
    return errorResponse(
      409,
      `Some of ${draft.name}'s days still need approval on the attendance sheet. Clear those before finalizing.`,
    );
  }
  if (draft.unconfigured && !adjustment) {
    return errorResponse(409, `${draft.name} has no salary set for this month, so there is nothing to finalize.`);
  }

  const line = computePayrollLine({
    days: draft.days,
    rules: rulesFromSnapshot(computed.rulesSnapshot),
    adjustmentsInr: adjustment?.amount ?? 0,
    // The same summed shortage the draft proposed — finalize may take it or
    // let it go, but never sees a different number.
    cashShortageInr: draft.proposedDeductions.cashShortageInr,
    apply,
  });

  const { data: runRow, error: runErr } = await admin
    .from('payroll_runs')
    .insert({
      period_start: bounds.from,
      period_end: bounds.to,
      user_id: userId,
      // Straight to 'finalized': a draft is never stored (lib/payroll/runState.ts).
      status: finalizeCheck.rule!.to,
      rules_snapshot: computed.rulesSnapshot,
      generated_by: owner.id,
      finalized_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (runErr) {
    // The one-active-run-per-staffer index lost a race to a second tap.
    if ((runErr as { code?: string }).code === '23505') {
      return errorResponse(409, 'This person is already finalized for that month.');
    }
    return errorResponse(500, runErr.message);
  }
  const run = runRow as PayrollRun;

  const row = runLineRow(run.id, draft, line, adjustment?.reason ?? '');
  const { error: lineErr } = await admin.from('payroll_run_lines').insert([row]);
  if (lineErr) {
    // Leave no half-written run behind: a finalized run with no line would
    // read as "this person was paid nothing" and block a re-finalize. The
    // clean-up used to be a single unchecked delete; now it is checked,
    // retried, falls back to reversing the run (a reversed run blocks
    // nothing), and says so if even that fails.
    const cleaned = await discardIncompleteRun(admin, run.id);
    return errorResponse(
      500,
      `Could not write the payroll line: ${lineErr.message}` +
        (cleaned
          ? ''
          : ` The unfinished run could not be removed either — finalizing ${draft.name} again in a minute will retire it.`),
    );
  }

  // CC-5: mark this person's shortage rows consumed — but ONLY if the owner
  // chose to deduct them. A shortage they let go stays unconsumed: it is not
  // on any payslip, and it is month-scoped, so no later month picks it up.
  // The run and line already stand here; a failure must not undo them, so it
  // is reported in the response (and on the screen) instead of failing the
  // request. Compare-and-set + one retry: lib/payroll/shortages.ts.
  const mark = await markShortagesConsumed(
    admin,
    run.id,
    line.appliedDeductions.cashShortage ? computed.shortageRows.filter((r) => r.user_id === userId) : [],
  );
  const cashShortagesMarked = mark.marked;
  const cashShortageMarkError = mark.error;

  // SA-5: the payslip email, to the personal email on file. Best-effort — a
  // finalized run must stand even if the email fails, so sendPayslipsForRun
  // never throws and any failure here is swallowed too.
  let payslips: Awaited<ReturnType<typeof sendPayslipsForRun>> = [];
  try {
    payslips = await sendPayslipsForRun(admin, run.id);
  } catch (err) {
    console.error('sendPayslipsForRun threw during finalize', run.id, err);
  }

  return NextResponse.json({
    run,
    line: row,
    payslips,
    cashShortagesMarked,
    ...(cashShortageMarkError ? { cashShortageMarkError } : {}),
  });
}

// PATCH { month, user_id, reason } — reverse ONE staffer's finalized month.
export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const month = typeof body.month === 'string' ? body.month : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const userId = typeof body.user_id === 'string' ? body.user_id : '';
  const bounds = monthBounds(month);
  if (!bounds) return errorResponse(400, 'month must look like 2026-08');
  if (!userId) return errorResponse(400, 'user_id is required — payroll is reversed one staffer at a time.');
  if (!reason) return errorResponse(400, 'A reason is required to reverse a payroll run.');

  const reverse = canPayrollRunTransition('finalized', 'reverse', { reason });
  if (!reverse.ok) return errorResponse(400, reverse.message!);

  const admin = createAdminSupabaseClient();
  // Reversal, never deletion: what was paid, and what it was corrected to, is
  // the entire point of keeping the record. Compare-and-set on 'finalized'.
  const { data, error } = await admin
    .from('payroll_runs')
    .update({
      status: reverse.rule!.to,
      reversed_at: new Date().toISOString(),
      reversal_reason: reason,
    })
    .eq('period_start', bounds.from)
    .eq('period_end', bounds.to)
    .eq('user_id', userId)
    .eq('status', reverse.rule!.from!)
    .select('*')
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return errorResponse(404, "That person's payroll isn't finalized for that month.");
  const run = data as PayrollRun;

  // CC-5: this run's shortages were marked payroll_run_id = run.id at
  // finalize so they'd never be deducted twice. Release them so the next
  // finalize re-includes them. If the release fails it is reported — but it
  // no longer strands anything: payroll reads a pointer to a reversed run as
  // unconsumed (lib/payroll/shortages.ts), and the next finalize re-points it.
  const release = await releaseShortagesForRun(admin, run.id);
  const cashShortagesCleared = release.cleared;
  const cashShortageClearError = release.error;

  return NextResponse.json({
    run,
    cashShortagesCleared,
    ...(cashShortageClearError ? { cashShortageClearError } : {}),
  });
}
