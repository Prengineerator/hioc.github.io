import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import { getOpenDay, isMissingColumn } from '@/lib/cash/dayServer';
import {
  autoApproved,
  totalsByCategory,
  validateExpense,
  type ExpenseListResponse,
} from '@/lib/cash/expenses';
import {
  EXPENSE_BASE_COLUMNS,
  EXPENSE_COLUMNS,
  actorRoleOf,
  loadCountMarks,
  toExpenseEntry,
  userIdsOf,
  type ExpenseRow,
} from '@/lib/cash/expensesServer';

export const dynamic = 'force-dynamic';

// Expenses paid from the cash drawer — ice, water, a milk run. Unlike the
// manager-only cash out (app/api/cash-movements/route.ts), ANY staffer can
// punch one: gated by hasPermission('cash_expense'), default staff, which the
// owner can raise to manager in the permissions grid. An expense is a
// cash_movements row with direction 'out' and a category, so the drawer math
// (lib/cash/checkpoints.ts cashFlowsBetween, the cash day's expected cash)
// already subtracts it. The rules live in lib/cash/expenses.ts and are shared
// with the staff form.
//
// PIN-3: gated by getCounterActor() — a session first, an enrolled device's PIN
// operator only when there is no session; roleHint = actor.role so
// hasPermission() doesn't re-derive the role through a session a device
// operator has none of (see lib/permissions.ts's own note).
//
// Approval + undo: a punched expense is pending until a manager/owner approves
// it (an owner's own punch is approved on entry); until then it can be undone
// (POST /api/cash-expenses/[id]/undo). The rules are lib/cash/expenses.ts's.

const NO_PERMISSION = "You don't have permission to record expenses.";
const MIGRATION_HINT = 'Could not record the expense — apply supabase/2026-10-cash-expenses.sql first.';

const NO_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;

// POST /api/cash-expenses — any staffer with 'cash_expense'.
// Body: { category, amountInr, note? }. Responds { expense }.
export async function POST(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const user = actor.user;
  if (!(await hasPermission(user, 'cash_expense', actor.role))) {
    return errorResponse(403, NO_PERMISSION);
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = validateExpense(body);
  if (!parsed.ok) return errorResponse(400, parsed.error);
  const { expense } = parsed;
  const role = actorRoleOf(actor.role);

  // An expense the owner punched needs no one else's sign-off.
  const approval = autoApproved(role) ? { approved_at: new Date().toISOString(), approved_by: user.id } : {};

  const admin = createAdminSupabaseClient();
  const { data: inserted, error } = await admin
    .from('cash_movements')
    .insert({
      direction: 'out',
      amount_inr: expense.amountInr,
      reason: expense.reason,
      category: expense.category,
      recorded_by: user.id,
      ...approval,
    })
    .select(EXPENSE_COLUMNS)
    .single();
  if (error || !inserted) {
    // The columns come from the migration; without them the insert fails
    // with a missing-column error, which is worth naming to whoever sees it.
    console.error('POST /api/cash-expenses: insert failed', error);
    return errorResponse(500, isMissingColumn(error) ? MIGRATION_HINT : 'Could not record the expense.');
  }

  const row = inserted as ExpenseRow;
  const names = await getStaffDisplayNames(admin, userIdsOf([row]));
  // Just punched: nothing has been counted since, so no marks to look up.
  const entry = toExpenseEntry(row, names, { userId: user.id, role }, { lastCountAt: null, lastCloseAt: null });
  return NextResponse.json({ expense: entry });
}

// GET /api/cash-expenses — any counter actor. The expenses of the OPEN cash
// day (since its opened_at), else of the last 24 hours when no day is open;
// newest first, with who punched each, its approval state, what THIS viewer
// may do to it, and the totals by category (undone ones excluded from totals).
//
// Before the migration there is no category column, so nothing can be an
// expense yet: that reads as an empty list, not an error. Without only the
// approval columns every expense reads as pending.
export async function GET() {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const role = actorRoleOf(actor.role);

  const admin = createAdminSupabaseClient();
  const { day: openDay, error: dayError } = await getOpenDay(admin);
  if (dayError) return errorResponse(500, dayError.message);

  const dayOpen = openDay !== null;
  const since = openDay ? openDay.opened_at : new Date(Date.now() - NO_DAY_WINDOW_MS).toISOString();

  const read = (columns: string) =>
    admin
      .from('cash_movements')
      .select(columns)
      .eq('direction', 'out')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT);
  let { data, error } = await read(EXPENSE_COLUMNS);
  if (error && isMissingColumn(error)) {
    ({ data, error } = await read(EXPENSE_BASE_COLUMNS));
  }
  if (error && !isMissingColumn(error)) {
    console.error('GET /api/cash-expenses: query failed', error);
    return errorResponse(500, 'Could not load expenses.');
  }

  // Plain manager cash outs (no category) share the table and are not expenses.
  const rows = error ? [] : ((data ?? []) as unknown as ExpenseRow[]).filter((r) => !!r.category);
  const [names, marks] = await Promise.all([
    getStaffDisplayNames(admin, userIdsOf(rows)),
    rows.length > 0 ? loadCountMarks(admin) : Promise.resolve({ lastCountAt: null, lastCloseAt: null }),
  ]);
  const expenses = rows.map((r) => toExpenseEntry(r, names, { userId: actor.user.id, role }, marks));
  const live = expenses.filter((e) => e.status !== 'undone');
  const pending = live.filter((e) => e.status === 'pending');

  const body: ExpenseListResponse = {
    since,
    dayOpen,
    expenses,
    totalInr: live.reduce((sum, e) => sum + e.amountInr, 0),
    byCategory: totalsByCategory(live),
    pendingCount: pending.length,
    pendingInr: pending.reduce((sum, e) => sum + e.amountInr, 0),
  };
  return NextResponse.json(body);
}
