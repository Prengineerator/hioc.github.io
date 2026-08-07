import { beforeEach, describe, expect, it, vi } from 'vitest';

// PAY-3 / PAY-4 — handler tests for the payroll route.
//
// The gates worth holding: it is OWNER-only and not delegable through the
// permission matrix, a draft is computed fresh while a finalized run is served
// FROZEN, finalizing is refused while any day still needs approval, and a
// reversal is recorded rather than deleting what was paid.

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
      const ctx = { op: 'select' };
      const chain: Record<string, unknown> = {};
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
          state.updatePayload = p;
          return chain;
        },
        delete: () => {
          ctx.op = 'delete';
          return chain;
        },
        eq: (c: string, v: unknown) => {
          if (ctx.op === 'delete' && c === 'id') state.deletedRunIds.push(String(v));
          return chain;
        },
        in: () => chain,
        gte: () => chain,
        lte: () => chain,
        lt: () => chain,
        neq: () => chain,
        is: () => chain,
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
