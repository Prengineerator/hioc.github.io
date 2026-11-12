import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { parseTimeToMinutes } from '@/lib/attendance/businessDate';
import { planEmploymentChange } from '@/lib/attendance/employmentState';
import { END_OF_TIME, findPayrollLock, lockedMonthLabel } from '@/lib/payroll/lock';
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

  // PAY-4: a new record prices EVERY day from effective_from on, so a
  // finalized payroll month anywhere on or after it would be restated — the
  // sheet and an already-paid payslip would disagree (lib/payroll/lock.ts).
  const lock = await findPayrollLock(admin, userId, effectiveFrom, END_OF_TIME);
  if (lock.error) return errorResponse(500, `Could not check payroll: ${lock.error}`);
  if (lock.run) {
    return errorResponse(
      409,
      `A record starting ${effectiveFrom} would change ${lockedMonthLabel(lock.run)}, which is inside this person's finalized payroll. Reverse that month first, or start the record after it.`,
    );
  }

  // Close any record still open at the new start date. The DB's exclusion
  // constraint would reject an overlap anyway; doing it here means the owner
  // gets "your new rate starts on the 1st" instead of a raw constraint error.
  const { data: openRows, error: openErr } = await admin
    .from('staff_employment')
    .select('id, effective_from, effective_to')
    .eq('user_id', userId)
    .is('effective_to', null);
  if (openErr) return errorResponse(500, openErr.message);

  const plan = planEmploymentChange(
    (openRows ?? []) as { id: string; effective_from: string; effective_to: string | null }[],
    effectiveFrom,
  );
  if (!plan.ok) return errorResponse(400, plan.message!);

  // Close first (the exclusion constraint forbids inserting the new row while
  // the old one is still open — lib/attendance/employmentState.ts), each close
  // compare-and-set on effective_to IS NULL so a concurrent change is a 409,
  // and every close is undone if a later step fails: the person must never be
  // left with no current rate.
  const closed: string[] = [];
  for (const id of plan.toClose) {
    const { data: closedRow, error: closeErr } = await admin
      .from('staff_employment')
      .update({ effective_to: effectiveFrom })
      .eq('id', id)
      .is('effective_to', null)
      .select('id')
      .maybeSingle();
    if (closeErr || !closedRow) {
      const restoreError = await restoreClosed(admin, closed, effectiveFrom);
      if (closeErr) {
        return errorResponse(500, `Could not close the previous record: ${closeErr.message}${restoreError}`);
      }
      return errorResponse(409, `That person's record changed while you were editing it. Refresh and try again.${restoreError}`);
    }
    closed.push(id);
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
    // The new rate did not land, so the one we just closed must be current
    // again — otherwise payroll finds no rate from effectiveFrom on and the
    // person reads as "not employed".
    const restoreError = await restoreClosed(admin, closed, effectiveFrom);
    // 23P01 = the exclusion constraint. Two records covering the same day would
    // make "the rate in effect that day" ambiguous, and payroll would silently
    // pick one.
    if ((error as { code?: string }).code === '23P01') {
      return errorResponse(400, `That period overlaps an existing record for this person.${restoreError}`);
    }
    return errorResponse(500, `${error.message}${restoreError}`);
  }

  return NextResponse.json({ record: data });
}

/**
 * Re-opens rows this request closed at `effectiveFrom` (compare-and-set on
 * that value, so a row someone else has since changed is left alone). Returns
 * '' on success, or a sentence for the error response naming what is now
 * wrong — a silent failure here is a person with no current salary.
 */
async function restoreClosed(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  ids: string[],
  effectiveFrom: string,
): Promise<string> {
  const stuck: string[] = [];
  for (const id of ids) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      const { error } = await admin
        .from('staff_employment')
        .update({ effective_to: null })
        .eq('id', id)
        .eq('effective_to', effectiveFrom);
      ok = !error;
      if (error) console.error('employment: could not re-open a closed record', id, error);
    }
    if (!ok) stuck.push(id);
  }
  return stuck.length === 0
    ? ''
    : ` The previous record was left closed on ${effectiveFrom} and could not be re-opened — add the new record again, or the person has no rate from that date.`;
}
