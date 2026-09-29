import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { expenseCategoryLabel, isExpenseCategory } from '@/lib/cash/expenses';
import { writeDayExpenses } from '@/lib/cash/dayServer';

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
      const { data: rows, error: sumError } = await admin
        .from('cash_movements')
        .select('amount_inr')
        .eq('direction', 'out')
        .not('category', 'is', null)
        .gt('created_at', day.opened_at)
        .lte('created_at', day.closed_at);
      if (sumError) continue;
      const total = ((rows ?? []) as { amount_inr: number | null }[]).reduce((s, r) => s + (r.amount_inr ?? 0), 0);
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
  const { data: row, error: rowError } = await admin
    .from('cash_movements')
    .select('id, direction, reason, created_at')
    .eq('id', id)
    .maybeSingle();
  if (rowError) return errorResponse(500, rowError.message);
  if (!row) return notFound();

  const movement = row as { id: string; direction: string; reason: string | null; created_at: string };
  if (movement.direction !== 'out') return errorResponse(400, 'Only a cash out can be an expense');
  if ((movement.reason ?? '').trim().toLowerCase().startsWith('day close handover')) {
    return errorResponse(400, 'The day-close handover is not an expense');
  }

  const { data: updated, error: updateError } = await admin
    .from('cash_movements')
    .update({ category })
    .eq('id', id)
    .select('id, category')
    .maybeSingle();
  if (updateError && isMissingColumn(updateError)) return errorResponse(409, MIGRATION_MESSAGE);
  if (updateError) return errorResponse(500, updateError.message);
  if (!updated) return notFound();

  await refreshClosedDayExpenses(admin, movement.created_at);

  const saved = ((updated as { category?: string | null }).category ?? null) as string | null;
  return NextResponse.json({
    movement: { id: movement.id, category: saved, categoryLabel: expenseCategoryLabel(saved) },
  });
}
