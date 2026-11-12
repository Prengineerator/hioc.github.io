// PAY-4 — "a finalized payroll run locks this person's month".
//
// ONE definition of the rule, used by every writer that could change a number
// a finalized run has already frozen: attendance corrections and manual
// entries, leave requests / decisions / withdrawals, cash-shortage approvals,
// and back-dated employment records. Before this lived here it was applied in
// the attendance-session PATCH alone, so a leave decision or a shortage
// approval could quietly make the sheet and an already-paid payslip disagree.
//
// Payroll is finalized PER STAFFER (supabase/2026-11-payroll-per-staff.sql),
// so only THIS person's finalized runs lock their days — finalizing Umesh's
// October freezes nothing of anyone else's.
//
// The predicate is pure (and safe to import from a client component); the
// loader takes the admin client as an argument, so nothing server-only is
// imported here.
//
// What this cannot close on its own: the check is read-then-write against a
// concurrent finalize. A finalize computes from the rows it reads, so a write
// landing in the instant between our check and its insert can still miss the
// payslip. Closing that needs the finalize and the write to share a lock in
// the database; the window is one owner racing themselves, and the next
// reversal + re-finalize picks the change up.

import type { SupabaseClient } from '@supabase/supabase-js';

/** The slice of a payroll_runs row the lock needs. */
export interface LockingRun {
  id: string;
  user_id: string | null;
  period_start: string;
  period_end: string;
  status: string;
}

/** Open-ended upper bound for "this date and everything after it". */
export const END_OF_TIME = '9999-12-31';

/**
 * The finalized run (of `userId`, when given) whose period contains `date`, or
 * null. Pure: `runs` is whatever the caller loaded; a reversed run never locks.
 */
export function lockingRunFor(
  runs: readonly LockingRun[],
  date: string,
  userId?: string,
): LockingRun | null {
  return (
    runs.find(
      (r) =>
        r.status === 'finalized' &&
        (userId === undefined || r.user_id === userId) &&
        r.period_start <= date &&
        r.period_end >= date,
    ) ?? null
  );
}

/** True when a finalized run covers `date`. */
export function isDateLocked(runs: readonly LockingRun[], date: string, userId?: string): boolean {
  return lockingRunFor(runs, date, userId) !== null;
}

/**
 * The first finalized run that overlaps [from, to] (inclusive). Used where a
 * change reaches every day from a date onward — a new employment rate prices
 * every day from its effective_from, so a finalized month anywhere after that
 * date is affected, not only the month the date falls in.
 */
export function lockingRunInRange(
  runs: readonly LockingRun[],
  from: string,
  to: string = END_OF_TIME,
  userId?: string,
): LockingRun | null {
  return (
    runs.find(
      (r) =>
        r.status === 'finalized' &&
        (userId === undefined || r.user_id === userId) &&
        r.period_start <= to &&
        r.period_end >= from,
    ) ?? null
  );
}

/** "August 2026" for a run, for the 409 copy. */
export function lockedMonthLabel(run: Pick<LockingRun, 'period_start'>): string {
  const [y, m] = run.period_start.split('-').map(Number);
  if (!y || !m) return run.period_start;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** The standard refusal, so every writer says the same thing. */
export function payrollLockedMessage(run: Pick<LockingRun, 'period_start'>, what = 'That day'): string {
  return `${what} is inside this person's finalized payroll for ${lockedMonthLabel(
    run,
  )}. Reverse their payroll for the month first if it genuinely needs changing.`;
}

type PgError = { code?: string; message?: string } | null | undefined;

/**
 * The payroll_runs table predates per-staff payroll; without
 * 2026-11-payroll-per-staff.sql there is no user_id column, and nothing can be
 * finalized per staffer — so nothing is locked. Same posture the attendance
 * PATCH always had (it ignored the read error).
 */
function isMissingSchema(error: PgError): boolean {
  if (!error) return false;
  if (['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code ?? '')) return true;
  return /does not exist|schema cache|could not find/i.test(error.message ?? '');
}

/** The query already filtered on status + user; fill either in if a row omits it. */
function asFinalizedRuns(data: unknown, userId: string): LockingRun[] {
  return ((data ?? []) as Partial<LockingRun>[]).map((r) => ({
    id: String(r.id ?? ''),
    user_id: r.user_id ?? userId,
    period_start: String(r.period_start ?? ''),
    period_end: String(r.period_end ?? ''),
    status: r.status ?? 'finalized',
  }));
}

export interface PayrollLockResult {
  /** The finalized run that locks the change, or null when it may go ahead. */
  run: LockingRun | null;
  /** Set when the lock could not be checked — callers refuse (fail closed). */
  error: string | null;
}

/**
 * Loads `userId`'s finalized runs overlapping [from, to] and reports the first
 * one, if any. Fails CLOSED on a read error (the caller should 500): letting a
 * pay-affecting write through because we could not tell whether the month was
 * already paid is the one direction this must not err in.
 */
export async function findPayrollLock(
  admin: SupabaseClient,
  userId: string,
  from: string,
  to: string = from,
): Promise<PayrollLockResult> {
  const { data, error } = await admin
    .from('payroll_runs')
    .select('id, user_id, period_start, period_end, status')
    .eq('status', 'finalized')
    .eq('user_id', userId)
    .lte('period_start', to)
    .gte('period_end', from)
    .limit(1);
  if (error) {
    if (isMissingSchema(error)) return { run: null, error: null };
    return { run: null, error: error.message ?? 'Could not check payroll' };
  }
  const runs = asFinalizedRuns(data, userId);
  return { run: lockingRunInRange(runs, from, to, userId), error: null };
}

/** The lock for a set of dates (e.g. an edit's pre- and post-edit business date). */
export async function findPayrollLockForDates(
  admin: SupabaseClient,
  userId: string,
  dates: readonly string[],
): Promise<PayrollLockResult> {
  const sorted = [...new Set(dates.filter(Boolean))].sort();
  if (sorted.length === 0) return { run: null, error: null };
  // One read for the whole span, then the exact per-date test in TS, so a gap
  // between two dates that happens to contain a finalized month (an edit that
  // moves a session from July to September) does not lock by accident.
  const { data, error } = await admin
    .from('payroll_runs')
    .select('id, user_id, period_start, period_end, status')
    .eq('status', 'finalized')
    .eq('user_id', userId)
    .lte('period_start', sorted[sorted.length - 1])
    .gte('period_end', sorted[0]);
  if (error) {
    if (isMissingSchema(error)) return { run: null, error: null };
    return { run: null, error: error.message ?? 'Could not check payroll' };
  }
  const runs = asFinalizedRuns(data, userId);
  for (const date of sorted) {
    const run = lockingRunFor(runs, date, userId);
    if (run) return { run, error: null };
  }
  return { run: null, error: null };
}
