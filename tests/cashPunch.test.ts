import { beforeEach, describe, expect, it, vi } from 'vitest';

// CC-2 — the cash-count gate wired into POST /api/attendance/punch
// (docs/PHASE-5-CASH-COUNTS.md): the 428 refusal, recording a real count or an
// override checkpoint AFTER the punch is accepted, and — critically — that a
// cash-count failure never undoes an already-accepted punch.
//
// tests/attendancePunch.test.ts already owns the geofence/idempotency/A-1..A-5
// invariants with a lighter per-table mock; this file uses a fuller in-memory
// fake (supporting .is/.gt/.lte, needed by lib/cash/checkpoints.ts's real
// query chains) so the cash-specific behaviour is exercised end-to-end rather
// than stubbed.

const STORE_LAT = 28.613939;
const STORE_LNG = 77.209023;
const M_PER_DEG_LAT = 111_320;

type Row = Record<string, unknown>;
type Filter = { op: string; col: string; val: unknown };

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every((f) => {
      const v = row[f.col];
      switch (f.op) {
        case 'eq':
          return v === f.val;
        case 'neq':
          return v !== f.val;
        case 'is':
          return f.val === null ? v === null || v === undefined : v === f.val;
        case 'gt':
          return (v as string | number) > (f.val as string | number);
        case 'gte':
          return (v as string | number) >= (f.val as string | number);
        case 'lt':
          return (v as string | number) < (f.val as string | number);
        case 'lte':
          return (v as string | number) <= (f.val as string | number);
        case 'in':
          return Array.isArray(f.val) && (f.val as unknown[]).includes(v);
        default:
          return true;
      }
    }),
  );
}

let idCounter = 0;
let insertCashCountsShouldFail = false;

function makeFakeAdmin(tables: Record<string, Row[]>) {
  const fake = {
    from(table: string) {
      const store = tables[table] ?? (tables[table] = []);
      const filters: Filter[] = [];
      let order: { col: string; asc: boolean } | null = null;
      let limitN: number | null = null;
      let op: 'select' | 'insert' | 'update' = 'select';
      let insertPayload: Row | Row[] | null = null;
      let updatePayload: Row | null = null;

      function exec(single: boolean): { data: unknown; error: unknown } {
        if (op === 'insert') {
          if (table === 'cash_counts' && insertCashCountsShouldFail) {
            return { data: null, error: { message: 'simulated insert failure' } };
          }
          const toInsert = Array.isArray(insertPayload) ? insertPayload : [insertPayload as Row];
          const created = toInsert.map((r) => {
            const row: Row = {
              id: `${table}-${++idCounter}`,
              created_at: new Date(Date.now() + idCounter).toISOString(),
              ...r,
            };
            store.push(row);
            return row;
          });
          return single ? { data: created[0] ?? null, error: null } : { data: created, error: null };
        }
        if (op === 'update') {
          const matched = applyFilters(store, filters);
          for (const row of matched) Object.assign(row, updatePayload);
          return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
        }
        let rows = applyFilters(store, filters);
        if (order) {
          const { col, asc } = order;
          rows = [...rows].sort((a, b) => {
            const av = a[col] as string | number;
            const bv = b[col] as string | number;
            if (av < bv) return asc ? -1 : 1;
            if (av > bv) return asc ? 1 : -1;
            return 0;
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      }

      const chain = {
        select: () => chain,
        insert: (p: Row | Row[]) => {
          op = 'insert';
          insertPayload = p;
          return chain;
        },
        update: (p: Row) => {
          op = 'update';
          updatePayload = p;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          filters.push({ op: 'eq', col: c, val: v });
          return chain;
        },
        neq: (c: string, v: unknown) => {
          filters.push({ op: 'neq', col: c, val: v });
          return chain;
        },
        is: (c: string, v: unknown) => {
          filters.push({ op: 'is', col: c, val: v });
          return chain;
        },
        gt: (c: string, v: unknown) => {
          filters.push({ op: 'gt', col: c, val: v });
          return chain;
        },
        gte: (c: string, v: unknown) => {
          filters.push({ op: 'gte', col: c, val: v });
          return chain;
        },
        lt: (c: string, v: unknown) => {
          filters.push({ op: 'lt', col: c, val: v });
          return chain;
        },
        lte: (c: string, v: unknown) => {
          filters.push({ op: 'lte', col: c, val: v });
          return chain;
        },
        in: (c: string, v: unknown[]) => {
          filters.push({ op: 'in', col: c, val: v });
          return chain;
        },
        order: (c: string, opts?: { ascending?: boolean }) => {
          order = { col: c, asc: opts?.ascending !== false };
          return chain;
        },
        limit: (n: number) => {
          limitN = n;
          return chain;
        },
        maybeSingle: () => Promise.resolve(exec(true)),
        single: () => Promise.resolve(exec(true)),
        then: (resolve: (v: unknown) => void) => resolve(exec(false)),
      };
      return chain;
    },
    // Models supabase/2026-08-attendance.sql's attendance_clock_out RPC: closes
    // the caller's own open session under a status guard, DB-time only.
    rpc(name: string, args: Record<string, unknown>) {
      if (name !== 'attendance_clock_out') return Promise.resolve({ data: null, error: { message: 'unknown rpc' } });
      const sessions = tables.attendance_sessions ?? (tables.attendance_sessions = []);
      const match = sessions.find(
        (s) => s.id === args.p_session_id && s.user_id === args.p_user_id && s.status === 'open',
      );
      if (!match) return Promise.resolve({ data: [], error: null });
      Object.assign(match, {
        status: 'closed',
        clock_out_at: new Date().toISOString(),
        clock_out_lat: args.p_lat,
        clock_out_lng: args.p_lng,
        clock_out_accuracy_m: args.p_accuracy_m,
        clock_out_distance_m: args.p_distance_m,
        flags: args.p_flags,
      });
      return Promise.resolve({ data: [match], error: null });
    },
  };
  return fake;
}

let admin: ReturnType<typeof makeFakeAdmin>;
let tables: Record<string, Row[]>;
let account: { user: { id: string }; role: string } | null;

function baseSettings(over: Row = {}): Row {
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
    cash_count_required: false,
    cash_count_tolerance_inr: 0,
    updated_by: null,
    updated_at: '',
    ...over,
  };
}

function seed(settingsOver: Row = {}) {
  tables = {
    attendance_settings: [baseSettings(settingsOver)],
    attendance_sessions: [],
    attendance_punch_attempts: [],
    staff_accounts: [],
    profiles: [{ id: 'staff-1', name: 'Priya' }, { id: 'mgr-1', name: 'Manager Meera' }],
    cash_counts: [],
    cash_count_overrides: [],
    cash_shortages: [],
    order_payments: [],
    orders: [],
    refunds: [],
    cash_movements: [],
  };
  admin = makeFakeAdmin(tables);
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => admin,
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(account),
}));

