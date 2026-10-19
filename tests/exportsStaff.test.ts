import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dayOfWeekFor,
  rollUpDay,
  type DayEmployment,
  type DayMark,
  type DayRules,
  type DaySession,
} from '@/lib/attendance/day';
import type { CsvTable, CsvValue } from '@/lib/reports/csv';
import type { ExportLine, ExportOrder, ExportRefund, VoidedLine } from '@/lib/reports/exports/types';
import {
  attendanceRegister,
  attendanceSummary,
  staffPerformance,
  type StaffDay,
  type StaffExpense,
  type StaffSession,
  type StaffShortage,
} from '@/lib/reports/exports/staffReports';
import { STAFF_REPORTS } from '@/lib/reports/exports/staffReportsServer';

// The staff sheets (lib/reports/exports/staffReports.ts). The day rollups are
// REAL rollUpDay results (lib/attendance/day.ts) on a shift of 10:00–18:00 with
// a 15-minute grace period, so late, overtime, half-day and leave figures are
// the payroll rules, not copies of them. Times are IST.

const RULES: DayRules = {
  gracePeriodMin: 15,
  otThresholdMin: 0,
  autoBreakMin: 0,
  autoBreakAfterMin: 360,
  halfDayMinMinutes: 240,
  absentBelowMinutes: 120,
};
const SHIFT: DayEmployment = { contractedHoursPerDay: 8, shiftStartTime: '10:00', shiftEndTime: '18:00', weeklyOffDow: null };

/** The UTC ISO of an IST wall-clock time on an IST date. */
function at(date: string, hm: string): string {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - (5 * 60 + 30) * 60_000).toISOString();
}

interface PunchSpec {
  id: string;
  /** IST 'HH:MM' on the day. */
  in: string;
  out: string | null;
  status?: StaffSession['status'];
  source?: StaffSession['source'];
  approvedAt?: string | null;
}

/** One staffer on one date, rolled up the way the attendance sheet does it. */
function staffDay(opts: {
  date: string;
  user?: string;
  name?: string;
  punches?: PunchSpec[];
  mark?: DayMark;
  employment?: DayEmployment | null;
  scheduledOff?: boolean;
}): StaffDay {
  const sessions: StaffSession[] = (opts.punches ?? []).map((p) => ({
    id: p.id,
    clock_in_at: at(opts.date, p.in),
    clock_out_at: p.out ? at(opts.date, p.out) : null,
    status: p.status ?? (p.out ? 'closed' : 'open'),
    source: p.source ?? 'punch',
    approved_at: p.approvedAt ?? null,
  }));
  const daySessions: DaySession[] = sessions.map((s) => ({
    id: s.id,
    clockInAt: s.clock_in_at,
    clockOutAt: s.clock_out_at,
    status: s.status,
    source: s.source,
    approvedAt: s.approved_at,
    flags: [],
  }));
  const mark = opts.mark ?? null;
  const rollup = rollUpDay({
    date: opts.date,
    sessions: daySessions,
    rules: RULES,
    employment: opts.employment === undefined ? SHIFT : opts.employment,
    mark,
    scheduledOff: opts.scheduledOff,
    dayOfWeek: dayOfWeekFor(opts.date),
  });
  return { user_id: opts.user ?? 'u1', staff: opts.name ?? 'Ravi Kumar', rollup, sessions, mark };
}

/** The cell in `row` under the column whose header is `header`. */
function cell(t: CsvTable, row: number, header: string): CsvValue {
  const i = t.columns.indexOf(header);
  if (i < 0) throw new Error(`no column ${header}`);
  return t.rows[row][i];
}

function rowNamed(t: CsvTable, first: string): number {
  return t.rows.findIndex((r) => r[0] === first);
}

// ── Attendance register ──────────────────────────────────────────────────────

