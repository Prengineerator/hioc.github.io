import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { expenseCategoryLabel, isExpenseCategory } from '@/lib/cash/expenses';
import { writeDayExpenses } from '@/lib/cash/dayServer';
import { isHandoverMovement } from '@/lib/cash/day';

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
  let { data: row, error: rowError } = await readRow('id, direction, reason, created_at, voided_at');
  // voided_at comes from the same migration as category: without it nothing can be undone.
  if (rowError && isMissingColumn(rowError)) ({ data: row, error: rowError } = await readRow('id, direction, reason, created_at'));
  if (rowError) return errorResponse(500, rowError.message);
  if (!row) return notFound();

  const movement = row as unknown as {
    id: string;
    direction: string;
    reason: string | null;
    created_at: string;
    voided_at?: string | null;
  };
  if (movement.voided_at) return errorResponse(409, 'This expense was undone, so it can no longer be tagged.');
  if (movement.direction !== 'out') return errorResponse(400, 'Only a cash out can be an expense');
  if (isHandoverMovement(movement.reason)) {
    return errorResponse(400, 'The day-close handover is not an expense');
  }

  // Tagging approves (owner act); clearing the tag clears the approval too — the
  // schema only allows approval on an expense row.
  const review = category === null
    ? { approved_at: null, approved_by: null }
    : { approved_at: new Date().toISOString(), approved_by: owner.id };
  const write = (payload: Record<string, unknown>) =>
    admin.from('cash_movements').update(payload).eq('id', id).select('id, category').maybeSingle();
  let { data: updated, error: updateError } = await write({ category, ...review });
  // Approval columns missing but category present: still save the tag.
  if (updateError && isMissingColumn(updateError)) ({ data: updated, error: updateError } = await write({ category }));
  if (updateError && isMissingColumn(updateError)) return errorResponse(409, MIGRATION_MESSAGE);
  if (updateError) return errorResponse(500, updateError.message);
  if (!updated) return notFound();

  await refreshClosedDayExpenses(admin, movement.created_at);

  const saved = ((updated as { category?: string | null }).category ?? null) as string | null;
  return NextResponse.json({
    movement: { id: movement.id, category: saved, categoryLabel: expenseCategoryLabel(saved) },
  });
}
