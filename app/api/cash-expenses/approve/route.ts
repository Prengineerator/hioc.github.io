import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor, getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { isMissingColumnError } from '@/lib/api/postgrest';
import {
  approveProblem,
  expenseStatus,
  type ActorRole,
  type ApproveExpensesResponse,
} from '@/lib/cash/expenses';
import {
  CHANGED_MESSAGE,
  EXPENSE_COLUMNS,
  REVIEW_MIGRATION_HINT,
  actorRoleOf,
  type ExpenseRow,
} from '@/lib/cash/expensesServer';

export const dynamic = 'force-dynamic';

const MAX_IDS = 100;

// POST /api/cash-expenses/approve — body { ids: string[] } (1..100 uuids).
// Manager or owner signs off pending expenses. The owner acts through a real
// owner session (getOwnerUser); everyone else through getCounterActor, where an
// owner unlocked by a device PIN is capped at 'manager' (a shared counter
// device never carries owner powers).
// Each id is judged by approveProblem (own expense, already approved, undone);
// the ones that pass are approved with a conditional update, so an undo racing
// this request wins and the expense is reported back as skipped.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  let user: { id: string };
  let role: ActorRole;
  if (owner) {
    user = owner;
    role = 'owner';
  } else {
    const actor = await getCounterActor();
    if (!actor) return unauthorized();
    user = actor.user;
    role = actorRoleOf(actor.role);
  }
  if (role === 'staff') {
    return errorResponse(403, 'Only a manager or the owner can approve expenses.');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const rawIds = body.ids;
  if (
    !Array.isArray(rawIds) ||
    rawIds.length < 1 ||
    rawIds.length > MAX_IDS ||
    !rawIds.every((v) => isUuid(v))
  ) {
    return errorResponse(400, `ids must be 1 to ${MAX_IDS} expense ids`);
  }
  const ids = [...new Set(rawIds as string[])];

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('cash_movements').select(EXPENSE_COLUMNS).in('id', ids);
  if (error) {
    if (isMissingColumnError(error)) return errorResponse(409, REVIEW_MIGRATION_HINT);
    console.error('approve expenses: read failed', error);
    return errorResponse(500, 'Could not load the expenses.');
  }
  const byId = new Map(((data ?? []) as ExpenseRow[]).map((r) => [r.id, r]));

  const skipped: ApproveExpensesResponse['skipped'] = [];
  const candidates: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || !row.category) {
      skipped.push({ id, reason: 'Expense not found.' });
      continue;
    }
    const problem = approveProblem({
      status: expenseStatus(row),
      isOwnEntry: row.recorded_by === user.id,
      actorRole: role,
    });
    if (problem) skipped.push({ id, reason: problem });
    else candidates.push(id);
  }

  const approvedSet = new Set<string>();
  if (candidates.length > 0) {
    const { data: updated, error: updateError } = await admin
      .from('cash_movements')
      .update({ approved_at: new Date().toISOString(), approved_by: user.id })
      .in('id', candidates)
      .is('approved_at', null)
      .is('voided_at', null)
      .select('id');
    if (updateError) {
      if (isMissingColumnError(updateError)) return errorResponse(409, REVIEW_MIGRATION_HINT);
      console.error('approve expenses: update failed', updateError);
      return errorResponse(500, 'Could not approve the expenses.');
    }
    for (const r of (updated ?? []) as { id: string }[]) approvedSet.add(r.id);
    for (const id of candidates) {
      if (!approvedSet.has(id)) skipped.push({ id, reason: CHANGED_MESSAGE });
    }
  }

  const result: ApproveExpensesResponse = {
    approved: ids.filter((id) => approvedSet.has(id)),
    skipped,
  };
  return NextResponse.json(result);
}
