import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import type { StaffEmployment } from '@/lib/types';
import type { DayEmployment } from '@/lib/attendance/day';

// SHEET-4 — effective-dated employment records.
//
// server-only: salary is owner-visible, and in this phase not even the staffer
// themself sees it (playbook A-5). Importing this from a client component is a
// build error rather than a review comment.

/**
 * The record in effect for `user` on `date`.
 *
 * Effective-dating is the whole point: a raise in November must not restate
 * what October was paid at, so payroll asks this question per DAY rather than
 * reading one current row per person.
 */
export function employmentOnDate(
  rows: StaffEmployment[],
  userId: string,
  date: string,
): StaffEmployment | null {
  const candidates = rows.filter(
    (r) =>
      r.user_id === userId &&
      r.effective_from <= date &&
      (r.effective_to === null || r.effective_to > date),
  );
  if (candidates.length === 0) return null;
  // The DB exclusion constraint makes overlaps impossible, so there is at most
  // one. Sorting defensively anyway costs nothing and means a constraint that
  // somehow went missing degrades to "most recent wins" rather than "whichever
  // row the planner happened to return".
  return candidates.sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
}

export function toDayEmployment(row: StaffEmployment | null): DayEmployment | null {
  if (!row) return null;
  return {
    contractedHoursPerDay: Number(row.contracted_hours_per_day),
    shiftStartTime: row.shift_start_time,
    shiftEndTime: row.shift_end_time,
    weeklyOffDow: row.weekly_off_dow,
  };
}

/** Every employment row overlapping [from, to] — one query for a whole month grid. */
export async function loadEmploymentRows(from: string, to: string): Promise<StaffEmployment[]> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('staff_employment')
    .select('*')
    .lte('effective_from', to)
    .or(`effective_to.is.null,effective_to.gt.${from}`);
  if (error) {
    console.error('attendance: employment load failed', error);
    return [];
  }
  return (data ?? []) as StaffEmployment[];
}
