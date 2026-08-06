import { beforeEach, describe, expect, it, vi } from 'vitest';

// ATT-1 / GEO-1 / GEO-3 — handler-level tests for POST /api/attendance/punch
// against a mocked Supabase admin client and auth.
//
// These exist to hold the invariants that comments alone cannot enforce
// (docs/SECURITY-PLAYBOOK.md A-1..A-5): the caller cannot name the time, cannot
// name the verdict, cannot punch from outside the fence, and cannot open two
// shifts by tapping twice.

const STORE_LAT = 28.613939;
const STORE_LNG = 77.209023;
const M_PER_DEG_LAT = 111_320;

const state: {
  account: { user: { id: string }; role: string } | null;
  settings: Record<string, unknown>;
  openSession: Record<string, unknown> | null;
  /** The row the losing writer finds when it re-reads after a 23505. */
  openSessionAfterConflict: Record<string, unknown> | null;
  lastClosed: Record<string, unknown> | null;
  priorPunch: Record<string, unknown> | null;
  insertError: { code?: string } | null;
  rpcRows: Record<string, unknown>[] | null;
  rpcError: { message: string } | null;
  insertPayload: Record<string, unknown> | null;
  rpcArgs: Record<string, unknown> | null;
  attempts: Record<string, unknown>[];
} = {
  account: null,
  settings: {},
  openSession: null,
  openSessionAfterConflict: null,
  lastClosed: null,
  priorPunch: null,
  insertError: null,
  rpcRows: null,
  rpcError: null,
  insertPayload: null,
  rpcArgs: null,
  attempts: [],
};

function baseSettings(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    is_singleton: true,
    store_lat: STORE_LAT,
    store_lng: STORE_LNG,
    geofence_radius_m: 150,
    max_accuracy_m: 100,
    max_fix_age_sec: 60,
    grace_period_min: 15,
    late_marks_per_halfday: 3,
    ot_threshold_min: 0,
    ot_multiplier: 1,
    auto_break_min: 0,
    auto_break_after_min: 360,
    half_day_min_minutes: 240,
    absent_below_minutes: 120,
    auto_close_grace_min: 120,
    max_session_hours: 14,
    location_retention_days: 365,
    updated_by: null,
    updated_at: '',
    ...over,
  };
}

function resolveValue(table: string, op: string, filters: [string, unknown][]) {
  const filterVal = (col: string) => filters.find((f) => f[0] === col)?.[1];

  if (table === 'attendance_settings') return { data: state.settings, error: null };

  if (table === 'attendance_sessions') {
    if (op === 'insert') {
      if (state.insertError) return { data: null, error: state.insertError };
      return {
        data: {
          id: 'new-session',
          user_id: state.account?.user.id,
          status: 'open',
          // The DB supplies these; the route must not.
          clock_in_at: '2026-08-06T04:30:00.000Z',
          business_date: '2026-08-06',
          flags: (state.insertPayload?.flags as string[]) ?? [],
          ...state.insertPayload,
        },
        error: null,
      };
    }
    if (filterVal('status') === 'open') {
      // Model the lost-insert-race re-read: before the insert there is no open
      // session, and after the unique index rejects us the winner's row is
      // there. A single static value cannot express that sequence.
      if (state.insertPayload !== null && state.openSessionAfterConflict) {
        return { data: state.openSessionAfterConflict, error: null };
      }
      return { data: state.openSession, error: null };
    }
    // The "recently closed" retry lookup and the prior-punch lookup both select
    // from this table; distinguish by whether a status filter was applied.
    if (filters.some((f) => f[0] === 'status')) return { data: state.lastClosed, error: null };
    return { data: state.priorPunch, error: null };
  }

  return { data: null, error: null };
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcArgs = { name, ...args };
      return Promise.resolve({ data: state.rpcRows, error: state.rpcError });
    },
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const ctx = { op: 'select' };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        insert: (p: Record<string, unknown>) => {
          ctx.op = 'insert';
          if (table === 'attendance_sessions') state.insertPayload = p;
          if (table === 'attendance_punch_attempts') state.attempts.push(p);
          return chain;
        },
        update: () => {
          ctx.op = 'update';
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        in: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        gte: () => chain,
        neq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(resolveValue(table, ctx.op, filters)),
        single: () => Promise.resolve(resolveValue(table, ctx.op, filters)),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue(table, ctx.op, filters)),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getStaffOrOwner: () => Promise.resolve(state.account),
}));

const { POST } = await import('@/app/api/attendance/punch/route');

