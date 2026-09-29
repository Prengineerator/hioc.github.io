import 'server-only';

// Server-side half of the expense approval + undo flow (the pure rules are in
// lib/cash/expenses.ts — expenseStatus / undoProblem / approveProblem). Shared
// by GET/POST /api/cash-expenses, the undo route and the approve route so they
// build ONE ExpenseEntry shape and ask ONE question ("was the drawer counted
// since this was punched?") the same way.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { UserRole } from '@/lib/types';
import {
  approveProblem,
  expenseCategoryLabel,
  expenseStatus,
  undoProblem,
  type ActorRole,
  type ExpenseEntry,
} from '@/lib/cash/expenses';

type Admin = SupabaseClient;

/** The base columns every database has (category needs the 2026-10 migration, the rest too). */
export const EXPENSE_BASE_COLUMNS = 'id, amount_inr, reason, category, recorded_by, created_at';
/** Base + the approval/undo columns (supabase/2026-10-cash-expenses.sql). */
export const EXPENSE_COLUMNS = `${EXPENSE_BASE_COLUMNS}, approved_by, approved_at, voided_by, voided_at`;

export const REVIEW_MIGRATION_HINT =
  'Expense approval is not set up yet — apply supabase/2026-10-cash-expenses.sql first.';
export const CHANGED_MESSAGE = 'This expense changed — reload';

export interface ExpenseRow {
  id: string;
  amount_inr: number;
  reason: string | null;
  category: string | null;
  recorded_by: string;
  created_at: string;
  approved_by?: string | null;
  approved_at?: string | null;
  voided_by?: string | null;
  voided_at?: string | null;
}

/** Collapses the session role to the three the rules know; anything else is plain staff. */
export function actorRoleOf(role: UserRole | ActorRole): ActorRole {
  return role === 'owner' || role === 'manager' ? role : 'staff';
}

/** Every user id an expense row mentions, for one getStaffDisplayNames call. */
export function userIdsOf(rows: readonly ExpenseRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.recorded_by);
    if (r.approved_by) ids.add(r.approved_by);
    if (r.voided_by) ids.add(r.voided_by);
  }
  return [...ids];
}

/** The newest drawer count and newest day close: what "counted since" compares each expense against. */
export interface CountMarks {
  lastCountAt: string | null;
  lastCloseAt: string | null;
}

/**
 * Read once per request. Any failure (table missing, hiccup) reads as "never
 * counted": the conditional update on the row is what actually protects the
 * money, and failing closed here would make every expense un-undoable.
 */
export async function loadCountMarks(admin: Admin): Promise<CountMarks> {
  const marks: CountMarks = { lastCountAt: null, lastCloseAt: null };
  try {
    const { data: count } = await admin
      .from('cash_counts')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    marks.lastCountAt = (count as { created_at?: string } | null)?.created_at ?? null;
  } catch (err) {
    console.error('expenses: could not read the newest cash count', err);
  }
  try {
    const { data: closed } = await admin
      .from('cash_days')
      .select('closed_at')
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    marks.lastCloseAt = (closed as { closed_at?: string | null } | null)?.closed_at ?? null;
  } catch (err) {
    console.error('expenses: could not read the newest closed cash day', err);
  }
  return marks;
}

/** A count was recorded after the punch, or a day closed at/after it. */
export function countedSince(createdAt: string, marks: CountMarks): boolean {
  if (marks.lastCountAt && marks.lastCountAt > createdAt) return true;
  if (marks.lastCloseAt && marks.lastCloseAt >= createdAt) return true;
  return false;
}

/** One expense as the API returns it, with canUndo / canApprove worked out for the viewer. */
export function toExpenseEntry(
  row: ExpenseRow,
  names: Map<string, string>,
  viewer: { userId: string; role: ActorRole },
  marks: CountMarks,
): ExpenseEntry {
  const category = row.category ?? '';
  const status = expenseStatus(row);
  const isOwnEntry = row.recorded_by === viewer.userId;
  const nameOf = (id: string | null | undefined) => (id ? (names.get(id) ?? 'Unknown staff') : null);
  return {
    id: row.id,
    category,
    categoryLabel: expenseCategoryLabel(category),
    amountInr: row.amount_inr,
    reason: row.reason || expenseCategoryLabel(category),
    recordedBy: row.recorded_by,
    recordedByName: names.get(row.recorded_by) ?? 'Unknown staff',
    createdAt: row.created_at,
    status,
    approvedByName: status === 'approved' ? nameOf(row.approved_by) : null,
    approvedAt: status === 'approved' ? (row.approved_at ?? null) : null,
    undoneByName: status === 'undone' ? nameOf(row.voided_by) : null,
    undoneAt: status === 'undone' ? (row.voided_at ?? null) : null,
    canUndo:
      undoProblem({
        status,
        isOwnEntry,
        actorRole: viewer.role,
        countedSince: countedSince(row.created_at, marks),
      }) === null,
    canApprove: approveProblem({ status, isOwnEntry, actorRole: viewer.role }) === null,
  };
}