describe('attendanceRegister', () => {
  it('has the register columns', () => {
    expect(attendanceRegister([]).columns).toEqual([
      'Date',
      'Staff',
      'Clock in (IST)',
      'Clock out (IST)',
      'Punch hours',
      'Status',
      'Source',
      'Late by (min)',
    ]);
  });

  it('writes one closed punch with IST times, hours to 2 dp, and the minutes late past the grace period', () => {
    const t = attendanceRegister([staffDay({ date: '2026-10-18', punches: [{ id: 's1', in: '10:20', out: '18:00' }] })]);
    expect(t.rows[0]).toEqual(['2026-10-18', 'Ravi Kumar', '10:20', '18:00', 7.67, 'Closed', 'Punch', 5]);
  });

  it('shows 0 late minutes for an on-time arrival', () => {
    const t = attendanceRegister([staffDay({ date: '2026-10-18', punches: [{ id: 's1', in: '10:10', out: '18:00' }] })]);
    expect(cell(t, 0, 'Late by (min)')).toBe(0);
  });

  it('puts the lateness on the first punch of the day only', () => {
    const t = attendanceRegister([
      staffDay({
        date: '2026-10-18',
        punches: [
          { id: 's1', in: '10:30', out: '13:00' },
          { id: 's2', in: '14:00', out: '18:00' },
        ],
      }),
    ]);
    expect(cell(t, 0, 'Late by (min)')).toBe(15);
    expect(cell(t, 1, 'Late by (min)')).toBe('');
  });

  it('labels each punch status and leaves the hours blank where the rules do not count the punch', () => {
    const t = attendanceRegister([
      staffDay({ date: '2026-10-19', punches: [{ id: 'open', in: '10:00', out: null }] }),
      staffDay({ date: '2026-10-20', punches: [{ id: 'unapproved', in: '10:00', out: '18:00', status: 'auto_closed' }] }),
      staffDay({ date: '2026-10-21', punches: [{ id: 'approved', in: '10:00', out: '18:00', status: 'auto_closed', approvedAt: '2026-10-22T03:00:00Z' }] }),
      staffDay({ date: '2026-10-22', punches: [{ id: 'void', in: '10:00', out: '18:00', status: 'void' }] }),
      staffDay({ date: '2026-10-23', punches: [{ id: 'manual', in: '10:00', out: '18:00', source: 'manual', approvedAt: '2026-10-24T03:00:00Z' }] }),
    ]);
    expect(t.rows[0]).toEqual(['2026-10-19', 'Ravi Kumar', '10:00', '', '', 'Open (no clock-out)', 'Punch', 0]);
    expect(t.rows[1]).toEqual(['2026-10-20', 'Ravi Kumar', '10:00', '18:00', '', 'Auto-closed, needs approval', 'Punch', 0]);
    expect(t.rows[2]).toEqual(['2026-10-21', 'Ravi Kumar', '10:00', '18:00', 8, 'Auto-closed (approved)', 'Punch', 0]);
    expect(t.rows[3]).toEqual(['2026-10-22', 'Ravi Kumar', '10:00', '18:00', '', 'Void (not counted)', 'Punch', '']);
    expect(t.rows[4]).toEqual(['2026-10-23', 'Ravi Kumar', '10:00', '18:00', 8, 'Closed', 'Manual', 0]);
  });

  it('adds a row for each paid and each unpaid leave day, with the clock columns blank', () => {
    const t = attendanceRegister([
      staffDay({ date: '2026-10-20', mark: 'paid_leave' }),
      staffDay({ date: '2026-10-21', mark: 'unpaid_leave' }),
    ]);
    expect(t.rows[0]).toEqual(['2026-10-20', 'Ravi Kumar', '', '', '', 'Paid leave', '', '']);
    expect(t.rows[1]).toEqual(['2026-10-21', 'Ravi Kumar', '', '', '', 'Unpaid leave', '', '']);
  });

  it('writes no row for a day with no punches and no leave mark', () => {
    const t = attendanceRegister([staffDay({ date: '2026-10-18' })]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][0]).toBe('TOTAL');
  });

  it('sorts by date, then staff, then clock-in, with a leave row before the punches of its day', () => {
    const t = attendanceRegister([
      staffDay({ date: '2026-10-19', user: 'u2', name: 'Asha Verma', punches: [{ id: 'a', in: '10:00', out: '11:00' }] }),
      staffDay({ date: '2026-10-19', user: 'u1', name: 'Ravi Kumar', punches: [{ id: 'r2', in: '14:00', out: '15:00' }] }),
      staffDay({ date: '2026-10-19', user: 'u1', name: 'Ravi Kumar', punches: [{ id: 'r1', in: '10:00', out: '11:00' }] }),
      staffDay({ date: '2026-10-18', user: 'u1', name: 'Ravi Kumar', mark: 'paid_leave' }),
    ]);
    expect(t.rows.map((r) => [r[0], r[1], r[2]])).toEqual([
      ['2026-10-18', 'Ravi Kumar', ''],
      ['2026-10-19', 'Asha Verma', '10:00'],
      ['2026-10-19', 'Ravi Kumar', '10:00'],
      ['2026-10-19', 'Ravi Kumar', '14:00'],
      ['TOTAL', '', ''],
    ]);
  });

  it('sums the counted hours on the TOTAL row and leaves leave and void rows out of it', () => {
    const t = attendanceRegister([
      staffDay({ date: '2026-10-18', punches: [{ id: 's1', in: '10:00', out: '13:00' }] }),
      staffDay({ date: '2026-10-19', punches: [{ id: 's2', in: '10:00', out: '12:30' }, { id: 's3', in: '13:00', out: '14:00', status: 'void' }] }),
      staffDay({ date: '2026-10-20', mark: 'paid_leave' }),
    ]);
    expect(cell(t, rowNamed(t, 'TOTAL'), 'Punch hours')).toBe(5.5);
  });

  it('returns only the headers and a zero TOTAL for empty input', () => {
    const t = attendanceRegister([]);
    expect(t.rows).toEqual([['TOTAL', '', '', '', 0, '', '', '']]);
  });
});

