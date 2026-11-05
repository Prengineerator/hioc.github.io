import { beforeEach, describe, expect, it, vi } from 'vitest';

// PAY-3 / PAY-4 — handler tests for the payroll route.
//
// The gates worth holding: it is OWNER-only and not delegable through the
// permission matrix; payroll is finalized ONE STAFFER AT A TIME, so a
// finalized person is served FROZEN while everyone else stays a fresh draft;
// finalizing is refused while that person's days still need approval;
// deductions are only PROPOSED until the owner ticks them; and a reversal is
// recorded rather than deleting what was paid.

interface CashShortageFixture {
  id: string;
  user_id: string;
  amount_inr: number;
  status: string;
  business_date: string;
  payroll_run_id: string | null;
}

type PgError = { code?: string; message?: string };
type Row = Record<string, unknown>;

const state: {
  owner: { id: string } | null;
  runs: Row[];
  runLines: Row[];
  profiles: Row[];
  sessions: Row[];
  settings: Row;
  employment: Row[];
  insertedRun: Row | null;
  runInsertError: PgError | null;
  insertedLines: Row[] | null;
  updateResult: Row | null;
  updatePayload: Row | null;
  updateFilters: Row | null;
  deletedRunIds: string[];
  // CC-5
  cashShortages: CashShortageFixture[];
  cashShortagesError: PgError | null; // affects reads AND the reversal-clear update
  cashShortageUpdateError: PgError | null; // affects only the finalize mark-consumed update
  cashShortageUpdatePayload: Row | null;
} = {
  owner: null,
  runs: [],
  runLines: [],
  profiles: [],
  sessions: [],
  settings: {},
  employment: [],
  insertedRun: null,
  runInsertError: null,
  insertedLines: null,
  updateResult: null,
  updatePayload: null,
  updateFilters: null,
  deletedRunIds: [],
  cashShortages: [],
  cashShortagesError: null,
  cashShortageUpdateError: null,
  cashShortageUpdatePayload: null,
};

