// Store expenses paid from the cash drawer (ice cubes, water, milk run …) —
// the shared contract. Pure rules + API shapes only; framework-free so the
// staff form and POST /api/cash-expenses validate with the SAME functions.
//
// An expense is a cash_movements row with direction 'out' and a category
// (supabase/2026-10-cash-expenses.sql). Because it IS a cash-out, the drawer
// math (lib/cash/checkpoints.ts cashFlowsBetween, the cash day's expected
// cash) already subtracts it — no second path to keep in step. The category
// is what lets the owner see WHERE petty cash went, and who punched it.
//
// Unlike the manager-only cash out / cash in, ANY staffer can punch an expense
// (permission key 'cash_expense', default 'staff' — the owner can raise it to
// manager in the permissions grid). A cash leak is prevented by making every
// rupee that leaves the drawer carry a category, an amount, a name and a time,
// not by stopping the person who actually paid the ice vendor from saying so.

export interface ExpenseCategory {
  key: string;
  label: string;
}

/** The categories offered at the counter, in display order. 'other' is last. */
export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  { key: 'ice', label: 'Ice cubes' },
  { key: 'water', label: 'Water' },
  { key: 'milk_dairy', label: 'Milk & dairy' },
  { key: 'groceries', label: 'Groceries & vegetables' },
  { key: 'gas_fuel', label: 'Gas / fuel' },
  { key: 'cleaning', label: 'Cleaning supplies' },
  { key: 'packaging', label: 'Packaging' },
  { key: 'transport', label: 'Transport / delivery' },
  { key: 'repairs', label: 'Repairs & maintenance' },
  { key: 'staff_food', label: 'Staff food' },
  { key: 'other', label: 'Other' },
];

const LABELS = new Map(EXPENSE_CATEGORIES.map((c) => [c.key, c.label]));

/** Petty cash only: anything bigger goes through a manager's cash out. */
export const MAX_EXPENSE_INR = 10_000;
/** 'Other' must say what it was; a preset category may add a note. */
export const MIN_OTHER_NOTE_LEN = 5;
export const MAX_EXPENSE_NOTE_LEN = 300;

export function isExpenseCategory(key: unknown): key is string {
  return typeof key === 'string' && LABELS.has(key);
}

/** Display label for a stored category key; an unknown key is shown as-is. */
export function expenseCategoryLabel(key: string | null | undefined): string {
  if (!key) return '';
  return LABELS.get(key) ?? key;
}

export interface ExpenseBody {
  category: string;
  amountInr: number;
  /** Optional for a preset category; required (≥ MIN_OTHER_NOTE_LEN) for 'other'. */
  note?: string;
}

export interface ValidExpense {
  category: string;
  amountInr: number;
  note: string;
  /** What goes in cash_movements.reason: the note, else the category label. */
  reason: string;
}

/** Validates an expense body; returns the normalised entry or an error message fit to show staff. */
export function validateExpense(
  body: unknown,
): { ok: true; expense: ValidExpense } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Request body must be a JSON object' };
  const { category, amountInr, note } = body as Record<string, unknown>;
  if (!isExpenseCategory(category)) return { ok: false, error: 'Pick what the expense was for.' };
  if (typeof amountInr !== 'number' || !Number.isInteger(amountInr) || amountInr < 1) {
    return { ok: false, error: 'Enter an amount greater than ₹0 (whole rupees).' };
  }
  if (amountInr > MAX_EXPENSE_INR) {
    return {
      ok: false,
      error: `Expenses over ₹${MAX_EXPENSE_INR.toLocaleString('en-IN')} need a manager's cash out.`,
    };
  }
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return { ok: false, error: 'note must be text' };
  }
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed.length > MAX_EXPENSE_NOTE_LEN) {
    return { ok: false, error: `Keep the note under ${MAX_EXPENSE_NOTE_LEN} characters.` };
  }
  if (category === 'other' && trimmed.length < MIN_OTHER_NOTE_LEN) {
    return { ok: false, error: `Say what "Other" was for (at least ${MIN_OTHER_NOTE_LEN} characters).` };
  }
  return {
    ok: true,
    expense: { category, amountInr, note: trimmed, reason: trimmed || expenseCategoryLabel(category) },
  };
}

export interface ExpenseCategoryTotal {
  category: string;
  label: string;
  amountInr: number;
  count: number;
}