// ── Attendance summary ───────────────────────────────────────────────────────

describe('attendanceSummary', () => {
  // Ravi: a full day, a half day, paid leave, unpaid leave, and a punch still open.
  // Asha: one late day with 60 minutes of overtime. Meera: no punches all month.
  const days: StaffDay[] = [
    staffDay({ date: '2026-10-18', user: 'u1', name: 'Ravi Kumar', punches: [{ id: 'r1', in: '10:00', out: '18:00' }] }),
    staffDay({ date: '2026-10-19', user: 'u1', name: 'Ravi Kumar', punches: [{ id: 'r2', in: '10:00', out: '13:00' }] }),
    staffDay({ date: '2026-10-20', user: 'u1', name: 'Ravi Kumar', mark: 'paid_leave' }),
    staffDay({ date: '2026-10-21', user: 'u1', name: 'Ravi Kumar', mark: 'unpaid_leave' }),
    staffDay({ date: '2026-10-22', user: 'u1', name: 'Ravi Kumar', punches: [{ id: 'r3', in: '10:00', out: null }] }),
    staffDay({ date: '2026-10-18', user: 'u2', name: 'Asha Verma', punches: [{ id: 'a1', in: '10:30', out: '19:30' }] }),
    staffDay({ date: '2026-10-19', user: 'u2', name: 'Asha Verma' }),
    staffDay({ date: '2026-10-18', user: 'u3', name: 'Meera Joshi' }),
    staffDay({ date: '2026-10-19', user: 'u3', name: 'Meera Joshi' }),
    staffDay({ date: '2026-10-18', user: 'u4', name: 'Dev Rao', employment: null }),
  ];
  const t = attendanceSummary(days);

  it('has one row per team member, sorted by name, then a TOTAL', () => {
    expect(t.columns).toEqual([
      'Staff',
      'Days present',
      'Hours worked',
      'Avg hours per day',
      'Late days',
      'Overtime hours',
      'Paid leave days',
      'Unpaid leave days',
      'Open sessions',
    ]);
    expect(t.rows.map((r) => r[0])).toEqual(['Asha Verma', 'Dev Rao', 'Meera Joshi', 'Ravi Kumar', 'TOTAL']);
  });

  it('counts a half day as present and a day awaiting approval as not present', () => {
    const ravi = rowNamed(t, 'Ravi Kumar');
    expect(cell(t, ravi, 'Days present')).toBe(2);
    expect(cell(t, ravi, 'Hours worked')).toBe(11);
    expect(cell(t, ravi, 'Avg hours per day')).toBe(5.5);
    expect(cell(t, ravi, 'Open sessions')).toBe(1);
  });

  it('counts paid and unpaid leave days', () => {
    const ravi = rowNamed(t, 'Ravi Kumar');
    expect(cell(t, ravi, 'Paid leave days')).toBe(1);
    expect(cell(t, ravi, 'Unpaid leave days')).toBe(1);
  });

  it('counts late days and overtime with the payroll rules', () => {
    const asha = rowNamed(t, 'Asha Verma');
    expect(cell(t, asha, 'Days present')).toBe(1);
    expect(cell(t, asha, 'Hours worked')).toBe(9);
    expect(cell(t, asha, 'Late days')).toBe(1);
    expect(cell(t, asha, 'Overtime hours')).toBe(1);
  });

  it('shows a month with no punches as zeros, with no average for a day that was never worked', () => {
    const meera = rowNamed(t, 'Meera Joshi');
    expect(t.rows[meera]).toEqual(['Meera Joshi', 0, 0, '', 0, 0, 0, 0, 0]);
  });

  it('does not count a day with no employment record as an absence', () => {
    const dev = rowNamed(t, 'Dev Rao');
    expect(t.rows[dev]).toEqual(['Dev Rao', 0, 0, '', 0, 0, 0, 0, 0]);
  });

  it('sums every column on the TOTAL row, with the average over all days present', () => {
    const total = rowNamed(t, 'TOTAL');
    expect(t.rows[total]).toEqual(['TOTAL', 3, 20, 6.67, 1, 1, 1, 1, 1]);
  });

  it('returns a zero TOTAL for empty input', () => {
    expect(attendanceSummary([]).rows).toEqual([['TOTAL', 0, 0, '', 0, 0, 0, 0, 0]]);
  });
});

