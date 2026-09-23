import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { parseTimeToMinutes } from '@/lib/attendance/businessDate';
import type { StaffEmployment } from '@/lib/types';

export const dynamic = 'force-dynamic';

// SHEET-4 — the salary + shift record, effective-dated.
//
// OWNER ONLY. Salary is not manager-delegable in this phase (D5-8) and is not
// readable by the staffer it describes, so this never widens past getOwnerUser().
//
// There is deliberately NO update-in-place. A change writes a NEW row and
// closes the previous one, because a raise must not restate what an earlier
// month was paid at. Editing a rate in place would silently rewrite history
// that someone has already been paid against.

export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('staff_employment')
    .select('*')
    .order('user_id', { ascending: true })
    .order('effective_from', { ascending: false });
  if (error) return errorResponse(500, error.message);

  return NextResponse.json({ records: (data ?? []) as StaffEmployment[] });
}

export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const userId = typeof body.user_id === 'string' ? body.user_id : '';
  const salary = body.monthly_salary_inr;
  const hours = body.contracted_hours_per_day;
  const shiftStart = typeof body.shift_start_time === 'string' ? body.shift_start_time : '';
  const shiftEnd = typeof body.shift_end_time === 'string' ? body.shift_end_time : '';
  const effectiveFrom = typeof body.effective_from === 'string' ? body.effective_from : '';
  const weeklyOff = body.weekly_off_dow;

  if (!userId) return errorResponse(400, 'user_id is required');
  if (typeof salary !== 'number' || !Number.isInteger(salary) || salary < 0) {
    return errorResponse(400, 'Monthly salary must be a whole number of rupees.');
  }
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24) {
    return errorResponse(400, 'Contracted hours must be between 0 and 24.');
  }
  if (parseTimeToMinutes(shiftStart) === null || parseTimeToMinutes(shiftEnd) === null) {
    return errorResponse(400, 'Shift start and end must be times like 10:00.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    return errorResponse(400, 'effective_from must be a date like 2026-08-01.');
  }
  if (weeklyOff !== null && weeklyOff !== undefined) {
    if (typeof weeklyOff !== 'number' || !Number.isInteger(weeklyOff) || weeklyOff < 0 || weeklyOff > 6) {
      return errorResponse(400, 'Weekly off must be a day number 0 (Sunday) to 6, or empty.');
    }
  }

  const admin = createAdminSupabaseClient();

  // Close any record still open at the new start date. The DB's exclusion
  // constraint would reject an overlap anyway; doing it here means the owner
  // gets "your new rate starts on the 1st" instead of a raw constraint error.
  const { data: openRows, error: openErr } = await admin
    .from('staff_employment')
    .select('id, effective_from, effective_to')
    .eq('user_id', userId)
    .is('effective_to', null);
  if (openErr) return errorResponse(500, openErr.message);

  for (const row of (openRows ?? []) as { id: string; effective_from: string }[]) {
    if (row.effective_from >= effectiveFrom) {
      return errorResponse(
        400,
        `There is already a record starting ${row.effective_from}. A new record must start after it.`,
      );
    }
    const { error: closeErr } = await admin
      .from('staff_employment')
      .update({ effective_to: effectiveFrom })
      .eq('id', row.id);
    if (closeErr) return errorResponse(500, `Could not close the previous record: ${closeErr.message}`);
  }

  const { data, error } = await admin
    .from('staff_employment')
    .insert({
      user_id: userId,
      monthly_salary_inr: salary,
      contracted_hours_per_day: hours,
      shift_start_time: shiftStart,
      shift_end_time: shiftEnd,
      weekly_off_dow: weeklyOff ?? null,
      effective_from: effectiveFrom,
      created_by: owner.id,
    })
    .select('*')
    .single();

  if (error) {
    // 23P01 = the exclusion constraint. Two records covering the same day would
    // make "the rate in effect that day" ambiguous, and payroll would silently
    // pick one.
    if ((error as { code?: string }).code === '23P01') {
      return errorResponse(400, 'That period overlaps an existing record for this person.');
    }
    return errorResponse(500, error.message);
  }

  return NextResponse.json({ record: data });
}
