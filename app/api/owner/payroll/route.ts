import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import { loadEmploymentRows, employmentOnDate, toDayEmployment } from '@/lib/attendance/employment';
import { rollUpDay, dayOfWeekFor, type DaySession, type DayMark } from '@/lib/attendance/day';
import { computePayrollLine, type PayrollDayInput } from '@/lib/payroll/compute';
import type { AttendanceSession, PayrollRun, StaffEmployment } from '@/lib/types';

export const dynamic = 'force-dynamic';

// PAY-3 / PAY-4 — compute a payroll period, and finalize it.
//
// OWNER ONLY (D5-8). Managers run the floor and clear the attendance queue;
// only the owner sees money. This route is deliberately absent from the
// permission matrix — there is no key that could widen it by accident.
//
// A draft is computed FRESH on every request from attendance + rules, never
// cached. A finalized run is the opposite: it is read back from its frozen
// snapshot and never recomputed, so a later rule change cannot restate a month
// somebody has already been paid for.

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

async function computePeriod(month: string) {
  const bounds = monthBounds(month)!;
  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();

  const [{ data: profileRows }, { data: sessionRows }, { data: markRows }, { data: leaveRows }, employment] =
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
    ]);

  const people = (profileRows ?? []) as { id: string; name: string; role: string }[];
  const sessions = (sessionRows ?? []) as AttendanceSession[];
  const marks = (markRows ?? []) as { user_id: string; business_date: string; mark: DayMark }[];
  const leave = (leaveRows ?? []) as { user_id: string; leave_date: string }[];
  const employmentRows = employment as StaffEmployment[];

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
      },
    });

    return {
      user_id: person.id,
      name: person.name || '(no name)',
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
    rulesSnapshot: {
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

export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const url = new URL(request.url);
  const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
  const bounds = monthBounds(month);
  if (!bounds) return errorResponse(400, 'month must look like 2026-08');

  const admin = createAdminSupabaseClient();

  // A finalized run is served from its FROZEN snapshot, never recomputed —
  // otherwise a rule changed in November would silently restate October.
  const { data: runRow } = await admin
    .from('payroll_runs')
    .select('*')
    .eq('period_start', bounds.from)
    .eq('period_end', bounds.to)
    .neq('status', 'reversed')
    .maybeSingle();
  const run = runRow as PayrollRun | null;

  if (run?.status === 'finalized') {
    const { data: lineRows } = await admin
      .from('payroll_run_lines')
      .select('*')
      .eq('run_id', run.id);
    return NextResponse.json({ month, finalized: true, run, lines: lineRows ?? [] });
  }

  const computed = await computePeriod(month);
  return NextResponse.json({ ...computed, finalized: false, run });
}

// POST { month, adjustments?: { user_id, amount_inr, reason }[] } — finalize.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const month = typeof body.month === 'string' ? body.month : '';
  const bounds = monthBounds(month);
  if (!bounds) return errorResponse(400, 'month must look like 2026-08');

  const admin = createAdminSupabaseClient();

  const { data: existing } = await admin
    .from('payroll_runs')
    .select('id, status')
    .eq('period_start', bounds.from)
    .eq('period_end', bounds.to)
    .neq('status', 'reversed')
    .maybeSingle();
  if ((existing as { status?: string } | null)?.status === 'finalized') {
    return errorResponse(409, 'That month is already finalized. Reverse it first to change anything.');
  }

  const computed = await computePeriod(month);

  // Refusing to finalize over unresolved days is the point of the whole
  // approval queue — a run that included a guessed day would freeze the guess.
  if (computed.blocked) {
    return errorResponse(
      409,
      'Some days still need approval on the attendance sheet. Clear those before finalizing.',
    );
  }

  const adjustments = new Map<string, { amount: number; reason: string }>();
  if (Array.isArray(body.adjustments)) {
    for (const a of body.adjustments as { user_id?: string; amount_inr?: number; reason?: string }[]) {
      if (typeof a?.user_id !== 'string' || typeof a?.amount_inr !== 'number') continue;
      if (!Number.isInteger(a.amount_inr)) {
        return errorResponse(400, 'Adjustments must be whole rupees.');
      }
      if (!a.reason?.trim()) {
        return errorResponse(400, 'Every adjustment needs a reason.');
      }
      adjustments.set(a.user_id, { amount: a.amount_inr, reason: a.reason.trim() });
    }
  }

  const { data: runRow, error: runErr } = await admin
    .from('payroll_runs')
    .insert({
      period_start: bounds.from,
      period_end: bounds.to,
      status: 'finalized',
      rules_snapshot: computed.rulesSnapshot,
      generated_by: owner.id,
      finalized_at: new Date().toISOString(),
    })
    .select('*')
    .single();
  if (runErr) return errorResponse(500, runErr.message);
  const run = runRow as PayrollRun;

  const lines = computed.lines
    .filter((l) => !l.unconfigured || adjustments.has(l.user_id))
    .map((l) => {
      const adj = adjustments.get(l.user_id);
      const withAdj = adj
        ? computePayrollLine({
            days: l.days,
            rules: {
              otMultiplier: computed.rulesSnapshot.ot_multiplier,
              lateMarksPerHalfday: computed.rulesSnapshot.late_marks_per_halfday,
            },
            adjustmentsInr: adj.amount,
          })
        : l;

      return {
        run_id: run.id,
        user_id: l.user_id,
        monthly_salary_inr: withAdj.segments[0]?.monthlySalaryInr ?? 0,
        contracted_hours_per_day: withAdj.segments[0]?.contractedHoursPerDay ?? 0,
        per_minute_paise:
          withAdj.segments[0] && withAdj.segments[0].expectedMinutes > 0
            ? (withAdj.segments[0].monthlySalaryInr * 100) / withAdj.segments[0].expectedMinutes
            : 0,
        days_present: withAdj.daysPresent,
        days_half: withAdj.daysHalf,
        days_absent: withAdj.daysAbsent,
        days_off: withAdj.daysOff,
        days_paid_leave: withAdj.daysPaidLeave,
        worked_minutes: withAdj.workedMinutes,
        ot_minutes: withAdj.otMinutes,
        late_marks: withAdj.lateMarks,
        base_pay_inr: withAdj.basePayInr,
        ot_pay_inr: withAdj.otPayInr,
        deductions_inr: withAdj.deductionsInr,
        adjustments_inr: withAdj.adjustmentsInr,
        net_pay_inr: withAdj.netPayInr,
        // The day-by-day derivation is frozen with the run. PAY-3 renders it,
        // and it is what makes the number trusted rather than re-checked.
        detail: {
          name: l.name,
          segments: withAdj.segments,
          adjustment_reason: adj?.reason ?? '',
          days: l.days.map((d) => ({
            date: d.date,
            status: d.status,
            worked: d.workedMinutes,
            ot: d.otMinutes,
            late: d.isLate,
          })),
        },
      };
    });

  if (lines.length > 0) {
    const { error: lineErr } = await admin.from('payroll_run_lines').insert(lines);
    if (lineErr) {
      // Leave no half-written run behind: a finalized run with missing lines
      // would read as "everyone was paid nothing".
      await admin.from('payroll_runs').delete().eq('id', run.id);
      return errorResponse(500, `Could not write payroll lines: ${lineErr.message}`);
    }
  }

  return NextResponse.json({ run, lines: lines.length });
}

// PATCH { month, reason } — reverse a finalized run.
export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const month = typeof body.month === 'string' ? body.month : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const bounds = monthBounds(month);
  if (!bounds) return errorResponse(400, 'month must look like 2026-08');
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
    .eq('status', 'finalized')
    .select('*')
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return errorResponse(404, 'No finalized run for that month.');
  return NextResponse.json({ run: data });
}