// ── Staff performance ────────────────────────────────────────────────────────

function order(p: Partial<ExportOrder> & { createdById: string | null }): ExportOrder {
  return {
    id: 'o',
    orderNumber: 1,
    invoiceNo: 'HIOC-000001',
    createdAt: '2026-10-18T05:00:00Z',
    date: '2026-10-18',
    time: '10:30',
    hour: 10,
    status: 'completed',
    valid: true,
    rejectReason: null,
    paymentStatus: 'paid',
    paymentMethods: ['cash'],
    channel: 'staff_pos',
    orderType: 'dine_in',
    orderKind: 'menu',
    tableLabel: null,
    createdByName: '',
    subtotalInr: 0,
    taxInr: 0,
    packagingInr: 0,
    discountInr: 0,
    totalInr: 0,
    settleDiscountInr: 0,
    tipInr: 0,
    couponCodes: [],
    couponDiscountInr: 0,
    beaniesDiscountInr: 0,
    refundedInr: 0,
    taxableValueInr: 0,
    exemptValueInr: 0,
    cgstInr: 0,
    sgstInr: 0,
    lines: [],
    voidedLines: [],
    ...p,
  } as ExportOrder;
}

const line = (quantity: number): ExportLine => ({ quantity, lineTotalInr: 0 }) as unknown as ExportLine;
const voided = (lineTotalInr: number): VoidedLine => ({ quantity: 1, lineTotalInr, name: 'Latte', variant: '', reason: null }) as VoidedLine;

function refund(p: Partial<ExportRefund>): ExportRefund {
  return { id: 'r', orderId: 'o', invoiceNo: 'HIOC-000001', orderDate: '2026-10-18', date: '2026-10-18', amountInr: 0, method: 'cash', reason: null, status: 'processed', processedAt: null, createdById: null, createdByName: '', ...p } as ExportRefund;
}

const NAMES = new Map([
  ['u1', 'Ravi Kumar'],
  ['u2', 'Asha Verma'],
  ['u3', 'Meera Joshi'],
]);

