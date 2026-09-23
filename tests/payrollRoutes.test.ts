import { beforeEach, describe, expect, it, vi } from 'vitest';

// PAY-3 / PAY-4 — handler tests for the payroll route.
//
// The gates worth holding: it is OWNER-only and not delegable through the
// permission matrix, a draft is computed fresh while a finalized run is served
// FROZEN, finalizing is refused while any day still needs approval, and a
// reversal is recorded rather than deleting what was paid.

interface CashShortageFixture {
  id: string;
  user_id: string;
  amount_inr: number;
  status: string;
  business_date: string;
  payroll_run_id: string | null;
}

type PgError = { code?: string; message?: string };

const state: {
  owner: { id: string } | null;
  run: Record<string, unknown> | null;
  runLines: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  settings: Record<string, unknown>;
  employment: Record<string, unknown>[];
  insertedRun: Record<string, unknown> | null;
  insertedLines: Record<string, unknown>[] | null;
  updateResult: Record<string, unknown> | null;
  updatePayload: Record<string, unknown> | null;
  deletedRunIds: string[];
  // CC-5
  cashShortages: CashShortageFixture[];
  cashShortagesError: PgError | null; // affects reads AND the reversal-clear update
  cashShortageUpdateError: PgError | null; // affects only the finalize mark-consumed update
  cashShortageUpdatePayload: Record<string, unknown> | null;
} = {
  owner: null,
  run: null,
  runLines: [],
  profiles: [],
  sessions: [],
  settings: {},
  employment: [],
  insertedRun: null,
  insertedLines: null,
  updateResult: null,
  updatePayload: null,
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
        filters: Record<string, unknown>;
        isNull: string[];
        gte: Record<string, string>;
        lte: Record<string, string>;
        inFilter?: { col: string; vals: unknown[] };
      } = { op: 'select', filters: {}, isNull: [], gte: {}, lte: {} };
      const chain: Record<string, unknown> = {};

      // CC-5 — real filtering against state.cashShortages, since these tests
      // need to assert exactly which rows get summed / marked / cleared.
      function matchesCashShortageFilters(r: CashShortageFixture): boolean {
        for (const [k, v] of Object.entries(ctx.filters)) {
          if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
        }
        for (const k of ctx.isNull) {
          if ((r as unknown as Record<string, unknown>)[k] !== null) return false;
        }
        for (const [k, v] of Object.entries(ctx.gte)) {
          if (String((r as unknown as Record<string, unknown>)[k]) < v) return false;
        }
        for (const [k, v] of Object.entries(ctx.lte)) {
          if (String((r as unknown as Record<string, unknown>)[k]) > v) return false;
        }
        if (ctx.inFilter) {
          const val = (r as unknown as Record<string, unknown>)[ctx.inFilter.col];
          if (!ctx.inFilter.vals.includes(val)) return false;
        }
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
          if (ctx.op === 'insert') return { data: state.insertedRun, error: null };
          if (ctx.op === 'update') return { data: state.updateResult, error: null };
          return { data: state.run, error: null };
        }
        if (table === 'payroll_run_lines') {
          if (ctx.op === 'insert') return { data: null, error: null };
          return { data: state.runLines, error: null };
        }
        if (table === 'cash_shortages') {
          if (ctx.op === 'update') {
            if (state.cashShortageUpdateError) return { data: null, error: state.cashShortageUpdateError };
            if (state.cashShortagesError) return { data: null, error: state.cashShortagesError };
            const matches = state.cashShortages.filter(matchesCashShortageFilters);
            for (const row of matches) Object.assign(row, state.cashShortageUpdatePayload);
            return { data: matches, error: null };
          }
          if (state.cashShortagesError) return { data: null, error: state.cashShortagesError };
          return { data: state.cashShortages.filter(matchesCashShortageFilters), error: null };
        }
        return { data: [], error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        insert: (p: unknown) => {
          ctx.op = 'insert';
          if (table === 'payroll_runs') state.insertedRun = { id: 'run-1', ...(p as object) };
          if (table === 'payroll_run_lines') state.insertedLines = p as Record<string, unknown>[];
          return chain;
        },
        update: (p: Record<string, unknown>) => {
          ctx.op = 'update';
          if (table === 'cash_shortages') {
            state.cashShortageUpdatePayload = p;
          } else {
            state.updatePayload = p;
          }
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

const { GET, POST, PATCH } = await import('@/app/api/owner/payroll/route');

function jsonReq(method: string, body: unknown) {
  return new Request('http://t/api/owner/payroll', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.run = null;
  state.runLines = [];
  state.profiles = [{ id: 'staff-1', name: 'Ravi', role: 'staff' }];
  state.sessions = [];
  state.settings = baseSettings();
  state.employment = [];
  state.insertedRun = null;
  state.insertedLines = null;
  state.updateResult = null;
  state.updatePayload = null;
  state.deletedRunIds = [];
  state.cashShortages = [];
  state.cashShortagesError = null;
  state.cashShortageUpdateError = null;
  state.cashShortageUpdatePayload = null;
});

describe('payroll route — authorization', () => {
  it('403s for a non-owner on GET', async () => {
    state.owner = null;
    const res = await GET(new Request('http://t/api/owner/payroll?month=2026-08'));
    expect(res.status).toBe(403);
  });

  it('403s for a non-owner on finalize', async () => {
    state.owner = null;
    expect((await POST(jsonReq('POST', { month: '2026-08' }))).status).toBe(403);
  });

  it('403s for a non-owner on reverse', async () => {
    state.owner = null;
    expect((await PATCH(jsonReq('PATCH', { month: '2026-08', reason: 'x' }))).status).toBe(403);
  });
});

describe('payroll route — GET', () => {
  it('rejects a malformed month', async () => {
    const res = await GET(new Request('http://t/api/owner/payroll?month=August'));
    expect(res.status).toBe(400);
  });

  it('computes a draft when no run exists', async () => {
    const body = await (await GET(new Request('http://t/api/owner/payroll?month=2026-08'))).json();
    expect(body.finalized).toBe(false);
    expect(Array.isArray(body.lines)).toBe(true);
  });

  it('reports someone with no employment record as unconfigured, not as zero pay', async () => {
    const body = await (await GET(new Request('http://t/api/owner/payroll?month=2026-08'))).json();
    expect(body.lines[0].unconfigured).toBe(true);
    expect(body.lines[0].netPayInr).toBe(0);
  });

  it('serves a FINALIZED run from its frozen snapshot rather than recomputing', async () => {
    // The whole point of PAY-4: a rule changed later must not restate a month
    // that has already been paid.
    state.run = { id: 'run-1', status: 'finalized', period_start: '2026-08-01' };
    state.runLines = [{ user_id: 'staff-1', net_pay_inr: 24_000 }];
    const body = await (await GET(new Request('http://t/api/owner/payroll?month=2026-08'))).json();
    expect(body.finalized).toBe(true);
    expect(body.lines[0].net_pay_inr).toBe(24_000);
  });
});

describe('payroll route — finalize', () => {
  it('refuses while any day still needs approval', async () => {
    // An open session makes rollUpDay return needs_approval for that day.
    state.employment = [
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
    state.sessions = [
      {
        id: 's1',
        user_id: 'staff-1',
        business_date: '2026-08-03',
        clock_in_at: '2026-08-03T04:30:00Z',
        clock_out_at: null,
        status: 'open',
        source: 'punch',
        approved_at: null,
        flags: [],
      },
    ];
    const res = await POST(jsonReq('POST', { month: '2026-08' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/need approval/i);
    expect(state.insertedRun).toBeNull();
  });

  it('refuses to finalize a month that is already finalized', async () => {
    state.run = { id: 'run-1', status: 'finalized' };
    const res = await POST(jsonReq('POST', { month: '2026-08' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already finalized/i);
  });

  it('freezes the rules snapshot with the run', async () => {
    await POST(jsonReq('POST', { month: '2026-08' }));
    expect(state.insertedRun?.status).toBe('finalized');
    expect((state.insertedRun?.rules_snapshot as Record<string, unknown>).ot_multiplier).toBe(1);
  });

  it('rejects a fractional adjustment', async () => {
    const res = await POST(
      jsonReq('POST', {
        month: '2026-08',
        adjustments: [{ user_id: 'staff-1', amount_inr: 12.5, reason: 'advance' }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an adjustment with no reason', async () => {
    const res = await POST(
      jsonReq('POST', {
        month: '2026-08',
        adjustments: [{ user_id: 'staff-1', amount_inr: -500, reason: '  ' }],
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reason/i);
  });

  it('rejects a malformed month', async () => {
    expect((await POST(jsonReq('POST', { month: 'nope' }))).status).toBe(400);
  });
});

// CC-5 (docs/PHASE-5-CASH-COUNTS.md) — cash-drawer shortages deducted at
// payroll. The property worth holding beyond the unit math in
// lib/payroll/compute.ts: the ROUTE only sums approved + unconsumed +
// in-month shortages, and finalize marks exactly those rows consumed so a
// later month can never deduct them again.
describe('payroll route — cash shortages (CC-5)', () => {
  function employedState() {
    state.employment = [
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

  describe('GET (compute)', () => {
    it('sums only approved + unconsumed + in-month shortages onto the line', async () => {
      employedState();
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
      const body = await (await GET(new Request('http://t/api/owner/payroll?month=2026-08'))).json();
      const line = body.lines.find((l: { user_id: string }) => l.user_id === 'staff-1');
      expect(line.cashShortageInr).toBe(500); // 300 + 200 only
    });

    it('deducts the shortage from whatever net pay attendance alone produced', async () => {
      // No attendance_sessions are set up here (that's lib/payroll/compute.ts's
      // job to test precisely, in tests/payroll.test.ts) — this only checks
      // the ROUTE wires the summed shortage into the same net-pay formula,
      // by comparing against a baseline fetched with no shortage at all.
      employedState();
      const baseline = await (await GET(new Request('http://t/api/owner/payroll?month=2026-08'))).json();
      const baselineNet = baseline.lines.find((l: { user_id: string }) => l.user_id === 'staff-1').netPayInr;

      state.cashShortages = [shortage({ amount_inr: 200 })];
      const body = await (await GET(new Request('http://t/api/owner/payroll?month=2026-08'))).json();
      const line = body.lines.find((l: { user_id: string }) => l.user_id === 'staff-1');
      expect(line.netPayInr).toBe(Math.max(0, baselineNet - 200));
      expect(line.cashShortageClamped).toBe(baselineNet < 200);
    });

    it('clamps net pay at zero and flags it when the shortage exceeds net pay', async () => {
      employedState();
      state.cashShortages = [shortage({ amount_inr: 40_000 })];
      const body = await (await GET(new Request('http://t/api/owner/payroll?month=2026-08'))).json();
      const line = body.lines.find((l: { user_id: string }) => l.user_id === 'staff-1');
      expect(line.netPayInr).toBe(0);
      expect(line.cashShortageClamped).toBe(true);
    });

    it('degrades to zero, with no error, when the cash_shortages table is missing', async () => {
      employedState();
      state.cashShortagesError = { code: '42P01', message: 'relation "cash_shortages" does not exist' };
      const res = await GET(new Request('http://t/api/owner/payroll?month=2026-08'));
      expect(res.status).toBe(200);
      const body = await res.json();
      const line = body.lines.find((l: { user_id: string }) => l.user_id === 'staff-1');
      expect(line.cashShortageInr).toBe(0);
    });

    it('does not leak internal shortage-row bookkeeping into the draft response', async () => {
      employedState();
      const body = await (await GET(new Request('http://t/api/owner/payroll?month=2026-08'))).json();
      expect(body.shortageRows).toBeUndefined();
    });
  });

  describe('finalize', () => {
    it('freezes cash_shortage_inr onto the payroll line', async () => {
      employedState();
      state.cashShortages = [shortage({ amount_inr: 500 })];
      await POST(jsonReq('POST', { month: '2026-08' }));
      const line = state.insertedLines?.find((l) => l.user_id === 'staff-1');
      expect(line?.cash_shortage_inr).toBe(500);
    });

    it('marks exactly the summed shortage rows consumed with this run', async () => {
      employedState();
      state.cashShortages = [
        shortage({ id: 's1', amount_inr: 300 }),
        shortage({ id: 's2', amount_inr: 200 }),
        shortage({ id: 's-unrelated', user_id: 'someone-else', amount_inr: 999 }),
      ];
      const res = await POST(jsonReq('POST', { month: '2026-08' }));
      const body = await res.json();
      expect(body.cashShortagesMarked).toBe(2);
      expect(state.cashShortages.find((r) => r.id === 's1')!.payroll_run_id).toBe('run-1');
      expect(state.cashShortages.find((r) => r.id === 's2')!.payroll_run_id).toBe('run-1');
      // Never touched — it wasn't summed into any line of THIS run, so
      // marking it consumed here would just lose it.
      expect(state.cashShortages.find((r) => r.id === 's-unrelated')!.payroll_run_id).toBeNull();
    });

    it('reports a marking failure clearly instead of losing it silently', async () => {
      employedState();
      state.cashShortages = [shortage({ id: 's1', amount_inr: 500 })];
      state.cashShortageUpdateError = { message: 'db exploded' };
      const res = await POST(jsonReq('POST', { month: '2026-08' }));
      // The run and its lines already stood — this must not fail the request.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cashShortageMarkError).toBe('db exploded');
      expect(body.cashShortagesMarked).toBe(0);
      // And the row is genuinely left unmarked, not silently dropped.
      expect(state.cashShortages.find((r) => r.id === 's1')!.payroll_run_id).toBeNull();
    });

    it('does nothing (no error) when there is nothing to mark', async () => {
      employedState();
      const res = await POST(jsonReq('POST', { month: '2026-08' }));
      const body = await res.json();
      expect(body.cashShortagesMarked).toBe(0);
      expect(body.cashShortageMarkError).toBeUndefined();
    });
  });
});

describe('payroll route — reverse', () => {
  it('requires a reason', async () => {
    const res = await PATCH(jsonReq('PATCH', { month: '2026-08' }));
    expect(res.status).toBe(400);
  });

  it('records the reversal rather than deleting what was paid', async () => {
    state.updateResult = { id: 'run-1', status: 'reversed' };
    const res = await PATCH(jsonReq('PATCH', { month: '2026-08', reason: 'wrong salary used' }));
    expect(res.status).toBe(200);
    expect(state.updatePayload?.status).toBe('reversed');
    expect(state.updatePayload?.reversal_reason).toBe('wrong salary used');
    expect(state.deletedRunIds).toHaveLength(0);
  });

  it('404s when there is no finalized run for that month', async () => {
    state.updateResult = null;
    const res = await PATCH(jsonReq('PATCH', { month: '2026-08', reason: 'x' }));
    expect(res.status).toBe(404);
  });
});

// CC-5 — a reversed run's shortages must go back to "unconsumed" or they can
// never be picked up by a re-finalize (of this month or any other).
describe('payroll route — reverse clears consumed shortages (CC-5)', () => {
  it("clears payroll_run_id on the run's shortages, leaving other runs' shortages alone", async () => {
    state.updateResult = { id: 'run-1', status: 'reversed' };
    state.cashShortages = [
      {
        id: 's1',
        user_id: 'staff-1',
        amount_inr: 500,
        status: 'approved',
        business_date: '2026-08-10',
        payroll_run_id: 'run-1',
      },
      {
        id: 's2',
        user_id: 'staff-2',
        amount_inr: 200,
        status: 'approved',
        business_date: '2026-08-11',
        payroll_run_id: 'run-other',
      },
    ];
    const res = await PATCH(jsonReq('PATCH', { month: '2026-08', reason: 'wrong salary used' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cashShortagesCleared).toBe(1);
    expect(state.cashShortages.find((r) => r.id === 's1')!.payroll_run_id).toBeNull();
    expect(state.cashShortages.find((r) => r.id === 's2')!.payroll_run_id).toBe('run-other');
  });

  it('does not report an error when the cash_shortages table is missing', async () => {
    state.updateResult = { id: 'run-1', status: 'reversed' };
    state.cashShortagesError = { code: '42P01', message: 'relation "cash_shortages" does not exist' };
    const res = await PATCH(jsonReq('PATCH', { month: '2026-08', reason: 'x' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cashShortageClearError).toBeUndefined();
  });
});
