import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { expenseCategoryLabel, expenseStatus, isExpenseCategory, retagReview } from '@/lib/cash/expenses';
import { writeDayExpenses } from '@/lib/cash/dayServer';
import { isHandoverMovement } from '@/lib/cash/day';
import { CHANGED_MESSAGE } from '@/lib/cash/expensesServer';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
type PgError = { code?: string; message?: string } | null | undefined;

const MIGRATION_MESSAGE = 'Expense categories are not set up yet — apply supabase/2026-10-cash-expenses.sql';

/** The `category` column doesn't exist yet (supabase/2026-10-cash-expenses.sql not applied). */
function isMissingColumn(error: PgError): boolean {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('category') && (msg.includes('schema cache') || msg.includes('does not exist'));
}

/**
 * A closed cash day freezes its expense total at close (cash_days.expenses_inr),
 * so re-tagging a movement inside that day must re-freeze it: recompute the
 * categorised cash-outs over the same (opened_at, closed_at] window
 * lib/cash/checkpoints.ts uses. An open day is computed live, so nothing to do
 * when no closed day contains the movement. Best-effort — the tag itself is
 * already saved, and a database without expenses_inr just skips the write.
 */
async function refreshClosedDayExpenses(admin: ReturnType<typeof createAdminSupabaseClient>, createdAt: string) {
  try {
    const { data: days, error } = await admin
      .from('cash_days')
      .select('id, opened_at, closed_at')
      .eq('status', 'closed')
      .lt('opened_at', createdAt)
      .gte('closed_at', createdAt);
    if (error || !days) return;
    for (const day of days as { id: string; opened_at: string; closed_at: string | null }[]) {
      if (!day.closed_at) continue;
      // An undone expense (voided_at) is not money that left the drawer.
      const sum = (columns: string) =>
        admin
          .from('cash_movements')
          .select(columns)
          .eq('direction', 'out')
          .not('category', 'is', null)
          .gt('created_at', day.opened_at)
          .lte('created_at', day.closed_at as string);
      let { data: rows, error: sumError } = await sum('amount_inr, voided_at');
      if (sumError && isMissingColumn(sumError)) ({ data: rows, error: sumError } = await sum('amount_inr'));
      if (sumError) continue;
      const total = ((rows ?? []) as unknown as { amount_inr: number | null; voided_at?: string | null }[])
        .filter((r) => !r.voided_at)
        .reduce((s, r) => s + (r.amount_inr ?? 0), 0);
      await writeDayExpenses(admin, day.id, total);
    }
  } catch (err) {
    console.error('cash-movements: could not refresh the closed day’s expenses', err);
  }
}

// PATCH /api/owner/cash-movements/[id] — body { category: string | null }.
//
// Re-categorises a PAST cash-out as a store expense (or clears a wrong tag), for
// the expenses that were entered as a plain "Cash out" before the Expenses
// option existed. ONLY `category` is written: amount, direction and reason are
// never touched, so the drawer math (lib/cash/checkpoints.ts cashFlowsBetween,
// the cash day's expected cash) is identical before and after.
//
// The review columns follow the expense's state (lib/cash/expenses.ts
// expenseStatus): tagging a PENDING (or untagged) cash-out approves it as the
// owner; re-tagging an APPROVED expense only changes its category and keeps
// who approved it and when; clearing the tag clears the approval. Each write
// is conditional on the state read (approved or not, not undone), so an
// approval or an undo landing in between makes it a 409, never an overwrite.
export async function PATCH(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const category = body.category;
  if (category !== null && !isExpenseCategory(category)) {
    return errorResponse(400, 'category must be an expense category or null');
  }

  const admin = createAdminSupabaseClient();
  const readRow = (columns: string) =>
    admin.from('cash_movements').select(columns).eq('id', id).maybeSingle();
  let { data: row, error: rowError } = await readRow('id, direction, reason, created_at, voided_at, approved_at');
  // The review columns come from the same migration as category: without them
  // nothing was approved or undone, and only the tag itself can be written.
  let hasReview = true;
  if (rowError && isMissingColumn(rowError)) {
    hasReview = false;
    ({ data: row, error: rowError } = await readRow('id, direction, reason, created_at'));
  }
  if (rowError) return errorResponse(500, rowError.message);
  if (!row) return notFound();

  const movement = row as unknown as {
    id: string;
    direction: string;
    reason: string | null;
    created_at: string;
    voided_at?: string | null;
    approved_at?: string | null;
  };
  const action = retagReview({ status: expenseStatus(movement), category: category as string | null });
  if (action === null) return errorResponse(409, 'This expense was undone, so it can no longer be tagged.');
  if (movement.direction !== 'out') return errorResponse(400, 'Only a cash out can be an expense');
  if (isHandoverMovement(movement.reason)) {
    return errorResponse(400, 'The day-close handover is not an expense');
  }

  // lib/cash/expenses.ts retagReview: tagging a pending one approves it (owner
  // act); re-tagging an approved one keeps its approval; clearing the tag
  // clears the approval too.
  const review =
    action === 'clear'
      ? { approved_at: null, approved_by: null }
      : action === 'keep'
        ? {}
        : { approved_at: new Date().toISOString(), approved_by: owner.id };
  const write = (payload: Record<string, unknown>, guarded: boolean) => {
    let q = admin.from('cash_movements').update(payload).eq('id', id);
    if (guarded) {
      // Compare-and-set on the state read above: still not undone, and still
      // approved / still not approved as it was.
      q = q.is('voided_at', null);
      if (action === 'keep') q = q.not('approved_at', 'is', null);
      if (action === 'approve') q = q.is('approved_at', null);
    }
    return q.select('id, category').maybeSingle();
  };
  let { data: updated, error: updateError } = await write({ category, ...review }, hasReview);
  // Approval columns missing but category present: still save the tag.
  if (updateError && isMissingColumn(updateError)) {
    hasReview = false;
    ({ data: updated, error: updateError } = await write({ category }, false));
  }
  if (updateError && isMissingColumn(updateError)) return errorResponse(409, MIGRATION_MESSAGE);
  if (updateError) return errorResponse(500, updateError.message);
  // Guarded and matched nothing: approved or undone since it was read.
  if (!updated) return hasReview ? errorResponse(409, CHANGED_MESSAGE) : notFound();

  await refreshClosedDayExpenses(admin, movement.created_at);

  const saved = ((updated as { category?: string | null }).category ?? null) as string | null;
  return NextResponse.json({
    movement: { id: movement.id, category: saved, categoryLabel: expenseCategoryLabel(saved) },
  });
}