describe('staffPerformance', () => {
  const days: StaffDay[] = [
    staffDay({ date: '2026-10-18', user: 'u1', name: 'Ravi Kumar', punches: [{ id: 'r1', in: '10:00', out: '18:00' }] }),
    staffDay({ date: '2026-10-18', user: 'u3', name: 'Meera Joshi', punches: [{ id: 'm1', in: '10:00', out: '13:00' }] }),
    // Dev has no punches and no orders: left out.
    staffDay({ date: '2026-10-18', user: 'u9', name: 'Dev Rao' }),
  ];
  const orders: ExportOrder[] = [
    order({ id: 'o1', createdById: 'u1', createdByName: 'Ravi Kumar', totalInr: 1000, discountInr: 50, settleDiscountInr: 20, tipInr: 30, lines: [line(2), line(1)] }),
    order({ id: 'o2', createdById: 'u1', createdByName: 'Ravi Kumar', valid: false, status: 'cancelled', totalInr: 300, voidedLines: [voided(120)] }),
    order({ id: 'o3', createdById: 'u2', createdByName: 'Asha Verma', totalInr: 500, lines: [line(4)] }),
    // A customer's web order has no creator and is not in the sheet.
    order({ id: 'o4', createdById: null, totalInr: 999, lines: [line(9)] }),
  ];
  const refunds: ExportRefund[] = [
    refund({ id: 'r1', createdById: 'u1', createdByName: 'Ravi Kumar', amountInr: 200, status: 'processed' }),
    refund({ id: 'r2', createdById: 'u1', createdByName: 'Ravi Kumar', amountInr: 100, status: 'pending' }),
    refund({ id: 'r3', createdById: 'u2', createdByName: 'Asha Verma', amountInr: 50, status: 'processed' }),
    // Issued by nobody on the roster: counted for nobody.
    refund({ id: 'r4', createdById: null, createdByName: '', amountInr: 70, status: 'processed' }),
    // Credited by id even when the name on the export differs.
    refund({ id: 'r5', createdById: 'u2', createdByName: 'A. Verma', amountInr: 25, status: 'processed' }),
  ];
  const expenses: StaffExpense[] = [
    { user_id: 'u1', amount_inr: 150, voided: false },
    { user_id: 'u1', amount_inr: 80, voided: true },
    { user_id: 'u2', amount_inr: 40, voided: false },
  ];
  const shortages: StaffShortage[] = [
    { user_id: 'u1', amount_inr: 500, status: 'approved' },
    { user_id: 'u1', amount_inr: 250, status: 'pending' },
    { user_id: 'u1', amount_inr: 100, status: 'waived' },
    { user_id: 'u3', amount_inr: 75, status: 'pending' },
  ];
  const t = staffPerformance({ names: NAMES, days, orders, refunds, expenses, shortages });

  it('has the performance columns', () => {
    expect(t.columns).toHaveLength(17);
    expect(t.columns[0]).toBe('Staff');
    expect(t.columns.slice(-2)).toEqual(['Cash shortages approved (INR)', 'Cash shortages pending (INR)']);
  });

  it('includes everyone with attendance or an order, sorted by name, and leaves out the rest', () => {
    expect(t.rows.map((r) => r[0])).toEqual(['Asha Verma', 'Meera Joshi', 'Ravi Kumar', 'TOTAL']);
  });

  it('counts bills, sales, items and discounts from the orders the person rang up, valid ones only for sales', () => {
    expect(t.rows[rowNamed(t, 'Ravi Kumar')]).toEqual([
      'Ravi Kumar', 8, 1, 1000, 125, 1000, 3, 50, 20, 30, 1, 1, 120, 200, 150, 500, 250,
    ]);
  });

  it('gives a person with attendance but no orders zero sales, no average bill, and their hours per hour as zero', () => {
    expect(t.rows[rowNamed(t, 'Meera Joshi')]).toEqual([
      'Meera Joshi', 3, 0, 0, 0, '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 75,
    ]);
  });

  it('gives a person with orders but no attendance a blank sales-per-hour', () => {
    expect(t.rows[rowNamed(t, 'Asha Verma')]).toEqual([
      'Asha Verma', 0, 1, 500, '', 500, 4, 0, 0, 0, 0, 0, 0, 75, 40, 0, 0,
    ]);
  });

  it('credits refunds to the staffer by id, counting only processed ones', () => {
    expect(cell(t, rowNamed(t, 'Ravi Kumar'), 'Refunds processed (INR)')).toBe(200);
    expect(cell(t, rowNamed(t, 'Asha Verma'), 'Refunds processed (INR)')).toBe(75);
  });

  it('counts expenses that are not voided, and shortages by status', () => {
    const ravi = rowNamed(t, 'Ravi Kumar');
    expect(cell(t, ravi, 'Expenses recorded (INR)')).toBe(150);
    expect(cell(t, ravi, 'Cash shortages approved (INR)')).toBe(500);
    expect(cell(t, ravi, 'Cash shortages pending (INR)')).toBe(250);
  });

  it('sums the TOTAL row, with sales per hour and average bill taken over the whole team', () => {
    expect(t.rows[rowNamed(t, 'TOTAL')]).toEqual([
      'TOTAL', 11, 2, 1500, 136.36, 750, 7, 50, 20, 30, 1, 1, 120, 275, 190, 500, 325,
    ]);
  });

  it('returns a zero TOTAL for empty input', () => {
    const empty = staffPerformance({ names: new Map(), days: [], orders: [], refunds: [], expenses: [], shortages: [] });
    expect(empty.rows).toEqual([['TOTAL', 0, 0, 0, '', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]]);
  });
});

