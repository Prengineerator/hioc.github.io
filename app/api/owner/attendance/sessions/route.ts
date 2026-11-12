import { NextResponse } from 'next/server';
import { getStaffOrOwner } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import { istBusinessDate } from '@/lib/attendance/businessDate';
import { canEditSessionTimes, canSessionTransition } from '@/lib/attendance/sessionState';
import { findPayrollLockForDates, payrollLockedMessage } from '@/lib/payroll/lock';
import type { AttendanceSession } from '@/lib/types';

export const dynamic = 'force-dynamic';

// SHEET-2 (corrections) + SHEET-3 (approvals).
//
// EVERY write here is audited into attendance_edits with a MANDATORY reason.
// That is not ceremony: this endpoint changes what someone gets paid, and an
// unexplained edit to a pay record is precisely what the audit table exists to
// make impossible.
//
// A manual session is permanently marked `source: 'manual'` and stays visually
// distinct everywhere, including payroll. An owner-typed time is a reasonable
// basis for pay; presenting it as a geofence-verified punch would not be.

interface EditRow {
  session_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  edited_by: string;
}

async function audit(rows: EditRow[]): Promise<void> {
  if (rows.length === 0) return;
  const admin = createAdminSupabaseClient();
  const { error } = await admin.from('attendance_edits').insert(rows);
  if (error) {
    // Loud, because an unaudited edit is the failure mode this table prevents.
    console.error('attendance: AUDIT WRITE FAILED for edit', rows, error);
  }
}

