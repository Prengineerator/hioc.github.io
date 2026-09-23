import { NextResponse } from 'next/server';
import { getStaffOrOwner } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getAttendanceSettings } from '@/lib/attendance/settings';
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
export async function PATCH(request: Request) {
  const account = await getStaffOrOwner();
  if (!account) return errorResponse(401, 'Unauthorized');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
  const action = typeof body.action === 'string' ? body.action : 'edit';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!sessionId) return errorResponse(400, 'session_id is required');

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

  // PAY-4: a finalized payroll run froze this day's numbers. Letting an edit
  // through now would mean the sheet and the payslip disagree about a month
  // someone has already been paid for.
  const { data: lockingRun } = await admin
    .from('payroll_runs')
    .select('id, period_start, period_end')
    .eq('status', 'finalized')
    .lte('period_start', session.business_date)
    .gte('period_end', session.business_date)
    .maybeSingle();
  if (lockingRun) {
    return errorResponse(
      409,
      'That day is inside a finalized payroll run. Reverse the run first if it genuinely needs correcting.',
    );
  }

  if (action === 'approve') {
    const { data, error } = await admin
      .from('attendance_sessions')
      .update({ approved_by: account.user.id, approved_at: new Date().toISOString() })
      .eq('id', sessionId)
      .select('*')
      .maybeSingle();
    if (error) return errorResponse(500, error.message);
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
    const { data, error } = await admin
      .from('attendance_sessions')
      .update({ status: 'void' })
      .eq('id', sessionId)
      .select('*')
      .maybeSingle();
    if (error) return errorResponse(500, error.message);
    await audit([
      {
        session_id: sessionId,
        field: 'status',
        old_value: session.status,
        new_value: 'void',
        reason,
        edited_by: account.user.id,
      },
    ]);
    return NextResponse.json({ session: data });
  }

  // --- edit times ----------------------------------------------------------
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
    // A corrected session is, by definition, resolved.
    patch.status = 'closed';
  }

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

  const { data, error } = await admin
    .from('attendance_sessions')
    .update({ ...patch, approved_by: account.user.id, approved_at: new Date().toISOString() })
    .eq('id', sessionId)
    .select('*')
    .maybeSingle();
  if (error) return errorResponse(500, error.message);

  await audit(edits);
  return NextResponse.json({ session: data });
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

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('attendance_sessions')
    .insert({
      user_id: userId,
      clock_in_at: body.clock_in_at,
      clock_out_at: body.clock_out_at,
      status: 'closed',
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