// ── The registry's loaders, over an in-memory fake database ──────────────────

// The settings and employment helpers take their client from the server module, so
// point it at the same fake the loader gets.
const staffDb: { client: SupabaseClient | null } = { client: null };
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => staffDb.client,
}));

type Row = Record<string, unknown>;
type QueryError = { code: string; message: string };
type QueryResult = { data: unknown; error: QueryError | null };

const SCHEMA: Record<string, string[]> = {
  profiles: ['id', 'name', 'role'],
  attendance_sessions: ['id', 'user_id', 'business_date', 'clock_in_at', 'clock_out_at', 'status', 'source', 'approved_at', 'flags'],
  attendance_day_marks: ['user_id', 'business_date', 'mark'],
  leave_requests: ['user_id', 'leave_date', 'status'],
  staff_employment: ['user_id', 'effective_from', 'effective_to', 'contracted_hours_per_day', 'shift_start_time', 'shift_end_time', 'weekly_off_dow'],
  attendance_settings: ['is_singleton'],
};

/** A select/filter chain over in-memory rows; a select naming an unknown column fails like PostgREST does. */
class StaffFakeQuery implements PromiseLike<QueryResult> {
  private preds: ((r: Row) => boolean)[] = [];
  private cols: string[] = [];
  private error: QueryError | null = null;
  private orderCol: string | null = null;
  private span: [number, number] | null = null;
  private single = false;

  constructor(
    private readonly rows: Row[],
    private readonly schema: string[],
  ) {}

