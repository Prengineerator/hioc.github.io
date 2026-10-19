// Staff sheets for the owner's downloads (Owner → Reports → Downloads): the
// attendance register, the attendance summary and the staff performance sheet.
// Pure. The server loader (staffReportsServer.ts) reads the punches, day marks,
// approved leave, employment and orders, and rolls every staffer's day up with
// rollUpDay (lib/attendance/day.ts), the function the owner's attendance sheet
// and the payroll engine both use. So hours, lateness, overtime and leave here
// are the numbers payroll pays on.
//
// Not payroll's hours on the REGISTER, though: each punch shows its own raw
// duration, so overlaps are not merged and a single-session auto-break is not
// taken off. The SUMMARY and PERFORMANCE sheets use the payroll day rules.

import { istMinutesOfDay } from '@/lib/attendance/businessDate';
import type { DayMark, DayRollup } from '@/lib/attendance/day';
import { round2, type CsvTable, type CsvValue } from '@/lib/reports/csv';
import type { ExportOrder, ExportRefund } from '@/lib/reports/exports/types';

/** One punch (attendance_sessions), as the register reads it. */
export interface StaffSession {
  id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  status: 'open' | 'closed' | 'auto_closed' | 'void';
  source: 'punch' | 'manual';
  approved_at: string | null;
}

/**
 * One staffer on one IST date: the day as the attendance sheet rolls it up.
 * Every staffer on the team has one per date in the range, so a month with no
 * punches is a row of absences, not a missing row.
 */
export interface StaffDay {
  user_id: string;
  staff: string;
  /** rollUpDay's answer for the day; `rollup.date` is the IST business date. */
  rollup: DayRollup;
  /** The day's punches, voided ones included. */
  sessions: StaffSession[];
  /** A paid or unpaid leave day mark (attendance_day_marks), or null. */
  mark: DayMark;
}

/** A cash-drawer expense someone recorded (cash_movements), with its void flag. */
export interface StaffExpense {
  user_id: string;
  amount_inr: number;
  voided: boolean;
}

/** A cash-drawer shortage charged to someone (cash_shortages), by its current owner. */
export interface StaffShortage {
  user_id: string;
  amount_inr: number;
  status: 'pending' | 'approved' | 'waived';
}

export interface StaffPerformanceInput {
  /** Display name by user id. Order creators not on the roster are added by the loader. */
  names: ReadonlyMap<string, string>;
  days: StaffDay[];
  /** Every order in the range (customer orders have no creator and are skipped here). */
  orders: ExportOrder[];
  /** Refunds in the range, credited to the staffer who issued them (createdById). */
  refunds: ExportRefund[];
  expenses: StaffExpense[];
  shortages: StaffShortage[];
}

const UNKNOWN_STAFF = 'Unknown staff';

/** 'HH:MM' (24 h, IST) of an instant. */
function hm(iso: string): string {
  const m = istMinutesOfDay(iso);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function sortedSessions(d: StaffDay): StaffSession[] {
  return [...d.sessions].sort((a, b) => Date.parse(a.clock_in_at) - Date.parse(b.clock_in_at));
}

/** A punch whose time the payroll rules count: closed, or an auto-close someone approved. */
function countsTowardHours(s: StaffSession): boolean {
  if (!s.clock_out_at) return false;
  return s.status === 'closed' || (s.status === 'auto_closed' && s.approved_at !== null);
}

function minutesBetween(s: StaffSession): number {
  if (!s.clock_out_at) return 0;
  return Math.max(0, Math.round((Date.parse(s.clock_out_at) - Date.parse(s.clock_in_at)) / 60_000));
}

function sessionStatusLabel(s: StaffSession): string {
  if (s.status === 'void') return 'Void (not counted)';
  if (s.status === 'open') return 'Open (no clock-out)';
  if (s.status === 'auto_closed') return s.approved_at ? 'Auto-closed (approved)' : 'Auto-closed, needs approval';
  return 'Closed';
}

// ── Attendance register ──────────────────────────────────────────────────────

const REGISTER_COLUMNS = [
  'Date',
  'Staff',
  'Clock in (IST)',
  'Clock out (IST)',
  // The raw punch duration, not the payroll hours of the summary (see the header).
  'Punch hours',
  'Status',
  'Source',
  'Late by (min)',
];

interface RegisterEntry {
  date: string;
  staff: string;
  /** Clock-in instant; -1 for a leave row, which sorts first in its day. */
  atMs: number;
  minutes: number;
  row: CsvValue[];
}

/**
 * One row per punch, plus one row per paid or unpaid leave day mark, oldest
 * first (date, then staff, then clock-in). "Late by" sits on the day's first
 * punch: how many minutes past the shift start, after the grace period (0 on
 * time), the same figure the payroll engine counts.
 */
export function attendanceRegister(days: StaffDay[]): CsvTable {
  const entries: RegisterEntry[] = [];
  for (const d of days) {
    const date = d.rollup.date;
    const firstLive = sortedSessions(d).find((s) => s.status !== 'void');
    for (const s of sortedSessions(d)) {
      const counted = countsTowardHours(s);
      const minutes = counted ? minutesBetween(s) : 0;
      const late = s.id === firstLive?.id ? d.rollup.lateMinutes : '';
      entries.push({
        date,
        staff: d.staff,
        atMs: Date.parse(s.clock_in_at),
        minutes,
        row: [
          date,
          d.staff,
          hm(s.clock_in_at),
          s.clock_out_at ? hm(s.clock_out_at) : '',
          counted ? round2(minutes / 60) : '',
          sessionStatusLabel(s),
          s.source === 'manual' ? 'Manual' : 'Punch',
          late,
        ],
      });
    }
    if (d.mark) {
      entries.push({
        date,
        staff: d.staff,
        atMs: -1,
        minutes: 0,
        row: [date, d.staff, '', '', '', d.mark === 'paid_leave' ? 'Paid leave' : 'Unpaid leave', '', ''],
      });
    }
  }
  entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.staff.localeCompare(b.staff) ||
      (a.atMs === b.atMs ? 0 : a.atMs < b.atMs ? -1 : 1),
  );
  const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);
  return {
    columns: REGISTER_COLUMNS,
    rows: [...entries.map((e) => e.row), ['TOTAL', '', '', '', round2(totalMinutes / 60), '', '', '']],
  };
}

