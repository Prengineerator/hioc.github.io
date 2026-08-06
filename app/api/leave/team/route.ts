import { NextResponse } from 'next/server';
import { getStaffOrOwner } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import {
  plannableWeek,
  leaveWeekFor,
  isWindowOpen,
  daysUntilDeadline,
  formatLeaveDate,
} from '@/lib/leave/week';
import type { LeaveRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

// LEAVE-2 — the manager's view of next week, and the approve/decline action.
//
// AUTHORIZATION: `leave_approve`, seeded at manager. Flat hierarchy by decision:
// any manager sees every staff member, because this is one cafe with one floor
// and there are no reporting lines to model. If that ever changes, the change is
// a filter here, not a redesign.

export async function GET(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return unauthorized();
  if (!(await hasPermission(account.user, 'leave_approve'))) {
    return errorResponse(403, 'You do not have access to the team leave plan.');
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get('week');
  const week = requested ? leaveWeekFor(requested) : plannableWeek();
  if (!week) return errorResponse(400, 'week must be a Monday, like 2026-08-10');

  const admin = createAdminSupabaseClient();

  const [{ data: profileRows, error: profileErr }, { data: leaveRows, error: leaveErr }] =
    await Promise.all([
      admin
        .from('profiles')
        .select('id, name, role')
        .in('role', ['staff', 'manager'])
        .order('name', { ascending: true }),
      admin
        .from('leave_requests')
        .select('*')
        .eq('week_start', week.weekStart)
        .neq('status', 'withdrawn'),
    ]);
  if (profileErr) return errorResponse(500, profileErr.message);
  if (leaveErr) return errorResponse(500, leaveErr.message);

  const people = (profileRows ?? []) as { id: string; name: string; role: string }[];
  const requests = (leaveRows ?? []) as LeaveRequest[];

  const byUser = new Map<string, LeaveRequest[]>();
  for (const r of requests) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(r);
    byUser.set(r.user_id, list);
  }

  // Per-day headcount, counting only what is live. This is the number that
  // makes the screen worth opening: three of four people picking Friday is a
  // coverage problem, and the manager should see it before Monday rather than
  // on Friday morning.
  const perDay = week.requestableDates.map((date) => {
    const onDate = requests.filter((r) => r.leave_date === date);
    return {
      date,
      label: formatLeaveDate(date),
      approved: onDate.filter((r) => r.status === 'approved').length,
      requested: onDate.filter((r) => r.status === 'requested').length,
    };
  });

  const rows = people.map((p) => ({
    user_id: p.id,
    name: p.name || '(no name)',
    role: p.role,
    requests: (byUser.get(p.id) ?? []).sort((a, b) => (a.leave_date < b.leave_date ? -1 : 1)),
    /** Nobody has planned anything — the person a reminder should target. */
    hasPlanned: (byUser.get(p.id) ?? []).length > 0,
  }));

  return NextResponse.json({
    week: {
      ...week,
      labels: week.requestableDates.map(formatLeaveDate),
      daysLeft: daysUntilDeadline(week),
      open: isWindowOpen(week),
    },
    rows,
    perDay,
    teamSize: people.length,
    pending: requests.filter((r) => r.status === 'requested').length,
    notPlanned: rows.filter((r) => !r.hasPlanned).length,
  });
}

// PATCH { id, action: 'approve' | 'decline', note? }
export async function PATCH(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return unauthorized();
  if (!(await hasPermission(account.user, 'leave_approve'))) {
    return errorResponse(403, 'You do not have permission to decide leave.');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const id = typeof body.id === 'string' ? body.id : '';
  const action = body.action;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!id) return errorResponse(400, 'id is required');
  if (action !== 'approve' && action !== 'decline') {
    return errorResponse(400, "action must be 'approve' or 'decline'");
  }
  // A decline without a reason is the one an argument starts over.
  if (action === 'decline' && !note) {
    return errorResponse(400, 'Please say why you are declining — the staffer sees this.');
  }

  const admin = createAdminSupabaseClient();

  // Status-guarded so two managers acting at once cannot overwrite each other:
  // the second one matches zero rows and is told what already happened.
  const { data, error } = await admin
    .from('leave_requests')
    .update({
      status: action === 'approve' ? 'approved' : 'declined',
      decided_by: account.user.id,
      decided_at: new Date().toISOString(),
      decision_note: note,
    })
    .eq('id', id)
    .in('status', ['requested', 'approved', 'declined'])
    .select('*')
    .maybeSingle();

  if (error) return errorResponse(500, error.message);
  if (!data) return errorResponse(409, 'That request was withdrawn or no longer exists.');

  return NextResponse.json({ request: data });
}