function punchReq(body: unknown) {
  return new Request('http://t/api/attendance/punch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A reading `metres` north of the store point. */
function reading(metres: number, over: Record<string, unknown> = {}) {
  return {
    lat: STORE_LAT + metres / M_PER_DEG_LAT,
    lng: STORE_LNG,
    accuracy_m: 20,
    fix_age_ms: 1000,
    ...over,
  };
}

beforeEach(() => {
  state.account = { user: { id: 'staff-1' }, role: 'staff' };
  state.settings = baseSettings();
  state.openSession = null;
  state.openSessionAfterConflict = null;
  state.lastClosed = null;
  state.priorPunch = null;
  state.insertError = null;
  state.rpcRows = null;
  state.rpcError = null;
  state.insertPayload = null;
  state.rpcArgs = null;
  state.attempts = [];
});

describe('POST /api/attendance/punch — authorization', () => {
  it('401s without a staff session', async () => {
    state.account = null;
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(401);
  });

  it('accepts a plain staff session — punching is NOT permission-gated (A-4)', async () => {
    // A new permission key would fail closed to manager wherever its seed row
    // is missing, stopping the whole team from marking attendance.
    state.account = { user: { id: 'staff-1' }, role: 'staff' };
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/attendance/punch — input handling', () => {
  it('400s on a non-JSON body', async () => {
    const res = await POST(
      new Request('http://t/api/attendance/punch', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
  });

  it('400s on an unknown punch type', async () => {
    const res = await POST(punchReq({ type: 'sideways', ...reading(10) }));
    expect(res.status).toBe(400);
  });

  it('400s when coordinates arrive as strings', async () => {
    const res = await POST(punchReq({ type: 'in', lat: '28.6', lng: '77.2', accuracy_m: 10 }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/attendance/punch — the client cannot forge state', () => {
  it('ignores a client-supplied clock_in_at (A-1)', async () => {
    await POST(
      punchReq({
        type: 'in',
        ...reading(10),
        clock_in_at: '2020-01-01T00:00:00Z',
        business_date: '2020-01-01',
      }),
    );
    // The insert payload must carry neither field — the column default and the
    // trigger own them.
    expect(state.insertPayload).not.toHaveProperty('clock_in_at');
    expect(state.insertPayload).not.toHaveProperty('business_date');
  });

  it('ignores a client-supplied distance and verdict (A-2)', async () => {
    // Claiming to be at the counter from 5 km away must not work.
    const res = await POST(
      punchReq({
        type: 'in',
        ...reading(5000),
        distance_m: 0,
        accepted: true,
      }),
    );
    expect(res.status).toBe(422);
  });

  it('records the SERVER-computed distance, not anything the client sent', async () => {
    await POST(punchReq({ type: 'in', ...reading(50), distance_m: 9999 }));
    expect(Number(state.insertPayload?.clock_in_distance_m)).toBeGreaterThan(45);
    expect(Number(state.insertPayload?.clock_in_distance_m)).toBeLessThan(55);
  });

  it('never uses a client-supplied user_id', async () => {
    await POST(punchReq({ type: 'in', ...reading(10), user_id: 'someone-else' }));
    expect(state.insertPayload?.user_id).toBe('staff-1');
  });
});

describe('POST /api/attendance/punch — geofence enforcement', () => {
  it('refuses a punch from outside the radius with a 422 and a readable reason', async () => {
    const res = await POST(punchReq({ type: 'in', ...reading(5000) }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/from the cafe/i);
    expect(state.insertPayload).toBeNull();
  });

  it('logs a refused punch so a pattern of attempts is visible (GEO-2)', async () => {
    await POST(punchReq({ type: 'in', ...reading(5000) }));
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].user_id).toBe('staff-1');
    expect(state.attempts[0].reason).toBe('outside');
    expect(Number(state.attempts[0].distance_m)).toBeGreaterThan(4000);
  });

  it('refuses when the cafe location is unset rather than accepting from anywhere', async () => {
    state.settings = baseSettings({ store_lat: null, store_lng: null });
    const res = await POST(punchReq({ type: 'in', ...reading(0) }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/owner/i);
  });

  it('refuses an imprecise fix whose centre is inside the radius', async () => {
    const res = await POST(punchReq({ type: 'in', ...reading(5, { accuracy_m: 2000 }) }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/precise/i);
  });

  it('refuses a stale fix', async () => {
    const res = await POST(punchReq({ type: 'in', ...reading(5, { fix_age_ms: 120_000 }) }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/out of date/i);
  });

  it('accepts and flags an ambiguous punch rather than costing an honest staffer their day', async () => {
    const res = await POST(punchReq({ type: 'in', ...reading(200, { accuracy_m: 80 }) }));
    expect(res.status).toBe(200);
    expect(state.insertPayload?.flags).toContain('low_confidence');
  });

  it('does not leak the radius or the store point to the staffer (A-3)', async () => {
    const res = await POST(punchReq({ type: 'in', ...reading(5000) }));
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('150');
    expect(text).not.toContain(String(STORE_LAT));
  });
});

describe('POST /api/attendance/punch — one open session', () => {
  it('returns the existing session instead of opening a second one', async () => {
    state.openSession = {
      id: 'open-1',
      user_id: 'staff-1',
      status: 'open',
      clock_in_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      flags: [],
    };
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyOpen).toBe(true);
    expect(body.session.id).toBe('open-1');
    expect(state.insertPayload).toBeNull();
  });

  it('treats a double-tap inside the retry window as a repeat, not a new shift', async () => {
    state.openSession = {
      id: 'open-1',
      user_id: 'staff-1',
      status: 'open',
      clock_in_at: new Date(Date.now() - 5_000).toISOString(),
      flags: [],
    };
    const body = await (await POST(punchReq({ type: 'in', ...reading(10) }))).json();
    expect(body.repeat).toBe(true);
    expect(state.insertPayload).toBeNull();
  });

  it('resolves a lost insert race by reporting the winner, not an error', async () => {
    // Two taps race past the open-session read; the partial unique index
    // rejects one. The loser must report the winner's shift, because from the
    // staffer's point of view they are clocked in — which they are.
    state.openSession = null;
    state.insertError = { code: '23505' };
    state.openSessionAfterConflict = {
      id: 'winner',
      user_id: 'staff-1',
      status: 'open',
      clock_in_at: new Date().toISOString(),
      flags: [],
    };
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe('winner');
    expect(body.alreadyOpen).toBe(true);
  });

  it('surfaces a genuine insert failure rather than pretending the punch worked', async () => {
    state.openSession = null;
    state.insertError = { code: '23503' }; // FK violation, not a race
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/attendance/punch — clock out', () => {
  beforeEach(() => {
    state.openSession = {
      id: 'open-1',
      user_id: 'staff-1',
      status: 'open',
      clock_in_at: new Date(Date.now() - 4 * 3_600_000).toISOString(),
      flags: [],
    };
  });

  it('409s when there is no open session', async () => {
    state.openSession = null;
    const res = await POST(punchReq({ type: 'out', ...reading(10) }));
    expect(res.status).toBe(409);
  });

  it('closes through the RPC so the time comes from the database, not this process (A-1)', async () => {
    state.rpcRows = [{ id: 'open-1', status: 'closed', clock_out_at: '2026-08-06T08:30:00Z' }];
    const res = await POST(punchReq({ type: 'out', ...reading(10) }));
    expect(res.status).toBe(200);
    expect(state.rpcArgs?.name).toBe('attendance_clock_out');
    expect(state.rpcArgs?.p_session_id).toBe('open-1');
    expect(state.rpcArgs?.p_user_id).toBe('staff-1');
    // No timestamp is sent — that is the whole point of the RPC.
    expect(JSON.stringify(state.rpcArgs)).not.toMatch(/clock_out_at/);
  });

  it('409s when the guarded close matches no rows (an auto-close got there first)', async () => {
    state.rpcRows = [];
    const res = await POST(punchReq({ type: 'out', ...reading(10) }));
    expect(res.status).toBe(409);
  });

  it('still refuses a clock-out from outside the fence', async () => {
    const res = await POST(punchReq({ type: 'out', ...reading(9000) }));
    expect(res.status).toBe(422);
    expect(state.rpcArgs).toBeNull();
  });

  it('treats a repeated clock-out inside the retry window as a repeat', async () => {
    state.openSession = null;
    state.lastClosed = {
      id: 'closed-1',
      status: 'closed',
      clock_out_at: new Date(Date.now() - 5_000).toISOString(),
    };
    const res = await POST(punchReq({ type: 'out', ...reading(10) }));
    expect(res.status).toBe(200);
    expect((await res.json()).repeat).toBe(true);
  });
});

describe('POST /api/attendance/punch — integrity flags', () => {
  it('flags byte-identical coordinates without blocking the punch', async () => {
    state.priorPunch = {
      clock_in_at: new Date(Date.now() - 8 * 3_600_000).toISOString(),
      clock_in_lat: STORE_LAT,
      clock_in_lng: STORE_LNG,
      clock_in_accuracy_m: 20,
    };
    const res = await POST(
      punchReq({ type: 'in', lat: STORE_LAT, lng: STORE_LNG, accuracy_m: 20, fix_age_ms: 0 }),
    );
    expect(res.status).toBe(200);
    expect(state.insertPayload?.flags).toContain('static_coords');
  });

  it('does not flag ordinary jitter', async () => {
    state.priorPunch = {
      clock_in_at: new Date(Date.now() - 8 * 3_600_000).toISOString(),
      clock_in_lat: STORE_LAT + 0.00004,
      clock_in_lng: STORE_LNG,
      clock_in_accuracy_m: 20,
    };
    await POST(punchReq({ type: 'in', ...reading(2) }));
    expect(state.insertPayload?.flags).toEqual([]);
  });
});
