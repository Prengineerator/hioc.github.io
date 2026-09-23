import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { TEAM_ROLES, type TeamRole } from '@/lib/staff/accounts';
import { SHORTAGE_COLUMNS, buildShortageRows, isMissingTable, type ShortageRow } from '../_lib';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/owner/cash-shortages/[id] — ShortageDecisionBody
// (lib/cash/counts.ts): { action: 'approve' | 'waive' | 'reassign', ... }.
//
// Decision rules (docs/PHASE-5-CASH-COUNTS.md CC-D4):
//  - Only a PENDING shortage can be decided. Once approved or waived it is
//    final from this endpoint — there's no "undo" route, by design: an
//    approved shortage may already be reflected in a payroll draft the owner
//    is looking at, and a silent reversal would make that draft wrong.
//  - An approved shortage additionally LOCKS the moment payroll finalize
//    sets its payroll_run_id (CC-5) — it has been paid out (deducted) by
//    then, so even re-approving/re-waiving must never be possible. Since
//    only pending rows reach the update below, this can't fire from here in
//    practice, but the check stays so the 409 message is specific.
//  - REASSIGN IS NOT A DECISION: it moves who the shortage is currently
//    charged to (user_id) but leaves status 'pending' — the owner still has
//    to separately approve or waive it under the new person. original_user_id
//    (whose count actually revealed the shortage) never changes, so the
//    count-log breadcrumb survives any number of reassigns. decided_by/
//    decided_at are left untouched (the DB CHECK requires them null while
//    status stays 'pending' anyway). The note goes into decision_note, same
//    field an eventual approve/waive would set — approve's note is optional
//    and, when omitted, leaves decision_note (e.g. the reassignment's
//    reason) as-is rather than clearing it.
export async function PATCH(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const action = body.action;
  if (action !== 'approve' && action !== 'waive' && action !== 'reassign') {
    return errorResponse(400, 'action must be approve, waive or reassign');
  }

  const admin = createAdminSupabaseClient();
  const { data: rowData, error: rowError } = await admin
    .from('cash_shortages')
    .select(SHORTAGE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (rowError && isMissingTable(rowError)) {
    return errorResponse(409, 'Cash-counts migration not applied yet — run supabase/2026-09-cash-counts.sql');
  }
  if (rowError) return errorResponse(500, rowError.message);
  if (!rowData) return notFound();
  const shortage = rowData as ShortageRow;

  if (shortage.status !== 'pending') {
    return errorResponse(
      409,
      shortage.payroll_run_id
        ? "This shortage has already been paid out and can't be changed."
        : `This shortage was already ${shortage.status}.`,
    );
  }

  if (action === 'approve') {
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const patch: Record<string, unknown> = {
      status: 'approved',
      decided_by: owner.id,
      decided_at: new Date().toISOString(),
    };
    if (note) patch.decision_note = note;
    const { error } = await admin.from('cash_shortages').update(patch).eq('id', id);
    if (error) return errorResponse(500, error.message);
  } else if (action === 'waive') {
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!note) return errorResponse(400, 'A note is required to waive a shortage.');
    const { error } = await admin
      .from('cash_shortages')
      .update({ status: 'waived', decided_by: owner.id, decided_at: new Date().toISOString(), decision_note: note })
      .eq('id', id);
    if (error) return errorResponse(500, error.message);
  } else {
    const userId = body.userId;
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (typeof userId !== 'string' || !isUuid(userId)) return errorResponse(400, 'Pick who to reassign this to.');
    if (!note) return errorResponse(400, 'A note is required to reassign a shortage.');
    if (userId === shortage.user_id) return errorResponse(400, 'Already assigned to that person.');

    const { data: targetProfile, error: targetErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    if (targetErr) return errorResponse(500, targetErr.message);
    const role = (targetProfile as { role?: string } | null)?.role ?? null;
    if (!role || !TEAM_ROLES.includes(role as TeamRole)) {
      return errorResponse(400, 'Pick an active team member.');
    }

    const { error } = await admin.from('cash_shortages').update({ user_id: userId, decision_note: note }).eq('id', id);
    if (error) return errorResponse(500, error.message);
  }

  const { data: updatedRow, error: reloadError } = await admin
    .from('cash_shortages')
    .select(SHORTAGE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (reloadError || !updatedRow) return errorResponse(500, reloadError?.message ?? 'Could not reload the shortage.');

  const [enriched] = await buildShortageRows(admin, [updatedRow as ShortageRow]);
  return NextResponse.json({ shortage: enriched });
}