// ── Attendance summary ───────────────────────────────────────────────────────

const SUMMARY_COLUMNS = [
  'Staff',
  'Days present',
  'Hours worked',
  'Avg hours per day',
  'Late days',
  'Overtime hours',
  'Paid leave days',
  'Unpaid leave days',
  'Open sessions',
];

interface SummaryFigures {
  staff: string;
  present: number;
  workedMinutes: number;
  lateDays: number;
  otMinutes: number;
  paidLeave: number;
  unpaidLeave: number;
  openSessions: number;
}

function summarize(staff: string, days: StaffDay[]): SummaryFigures {
  // Days the staffer is employed on; a day with no employment record is not an absence.
  const counted = days.filter((d) => d.rollup.status !== 'not_employed');
  return {
    staff,
    // Half days count as days present; the owner's sheet also shows them on their own.
    present: counted.filter((d) => d.rollup.status === 'present' || d.rollup.status === 'half_day').length,
    workedMinutes: days.reduce((s, d) => s + d.rollup.workedMinutes, 0),
    lateDays: counted.filter((d) => d.rollup.isLate).length,
    otMinutes: days.reduce((s, d) => s + d.rollup.otMinutes, 0),
    paidLeave: counted.filter((d) => d.rollup.status === 'paid_leave').length,
    unpaidLeave: counted.filter((d) => d.rollup.status === 'unpaid_leave').length,
    openSessions: days.reduce((s, d) => s + d.sessions.filter((x) => x.status === 'open').length, 0),
  };
}

function summaryRow(f: SummaryFigures): CsvValue[] {
  return [
    f.staff,
    f.present,
    round2(f.workedMinutes / 60),
    f.present > 0 ? round2(f.workedMinutes / 60 / f.present) : '',
    f.lateDays,
    round2(f.otMinutes / 60),
    f.paidLeave,
    f.unpaidLeave,
    f.openSessions,
  ];
}

/**
 * One row per staffer on the team (everyone in `days`), with the figures payroll
 * uses: days present, hours, lateness, overtime (the payroll OT rule), leave
 * days and punches still open. A TOTAL row.
 */
export function attendanceSummary(days: StaffDay[]): CsvTable {
  const byPerson = new Map<string, { staff: string; days: StaffDay[] }>();
  for (const d of days) {
    const p = byPerson.get(d.user_id) ?? { staff: d.staff, days: [] };
    p.days.push(d);
    byPerson.set(d.user_id, p);
  }
  const figures = [...byPerson.values()]
    .map((p) => summarize(p.staff, p.days))
    .sort((a, b) => a.staff.localeCompare(b.staff));
  const total = figures.reduce<SummaryFigures>(
    (t, f) => ({
      staff: 'TOTAL',
      present: t.present + f.present,
      workedMinutes: t.workedMinutes + f.workedMinutes,
      lateDays: t.lateDays + f.lateDays,
      otMinutes: t.otMinutes + f.otMinutes,
      paidLeave: t.paidLeave + f.paidLeave,
      unpaidLeave: t.unpaidLeave + f.unpaidLeave,
      openSessions: t.openSessions + f.openSessions,
    }),
    { staff: 'TOTAL', present: 0, workedMinutes: 0, lateDays: 0, otMinutes: 0, paidLeave: 0, unpaidLeave: 0, openSessions: 0 },
  );
  return {
    columns: SUMMARY_COLUMNS,
    rows: [...figures.map(summaryRow), summaryRow(total)],
  };
}

// ── Staff performance ────────────────────────────────────────────────────────