function isIsoInstant(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

// PATCH — correct an existing session, or approve it as-is.
//
// Every action goes through the session state machine
// (lib/attendance/sessionState.ts) and every write is compare-and-set on the
// status that was read: a second owner acting on the same row, or the cron
// auto-closing it mid-correction, gets a 409 instead of a silent overwrite.
export async function PATCH(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return errorResponse(401, 'Unauthorized');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
  const action = typeof body.action === 'string' ? body.action : 'edit';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!sessionId) return errorResponse(400, 'session_id is required');
  if (action !== 'approve' && action !== 'void' && action !== 'edit') {
    return errorResponse(400, "action must be 'approve', 'void' or 'edit'");
  }

  // Approving is a lighter act than rewriting a time, so they carry different
  // keys — an owner may want a manager to clear the queue without also being
  // able to change recorded hours.
  const needed = action === 'approve' ? 'attendance_approve' : 'attendance_edit';
  if (!(await hasPermission(account.user, needed))) {
    return errorResponse(403, 'You do not have permission to change attendance.');
  }
  if (!reason) return errorResponse(400, 'A reason is required for every attendance change.');

  const admin = createAdminSupabaseClient();
  const { data: existing, error: readErr } = await admin
    .from('attendance_sessions')
    .select('*')
    .eq('id', sessionId)
    .maybeSingle();
  if (readErr) return errorResponse(500, readErr.message);
  if (!existing) return errorResponse(404, 'That attendance session no longer exists.');
  const session = existing as AttendanceSession;
  const facts = { status: session.status, approvedAt: session.approved_at };

  // PAY-4: a finalized payroll run froze this person's month. Letting a change
  // through now would mean the sheet and the payslip disagree about a month
  // someone has already been paid for (lib/payroll/lock.ts — payroll is
  // finalized per staffer, so only THIS person's runs lock their days).
  async function lockRefusal(dates: string[]): Promise<Response | null> {
    const lock = await findPayrollLockForDates(admin, session.user_id, dates);
    if (lock.error) return errorResponse(500, `Could not check payroll: ${lock.error}`);
    if (lock.run) return errorResponse(409, payrollLockedMessage(lock.run));
    return null;
  }

  if (action === 'approve') {
    // Only an unapproved auto-close — exactly where the sheet offers it. An
    // OPEN session approved here used to keep the stamp through the cron's
    // auto-close and get paid as an approved guess.
    const check = canSessionTransition(facts, 'approve', { reason });
    if (!check.ok) return errorResponse(409, check.message ?? 'That session cannot be approved.');
    const locked = await lockRefusal([session.business_date]);
    if (locked) return locked;

    const { data, error } = await admin
      .from('attendance_sessions')
      .update({ approved_by: account.user.id, approved_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('status', session.status)
      .is('approved_at', null)
      .select('*')
      .maybeSingle();
    if (error) return errorResponse(500, error.message);
    if (!data) return changedUnderYou();
    await audit([
      {
        session_id: sessionId,
        field: 'approved',
        old_value: session.approved_at,
        new_value: 'approved',
        reason,
        edited_by: account.user.id,
      },
    ]);
    return NextResponse.json({ session: data });
  }

  if (action === 'void') {
    const check = canSessionTransition(facts, 'void', { reason });
    if (!check.ok) return errorResponse(409, check.message ?? 'That session cannot be voided.');
    const locked = await lockRefusal([session.business_date]);
    if (locked) return locked;

    const { data, error } = await admin
      .from('attendance_sessions')
      .update({ status: check.rule!.to })
      .eq('id', sessionId)
      .eq('status', session.status)
      .select('*')
      .maybeSingle();
    if (error) return errorResponse(500, error.message);
    if (!data) return changedUnderYou();
    await audit([
      {
        session_id: sessionId,
        field: 'status',
        old_value: session.status,
        new_value: check.rule!.to,
        reason,
        edited_by: account.user.id,
      },
    ]);
    return NextResponse.json({ session: data });
  }

  // --- edit times ----------------------------------------------------------
  // A void session is gone: correcting its times used to flip it straight
  // back to `closed` and stamp it approved, resurrecting a shift someone had
  // deliberately struck out.
  if (!canEditSessionTimes({ status: session.status, approved_at: session.approved_at })) {
    return errorResponse(409, 'That session was voided and cannot be changed.');
  }

  const patch: Record<string, string | null> = {};
  const edits: EditRow[] = [];

  if ('clock_in_at' in body) {
    if (!isIsoInstant(body.clock_in_at)) return errorResponse(400, 'clock_in_at must be a valid time.');
    patch.clock_in_at = body.clock_in_at;
  }
  if ('clock_out_at' in body) {
    if (body.clock_out_at === null) {
      patch.clock_out_at = null;
    } else if (!isIsoInstant(body.clock_out_at)) {
      return errorResponse(400, 'clock_out_at must be a valid time.');
    } else {
      patch.clock_out_at = body.clock_out_at;
    }
  }
  if (Object.keys(patch).length === 0) return errorResponse(400, 'Nothing to change.');

  const nextIn = patch.clock_in_at ?? session.clock_in_at;
  const nextOut = 'clock_out_at' in patch ? patch.clock_out_at : session.clock_out_at;

  // Clearing the clock-out of a finished session would make it `open` again —
  // a second open session the one-open index refuses, or a shift that never
  // ends. The DB CHECK rejects it too; say so plainly instead of a 500.
  if (nextOut === null && session.status !== 'open') {
    return errorResponse(400, 'A finished session needs a clock-out. Void it instead if it should not count.');
  }

  if (nextOut !== null) {
    const inMs = Date.parse(nextIn);
    const outMs = Date.parse(nextOut);
    if (outMs <= inMs) {
      return errorResponse(400, 'Clock-out must be after clock-in.');
    }
    const settings = await getAttendanceSettings();
    // A correction that produces a 30-hour shift is a typo, not a shift. The
    // cap is the same one the auto-close job uses, so the two agree about what
    // "impossibly long" means.
    if (outMs - inMs > settings.max_session_hours * 3_600_000) {
      return errorResponse(
        400,
        `That would be longer than the ${settings.max_session_hours}-hour maximum for a single shift.`,
      );
    }
  }

  // A corrected session is, by definition, resolved (→ closed). Correcting
  // only the clock-in of a session that is still running leaves it open.
  const to = nextOut !== null ? 'closed' : 'open';
  const check = canSessionTransition(facts, 'edit_times', { to, reason });
  if (!check.ok) return errorResponse(409, check.message ?? 'That session cannot be corrected.');
  if (to !== session.status) patch.status = to;

  // Editing clock_in_at moves the business date (the set_attendance_business_date
  // trigger re-derives it), so BOTH the day the session is leaving and the day
  // it is moving to must be outside a finalized month.
  const locked = await lockRefusal([session.business_date, istBusinessDate(nextIn)]);
  if (locked) return locked;

  for (const [field, value] of Object.entries(patch)) {
    const old = (session as unknown as Record<string, string | null>)[field] ?? null;
    if (old !== value) {
      edits.push({
        session_id: sessionId,
        field,
        old_value: old,
        new_value: value,
        reason,
        edited_by: account.user.id,
      });
    }
  }

  // Only a correction that RESOLVES the session carries the corrector's
  // approval; a stamp on a still-open session is what the cron used to inherit.
  const stamp = check.rule!.approval
    ? { approved_by: account.user.id, approved_at: new Date().toISOString() }
    : {};

  const { data, error } = await admin
    .from('attendance_sessions')
    .update({ ...patch, ...stamp })
    .eq('id', sessionId)
    .eq('status', session.status)
    .select('*')
    .maybeSingle();
  if (error) return errorResponse(500, error.message);
  if (!data) return changedUnderYou();

  await audit(edits);
  return NextResponse.json({ session: data });
}

function changedUnderYou(): Response {
  return errorResponse(
    409,
    'That session changed while you were looking at it (approved, voided or closed by someone else). Refresh and try again.',
  );
}

// POST — a manual session for someone who could not punch (dead phone, declined
// location, simply forgot).
export async function POST(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return errorResponse(401, 'Unauthorized');
  if (!(await hasPermission(account.user, 'attendance_edit'))) {
    return errorResponse(403, 'You do not have permission to add attendance.');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const userId = typeof body.user_id === 'string' ? body.user_id : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!userId) return errorResponse(400, 'user_id is required');
  if (!reason) return errorResponse(400, 'A reason is required for a manual entry.');
  if (!isIsoInstant(body.clock_in_at) || !isIsoInstant(body.clock_out_at)) {
    return errorResponse(400, 'A manual entry needs both a clock-in and a clock-out time.');
  }
  const inMs = Date.parse(body.clock_in_at as string);
  const outMs = Date.parse(body.clock_out_at as string);
  if (outMs <= inMs) return errorResponse(400, 'Clock-out must be after clock-in.');

  const settings = await getAttendanceSettings();
  if (outMs - inMs > settings.max_session_hours * 3_600_000) {
    return errorResponse(400, `A single shift cannot exceed ${settings.max_session_hours} hours.`);
  }

  const entry = canSessionTransition(null, 'manual_entry', { reason });
  if (!entry.ok) return errorResponse(400, entry.message ?? 'That entry cannot be added.');

  const admin = createAdminSupabaseClient();

  // PAY-4: a manual shift on a day inside this person's finalized payroll would
  // change a month they have already been paid for. The trigger files a
  // session under the IST date of its clock-in, so that is the day to check.
  const lock = await findPayrollLockForDates(admin, userId, [istBusinessDate(body.clock_in_at as string)]);
  if (lock.error) return errorResponse(500, `Could not check payroll: ${lock.error}`);
  if (lock.run) return errorResponse(409, payrollLockedMessage(lock.run));

  const { data, error } = await admin
    .from('attendance_sessions')
    .insert({
      user_id: userId,
      clock_in_at: body.clock_in_at,
      clock_out_at: body.clock_out_at,
      status: entry.rule!.to,
      // Permanent, and surfaced everywhere: this was typed, not verified.
      source: 'manual',
      approved_by: account.user.id,
      approved_at: new Date().toISOString(),
      notes: reason,
    })
    .select('*')
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return errorResponse(409, 'That person already has an open session — close it first.');
    }
    return errorResponse(500, error.message);
  }

  await audit([
    {
      session_id: (data as AttendanceSession).id,
      field: 'created',
      old_value: null,
      new_value: 'manual session',
      reason,
      edited_by: account.user.id,
    },
  ]);

  return NextResponse.json({ session: data });
}
