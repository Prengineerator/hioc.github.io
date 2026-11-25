import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET and finalize on /api/owner/payroll with salary advances in play, and
// the not-yet-migrated case (no staff_advances table, no advance_inr column).

type Row = Record<string, unknown>;
type PgError = { code?: string; message?: string };

const state: {
  runs: Row[];
  runLines: Row[];
  advances: Row[];
  advancesError: PgError | null;
  linesSelectError: PgError | null;
  insertedLines: Row[] | null;
  gtFilters: [string, number][];
} = {
  runs: [],
  runLines: [],
  advances: [],
  advancesError: null,
  linesSelectError: null,
  insertedLines: null,
  gtFilters: [],
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      let op = 'select';
      const filters: Row = {};
      const isNull: string[] = [];
      let inF: { col: string; vals: unknown[] } | null = null;
      const chain: Row = {};
      const ok = (r: Row) =>
        Object.entries(filters).every(([k, v]) => r[k] === v) &&
        isNull.every((k) => r[k] === null || r[k] === undefined) &&
        (!inF || inF.vals.includes(r[inF.col]));
      const result = () => {
        if (table === 'attendance_settings') return { data: settings, error: null };
        if (table === 'profiles') return { data: [{ id: 'staff-1', name: 'Ravi', role: 'staff' }], error: null };
        if (table === 'attendance_sessions') return { data: sessions, error: null };
        if (table === 'staff_employment') return { data: employment, error: null };
        if (table === 'staff_advances') {
          if (state.advancesError) return { data: null, error: state.advancesError };
          return { data: state.advances.filter(ok), error: null };
        }
        if (table === 'payroll_runs') {
          if (op === 'insert') return { data: { id: 'run-new' }, error: null };
          return { data: state.runs.filter(ok), error: null };
        }
        if (table === 'payroll_run_lines') {
          if (op === 'insert') return { data: null, error: null };
          if (state.linesSelectError) return { data: null, error: state.linesSelectError };
          return { data: state.runLines.filter(ok), error: null };
        }
        return { data: [], error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        insert: (p: unknown) => {
          op = 'insert';
          if (table === 'payroll_run_lines') state.insertedLines = p as Row[];
          return chain;
        },
        update: () => chain,
        delete: () => chain,
        eq: (c: string, v: unknown) => {
          filters[c] = v;
          return chain;
        },
        in: (c: string, v: unknown[]) => {
          inF = { col: c, vals: v };
          return chain;
        },
        is: (c: string, v: unknown) => {
          if (v === null) isNull.push(c);
          return chain;
        },
        gt: (c: string, v: number) => {
          state.gtFilters.push([c, v]);
          return chain;
        },
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        neq: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result()),
        single: () => Promise.resolve(result()),
        then: (r: (v: unknown) => void) => r(result()),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve({ id: 'owner-1' }) }));
vi.mock('@/lib/payroll/payslipEmail', () => ({ sendPayslipsForRun: () => Promise.resolve([]) }));

const settings = {
  is_singleton: true,
  grace_period_min: 15,
  late_marks_per_halfday: 3,
  ot_threshold_min: 0,
  ot_multiplier: 1,
  auto_break_min: 0,
  auto_break_after_min: 360,
  half_day_min_minutes: 240,
  absent_below_minutes: 120,
  max_session_hours: 14,
  location_retention_days: 365,
  max_leave_days_per_week: 1,
};
const employment = [
  {
    id: 'emp-1',
    user_id: 'staff-1',
    monthly_salary_inr: 25_000,
    contracted_hours_per_day: 9,
    shift_start_time: '10:00',
    shift_end_time: '19:00',
    weekly_off_dow: 0,
    effective_from: '2026-01-01',
    effective_to: null,
  },
];
// One full 9h day in August: earns 25,000 × 540 ÷ (27 × 540) = ₹926.
const sessions = [
  {
    id: 's1',
    user_id: 'staff-1',
    business_date: '2026-08-03',
    clock_in_at: '2026-08-03T04:30:00Z',
    clock_out_at: '2026-08-03T13:30:00Z',
    status: 'closed',
    source: 'punch',
    approved_at: null,
    flags: [],
  },
];

const { GET, POST } = await import('@/app/api/owner/payroll/route');

const getMonth = (m = '2026-08') => GET(new Request(`http://t/api/owner/payroll?month=${m}`));
const finalize = () =>
  POST(
    new Request('http://t/api/owner/payroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ month: '2026-08', user_id: 'staff-1' }),
    }),
  );
const ravi = async (res: Response) =>
  ((await res.json()).lines as Row[]).find((l) => l.user_id === 'staff-1') as Row;

const adv = (over: Row = {}): Row => ({
  id: 'a1',
  user_id: 'staff-1',
  amount_inr: 3000,
  given_on: '2026-08-05',
  note: 'UPI',
  created_at: '2026-08-05T06:00:00Z',
  removed_at: null,
  ...over,
});

beforeEach(() => {
  state.runs = [];
  state.runLines = [];
  state.advances = [];
  state.advancesError = null;
  state.linesSelectError = null;
  state.insertedLines = null;
  state.gtFilters = [];
});