function baseSettings() {
  return {
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
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: {
        op: string;
        filters: Row;
        isNull: string[];
        gte: Record<string, string>;
        lte: Record<string, string>;
        inFilter?: { col: string; vals: unknown[] };
      } = { op: 'select', filters: {}, isNull: [], gte: {}, lte: {} };
      const chain: Row = {};

      // Real filtering for the tables whose rows these tests assert on.
      function matches(r: Row): boolean {
        for (const [k, v] of Object.entries(ctx.filters)) if (r[k] !== v) return false;
        for (const k of ctx.isNull) if (r[k] !== null) return false;
        for (const [k, v] of Object.entries(ctx.gte)) if (String(r[k]) < v) return false;
        for (const [k, v] of Object.entries(ctx.lte)) if (String(r[k]) > v) return false;
        if (ctx.inFilter && !ctx.inFilter.vals.includes(r[ctx.inFilter.col])) return false;
        return true;
      }

      const result = () => {
        if (table === 'attendance_settings') return { data: state.settings, error: null };
        if (table === 'profiles') return { data: state.profiles, error: null };
        if (table === 'attendance_sessions') return { data: state.sessions, error: null };
        if (table === 'attendance_day_marks') return { data: [], error: null };
        if (table === 'leave_requests') return { data: [], error: null };
        if (table === 'staff_employment') return { data: state.employment, error: null };
        if (table === 'payroll_runs') {
          if (ctx.op === 'insert') {
            if (state.runInsertError) return { data: null, error: state.runInsertError };
            return { data: state.insertedRun, error: null };
          }
          if (ctx.op === 'update') {
            state.updateFilters = { ...ctx.filters };
            return { data: state.updateResult, error: null };
          }
          if (ctx.op === 'delete') return { data: null, error: null };
          return { data: state.runs.filter(matches), error: null };
        }
        if (table === 'payroll_run_lines') {
          if (ctx.op === 'insert') return { data: null, error: null };
          return { data: state.runLines.filter(matches), error: null };
        }
        if (table === 'cash_shortages') {
          const rows = state.cashShortages as unknown as Row[];
          if (ctx.op === 'update') {
            if (state.cashShortageUpdateError) return { data: null, error: state.cashShortageUpdateError };
            if (state.cashShortagesError) return { data: null, error: state.cashShortagesError };
            const hit = rows.filter(matches);
            for (const row of hit) Object.assign(row, state.cashShortageUpdatePayload);
            return { data: hit, error: null };
          }
          if (state.cashShortagesError) return { data: null, error: state.cashShortagesError };
          return { data: rows.filter(matches), error: null };
        }
        return { data: [], error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        insert: (p: unknown) => {
          ctx.op = 'insert';
          if (table === 'payroll_runs') state.insertedRun = { id: 'run-1', ...(p as object) };
          if (table === 'payroll_run_lines') state.insertedLines = p as Row[];
          return chain;
        },
        update: (p: Row) => {
          ctx.op = 'update';
          if (table === 'cash_shortages') state.cashShortageUpdatePayload = p;
          else state.updatePayload = p;
          return chain;
        },
        delete: () => {
          ctx.op = 'delete';
          return chain;
        },
        eq: (c: string, v: unknown) => {
          if (ctx.op === 'delete' && c === 'id') state.deletedRunIds.push(String(v));
          ctx.filters[c] = v;
          return chain;
        },
        in: (c: string, v: unknown[]) => {
          ctx.inFilter = { col: c, vals: v };
          return chain;
        },
        gte: (c: string, v: string) => {
          ctx.gte[c] = v;
          return chain;
        },
        lte: (c: string, v: string) => {
          ctx.lte[c] = v;
          return chain;
        },
        lt: () => chain,
        neq: () => chain,
        is: (c: string, v: unknown) => {
          if (v === null) ctx.isNull.push(c);
          return chain;
        },
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

vi.mock('@/lib/api/auth', () => ({
  getOwnerUser: () => Promise.resolve(state.owner),
}));

// Payslip email is covered by its own tests; here it must simply not throw.
vi.mock('@/lib/payroll/payslipEmail', () => ({
  sendPayslipsForRun: () => Promise.resolve([]),
}));

const { GET, POST, PATCH } = await import('@/app/api/owner/payroll/route');

function jsonReq(method: string, body: unknown) {
  return new Request('http://t/api/owner/payroll', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getMonth(month = '2026-08') {
  return GET(new Request(`http://t/api/owner/payroll?month=${month}`));
}

function employ(userId: string) {
  state.employment.push({
    id: `emp-${userId}`,
    user_id: userId,
    monthly_salary_inr: 25_000,
    contracted_hours_per_day: 9,
    shift_start_time: '10:00',
    shift_end_time: '19:00',
    weekly_off_dow: 0,
    effective_from: '2026-01-01',
    effective_to: null,
  });
}

/** Ravi works one full, closed 10:00–19:00 day so his draft is not ₹0. */
function workedDay(userId: string, date = '2026-08-03') {
  state.sessions.push({
    id: `s-${userId}-${date}`,
    user_id: userId,
    business_date: date,
    clock_in_at: `${date}T04:30:00Z`,
    clock_out_at: `${date}T13:30:00Z`,
    status: 'closed',
    source: 'punch',
    approved_at: null,
    flags: [],
  });
}

function openSession(userId: string) {
  state.sessions.push({
    id: `open-${userId}`,
    user_id: userId,
    business_date: '2026-08-04',
    clock_in_at: '2026-08-04T04:30:00Z',
    clock_out_at: null,
    status: 'open',
    source: 'punch',
    approved_at: null,
    flags: [],
  });
}

function shortage(over: Partial<CashShortageFixture> = {}): CashShortageFixture {
  return {
    id: 's1',
    user_id: 'staff-1',
    amount_inr: 500,
    status: 'approved',
    business_date: '2026-08-10',
    payroll_run_id: null,
    ...over,
  };
}

function lineFor(body: { lines: Row[] }, userId: string) {
  return body.lines.find((l) => l.user_id === userId) as Row;
}

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.runs = [];
  state.runLines = [];
  state.profiles = [
    { id: 'staff-1', name: 'Ravi', role: 'staff' },
    { id: 'staff-2', name: 'Umesh', role: 'manager' },
  ];
  state.sessions = [];
  state.settings = baseSettings();
  state.employment = [];
  state.insertedRun = null;
  state.runInsertError = null;
  state.insertedLines = null;
  state.updateResult = null;
  state.updatePayload = null;
  state.updateFilters = null;
  state.deletedRunIds = [];
  state.cashShortages = [];
  state.cashShortagesError = null;
  state.cashShortageUpdateError = null;
  state.cashShortageUpdatePayload = null;
});

describe('payroll route — authorization', () => {
  it('403s for a non-owner on GET', async () => {
    state.owner = null;
    expect((await getMonth()).status).toBe(403);
  });

  it('403s for a non-owner on finalize', async () => {
    state.owner = null;
    expect((await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }))).status).toBe(403);
  });

  it('403s for a non-owner on reverse', async () => {
    state.owner = null;
    expect(
      (await PATCH(jsonReq('PATCH', { month: '2026-08', user_id: 'staff-1', reason: 'x' }))).status,
    ).toBe(403);
  });
});

describe('payroll route — GET', () => {
  it('rejects a malformed month', async () => {
    expect((await getMonth('August')).status).toBe(400);
  });

  it('computes everyone as a draft when nobody is finalized', async () => {
    const body = await (await getMonth()).json();
    expect(body.finalizedCount).toBe(0);
    expect(body.lines.every((l: Row) => l.finalized === false)).toBe(true);
  });

  it('reports someone with no employment record as unconfigured, not as zero pay', async () => {
    const body = await (await getMonth()).json();
    expect(lineFor(body, 'staff-1').unconfigured).toBe(true);
    expect(lineFor(body, 'staff-1').netPayInr).toBe(0);
  });

  it('serves a FINALIZED staffer frozen while everyone else stays a fresh draft', async () => {
    employ('staff-1');
    employ('staff-2');
    state.runs = [
      {
        id: 'run-1',
        user_id: 'staff-1',
        status: 'finalized',
        period_start: '2026-08-01',
        period_end: '2026-08-31',
        finalized_at: '2026-09-01T10:00:00Z',
      },
    ];
    state.runLines = [
      {
        run_id: 'run-1',
        user_id: 'staff-1',
        net_pay_inr: 24_000,
        deductions_inr: 0,
        cash_shortage_inr: 0,
        detail: { proposed_deductions: { lateInr: 369, cashShortageInr: 0 }, applied_deductions: { late: false, cashShortage: false } },
      },
    ];
    const body = await (await getMonth()).json();
    const ravi = lineFor(body, 'staff-1');
    expect(ravi.finalized).toBe(true);
    expect(ravi.netPayInr).toBe(24_000);
    expect((ravi.run as Row).id).toBe('run-1');
    expect((ravi.proposedDeductions as Row).lateInr).toBe(369);
    expect(lineFor(body, 'staff-2').finalized).toBe(false);
    expect(body.finalizedCount).toBe(1);
  });

  it('only blocks on unapproved days of staff who are not finalized yet', async () => {
    employ('staff-1');
    openSession('staff-1');
    const body = await (await getMonth()).json();
    expect(body.blocked).toBe(true);
    expect(lineFor(body, 'staff-1').blocked).toBe(true);
    expect(lineFor(body, 'staff-2').blocked).toBe(false);
  });
});

describe('payroll route — finalize ONE staffer', () => {
  it('requires a user_id — there is no whole-month finalize any more', async () => {
    const res = await POST(jsonReq('POST', { month: '2026-08' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/one staffer at a time/i);
  });

  it('rejects a malformed month', async () => {
    expect((await POST(jsonReq('POST', { month: 'nope', user_id: 'staff-1' }))).status).toBe(400);
  });

  it("refuses while THIS person's days still need approval", async () => {
    employ('staff-1');
    openSession('staff-1');
    const res = await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/need approval/i);
    expect(state.insertedRun).toBeNull();
  });

  it("is not blocked by SOMEONE ELSE's unapproved days", async () => {
    employ('staff-1');
    employ('staff-2');
    openSession('staff-2');
    const res = await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    expect(res.status).toBe(200);
  });

  it('refuses when that person is already finalized for the month', async () => {
    employ('staff-1');
    state.runs = [
      { id: 'run-0', user_id: 'staff-1', status: 'finalized', period_start: '2026-08-01', period_end: '2026-08-31' },
    ];
    const res = await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already finalized/i);
  });

  it("finalizes one person while another's month stays open", async () => {
    employ('staff-1');
    employ('staff-2');
    state.runs = [
      { id: 'run-0', user_id: 'staff-2', status: 'finalized', period_start: '2026-08-01', period_end: '2026-08-31' },
    ];
    const res = await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    expect(res.status).toBe(200);
  });

  it('writes a run that belongs to that staffer, with exactly their one line', async () => {
    employ('staff-1');
    employ('staff-2');
    workedDay('staff-1');
    await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    expect(state.insertedRun?.user_id).toBe('staff-1');
    expect(state.insertedRun?.status).toBe('finalized');
    expect(state.insertedLines).toHaveLength(1);
    expect(state.insertedLines?.[0].user_id).toBe('staff-1');
    expect(state.insertedLines?.[0].net_pay_inr as number).toBeGreaterThan(0);
  });

  it('freezes the rules snapshot with the run', async () => {
    employ('staff-1');
    await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    const snap = state.insertedRun?.rules_snapshot as Row;
    expect(snap.ot_multiplier).toBe(1);
    expect(snap.paid_leaves_per_month).toBe(4);
  });

  it('refuses someone with no salary set (nothing to finalize)', async () => {
    const res = await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no salary/i);
  });

  it("404s for someone who isn't on the month's payroll", async () => {
    const res = await POST(jsonReq('POST', { month: '2026-08', user_id: 'stranger' }));
    expect(res.status).toBe(404);
  });

  it('rejects a fractional adjustment', async () => {
    const res = await POST(
      jsonReq('POST', { month: '2026-08', user_id: 'staff-1', adjustment: { amount_inr: 12.5, reason: 'advance' } }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an adjustment with no reason', async () => {
    const res = await POST(
      jsonReq('POST', { month: '2026-08', user_id: 'staff-1', adjustment: { amount_inr: -500, reason: '  ' } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason/i);
  });

  it('applies a signed adjustment and freezes its reason', async () => {
    employ('staff-1');
    workedDay('staff-1');
    const draft = lineFor(await (await getMonth()).json(), 'staff-1');
    await POST(
      jsonReq('POST', { month: '2026-08', user_id: 'staff-1', adjustment: { amount_inr: -300, reason: 'advance' } }),
    );
    const line = state.insertedLines![0];
    expect(line.adjustments_inr).toBe(-300);
    expect(line.net_pay_inr).toBe((draft.netPayInr as number) - 300);
    expect((line.detail as Row).adjustment_reason).toBe('advance');
  });

  it('turns a lost race on the one-run-per-staffer index into a 409, not a 500', async () => {
    employ('staff-1');
    state.runInsertError = { code: '23505', message: 'duplicate key' };
    const res = await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    expect(res.status).toBe(409);
  });
});

describe('payroll route — deductions are proposals until ticked', () => {
  it('proposes an approved shortage on the draft but takes nothing off', async () => {
    employ('staff-1');
    workedDay('staff-1');
    const baseline = lineFor(await (await getMonth()).json(), 'staff-1');
    state.cashShortages = [shortage({ amount_inr: 200 })];
    const line = lineFor(await (await getMonth()).json(), 'staff-1');
    expect((line.proposedDeductions as Row).cashShortageInr).toBe(200);
    expect(line.cashShortageInr).toBe(0);
    expect(line.netPayInr).toBe(baseline.netPayInr);
  });

  it('sums only approved + unconsumed + in-month shortages of that person into the proposal', async () => {
    employ('staff-1');
    state.cashShortages = [
      shortage({ id: 's1', amount_inr: 300 }),
      shortage({ id: 's2', amount_inr: 200 }),
      shortage({ id: 's3', amount_inr: 999, status: 'pending' }), // not decided yet
      shortage({ id: 's4', amount_inr: 999, status: 'waived' }), // owner waived it
      shortage({ id: 's5', amount_inr: 999, payroll_run_id: 'some-earlier-run' }), // already consumed
      shortage({ id: 's6', amount_inr: 999, business_date: '2026-07-31' }), // last month
      shortage({ id: 's7', amount_inr: 999, business_date: '2026-09-01' }), // next month
      shortage({ id: 's8', amount_inr: 111, user_id: 'someone-else' }), // different person
    ];
    const line = lineFor(await (await getMonth()).json(), 'staff-1');
    expect((line.proposedDeductions as Row).cashShortageInr).toBe(500);
  });

  it('degrades to zero, with no error, when the cash_shortages table is missing', async () => {
    employ('staff-1');
    state.cashShortagesError = { code: '42P01', message: 'relation "cash_shortages" does not exist' };
    const res = await getMonth();
    expect(res.status).toBe(200);
    expect((lineFor(await res.json(), 'staff-1').proposedDeductions as Row).cashShortageInr).toBe(0);
  });

  it('does not leak internal shortage-row bookkeeping into the response', async () => {
    employ('staff-1');
    expect((await (await getMonth()).json()).shortageRows).toBeUndefined();
  });

  it('finalizing WITHOUT ticking freezes no deduction and leaves the shortage unconsumed', async () => {
    employ('staff-1');
    workedDay('staff-1');
    state.cashShortages = [shortage({ amount_inr: 500 })];
    const res = await POST(jsonReq('POST', { month: '2026-08', user_id: 'staff-1' }));
    const body = await res.json();
    const line = state.insertedLines![0];
    expect(line.cash_shortage_inr).toBe(0);
    expect(line.deductions_inr).toBe(0);
    expect((line.detail as Row).proposed_deductions).toEqual({ lateInr: 0, cashShortageInr: 500 });
    expect((line.detail as Row).applied_deductions).toEqual({ late: false, cashShortage: false });
    expect(body.cashShortagesMarked).toBe(0);
    expect(state.cashShortages[0].payroll_run_id).toBeNull();
  });

  it('finalizing WITH the shortage ticked freezes it and marks exactly that person\'s rows consumed', async () => {
    employ('staff-1');
    workedDay('staff-1');
    state.cashShortages = [
      shortage({ id: 's1', amount_inr: 300 }),
      shortage({ id: 's2', amount_inr: 200 }),
      shortage({ id: 's-other', user_id: 'staff-2', amount_inr: 999 }),
    ];
    const res = await POST(
      jsonReq('POST', { month: '2026-08', user_id: 'staff-1', apply: { cash_shortage: true } }),
    );
    const body = await res.json();
    expect(state.insertedLines![0].cash_shortage_inr).toBe(500);
    expect(body.cashShortagesMarked).toBe(2);
    expect(state.cashShortages.find((r) => r.id === 's1')!.payroll_run_id).toBe('run-1');
    expect(state.cashShortages.find((r) => r.id === 's2')!.payroll_run_id).toBe('run-1');
    expect(state.cashShortages.find((r) => r.id === 's-other')!.payroll_run_id).toBeNull();
  });

  it('reports a marking failure clearly instead of losing it silently', async () => {
    employ('staff-1');
    state.cashShortages = [shortage({ id: 's1', amount_inr: 500 })];
    state.cashShortageUpdateError = { message: 'db exploded' };
    const res = await POST(
      jsonReq('POST', { month: '2026-08', user_id: 'staff-1', apply: { cash_shortage: true } }),
    );
    // The run and its line already stood — this must not fail the request.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cashShortageMarkError).toBe('db exploded');
    expect(body.cashShortagesMarked).toBe(0);
    expect(state.cashShortages[0].payroll_run_id).toBeNull();
  });

  it('only takes deductions on an explicit true, never on a truthy string', async () => {
    employ('staff-1');
    state.cashShortages = [shortage({ amount_inr: 500 })];
    await POST(
      jsonReq('POST', { month: '2026-08', user_id: 'staff-1', apply: { cash_shortage: 'yes', late: 1 } }),
    );
    expect(state.insertedLines![0].cash_shortage_inr).toBe(0);
  });
});

describe('payroll route — reverse ONE staffer', () => {
  it('requires a reason', async () => {
    expect((await PATCH(jsonReq('PATCH', { month: '2026-08', user_id: 'staff-1' }))).status).toBe(400);
  });

  it('requires a user_id', async () => {
    expect((await PATCH(jsonReq('PATCH', { month: '2026-08', reason: 'x' }))).status).toBe(400);
  });

  it("records the reversal of just that person's run rather than deleting what was paid", async () => {
    state.updateResult = { id: 'run-1', status: 'reversed' };
    const res = await PATCH(
      jsonReq('PATCH', { month: '2026-08', user_id: 'staff-1', reason: 'wrong salary used' }),
    );
    expect(res.status).toBe(200);
    expect(state.updatePayload?.status).toBe('reversed');
    expect(state.updatePayload?.reversal_reason).toBe('wrong salary used');
    expect(state.updateFilters?.user_id).toBe('staff-1');
    expect(state.deletedRunIds).toHaveLength(0);
  });

  it('404s when that person is not finalized for the month', async () => {
    state.updateResult = null;
    const res = await PATCH(jsonReq('PATCH', { month: '2026-08', user_id: 'staff-1', reason: 'x' }));
    expect(res.status).toBe(404);
  });

  it("clears payroll_run_id on the run's shortages, leaving other runs' shortages alone", async () => {
    state.updateResult = { id: 'run-1', status: 'reversed' };
    state.cashShortages = [
      shortage({ id: 's1', payroll_run_id: 'run-1' }),
      shortage({ id: 's2', user_id: 'staff-2', payroll_run_id: 'run-other' }),
    ];
    const res = await PATCH(
      jsonReq('PATCH', { month: '2026-08', user_id: 'staff-1', reason: 'wrong salary used' }),
    );
    const body = await res.json();
    expect(body.cashShortagesCleared).toBe(1);
    expect(state.cashShortages.find((r) => r.id === 's1')!.payroll_run_id).toBeNull();
    expect(state.cashShortages.find((r) => r.id === 's2')!.payroll_run_id).toBe('run-other');
  });

  it('does not report an error when the cash_shortages table is missing', async () => {
    state.updateResult = { id: 'run-1', status: 'reversed' };
    state.cashShortagesError = { code: '42P01', message: 'relation "cash_shortages" does not exist' };
    const res = await PATCH(jsonReq('PATCH', { month: '2026-08', user_id: 'staff-1', reason: 'x' }));
    expect(res.status).toBe(200);
    expect((await res.json()).cashShortageClearError).toBeUndefined();
  });
});
