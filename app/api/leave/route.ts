import { NextResponse } from 'next/server';
import { getCounterActor } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import {
  plannableWeek,
  isRequestableDate,
  isWindowOpen,
  daysUntilDeadline,
  formatLeaveDate,
} from '@/lib/leave/week';
import { canLeaveTransition, HELD_LEAVE_STATUSES } from '@/lib/leave/state';
import { findPayrollLock, payrollLockedMessage } from '@/lib/payroll/lock';
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
//
// Every status change goes through the leave state machine (lib/leave/state.ts)
// and is compare-and-set on the status that was read, so a manager's decision
// landing at the same moment is never silently overwritten.
//
// PIN-3: gated by getCounterActor() — the operator IS the person, and their
// PIN on a trusted counter proves that the same way a classic session does.
// Classic session first, unchanged; the device path only when there is no
// session at all.

/** The caller's own requests for the plannable week, plus the week itself. */
export async function GET() {
  const account = await getCounterActor();
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

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/** PAY-4: a day inside this person's finalized payroll cannot change. */
async function payrollLockRefusal(admin: Admin, userId: string, leaveDate: string): Promise<Response | null> {
  const lock = await findPayrollLock(admin, userId, leaveDate);
  if (lock.error) return errorResponse(500, `Could not check payroll: ${lock.error}`);
  if (lock.run) return errorResponse(409, payrollLockedMessage(lock.run));
  return null;
}

function changedUnderYou(): Response {
  return errorResponse(409, 'That day changed while you were planning it (your manager may have just decided it). Refresh and try again.');
}

// POST { leave_date, reason? } — request a day off.
export async function POST(request: Request) {
  const account = await getCounterActor();
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

  const userId = account.user.id;
  const admin = createAdminSupabaseClient();
  const settings = await getAttendanceSettings();

  const locked = await payrollLockRefusal(admin, userId, leaveDate);
  if (locked) return locked;

  // What is already on record for this exact day decides the move: a fresh
  // ask, a re-ask after a decline or withdrawal — or nothing, if the day is
  // already approved. The old blind upsert reset an APPROVED day to
  // 'requested', silently undoing the manager's decision.
  const { data: currentRow, error: currentErr } = await admin
    .from('leave_requests')
    .select('*')
    .eq('user_id', userId)
    .eq('leave_date', leaveDate)
    .maybeSingle();
  if (currentErr) return errorResponse(500, 'Could not check your existing plan');
  const current = (currentRow ?? null) as LeaveRequest | null;

  const check = canLeaveTransition(current?.status ?? null, 'request');
  if (!check.ok) return errorResponse(409, check.message ?? 'That day cannot be requested.');

  // Count what they already hold this week, excluding the day being requested
  // (so re-requesting a declined day is not blocked by itself).
  const held = await heldThisWeek(admin, userId, week.weekStart);
  if (held === null) return errorResponse(500, 'Could not check your existing plan');
  if (held.filter((r) => r.leave_date !== leaveDate).length >= settings.max_leave_days_per_week) {
    return errorResponse(400, capMessage(settings.max_leave_days_per_week));
  }

  const fields = {
    week_start: week.weekStart,
    status: check.rule!.to,
    reason,
    decided_by: null,
    decided_at: null,
    decision_note: '',
  };

  let saved: LeaveRequest | null = null;
  if (!current) {
    const { data, error } = await admin
      .from('leave_requests')
      .insert({ user_id: userId, leave_date: leaveDate, ...fields })
      .select('*')
      .single();
    if (error) {
      // 23505 = (user_id, leave_date) — a second tap or another device created
      // the row between our read and this insert.
      if ((error as { code?: string }).code === '23505') return changedUnderYou();
      // 23514 = one of the weekday / Monday / within-week CHECKs. Reaching this
      // means the client sent something the date guards above should have caught.
      if ((error as { code?: string }).code === '23514') {
        return errorResponse(400, 'That date cannot be taken as leave.');
      }
      return errorResponse(500, error.message);
    }
    saved = data as LeaveRequest;
  } else {
    const { data, error } = await admin
      .from('leave_requests')
      .update(fields)
      .eq('id', current.id)
      .eq('user_id', userId)
      .eq('status', current.status)
      .select('*')
      .maybeSingle();
    if (error) {
      if ((error as { code?: string }).code === '23514') {
        return errorResponse(400, 'That date cannot be taken as leave.');
      }
      return errorResponse(500, error.message);
    }
    if (!data) return changedUnderYou();
    saved = data as LeaveRequest;
  }

  // The per-week cap is read-then-write: two requests for DIFFERENT days of
  // the same week (two devices, a double tap) can both pass the count above.
  // Re-count now that ours is written; if the week is over the cap, take ours
  // back and say so. Two racers may both step back — the safe direction; one
  // retry settles it. (An airtight cap needs a DB constraint; this keeps the
  // week from silently holding more days than the owner allows.)
  const after = await heldThisWeek(admin, userId, week.weekStart);
  if (after !== null && after.length > settings.max_leave_days_per_week) {
    await revertRequest(admin, saved, current);
    return errorResponse(
      409,
      `${capMessage(settings.max_leave_days_per_week)} Another request for this week was saved at the same moment — refresh and try again.`,
    );
  }

  return NextResponse.json({ request: saved });
}

function capMessage(max: number): string {
  return max === 1
    ? 'You already have a day planned for next week. Withdraw it first to pick a different one.'
    : `You can plan at most ${max} days off in a week.`;
}

async function heldThisWeek(
  admin: Admin,
  userId: string,
  weekStart: string,
): Promise<{ id: string; leave_date: string }[] | null> {
  const { data, error } = await admin
    .from('leave_requests')
    .select('id, leave_date, status')
    .eq('user_id', userId)
    .eq('week_start', weekStart)
    .in('status', [...HELD_LEAVE_STATUSES]);
  if (error) return null;
  return (data ?? []) as { id: string; leave_date: string }[];
}

/** Undo our own write after losing the cap race — compare-and-set on the status we wrote. */
async function revertRequest(admin: Admin, saved: LeaveRequest, previous: LeaveRequest | null): Promise<void> {
  const q = previous
    ? admin
        .from('leave_requests')
        .update({
          status: previous.status,
          reason: previous.reason,
          decided_by: previous.decided_by,
          decided_at: previous.decided_at,
          decision_note: previous.decision_note,
        })
        .eq('id', saved.id)
        .eq('status', saved.status)
    : admin.from('leave_requests').delete().eq('id', saved.id).eq('status', saved.status);
  const { error } = await q;
  if (error) console.error('leave: could not take back an over-cap request', saved.id, error);
}

// DELETE { leave_date } — withdraw a pending request, while the window is open.
//
// Only a day in the week being planned, and only while it is still a REQUEST.
// This used to check next week's window and then withdraw by date with no week
// filter at all, so a staffer could strike out leave from any week — including
// a past, approved day payroll had already counted as their day off.
export async function DELETE(request: Request) {
  const account = await getCounterActor();
  if (!account) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const leaveDate = typeof body.leave_date === 'string' ? body.leave_date : '';
  if (!leaveDate) return errorResponse(400, 'leave_date is required');

  const week = plannableWeek();
  if (!isRequestableDate(week, leaveDate)) {
    return errorResponse(409, 'You can only withdraw days in the week you are planning — ask your manager to change it.');
  }
  if (!isWindowOpen(week)) {
    return errorResponse(409, 'Planning for next week has closed — ask your manager to change it.');
  }

  const userId = account.user.id;
  const admin = createAdminSupabaseClient();

  // Scoped to the caller's own user_id: nobody withdraws anyone else's leave.
  const { data: row, error: readErr } = await admin
    .from('leave_requests')
    .select('*')
    .eq('user_id', userId)
    .eq('week_start', week.weekStart)
    .eq('leave_date', leaveDate)
    .maybeSingle();
  if (readErr) return errorResponse(500, readErr.message);
  const current = (row ?? null) as LeaveRequest | null;
  if (!current || current.status === 'withdrawn') {
    return errorResponse(404, 'No leave request found for that day.');
  }

  const check = canLeaveTransition(current.status, 'withdraw');
  if (!check.ok) return errorResponse(409, check.message ?? 'That day cannot be withdrawn.');

  const locked = await payrollLockRefusal(admin, userId, leaveDate);
  if (locked) return locked;

  const { data, error } = await admin
    .from('leave_requests')
    .update({ status: check.rule!.to })
    .eq('id', current.id)
    .eq('user_id', userId)
    .eq('status', current.status)
    .select('*')
    .maybeSingle();
  if (error) return errorResponse(500, error.message);
  if (!data) return changedUnderYou();

  return NextResponse.json({ request: data });
}
