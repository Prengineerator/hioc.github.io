import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import { expenseStatus, undoProblem } from '@/lib/cash/expenses';
import {
  CHANGED_MESSAGE,
  EXPENSE_COLUMNS,
  REVIEW_MIGRATION_HINT,
  actorRoleOf,
  countedSince,
  loadCountMarks,
  toExpenseEntry,
  userIdsOf,
  type ExpenseRow,
} from '@/lib/cash/expensesServer';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/cash-expenses/[id]/undo — no body. Voids a PENDING expense (a
// wrong amount, a double tap): the row is kept for the owner's audit trail
// (voided_at / voided_by) and every reader of cash_movements skips it, so it
// leaves the drawer math. The person who punched it, or a manager/owner, may
// undo — never once approved, and never once the drawer was counted or the day
// closed after the punch (that count already reflected the money out). The
// rules are lib/cash/expenses.ts undoProblem; this route only maps them to
// HTTP and makes the write race-safe.
export async function POST(_request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const { id } = params;
  if (!isUuid(id)) return notFound();
  const role = actorRoleOf(actor.role);

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('cash_movements').select(EXPENSE_COLUMNS).eq('id', id).maybeSingle();
  if (error) {
    if (isMissingColumnError(error)) return errorResponse(409, REVIEW_MIGRATION_HINT);
    console.error('undo expense: read failed', error);
    return errorResponse(500, 'Could not load the expense.');
  }
  const row = data as ExpenseRow | null;
  if (!row || !row.category) return notFound();

  const status = expenseStatus(row);
  const isOwnEntry = row.recorded_by === actor.user.id;
  const marks = await loadCountMarks(admin);
  const problem = undoProblem({
    status,
    isOwnEntry,
    actorRole: role,
    countedSince: countedSince(row.created_at, marks),
  });
  if (problem) {
    // "Only the person who punched it or a manager" is a permission problem;
    // everything else is the expense's state.
    const forbidden = status === 'pending' && !isOwnEntry && role === 'staff';
    return errorResponse(forbidden ? 403 : 409, problem);
  }

  // Race-safe: only a row that is STILL pending is voided. An approval or a
  // second undo landing between the read above and here matches 0 rows.
  const voidedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await admin
    .from('cash_movements')
    .update({ voided_at: voidedAt, voided_by: actor.user.id })
    .eq('id', id)
    .is('approved_at', null)
    .is('voided_at', null)
    .select(EXPENSE_COLUMNS)
    .maybeSingle();
  if (updateError) {
    if (isMissingColumnError(updateError)) return errorResponse(409, REVIEW_MIGRATION_HINT);
    console.error('undo expense: update failed', updateError);
    return errorResponse(500, 'Could not undo the expense.');
  }
  if (!updated) return errorResponse(409, CHANGED_MESSAGE);

  const saved = updated as ExpenseRow;
  const names = await getStaffDisplayNames(admin, userIdsOf([saved]));
  return NextResponse.json({
    expense: toExpenseEntry(saved, names, { userId: actor.user.id, role }, marks),
  });
}