  select(list: string) {
    this.cols = list.trim() === '*' ? this.schema : list.split(',').map((c) => c.trim());
    const bad = this.cols.find((c) => !this.schema.includes(c));
    if (bad) this.error = { code: '42703', message: `column "${bad}" does not exist` };
    return this;
  }
  eq(c: string, v: unknown) {
    this.preds.push((r) => r[c] === v);
    return this;
  }
  in(c: string, vals: unknown[]) {
    this.preds.push((r) => vals.includes(r[c]));
    return this;
  }
  gte(c: string, v: string) {
    this.preds.push((r) => typeof r[c] === 'string' && (r[c] as string) >= v);
    return this;
  }
  lte(c: string, v: string) {
    this.preds.push((r) => typeof r[c] === 'string' && (r[c] as string) <= v);
    return this;
  }
  /** Not needed for these fixtures: loadEmploymentRows over-fetches and employmentOnDate filters per date. */
  or() {
    return this;
  }
  order(c: string) {
    this.orderCol = c;
    return this;
  }
  range(from: number, to: number) {
    this.span = [from, to];
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private run(): QueryResult {
    if (this.error) return { data: null, error: this.error };
    let rows = this.rows.filter((r) => this.preds.every((p) => p(r)));
    const col = this.orderCol;
    if (col) rows = [...rows].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')));
    if (this.span) rows = rows.slice(this.span[0], this.span[1] + 1);
    const out = rows.map((r) => Object.fromEntries(this.cols.map((c) => [c, r[c] ?? null])));
    return { data: this.single ? (out[0] ?? null) : out, error: null };
  }

  then<T1 = QueryResult, T2 = never>(
    onfulfilled?: ((value: QueryResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

const STAFF_TABLES: Record<string, Row[]> = {
  profiles: [
    { id: 'u1', name: 'Ravi Kumar', role: 'staff' },
    { id: 'u2', name: 'Asha Verma', role: 'manager' },
    { id: 'u5', name: 'Web Customer', role: 'customer' },
  ],
  attendance_sessions: [
    // Ravi punches in 10:20 (5 minutes late after the 15-minute grace period) and leaves at 18:00.
    { id: 's1', user_id: 'u1', business_date: '2026-10-18', clock_in_at: at('2026-10-18', '10:20'), clock_out_at: at('2026-10-18', '18:00'), status: 'closed', source: 'punch', approved_at: null, flags: [] },
    { id: 's2', user_id: 'u2', business_date: '2026-10-18', clock_in_at: at('2026-10-18', '10:00'), clock_out_at: at('2026-10-18', '18:00'), status: 'closed', source: 'punch', approved_at: null, flags: [] },
    // Ravi clocked in on the 19th and never out.
    { id: 's3', user_id: 'u1', business_date: '2026-10-19', clock_in_at: at('2026-10-19', '10:00'), clock_out_at: null, status: 'open', source: 'punch', approved_at: null, flags: [] },
  ],
  attendance_day_marks: [{ user_id: 'u1', business_date: '2026-10-20', mark: 'paid_leave' }],
  leave_requests: [],
  staff_employment: [
    { user_id: 'u1', effective_from: '2026-10-01', effective_to: null, contracted_hours_per_day: 8, shift_start_time: '10:00', shift_end_time: '18:00', weekly_off_dow: null },
    { user_id: 'u2', effective_from: '2026-10-01', effective_to: null, contracted_hours_per_day: 8, shift_start_time: '10:00', shift_end_time: '18:00', weekly_off_dow: null },
  ],
  // No settings row: the helper falls back to the migration defaults, which are the RULES above.
  attendance_settings: [],
};

function staffLoader(key: string) {
  const def = STAFF_REPORTS.find((r) => r.key === key);
  if (!def) throw new Error(`no report ${key}`);
  staffDb.client = {
    from: (table: string) => new StaffFakeQuery(STAFF_TABLES[table] ?? [], SCHEMA[table] ?? []),
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
  } as unknown as SupabaseClient;
  return (from: string, to: string) => def.load(staffDb.client as SupabaseClient, from, to);
}

describe('STAFF_REPORTS loaders over the fake database', () => {
  it('registers exactly the three staff keys in the staff group', () => {
    expect(STAFF_REPORTS.map((r) => r.key)).toEqual(['staff-attendance', 'staff-attendance-summary', 'staff-performance']);
    expect(STAFF_REPORTS.every((r) => r.group === 'staff')).toBe(true);
  });

  it('builds the attendance register from the punches and the leave mark, with the team roster only', async () => {
    const t = await staffLoader('staff-attendance')('2026-10-18', '2026-10-20');
    expect(t.rows.map((r) => [r[0], r[1], r[2], r[5]])).toEqual([
      ['2026-10-18', 'Asha Verma', '10:00', 'Closed'],
      ['2026-10-18', 'Ravi Kumar', '10:20', 'Closed'],
      ['2026-10-19', 'Ravi Kumar', '10:00', 'Open (no clock-out)'],
      ['2026-10-20', 'Ravi Kumar', '', 'Paid leave'],
      ['TOTAL', '', '', ''],
    ]);
    expect(cell(t, 1, 'Late by (min)')).toBe(5);
    expect(cell(t, 0, 'Punch hours')).toBe(8);
    expect(cell(t, rowNamed(t, 'TOTAL'), 'Punch hours')).toBe(15.67);
  });

  it('builds the attendance summary with the payroll rules, one row per team member', async () => {
    const t = await staffLoader('staff-attendance-summary')('2026-10-18', '2026-10-20');
    expect(t.rows).toEqual([
      ['Asha Verma', 1, 8, 8, 0, 0, 0, 0, 0],
      ['Ravi Kumar', 1, 7.67, 7.67, 1, 0, 1, 0, 1],
      ['TOTAL', 2, 15.67, 7.83, 1, 0, 1, 0, 1],
    ]);
  });
});