const { POST } = await import('@/app/api/attendance/punch/route');

function punchReq(body: unknown) {
  return new Request('http://t/api/attendance/punch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A reading `metres` north of the store point — well inside the default 150m fence. */
function reading(metres: number, over: Row = {}) {
  return {
    lat: STORE_LAT + metres / M_PER_DEG_LAT,
    lng: STORE_LNG,
    accuracy_m: 20,
    fix_age_ms: 1000,
    ...over,
  };
}

beforeEach(() => {
  idCounter = 0;
  insertCashCountsShouldFail = false;
  account = { user: { id: 'staff-1' }, role: 'staff' };
  seed();
});

describe('POST /api/attendance/punch — cash count not required', () => {
  it('punches through unaffected when the switch is off (existing behaviour)', async () => {
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cashCount).toBeUndefined();
    expect(body.cashCountError).toBeUndefined();
  });
});

describe('POST /api/attendance/punch — 428 gate', () => {
  beforeEach(() => {
    seed({ cash_count_required: true });
  });

  it('428s a clock-in with no denoms and no usable override', async () => {
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.code).toBe('CASH_COUNT_REQUIRED');
    expect(tables.attendance_sessions).toHaveLength(0); // nothing irreversible happened
  });

  it('is NOT required for a staffer marked handles_cash: false', async () => {
    tables.staff_accounts.push({ user_id: 'staff-1', handles_cash: false, status: 'active' });
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(200);
  });

  it('200s and records a clock_in checkpoint when denoms are supplied', async () => {
    const res = await POST(punchReq({ type: 'in', ...reading(10), cash_denoms: { '500': 4 } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cashCount.kind).toBe('clock_in');
    expect(body.cashCount.countedTotalInr).toBe(2000);
    expect(tables.cash_counts).toHaveLength(1);
    expect(tables.cash_counts[0].attendance_session_id).toBe(body.session.id);
  });

  it('consumes a usable override instead of requiring denoms', async () => {
    tables.cash_count_overrides.push({
      id: 'ov-1',
      user_id: 'staff-1',
      punch_type: 'in',
      reason: 'Till jammed, manager verified the float by eye',
      granted_by: 'mgr-1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      created_at: new Date().toISOString(),
    });
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cashCount.kind).toBe('override');
    expect(tables.cash_count_overrides[0].used_at).not.toBeNull();
  });

  it('an override for the OTHER punch type does not satisfy the gate', async () => {
    tables.cash_count_overrides.push({
      id: 'ov-1',
      user_id: 'staff-1',
      punch_type: 'out',
      reason: 'Drawer sealed for the bank run, manager present',
      granted_by: 'mgr-1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      created_at: new Date().toISOString(),
    });
    const res = await POST(punchReq({ type: 'in', ...reading(10) }));
    expect(res.status).toBe(428);
  });

  it('prefers an actual count over a standing override — the override is left unconsumed', async () => {
    tables.cash_count_overrides.push({
      id: 'ov-1',
      user_id: 'staff-1',
      punch_type: 'in',
      reason: 'Till jammed, manager verified the float by eye',
      granted_by: 'mgr-1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      created_at: new Date().toISOString(),
    });
    const res = await POST(punchReq({ type: 'in', ...reading(10), cash_denoms: { '500': 2 } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cashCount.kind).toBe('clock_in');
    expect(tables.cash_count_overrides[0].used_at).toBeNull(); // still available
  });

  it('the punch is NOT undone when the cash count insert fails', async () => {
    insertCashCountsShouldFail = true;
    const res = await POST(punchReq({ type: 'in', ...reading(10), cash_denoms: { '500': 2 } }));
    expect(res.status).toBe(200); // the punch itself still succeeds
    const body = await res.json();
    expect(body.session).toBeTruthy();
    expect(body.cashCountError).toMatch(/could not be saved/i);
    expect(tables.attendance_sessions).toHaveLength(1); // the session write stands
  });

  it('gates a clock-out the same way, and records the checkpoint on success', async () => {
    tables.attendance_sessions.push({
      id: 'open-1',
      user_id: 'staff-1',
      status: 'open',
      clock_in_at: new Date(Date.now() - 4 * 3_600_000).toISOString(),
      flags: [],
    });
    const gated = await POST(punchReq({ type: 'out', ...reading(10) }));
    expect(gated.status).toBe(428);

    const ok = await POST(punchReq({ type: 'out', ...reading(10), cash_denoms: { '500': 1 } }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.cashCount.kind).toBe('clock_out');
    expect(tables.attendance_sessions[0].status).toBe('closed');
  });
});
