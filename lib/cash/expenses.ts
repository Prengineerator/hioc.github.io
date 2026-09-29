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

// ── API contract ────────────────────────────────────────────────────────────

/** One entry as GET/POST /api/cash-expenses return it. */
export interface ExpenseEntry {
  id: string;
  category: string;
  categoryLabel: string;
  amountInr: number;
  /** The note, or the category label when none was given. */
  reason: string;
  recordedByName: string;
  createdAt: string;
}

/**
 * GET /api/cash-expenses — any staff. The expenses of the currently open cash
 * day (since its opened_at), else of the last 24 hours when no day is open.
 */
export interface ExpenseListResponse {
  since: string;
  dayOpen: boolean;
  expenses: ExpenseEntry[];
  totalInr: number;
  byCategory: ExpenseCategoryTotal[];
}
