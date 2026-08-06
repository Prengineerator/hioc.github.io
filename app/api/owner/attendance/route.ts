import { NextResponse } from 'next/server';
import { getStaffOrOwner } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import { loadEmploymentRows, employmentOnDate, toDayEmployment } from '@/lib/attendance/employment';
import { rollUpDay, dayOfWeekFor, type DaySession, type DayMark } from '@/lib/attendance/day';
import type { AttendanceSession, StaffEmployment } from '@/lib/types';

export const dynamic = 'force-dynamic';

// SHEET-1 — the owner's month grid.
//
// AUTHORIZATION: D5-8 — a MANAGER may see the sheet and approve; only the owner
// sees money. So this is gated on `attendance_approve` (seeded at manager)
// rather than getOwnerUser(), and it returns no salary field at all. The
// payroll routes, which do carry money, are owner-only.

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

export async function GET(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return errorResponse(401, 'Unauthorized');
  if (!(await hasPermission(account.user, 'attendance_approve'))) {
    return errorResponse(403, 'You do not have access to the attendance sheet.');
  }

  const url = new URL(request.url);
  const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
  const bounds = monthBounds(month);
  if (!bounds) return errorResponse(400, 'month must look like 2026-08');

  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();

  // Everyone on the team, so a person with no punches still shows a row —
  // a whole month of nothing is a fact the owner needs to see, and filtering
  // to "people who punched" would hide exactly that.
  const { data: profileRows, error: profileErr } = await admin
    .from('profiles')
    .select('id, name, role')
    .in('role', ['staff', 'manager', 'owner'])
    .order('name', { ascending: true });
  if (profileErr) return errorResponse(500, profileErr.message);
  const people = (profileRows ?? []) as { id: string; name: string; role: string }[];

  const [{ data: sessionRows, error: sessErr }, { data: markRows }, { data: leaveRows }, employment] = await Promise.all([
    admin
      .from('attendance_sessions')
      .select('*')
      .gte('business_date', bounds.from)
      .lte('business_date', bounds.to)
      .order('clock_in_at', { ascending: true }),
    admin
      .from('attendance_day_marks')
      .select('user_id, business_date, mark, reason')
      .gte('business_date', bounds.from)
      .lte('business_date', bounds.to),
    // Approved leave is the week's rostered day off (LEAVE). Without this the
    // sheet would mark someone ABSENT on a day their manager had cleared.
    admin
      .from('leave_requests')
      .select('user_id, leave_date')
      .eq('status', 'approved')
      .gte('leave_date', bounds.from)
      .lte('leave_date', bounds.to),
    loadEmploymentRows(bounds.from, bounds.to),
  ]);
  if (sessErr) return errorResponse(500, sessErr.message);

  const sessions = (sessionRows ?? []) as AttendanceSession[];
  const marks = (markRows ?? []) as { user_id: string; business_date: string; mark: DayMark }[];

  const rules = {
    gracePeriodMin: settings.grace_period_min,
    otThresholdMin: settings.ot_threshold_min,
    autoBreakMin: settings.auto_break_min,
    autoBreakAfterMin: settings.auto_break_after_min,
    halfDayMinMinutes: settings.half_day_min_minutes,
    absentBelowMinutes: settings.absent_below_minutes,
  };

  const sessionKey = (userId: string, date: string) => `${userId}|${date}`;
  const byUserDate = new Map<string, AttendanceSession[]>();
  for (const s of sessions) {
    const k = sessionKey(s.user_id, s.business_date);
    const list = byUserDate.get(k) ?? [];
    list.push(s);
    byUserDate.set(k, list);
  }
  const markByUserDate = new Map(marks.map((m) => [sessionKey(m.user_id, m.business_date), m.mark]));

  // Only dates that actually appear here get `scheduledOff` passed. Everything
  // else leaves it undefined, so rollUpDay falls back to the fixed weekly_off_dow
  // — which is what keeps weeks predating the leave feature computing correctly.
  const approvedLeave = new Set(
    ((leaveRows ?? []) as { user_id: string; leave_date: string }[]).map((l) =>
      sessionKey(l.user_id, l.leave_date),
    ),
  );
  const leaveWeeksSeen = new Set(
    ((leaveRows ?? []) as { user_id: string; leave_date: string }[]).map(
      (l) => `${l.user_id}|${l.leave_date.slice(0, 7)}`,
    ),
  );

  const dates = eachDate(bounds.from, bounds.to);
  const employmentRows = employment as StaffEmployment[];

  const rows = people.map((person) => {
    const days = dates.map((date) => {
      const raw = byUserDate.get(sessionKey(person.id, date)) ?? [];
      const daySessions: DaySession[] = raw.map((s) => ({
        id: s.id,
        clockInAt: s.clock_in_at,
        clockOutAt: s.clock_out_at,
        status: s.status,
        source: s.source,
        approvedAt: s.approved_at,
        flags: s.flags ?? [],
      }));
      return rollUpDay({
        date,
        sessions: daySessions,
        rules,
        employment: toDayEmployment(employmentOnDate(employmentRows, person.id, date)),
        mark: markByUserDate.get(sessionKey(person.id, date)) ?? null,
        // Supplied only when this person has SOME approved leave in the month;
        // otherwise undefined so the fixed rostered day still applies.
        scheduledOff: leaveWeeksSeen.has(`${person.id}|${date.slice(0, 7)}`)
          ? approvedLeave.has(sessionKey(person.id, date))
          : undefined,
        dayOfWeek: dayOfWeekFor(date),
      });
    });

    const counted = days.filter((d) => d.status !== 'not_employed');
    return {
      user_id: person.id,
      name: person.name || '(no name)',
      role: person.role,
      // Whether they are set up for payroll at all. A missing record must be
      // visible, not silently computed as zero.
      configured: employmentOnDate(employmentRows, person.id, bounds.to) !== null,
      days,
      totals: {
        present: counted.filter((d) => d.status === 'present').length,
        half: counted.filter((d) => d.status === 'half_day').length,
        absent: counted.filter((d) => d.status === 'absent').length,
        off: counted.filter((d) => d.status === 'weekly_off').length,
        paidLeave: counted.filter((d) => d.status === 'paid_leave').length,
        needsApproval: counted.filter((d) => d.needsApproval).length,
        lateMarks: counted.filter((d) => d.isLate).length,
        workedMinutes: counted.reduce((a, d) => a + d.workedMinutes, 0),
        otMinutes: counted.reduce((a, d) => a + d.otMinutes, 0),
      },
    };
  });

  return NextResponse.json({
    month,
    dates,
    rows,
    needsApprovalTotal: rows.reduce((a, r) => a + r.totals.needsApproval, 0),
  });
}
