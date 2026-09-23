import { NextResponse } from 'next/server';
import { getStaffOrOwner } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import {
  plannableWeek,
  leaveWeekFor,
  isRequestableDate,
  isWindowOpen,
  daysUntilDeadline,
  formatLeaveDate,
} from '@/lib/leave/week';
import type { LeaveRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

// LEAVE-2 — a staffer's own leave for next week.
//
// AUTHORIZATION: a valid staff session, nothing more. Requesting a day off is
// deliberately NOT behind hasPermission() — that helper fails closed to manager
// for an unseeded key, and a missing seed row would stop the entire team from
// asking for leave (SECURITY-PLAYBOOK A-4, same reasoning as punching).
//
// THE WINDOW IS ENFORCED HERE, not in the UI. A closed window that only the
// browser knows about is not closed.

/** The caller's own requests for the plannable week, plus the week itself. */
export async function GET() {
  const account = await getStaffOrOwner();
  if (!account) return unauthorized();

  const week = plannableWeek();
  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();

  const { data, error } = await admin
    .from('leave_requests')
    .select('*')
    .eq('user_id', account.user.id)
    .gte('week_start', week.weekStart)
    .neq('status', 'withdrawn')
    .order('leave_date', { ascending: true });
  if (error) return errorResponse(500, 'Could not load your leave plan');

  return NextResponse.json({
    week: {
      ...week,
      labels: week.requestableDates.map(formatLeaveDate),
      daysLeft: daysUntilDeadline(week),
      open: isWindowOpen(week),
    },
    requests: (data ?? []) as LeaveRequest[],
    maxPerWeek: settings.max_leave_days_per_week,
  });
}

// POST { leave_date, reason? } — request a day off.
export async function POST(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const leaveDate = typeof body.leave_date === 'string' ? body.leave_date : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (!leaveDate) return errorResponse(400, 'leave_date is required');

  // The week is derived from the requested DATE, never taken from the client —
  // otherwise a caller could pair a valid date with someone else's week and
  // slip past the window check.
  const week = plannableWeek();
  if (!isRequestableDate(week, leaveDate)) {
    return errorResponse(
      400,
      `You can only plan ${formatLeaveDate(week.requestableDates[0])} to ${formatLeaveDate(
        week.requestableDates[4],
      )}. Weekends aren't available for leave.`,
    );
  }
  if (!isWindowOpen(week)) {
    return errorResponse(409, 'Planning for next week has closed. Speak to your manager.');
  }

  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();

  // Count what they already hold this week, excluding the day being requested
  // (so re-requesting a declined day is not blocked by itself).
  const { data: existing, error: readErr } = await admin
    .from('leave_requests')
    .select('id, leave_date, status')
    .eq('user_id', account.user.id)
    .eq('week_start', week.weekStart)
    .in('status', ['requested', 'approved']);
  if (readErr) return errorResponse(500, 'Could not check your existing plan');

  const held = ((existing ?? []) as { leave_date: string }[]).filter(
    (r) => r.leave_date !== leaveDate,
  );
  if (held.length >= settings.max_leave_days_per_week) {
    return errorResponse(
      400,
      settings.max_leave_days_per_week === 1
        ? 'You already have a day planned for next week. Withdraw it first to pick a different one.'
        : `You can plan at most ${settings.max_leave_days_per_week} days off in a week.`,
    );
  }

  // Upsert on (user_id, leave_date): asking again for a day previously declined
  // or withdrawn re-opens it as a fresh request rather than erroring.
  const { data, error } = await admin
    .from('leave_requests')
    .upsert(
      {
        user_id: account.user.id,
        week_start: week.weekStart,
        leave_date: leaveDate,
        status: 'requested',
        reason,
        decided_by: null,
        decided_at: null,
        decision_note: '',
      },
      { onConflict: 'user_id,leave_date' },
    )
    .select('*')
    .single();

  if (error) {
    // 23514 = one of the weekday / Monday / within-week CHECKs. Reaching this
    // means the client sent something the date guards above should have caught.
    if ((error as { code?: string }).code === '23514') {
      return errorResponse(400, 'That date cannot be taken as leave.');
    }
    return errorResponse(500, error.message);
  }

  return NextResponse.json({ request: data });
}

// DELETE { leave_date } — withdraw, while the window is still open.
export async function DELETE(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const leaveDate = typeof body.leave_date === 'string' ? body.leave_date : '';
  if (!leaveDate) return errorResponse(400, 'leave_date is required');

  const week = leaveWeekFor(plannableWeek().weekStart)!;
  if (!isWindowOpen(week)) {
    return errorResponse(409, 'Planning for next week has closed — ask your manager to change it.');
  }

  const admin = createAdminSupabaseClient();
  // Scoped to the caller's own user_id: nobody withdraws anyone else's leave.
  const { data, error } = await admin
    .from('leave_requests')
    .update({ status: 'withdrawn' })
    .eq('user_id', account.user.id)
    .eq('leave_date', leaveDate)
    .select('*')
    .maybeSingle();
  if (error) return errorResponse(500, error.message);
  if (!data) return errorResponse(404, 'No leave request found for that day.');

  return NextResponse.json({ request: data });
}
