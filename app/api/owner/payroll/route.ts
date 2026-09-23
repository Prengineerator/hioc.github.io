import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import { loadEmploymentRows, employmentOnDate, toDayEmployment } from '@/lib/attendance/employment';
import { rollUpDay, dayOfWeekFor, type DaySession, type DayMark } from '@/lib/attendance/day';
import { computePayrollLine, type PayrollDayInput } from '@/lib/payroll/compute';
import { sendPayslipsForRun } from '@/lib/payroll/payslipEmail';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
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
  return NextResponse.json({
    month: computed.month,
    bounds: computed.bounds,
    lines: computed.lines,
    blocked: computed.blocked,
    rulesSnapshot: computed.rulesSnapshot,
    finalized: false,
    run,
  });
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
            // Recomputing for a manual adjustment must not drop the cash
            // shortage that was already priced into `l` — otherwise adding
            // any adjustment would silently waive an approved shortage.
            cashShortageInr: l.cashShortageInr,
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
        cash_shortage_inr: withAdj.cashShortageInr,
        adjustments_inr: withAdj.adjustmentsInr,
        net_pay_inr: withAdj.netPayInr,
        // The day-by-day derivation is frozen with the run. PAY-3 renders it,
        // and it is what makes the number trusted rather than re-checked.
        detail: {
          name: l.name,
          segments: withAdj.segments,
          adjustment_reason: adj?.reason ?? '',
          cash_shortage_clamped: withAdj.cashShortageClamped,
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

  // CC-5: the run and its lines are written — cash_shortage_inr is frozen
  // into each line above. Now mark exactly those shortage rows consumed
  // (payroll_run_id = run.id) so a later month's finalize never deducts them
  // again. Scoped to the users who actually got a payroll_run_line here —
  // computed.shortageRows came from the SAME query that produced each line's
  // cashShortageInr, so this can't drift from what was frozen. The run and
  // its lines already stand at this point; a failure here must not undo them
  // (that would double-charge nobody but silently un-freeze correct numbers),
  // so it is reported in the response instead of failing the request.
  const paidUserIds = new Set(lines.map((l) => l.user_id));
  const shortageIdsToMark = computed.shortageRows
    .filter((r) => paidUserIds.has(r.user_id))
    .map((r) => r.id);

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

  // SA-5: one payslip email per line, to the personal email on file. This is
  // best-effort — a finalized run must stand even if every email fails, so
  // sendPayslipsForRun never throws and any failure here is swallowed too.
  let payslips: Awaited<ReturnType<typeof sendPayslipsForRun>> = [];
  try {
    payslips = await sendPayslipsForRun(admin, run.id);
  } catch (err) {
    console.error('sendPayslipsForRun threw during finalize', run.id, err);
  }

  return NextResponse.json({
    run,
    lines: lines.length,
    payslips,
    cashShortagesMarked,
    ...(cashShortageMarkError ? { cashShortageMarkError } : {}),
  });
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
  const run = data as PayrollRun;

  // CC-5: this run's shortages were marked payroll_run_id = run.id at
  // finalize so they'd never be deducted twice. Reversing without undoing
  // that mark would strand them forever — no future month's compute would
  // ever pick them up again (they're not "unconsumed" any more). Clear it so
  // the next finalize (for this month or any other) re-includes them.
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
