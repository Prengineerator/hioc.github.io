import 'server-only';

// Reads the rows behind the staff downloads (Owner → Reports → Downloads) and
// rolls every staffer's day up with rollUpDay, the way the owner's attendance
// sheet does (app/api/owner/attendance/route.ts): the same team roster, the same
// approved-leave rule for a scheduled day off, the same settings. The sheets are
// the pure builders in staffReports.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError, type PostgrestLikeError } from '@/lib/api/postgrest';
import { employmentOnDate, loadEmploymentRows, toDayEmployment } from '@/lib/attendance/employment';
import { getAttendanceSettings } from '@/lib/attendance/settings';
import { dayOfWeekFor, rollUpDay, type DayMark, type DaySession } from '@/lib/attendance/day';
import { loadApprovedLeave, loadTeamRoster, scheduledOffLookup } from '@/lib/attendance/roster';
import { datesBetween, rangeBounds } from '@/lib/reports/reconcile';
import { fetchAll, type PageResult } from '@/lib/reports/reconcileServer';
import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';
import type { ReportDef } from '@/lib/reports/exports/types';
import {
  attendanceRegister,
  attendanceSummary,
  staffPerformance,
  type StaffDay,
  type StaffExpense,
  type StaffPerformanceInput,
  type StaffSession,
  type StaffShortage,
} from '@/lib/reports/exports/staffReports';

const UNKNOWN_STAFF = 'Unknown staff';

interface SessionDbRow {
  id: string;
  user_id: string;
  business_date: string;
  clock_in_at: string;
  clock_out_at: string | null;
  status: StaffSession['status'];
  source: StaffSession['source'];
  approved_at: string | null;
  flags: string[] | null;
}

interface MarkDbRow {
  user_id: string;
  business_date: string;
  mark: DayMark;
}

function isMissingRelation(err: unknown): boolean {
  const e = err as PostgrestLikeError | undefined;
  return e?.code === '42P01' || e?.code === 'PGRST205' || /does not exist|could not find the table/i.test(e?.message ?? '');
}

interface StaffRoster {
  /** Display name by user id, for the team roster. */
  names: Map<string, string>;
  /** Every team member on every IST date in the range, rolled up with rollUpDay. */
  days: StaffDay[];
}

async function loadStaffDays(admin: SupabaseClient, from: string, to: string): Promise<StaffRoster> {
  const settings = await getAttendanceSettings();

  // The same team and names as the owner's attendance sheet (lib/attendance/roster.ts).
  const roster = await loadTeamRoster(admin);
  if (!roster.ok) throw new Error(`staff report: roster failed: ${roster.message}`);
  const people = roster.people.map((p) => p.id);
  const names = roster.displayNames;

  const [sessions, marks, leaveResult, employmentRows] = await Promise.all([
    fetchAll<SessionDbRow>((a, b) =>
      admin
        .from('attendance_sessions')
        .select('id, user_id, business_date, clock_in_at, clock_out_at, status, source, approved_at, flags')
        .gte('business_date', from)
        .lte('business_date', to)
        .order('clock_in_at')
        .order('id')
        .range(a, b) as unknown as PromiseLike<PageResult<SessionDbRow>>,
    ),
    fetchAll<MarkDbRow>((a, b) =>
      admin
        .from('attendance_day_marks')
        .select('user_id, business_date, mark')
        .gte('business_date', from)
        .lte('business_date', to)
        .order('id')
        .range(a, b) as unknown as PromiseLike<PageResult<MarkDbRow>>,
    ),
    // Approved leave is the week's rostered day off (LEAVE), as on the owner's sheet.
    loadApprovedLeave(admin, from, to),
    loadEmploymentRows(from, to),
  ]);
  if (leaveResult.error) throw new Error(`staff report: leave failed: ${leaveResult.error}`);
  const leave = leaveResult.rows;

  const key = (userId: string, date: string) => `${userId}|${date}`;
  const sessionsByDay = new Map<string, SessionDbRow[]>();
  for (const s of sessions) {
    const k = key(s.user_id, s.business_date);
    sessionsByDay.set(k, [...(sessionsByDay.get(k) ?? []), s]);
  }
  const markByDay = new Map(marks.map((m) => [key(m.user_id, m.business_date), m.mark]));
  const scheduledOff = scheduledOffLookup(leave);

  const rules = {
    gracePeriodMin: settings.grace_period_min,
    otThresholdMin: settings.ot_threshold_min,
    autoBreakMin: settings.auto_break_min,
    autoBreakAfterMin: settings.auto_break_after_min,
    halfDayMinMinutes: settings.half_day_min_minutes,
    absentBelowMinutes: settings.absent_below_minutes,
  };

  const dates = datesBetween(from, to);
  const days: StaffDay[] = [];
  for (const userId of people) {
    const staff = names.get(userId) ?? UNKNOWN_STAFF;
    for (const date of dates) {
      const k = key(userId, date);
      const raw = sessionsByDay.get(k) ?? [];
      const mark = markByDay.get(k) ?? null;
      const daySessions: DaySession[] = raw.map((s) => ({
        id: s.id,
        clockInAt: s.clock_in_at,
        clockOutAt: s.clock_out_at,
        status: s.status,
        source: s.source,
        approvedAt: s.approved_at,
        flags: s.flags ?? [],
      }));
      const rollup = rollUpDay({
        date,
        sessions: daySessions,
        rules,
        employment: toDayEmployment(employmentOnDate(employmentRows, userId, date)),
        mark,
        scheduledOff: scheduledOff(userId, date),
        dayOfWeek: dayOfWeekFor(date),
      });
      days.push({
        user_id: userId,
        staff,
        rollup,
        sessions: raw.map((s) => ({
          id: s.id,
          clock_in_at: s.clock_in_at,
          clock_out_at: s.clock_out_at,
          status: s.status,
          source: s.source,
          approved_at: s.approved_at,
        })),
        mark,
      });
    }
  }
  return { names: new Map(names), days };
}