const PERFORMANCE_COLUMNS = [
  'Staff',
  'Hours worked',
  'Bills rung up',
  'Sales (INR)',
  'Sales per hour (INR)',
  'Avg bill (INR)',
  'Items sold',
  'Discounts given (INR)',
  'Settle discounts (INR)',
  'Tips (INR)',
  'Cancelled/rejected bills',
  'Voided items',
  'Voided value (INR)',
  'Refunds processed (INR)',
  'Expenses recorded (INR)',
  'Cash shortages approved (INR)',
  'Cash shortages pending (INR)',
];

interface PerformanceFigures {
  staff: string;
  workedMinutes: number;
  bills: number;
  sales: number;
  items: number;
  discounts: number;
  settle: number;
  tips: number;
  cancelled: number;
  voidedItems: number;
  voidedValue: number;
  refunds: number;
  expenses: number;
  shortApproved: number;
  shortPending: number;
}

const EMPTY_FIGURES: Omit<PerformanceFigures, 'staff'> = {
  workedMinutes: 0,
  bills: 0,
  sales: 0,
  items: 0,
  discounts: 0,
  settle: 0,
  tips: 0,
  cancelled: 0,
  voidedItems: 0,
  voidedValue: 0,
  refunds: 0,
  expenses: 0,
  shortApproved: 0,
  shortPending: 0,
};

function performanceRow(f: PerformanceFigures): CsvValue[] {
  const hours = f.workedMinutes / 60;
  return [
    f.staff,
    round2(hours),
    f.bills,
    round2(f.sales),
    hours > 0 ? round2(f.sales / hours) : '',
    f.bills > 0 ? round2(f.sales / f.bills) : '',
    f.items,
    round2(f.discounts),
    round2(f.settle),
    round2(f.tips),
    f.cancelled,
    f.voidedItems,
    round2(f.voidedValue),
    round2(f.refunds),
    round2(f.expenses),
    round2(f.shortApproved),
    round2(f.shortPending),
  ];
}

/**
 * One row per person with attendance in the range, an order they rang up, or an
 * expense or cash shortage recorded against them, by name. Sales are the bills
 * they rang up that stand (not cancelled or rejected); cancelled bills and voided
 * items count on any order of theirs. Hours are the payroll day rules.
 */
export function staffPerformance(input: StaffPerformanceInput): CsvTable {
  const { names, days, orders, refunds, expenses, shortages } = input;

  const ordersBy = new Map<string, ExportOrder[]>();
  for (const o of orders) {
    if (!o.createdById) continue;
    const list = ordersBy.get(o.createdById) ?? [];
    list.push(o);
    ordersBy.set(o.createdById, list);
  }

  const ids = new Set<string>();
  for (const d of days) if (d.sessions.length > 0 || d.mark) ids.add(d.user_id);
  for (const id of ordersBy.keys()) ids.add(id);
  for (const e of expenses) ids.add(e.user_id);
  for (const s of shortages) ids.add(s.user_id);

  const figures: PerformanceFigures[] = [...ids].map((id) => {
    const f: PerformanceFigures = { ...EMPTY_FIGURES, staff: names.get(id) ?? UNKNOWN_STAFF };
    for (const d of days) if (d.user_id === id) f.workedMinutes += d.rollup.workedMinutes;
    for (const o of ordersBy.get(id) ?? []) {
      for (const v of o.voidedLines) {
        f.voidedItems += 1;
        f.voidedValue += v.lineTotalInr;
      }
      if (!o.valid) {
        f.cancelled += 1;
        continue;
      }
      f.bills += 1;
      f.sales += o.totalInr;
      f.discounts += o.discountInr;
      f.settle += o.settleDiscountInr;
      f.tips += o.tipInr;
      for (const l of o.lines) f.items += l.quantity;
    }
    for (const r of refunds) {
      if (r.status !== 'processed' || r.createdById !== id) continue;
      f.refunds += r.amountInr;
    }
    for (const e of expenses) if (e.user_id === id && !e.voided) f.expenses += e.amount_inr;
    for (const s of shortages) {
      if (s.user_id !== id) continue;
      if (s.status === 'approved') f.shortApproved += s.amount_inr;
      if (s.status === 'pending') f.shortPending += s.amount_inr;
    }
    return f;
  });
  figures.sort((a, b) => a.staff.localeCompare(b.staff));

  const total = figures.reduce<PerformanceFigures>(
    (t, f) => ({
      staff: 'TOTAL',
      workedMinutes: t.workedMinutes + f.workedMinutes,
      bills: t.bills + f.bills,
      sales: t.sales + f.sales,
      items: t.items + f.items,
      discounts: t.discounts + f.discounts,
      settle: t.settle + f.settle,
      tips: t.tips + f.tips,
      cancelled: t.cancelled + f.cancelled,
      voidedItems: t.voidedItems + f.voidedItems,
      voidedValue: t.voidedValue + f.voidedValue,
      refunds: t.refunds + f.refunds,
      expenses: t.expenses + f.expenses,
      shortApproved: t.shortApproved + f.shortApproved,
      shortPending: t.shortPending + f.shortPending,
    }),
    { ...EMPTY_FIGURES, staff: 'TOTAL' },
  );

  return {
    columns: PERFORMANCE_COLUMNS,
    rows: [...figures.map(performanceRow), performanceRow(total)],
  };
}
