// SHEET-4 — the employment record's (tiny) state machine.
//
// A staff_employment row is CURRENT while effective_to IS NULL and CLOSED once
// a newer record supersedes it. The only move is
//
//   (new record from D) ──▶ current          and, for the row it supersedes,
//   current ──close at D──▶ closed           (effective_to = D, exclusive)
//
// with these guards:
//
//   * D must be AFTER the current row's own start — a record cannot be
//     superseded before (or on the day) it began;
//   * D must not reach into a finalized payroll month (lib/payroll/lock.ts).
//     A new rate prices every day from D onward, so a finalized month anywhere
//     on or after D would be restated, not only the month D falls in.
//
// Order of writes. Ideally the new row would be inserted first and the old one
// closed after, so a failure could never leave the person with no current
// rate. The exclusion constraint staff_employment_no_overlap
// (supabase/2026-08-attendance.sql) makes that impossible: the new [D, ∞)
// overlaps the old [F, ∞) until the old row is closed, and the constraint is
// not deferrable. So the route closes first, compare-and-set on
// effective_to IS NULL, and RESTORES the closed row if the insert then fails.
//
// Pure — safe in client components.

export type EmploymentState = 'current' | 'closed';

export function employmentState(row: { effective_to: string | null }): EmploymentState {
  return row.effective_to === null ? 'current' : 'closed';
}

export interface EmploymentChangeCheck {
  ok: boolean;
  code?: 'starts_too_early';
  message?: string;
  /** Current rows the new record closes, at effectiveFrom. */
  toClose: string[];
}

/** May a record starting `effectiveFrom` supersede `currentRows` (effective_to IS NULL)? */
export function planEmploymentChange(
  currentRows: readonly { id: string; effective_from: string; effective_to: string | null }[],
  effectiveFrom: string,
): EmploymentChangeCheck {
  const toClose: string[] = [];
  for (const row of currentRows) {
    if (employmentState(row) !== 'current') continue;
    if (row.effective_from >= effectiveFrom) {
      return {
        ok: false,
        code: 'starts_too_early',
        message: `There is already a record starting ${row.effective_from}. A new record must start after it.`,
        toClose: [],
      };
    }
    toClose.push(row.id);
  }
  return { ok: true, toClose };
}
