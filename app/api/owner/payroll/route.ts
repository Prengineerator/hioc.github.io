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
// APPROVED but that no payroll run has consumed yet (payroll_run_id IS NULL).
// The cash_counts / cash_shortages tables come from a migration that may not
// be applied yet (supabase/2026-09-cash-counts.sql); a missing table just
// yields no rows here, same as every other optional table this route reads —
// no error, no special-casing, the month simply shows zero shortages.
interface CashShortageRow {
  id: string;
  user_id: string;
  amount_inr: number;
}

async function loadUnconsumedApprovedShortages(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  bounds: { from: string; to: string },
): Promise<CashShortageRow[]> {
  const { data } = await admin
    .from('cash_shortages')
    .select('id, user_id, amount_inr')
    .eq('status', 'approved')
    .is('payroll_run_id', null)
    .gte('business_date', bounds.from)
    .lte('business_date', bounds.to);
  return (data ?? []) as CashShortageRow[];
}

function sumShortagesByUser(rows: CashShortageRow[]): Map<string, number> {
  const byUser = new Map<string, number>();
  for (const r of rows) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + r.amount_inr);
  return byUser;
}

/**
 * True when `error` means "the relation doesn't exist" — the cash-counts
 * migration hasn't been applied yet. Mirrors the same check duplicated in
 * lib/payroll/payslipEmail.ts and app/api/owner/staff/_lib.ts: PostgREST
 * usually reports it as PGRST205 (schema-cache miss), raw Postgres as 42P01.
 */
function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /relation .* does not exist|could not find the table|schema cache/i.test(error.message ?? '');
}

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
    const dayInputs: PayrollDayInput[] = dates.map((date) => {
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
      })),
    },
  };
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
    .select('id')
    .eq('period_start', bounds.from)
    .eq('period_end', bounds.to)
    .eq('user_id', userId)
    .eq('status', 'finalized')
    .limit(1);
  if ((existingRows ?? []).length > 0) {
    return errorResponse(409, 'This person is already finalized for that month. Reverse it first to change anything.');
  }

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
      status: 'finalized',
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
    // read as "this person was paid nothing".
    await admin.from('payroll_runs').delete().eq('id', run.id);
    return errorResponse(500, `Could not write the payroll line: ${lineErr.message}`);
  }

  // CC-5: mark this person's shortage rows consumed — but ONLY if the owner
  // chose to deduct them. A shortage they let go stays unconsumed: it is not
  // on any payslip, and it is month-scoped, so no later month picks it up.
  // The run and line already stand here; a failure must not undo them, so it
  // is reported in the response instead of failing the request.
  const shortageIdsToMark = line.appliedDeductions.cashShortage
    ? computed.shortageRows.filter((r) => r.user_id === userId).map((r) => r.id)
    : [];

  let cashShortagesMarked = 0;
  let cashShortageMarkError: string | null = null;
  if (shortageIdsToMark.length > 0) {
    try {
      const { error: markErr } = await admin
        .from('cash_shortages')
        .update({ payroll_run_id: run.id })
        .in('id', shortageIdsToMark);
      if (markErr) {
        cashShortageMarkError = markErr.message;
        console.error('Could not mark cash shortages as consumed by payroll run', run.id, markErr);
      } else {
        cashShortagesMarked = shortageIdsToMark.length;
      }
    } catch (err) {
      cashShortageMarkError = err instanceof Error ? err.message : 'Could not mark cash shortages consumed.';
      console.error('cash_shortages marking threw during finalize', run.id, err);
    }
  }

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

  const admin = createAdminSupabaseClient();
  // Reversal, never deletion: what was paid, and what it was corrected to, is
  // the entire point of keeping the record.
  const { data, error } = await admin
    .from('payroll_runs')
    .update({
      status: 'reversed',
      reversed_at: new Date().toISOString(),
      reversal_reason: reason,
    })
    .eq('period_start', bounds.from)
    .eq('period_end', bounds.to)
    .eq('user_id', userId)
    .eq('status', 'finalized')
    .select('*')
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return errorResponse(404, "That person's payroll isn't finalized for that month.");
  const run = data as PayrollRun;

  // CC-5: this run's shortages were marked payroll_run_id = run.id at
  // finalize so they'd never be deducted twice. Reversing without undoing
  // that mark would strand them forever — no future compute would ever pick
  // them up again (they're not "unconsumed" any more). Clear it so the next
  // finalize re-includes them.
  let cashShortagesCleared = 0;
  let cashShortageClearError: string | null = null;
  try {
    const { data: clearedRows, error: clearErr } = await admin
      .from('cash_shortages')
      .update({ payroll_run_id: null })
      .eq('payroll_run_id', run.id)
      .select('id');
    if (clearErr) {
      // A missing cash-counts migration is not a failure worth reporting —
      // there was nothing to clear either way.
      if (!isMissingRelation(clearErr)) {
        cashShortageClearError = clearErr.message;
        console.error('Could not clear cash_shortage payroll_run_id on reversal', run.id, clearErr);
      }
    } else {
      cashShortagesCleared = (clearedRows ?? []).length;
    }
  } catch (err) {
    cashShortageClearError = err instanceof Error ? err.message : 'Could not clear cash shortages.';
    console.error('cash_shortages clear threw during reversal', run.id, err);
  }

  return NextResponse.json({
    run,
    cashShortagesCleared,
    ...(cashShortageClearError ? { cashShortageClearError } : {}),
  });
}