/** Σ by category, biggest first — for the day list and the owner's breakdown. */
export function totalsByCategory(
  rows: readonly { category: string | null | undefined; amountInr: number }[],
): ExpenseCategoryTotal[] {
  const map = new Map<string, ExpenseCategoryTotal>();
  for (const r of rows) {
    if (!r.category) continue;
    const t = map.get(r.category) ?? {
      category: r.category,
      label: expenseCategoryLabel(r.category),
      amountInr: 0,
      count: 0,
    };
    t.amountInr += r.amountInr;
    t.count += 1;
    map.set(r.category, t);
  }
  return [...map.values()].sort((a, b) => b.amountInr - a.amountInr || a.label.localeCompare(b.label));
}

// ── Approval + undo ─────────────────────────────────────────────────────────
//
// A punched expense is PENDING until a manager or the owner approves it. While
// pending, the staffer who punched it (or a manager/owner) can UNDO it — a
// wrong amount, a double tap. Undo voids the row (cash_movements.voided_at),
// it never deletes: the owner still sees what was punched and undone, and
// every reader of cash_movements skips voided rows, so an undone expense
// leaves the drawer math. Pending expenses DO count as money out — the cash
// really left the drawer; approval is the owner's sign-off, not the math.
//
// Undo is refused once the drawer has been counted (any cash_counts row) or a
// cash day closed after the punch: that count already reflected the money
// out, and voiding it afterwards would make the day and the count chain
// disagree. A manager then corrects it with a cash in.

export type ExpenseStatus = 'pending' | 'approved' | 'undone';

export function expenseStatus(row: { approved_at?: string | null; voided_at?: string | null }): ExpenseStatus {
  if (row.voided_at) return 'undone';
  if (row.approved_at) return 'approved';
  return 'pending';
}

export type ActorRole = 'staff' | 'manager' | 'owner';

/** Why this actor may not undo this expense, or null when they may. */
export function undoProblem(input: {
  status: ExpenseStatus;
  isOwnEntry: boolean;
  actorRole: ActorRole;
  /** A drawer count (cash_counts) or a day close happened after the punch. */
  countedSince: boolean;
}): string | null {
  if (input.status === 'undone') return 'This expense was already undone.';
  if (input.status === 'approved') return 'This expense is already approved and can no longer be undone.';
  if (!input.isOwnEntry && input.actorRole === 'staff') return 'Only the person who punched it or a manager can undo it.';
  if (input.countedSince) {
    return 'The drawer has been counted since this was punched — ask a manager to correct it with a cash in.';
  }
  return null;
}

/**
 * Why this actor may not approve this expense, or null when they may. The
 * owner approves anything; a manager approves anyone's but their own (four
 * eyes on the money); plain staff never approve.
 */
export function approveProblem(input: { status: ExpenseStatus; isOwnEntry: boolean; actorRole: ActorRole }): string | null {
  if (input.status === 'undone') return 'This expense was undone.';
  if (input.status === 'approved') return 'This expense is already approved.';
  if (input.actorRole === 'staff') return 'Only a manager or the owner can approve expenses.';
  if (input.actorRole === 'manager' && input.isOwnEntry) return 'Another manager or the owner must approve your own expense.';
  return null;
}

/** Expenses punched by the owner need no one else's sign-off: they are approved on entry. */
export function autoApproved(actorRole: ActorRole): boolean {
  return actorRole === 'owner';
}

// ── API contract ────────────────────────────────────────────────────────────

/** One entry as GET/POST /api/cash-expenses return it. */
export interface ExpenseEntry {
  id: string;
  category: string;
  categoryLabel: string;
  amountInr: number;
  /** The note, or the category label when none was given. */
  reason: string;
  recordedBy: string;
  recordedByName: string;
  createdAt: string;
  status: ExpenseStatus;
  approvedByName: string | null;
  approvedAt: string | null;
  undoneByName: string | null;
  undoneAt: string | null;
  /** For the viewer asking: undoProblem(...) === null. */
  canUndo: boolean;
  /** For the viewer asking: approveProblem(...) === null. */
  canApprove: boolean;
}

/**
 * GET /api/cash-expenses — any staff. The expenses of the currently open cash
 * day (since its opened_at), else of the last 24 hours when no day is open.
 */
export interface ExpenseListResponse {
  since: string;
  dayOpen: boolean;
  /** Newest first, undone ones included (shown struck through). */
  expenses: ExpenseEntry[];
  /** Pending + approved; undone excluded. */
  totalInr: number;
  byCategory: ExpenseCategoryTotal[];
  pendingCount: number;
  pendingInr: number;
}

/** POST /api/cash-expenses/[id]/undo — no body. Responds { expense: ExpenseEntry }. */

/** POST /api/cash-expenses/approve — manager/owner. */
export interface ApproveExpensesBody {
  ids: string[];
}
export interface ApproveExpensesResponse {
  approved: string[];
  /** Not approved, with the reason (already approved, undone, own expense …). */
  skipped: { id: string; reason: string }[];
}
