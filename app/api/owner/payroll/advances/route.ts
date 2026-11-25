import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { istDateIso } from '@/lib/api/date';
import { isUuid } from '@/lib/api/constants';
import { isAdvanceCounted } from '@/lib/payroll/advances';

export const dynamic = 'force-dynamic';

// Salary advances (docs/STAFF-ADVANCES-SPEC.md). OWNER ONLY, checked on every
// method. The owner notes an advance here; the payroll route takes it off the
// month. Removal is a soft delete (removed_at / removed_by) so the record of
// money given stays, and it is refused once a finalized month has taken it off.

const MAX_ADVANCE_INR = 100_000;
const MIN_DATE = '2024-01-01';
const MISSING_TABLE = 'Run supabase/2026-11-staff-advances.sql on Hioc India first.';

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  // Codes only: PGRST002 ("schema cache", PostgREST cannot reach the database)
  // is an outage, not a missing table.
  return error.code === '42P01' || error.code === 'PGRST205';
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// POST { user_id, amount_inr, given_on, note? }
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const userId = typeof body.user_id === 'string' ? body.user_id : '';
  if (!isUuid(userId)) return errorResponse(400, 'user_id is required.');

  const amount = body.amount_inr;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_ADVANCE_INR) {
    return errorResponse(400, 'Amount must be whole rupees from ₹1 to ₹1,00,000. Enter a larger advance as two entries.');
  }

  const givenOn = typeof body.given_on === 'string' ? body.given_on : '';
  if (!isRealDate(givenOn)) return errorResponse(400, 'Date must look like 2026-11-08.');
  if (givenOn > istDateIso()) return errorResponse(400, 'The date cannot be in the future.');
  if (givenOn < MIN_DATE) return errorResponse(400, 'That date is too far back.');

  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    return errorResponse(400, 'Note must be text.');
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > 200) return errorResponse(400, 'Note can be at most 200 characters.');

  const admin = createAdminSupabaseClient();

  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('id, role')
    .eq('id', userId)
    .maybeSingle();
  if (profileErr) return errorResponse(500, 'Could not check that person.');
  const role = (profile as { role?: string } | null)?.role;
  if (!profile || !role || !['staff', 'manager', 'owner'].includes(role)) {
    return errorResponse(404, "That person isn't on the staff list.");
  }

  const { data, error } = await admin
    .from('staff_advances')
    .insert({ user_id: userId, amount_inr: amount, given_on: givenOn, note, created_by: owner.id })
    .select('id, user_id, amount_inr, given_on, note')
    .single();
  if (error) {
    if (isMissingRelation(error)) return errorResponse(503, MISSING_TABLE);
    console.error('staff_advances insert failed', error.code);
    return errorResponse(500, 'Could not save the advance.');
  }
  return NextResponse.json({ advance: data });
}

// DELETE { id } — soft-remove a mistaken advance.
export async function DELETE(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!isUuid(id)) return errorResponse(400, 'id is required.');

  const admin = createAdminSupabaseClient();

  const { data: row, error: readErr } = await admin
    .from('staff_advances')
    .select('id, user_id, given_on, created_at, removed_at')
    .eq('id', id)
    .maybeSingle();
  if (readErr) {
    if (isMissingRelation(readErr)) return errorResponse(503, MISSING_TABLE);
    return errorResponse(500, 'Could not load the advance.');
  }
  const adv = row as {
    id: string;
    user_id: string;
    given_on: string;
    created_at: string;
    removed_at: string | null;
  } | null;
  if (!adv || adv.removed_at) return errorResponse(404, 'That advance was not found.');

  // Already counted by a finalized month (a finalized run ending on or after
  // the advance date, finalized after the advance was created): reverse it first.
  const { data: locks, error: lockErr } = await admin
    .from('payroll_runs')
    .select('id, user_id, period_end, finalized_at')
    .eq('user_id', adv.user_id)
    .eq('status', 'finalized')
    .gte('period_end', adv.given_on);
  if (lockErr) return errorResponse(500, 'Could not check payroll.');
  if (
    isAdvanceCounted(
      adv,
      (locks ?? []) as { user_id: string; period_end: string; finalized_at: string | null }[],
    )
  ) {
    return errorResponse(409, 'This advance was already counted in a finalized month. Reverse that month first.');
  }

  const { data: updated, error: updErr } = await admin
    .from('staff_advances')
    .update({ removed_at: new Date().toISOString(), removed_by: owner.id })
    .eq('id', id)
    .is('removed_at', null)
    .select('id')
    .maybeSingle();
  if (updErr) return errorResponse(500, 'Could not remove the advance.');
  if (!updated) return errorResponse(404, 'That advance was not found.');
  return NextResponse.json({ removed: true, id });
}