describe('payroll GET with advances', () => {
  it('takes the advance off, carries the rest, and lists the advances', async () => {
    state.advances = [adv()];
    const l = await ravi(await getMonth());
    expect(l.netBeforeDeductionsInr).toBe(926);
    expect(l.advanceOutstandingInr).toBe(3000);
    expect(l.advanceInr).toBe(926);
    expect(l.advanceCarriedInr).toBe(2074);
    expect(l.netPayInr).toBe(0);
    expect(l.advances).toEqual([{ id: 'a1', given_on: '2026-08-05', amount_inr: 3000, note: 'UPI', locked: false }]);
    expect(l.advanceCarriedFromEarlierInr).toBe(0);
  });

  it('shows an earlier month’s advance as carried from earlier', async () => {
    state.advances = [adv({ id: 'a0', amount_inr: 700, given_on: '2026-07-20' })];
    const l = await ravi(await getMonth());
    expect(l.advanceCarriedFromEarlierInr).toBe(700);
    expect(l.advances).toEqual([]);
    expect(l.advanceInr).toBe(700);
    expect(l.netPayInr).toBe(226);
  });

  it('ignores an advance dated after the month', async () => {
    state.advances = [adv({ given_on: '2026-09-02' })];
    const l = await ravi(await getMonth());
    expect(l.advanceOutstandingInr).toBe(0);
    expect(l.netPayInr).toBe(926);
  });

  it('does not take what a finalized run (another month) already took, and locks old advances', async () => {
    state.advances = [adv({ amount_inr: 1000 })];
    state.runs = [
      {
        id: 'run-j',
        user_id: 'staff-1',
        status: 'finalized',
        period_start: '2026-09-01',
        period_end: '2026-09-30',
        finalized_at: '2026-10-01T00:00:00Z',
      },
    ];
    state.runLines = [
      { run_id: 'run-j', user_id: 'staff-1', advance_inr: 1000 },
      // a reversed run's line must not count
      { run_id: 'run-rev', user_id: 'staff-1', advance_inr: 500 },
    ];
    const l = await ravi(await getMonth());
    expect(l.advanceOutstandingInr).toBe(0);
    expect((l.advances as Row[])[0].locked).toBe(true);
  });

  it('queries lines with advance_inr > 0 and no run-id list, filtering runs in memory', async () => {
    state.runs = [
      { id: 'run-j', user_id: 'staff-1', status: 'finalized', period_start: '2026-07-01', period_end: '2026-07-31', finalized_at: 'x' },
    ];
    await getMonth();
    expect(state.gtFilters).toContainEqual(['advance_inr', 0]);
  });

  it('does not lock an advance added after the month was finalized, and locks one it counted', async () => {
    state.runs = [
      {
        id: 'run-1',
        user_id: 'staff-1',
        status: 'finalized',
        period_start: '2026-08-01',
        period_end: '2026-08-31',
        finalized_at: '2026-09-01T00:00:00Z',
      },
    ];
    state.runLines = [
      { run_id: 'run-1', user_id: 'staff-1', net_pay_inr: 926, deductions_inr: 0, cash_shortage_inr: 0, detail: {} },
    ];
    state.advances = [
      adv({ id: 'old', given_on: '2026-08-10', created_at: '2026-08-10T06:00:00Z' }),
      adv({ id: 'late', given_on: '2026-08-28', created_at: '2026-09-02T06:00:00Z' }),
    ];
    const l = await ravi(await getMonth());
    const byId = Object.fromEntries((l.advances as Row[]).map((a) => [a.id, a.locked]));
    expect(byId).toEqual({ old: true, late: false });
  });

  it('serves a finalized line frozen, with its advance and carried amounts', async () => {
    state.runs = [
      { id: 'run-1', user_id: 'staff-1', status: 'finalized', period_start: '2026-08-01', period_end: '2026-08-31', finalized_at: 'x' },
    ];
    state.runLines = [
      {
        run_id: 'run-1',
        user_id: 'staff-1',
        net_pay_inr: 0,
        deductions_inr: 0,
        cash_shortage_inr: 0,
        advance_inr: 926,
        detail: { net_before_deductions_inr: 926, advance_outstanding_inr: 3000, advance_carried_inr: 2074 },
      },
    ];
    const l = await ravi(await getMonth());
    expect(l.finalized).toBe(true);
    expect(l.advanceInr).toBe(926);
    expect(l.advanceCarriedInr).toBe(2074);
    expect(l.advanceOutstandingInr).toBe(3000);
    expect(l.netBeforeDeductionsInr).toBe(926);
  });

  it('still works with no staff_advances table and no advance_inr column', async () => {
    state.advancesError = { code: 'PGRST205', message: 'Could not find the table' };
    state.runs = [
      { id: 'run-j', user_id: 'staff-1', status: 'finalized', period_start: '2026-07-01', period_end: '2026-07-31' },
    ];
    state.linesSelectError = { code: '42703', message: 'column payroll_run_lines.advance_inr does not exist' };
    const res = await getMonth();
    expect(res.status).toBe(200);
    const l = await ravi(res);
    expect(l.advanceInr).toBe(0);
    expect(l.netPayInr).toBe(926);
  });
});

describe('payroll finalize with advances', () => {
  it('freezes the advance taken and what carries, with the advances counted', async () => {
    state.advances = [adv(), adv({ id: 'a2', amount_inr: 500, given_on: '2026-08-20' })];
    const res = await finalize();
    expect(res.status).toBe(200);
    const row = (state.insertedLines as Row[])[0];
    expect(row.advance_inr).toBe(926);
    expect(row.net_pay_inr).toBe(0);
    const d = row.detail as Row;
    expect(d.net_before_deductions_inr).toBe(926);
    expect(d.advance_outstanding_inr).toBe(3500);
    expect(d.advance_carried_inr).toBe(2574);
    expect(d.advance_ids).toEqual(['a1', 'a2']);
  });

  it('leaves advance_inr out of the row for someone with no advance (works before the SQL)', async () => {
    state.advancesError = { code: 'PGRST205', message: 'Could not find the table' };
    const res = await finalize();
    expect(res.status).toBe(200);
    const row = (state.insertedLines as Row[])[0];
    expect('advance_inr' in row).toBe(false);
    expect((row.detail as Row).advance_ids).toBeUndefined();
    expect(row.net_pay_inr).toBe(926);
  });
});