/**
 * Cash-drawer expenses recorded in the range (cash_movements, direction 'out' with a
 * category), voided ones kept and flagged. Before 2026-10-cash-expenses.sql there are none.
 */
async function loadExpenses(admin: SupabaseClient, from: string, to: string): Promise<StaffExpense[]> {
  const { startIso, endIso } = rangeBounds(from, to);
  const rows = await fetchAll<{ recorded_by: string; amount_inr: number; voided_at: string | null }>((a, b) =>
    admin
      .from('cash_movements')
      .select('recorded_by, amount_inr, voided_at')
      .eq('direction', 'out')
      .not('category', 'is', null)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('id')
      .range(a, b) as unknown as PromiseLike<PageResult<{ recorded_by: string; amount_inr: number; voided_at: string | null }>>,
  ).catch((err: unknown) => {
    if (isMissingColumnError(err as PostgrestLikeError) || isMissingRelation(err)) {
      return [] as { recorded_by: string; amount_inr: number; voided_at: string | null }[];
    }
    throw err;
  });
  return rows.map((r) => ({ user_id: r.recorded_by, amount_inr: r.amount_inr, voided: r.voided_at !== null }));
}

/** Cash-drawer shortages whose business date is in the range, by the person they are charged to now. */
async function loadShortages(admin: SupabaseClient, from: string, to: string): Promise<StaffShortage[]> {
  const rows = await fetchAll<{ user_id: string; amount_inr: number; status: string }>((a, b) =>
    admin
      .from('cash_shortages')
      .select('user_id, amount_inr, status')
      .gte('business_date', from)
      .lte('business_date', to)
      .order('id')
      .range(a, b) as unknown as PromiseLike<PageResult<{ user_id: string; amount_inr: number; status: string }>>,
  ).catch((err: unknown) => {
    // cash_shortages arrived with the cash-counts migration (2026-09).
    if (isMissingColumnError(err as PostgrestLikeError) || isMissingRelation(err)) {
      return [] as { user_id: string; amount_inr: number; status: string }[];
    }
    throw err;
  });
  return rows.map((r) => ({ user_id: r.user_id, amount_inr: r.amount_inr, status: r.status as StaffShortage['status'] }));
}

async function loadPerformance(admin: SupabaseClient, from: string, to: string): Promise<StaffPerformanceInput> {
  const [roster, dataset, expenses, shortages] = await Promise.all([
    loadStaffDays(admin, from, to),
    loadOrderDataset(admin, from, to),
    loadExpenses(admin, from, to),
    loadShortages(admin, from, to),
  ]);
  // Order creators who are not on the team roster (e.g. a former staffer) still get a name.
  const names = new Map(roster.names);
  for (const o of dataset.orders) {
    if (o.createdById && !names.has(o.createdById)) names.set(o.createdById, o.createdByName || UNKNOWN_STAFF);
  }
  return { names, days: roster.days, orders: dataset.orders, refunds: dataset.refunds, expenses, shortages };
}

export const STAFF_REPORTS: ReportDef[] = [
  {
    key: 'staff-attendance',
    group: 'staff',
    title: 'Attendance register',
    description:
      'Every punch in the period, one row each, with its status, whether it was a punch or a manual entry, and how late the day started. Each paid or unpaid leave day has its own row.',
    load: async (admin, from, to) => attendanceRegister((await loadStaffDays(admin, from, to)).days),
  },
  {
    key: 'staff-attendance-summary',
    group: 'staff',
    title: 'Attendance summary',
    description:
      'One row per team member: days present, hours worked, lateness, overtime, leave days and punches still open, counted the way payroll counts them.',
    load: async (admin, from, to) => attendanceSummary((await loadStaffDays(admin, from, to)).days),
  },
  {
    key: 'staff-performance',
    group: 'staff',
    title: 'Staff performance',
    description:
      'For each person: hours worked, bills rung up, sales, discounts, tips, cancellations, voided items, refunds, expenses and cash shortages for the period.',
    load: async (admin, from, to) => staffPerformance(await loadPerformance(admin, from, to)),
  },
];
