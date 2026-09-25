import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// CC-2 — the cash-drawer checkpoint engine (docs/PHASE-5-CASH-COUNTS.md) and
// the routes built on it: POST/GET /api/cash-counts, POST/GET
// /api/cash-counts/overrides, POST/GET /api/cash-movements.
//
// A generic in-memory fake Postgres (below) drives lib/cash/checkpoints.ts's
// real filter chains (.eq/.neq/.is/.gt/.gte/.lt/.lte/.in/.order/.limit), so
// these tests exercise the actual query logic rather than a per-call stub —
// the engine issues enough distinct queries per table that a bespoke
// resolveValue() (as tests/cashDays.test.ts uses) would be unreadable here.

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
// A virtual, monotonic clock for generated created_at values — decoupled from
// real wall-clock time so a test can push a row's created_at to a precise
// instant BETWEEN two checkpoints (real time barely advances between two
// `await`s in the same test, which made window-boundary tests flaky when this
// used `Date.now()`). Ticks one second per DB insert.
let clockMs = Date.parse('2026-09-01T00:00:00.000Z');
function makeFakeAdmin(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const store = tables[table] ?? (tables[table] = []);
      const filters: Filter[] = [];
      let order: { col: string; asc: boolean } | null = null;
      let limitN: number | null = null;
      let op: 'select' | 'insert' | 'update' = 'select';
      let insertPayload: Row | Row[] | null = null;
      let updatePayload: Row | null = null;

      function exec(single: boolean): { data: unknown; error: null } {
        if (op === 'insert') {
          const toInsert = Array.isArray(insertPayload) ? insertPayload : [insertPayload as Row];
          const created = toInsert.map((r) => {
            clockMs += 1000;
            const row: Row = {
              id: `${table}-${++idCounter}`,
              created_at: new Date(clockMs).toISOString(),
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
  };
}

// ---------------------------------------------------------------------------
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => admin,
}));

// Typed as SupabaseClient (the real Admin type lib/cash/checkpoints.ts's
// exports expect) via cast — the fake only implements the query-builder
// surface those functions actually call, not the full client.
let admin: SupabaseClient;
let tables: Record<string, Row[]>;

function seed() {
  tables = {
    attendance_settings: [{ id: 's1', is_singleton: true, cash_count_required: false, cash_count_tolerance_inr: 0 }],
    staff_accounts: [],
    profiles: [
      { id: 'staff-1', name: 'Priya' },
      { id: 'staff-2', name: 'Rohan' },
      { id: 'mgr-1', name: 'Manager Meera' },
    ],
    cash_counts: [],
    cash_count_overrides: [],
    cash_shortages: [],
    order_payments: [],
    orders: [],
    refunds: [],
    cash_movements: [],
  };
  admin = makeFakeAdmin(tables) as unknown as SupabaseClient;
}

beforeEach(() => {
  idCounter = 0;
  clockMs = Date.parse('2026-09-01T00:00:00.000Z');
  seed();
});

const {
  cashFlowsBetween,
  lastRealCount,
  recordCount,
  recordOverride,
  cashRequirementFor,
} = await import('@/lib/cash/checkpoints');

// ---------------------------------------------------------------------------
// cashFlowsBetween — windowing
// ---------------------------------------------------------------------------
describe('cashFlowsBetween', () => {
  it('sums split cash parts by their OWN created_at, ignoring the order', () => {
    tables.order_payments.push(
      { order_id: 'o1', method: 'cash', amount_inr: 200, created_at: '2026-09-01T05:00:00.000Z' },
      { order_id: 'o1', method: 'upi', amount_inr: 280, created_at: '2026-09-01T05:00:00.000Z' },
      { order_id: 'o2', method: 'cash', amount_inr: 50, created_at: '2026-09-01T09:00:00.000Z' }, // outside window
    );
    return cashFlowsBetween(admin, '2026-09-01T04:00:00.000Z', '2026-09-01T06:00:00.000Z').then((flows) => {
      expect(flows.cashSettledInr).toBe(200);
    });
  });

  it('windows a single-tender settle by orders.paid_at', async () => {
    tables.orders.push({
      id: 'legacy-1',
      payment_status: 'paid',
      payment_method: 'cash',
      total_inr: 300,
      subtotal_inr: 300,
      paid_at: '2026-09-01T05:00:00.000Z',
      updated_at: '2026-09-01T05:00:00.000Z',
    });
    const flows = await cashFlowsBetween(admin, '2026-09-01T04:00:00.000Z', '2026-09-01T06:00:00.000Z');
    expect(flows.cashSettledInr).toBe(300);
  });

  it('does not count a paid order again when a later status change bumps updated_at (phantom shortage)', async () => {
    // Paid in cash at 05:00 (window 1); marked completed at 07:00 (window 2).
    tables.orders.push({
      id: 'legacy-2',
      payment_status: 'paid',
      payment_method: 'cash',
      total_inr: 250,
      subtotal_inr: 250,
      paid_at: '2026-09-01T05:00:00.000Z',
      updated_at: '2026-09-01T07:00:00.000Z',
    });
    const w1 = await cashFlowsBetween(admin, '2026-09-01T04:00:00.000Z', '2026-09-01T06:00:00.000Z');
    const w2 = await cashFlowsBetween(admin, '2026-09-01T06:00:00.000Z', '2026-09-01T08:00:00.000Z');
    expect(w1.cashSettledInr).toBe(250);
    expect(w2.cashSettledInr).toBe(0);
  });

  it('still counts the cash in the window it was paid after the order is later refunded', async () => {
    tables.orders.push({
      id: 'legacy-3',
      payment_status: 'refunded',
      payment_method: 'cash',
      total_inr: 120,
      subtotal_inr: 120,
      paid_at: '2026-09-01T05:00:00.000Z',
      updated_at: '2026-09-01T09:00:00.000Z',
    });
    const flows = await cashFlowsBetween(admin, '2026-09-01T04:00:00.000Z', '2026-09-01T06:00:00.000Z');
    expect(flows.cashSettledInr).toBe(120);
  });

  it('does not double-count a split order via the legacy fallback', async () => {
    tables.orders.push({
      id: 'split-1',
      payment_status: 'paid',
      payment_method: 'cash', // dominant part is cash
      total_inr: 480,
      subtotal_inr: 480,
      updated_at: '2026-09-01T05:00:00.000Z',
    });
    tables.order_payments.push(
      { order_id: 'split-1', method: 'cash', amount_inr: 300, created_at: '2026-09-01T05:00:00.000Z' },
      { order_id: 'split-1', method: 'upi', amount_inr: 180, created_at: '2026-09-01T05:00:00.000Z' },
    );
    const flows = await cashFlowsBetween(admin, '2026-09-01T04:00:00.000Z', '2026-09-01T06:00:00.000Z');
    // 300 from the parts query, NOT 300 + 480 from also falling through to legacy.
    expect(flows.cashSettledInr).toBe(300);
  });

  it('counts only processed cash-or-methodless refunds by processed_at', async () => {
    tables.refunds.push(
      { amount_inr: 100, method: 'cash', status: 'processed', processed_at: '2026-09-01T05:00:00.000Z' },
      { amount_inr: 50, method: 'upi', status: 'processed', processed_at: '2026-09-01T05:00:00.000Z' },
      { amount_inr: 20, status: 'processed', processed_at: '2026-09-01T05:00:00.000Z' }, // legacy, no method
      { amount_inr: 999, method: 'cash', status: 'pending', processed_at: '2026-09-01T05:00:00.000Z' },
    );
    const flows = await cashFlowsBetween(admin, '2026-09-01T04:00:00.000Z', '2026-09-01T06:00:00.000Z');
    expect(flows.cashRefundedInr).toBe(120);
  });

  it('sums cash_movements by direction within the window', async () => {
    tables.cash_movements.push(
      { direction: 'out', amount_inr: 500, created_at: '2026-09-01T05:00:00.000Z' },
      { direction: 'in', amount_inr: 200, created_at: '2026-09-01T05:00:00.000Z' },
      { direction: 'out', amount_inr: 9999, created_at: '2026-09-01T09:00:00.000Z' }, // outside window
    );
    const flows = await cashFlowsBetween(admin, '2026-09-01T04:00:00.000Z', '2026-09-01T06:00:00.000Z');
    expect(flows.cashOutInr).toBe(500);
    expect(flows.cashInInr).toBe(200);
  });

  it('treats a missing cash_movements table as "no movements" rather than failing', async () => {
    delete tables.cash_movements;
    const brokenAdmin = {
      from(table: string) {
        if (table === 'cash_movements') {
          return {
            select: () => brokenAdmin.from(table),
            gt: () => brokenAdmin.from(table),
            lte: () => brokenAdmin.from(table),
            then: (resolve: (v: unknown) => void) =>
              resolve({ data: null, error: { code: 'PGRST205', message: 'schema cache' } }),
          };
        }
        return admin.from(table);
      },
    };
    const flows = await cashFlowsBetween(brokenAdmin as never, '2026-09-01T04:00:00.000Z', '2026-09-01T06:00:00.000Z');
    expect(flows.cashOutInr).toBe(0);
    expect(flows.cashInInr).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordCount — chaining, baseline, tolerance, shortage
// ---------------------------------------------------------------------------
describe('recordCount', () => {
  it('the first-ever count has no previous — a baseline with no expected/variance', async () => {
    const result = await recordCount(admin, {
      kind: 'manual',
      userId: 'staff-1',
      denoms: { '500': 4 }, // 2000
    });
    expect(result.countedTotalInr).toBe(2000);
    expect(result.expectedTotalInr).toBeNull();
    expect(result.varianceInr).toBeNull();
    expect(result.shortageInr).toBe(0);
    expect(tables.cash_shortages).toHaveLength(0);
  });

  it('chains: expected = previous counted + settled − refunded − out + in', async () => {
    await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 4 } }); // 2000
    // Activity strictly AFTER the first count's created_at.
    const afterFirst = new Date(Date.parse(tables.cash_counts[0].created_at as string) + 500).toISOString();
    tables.order_payments.push({ order_id: 'o1', method: 'cash', amount_inr: 500, created_at: afterFirst });
    tables.refunds.push({ amount_inr: 100, method: 'cash', status: 'processed', processed_at: afterFirst });

    const second = await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 4, '100': 4 } }); // 2400
    // expected = 2000 + 500 − 100 = 2400 → exact tie-out.
    expect(second.expectedTotalInr).toBe(2400);
    expect(second.varianceInr).toBe(0);
    expect(second.shortageInr).toBe(0);
  });

  it('an override checkpoint is skipped by the chain — the next real count compares to the last REAL one', async () => {
    const first = await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 4 } }); // 2000
    expect(first.expectedTotalInr).toBeNull();

    // Grant + consume an override in between.
    tables.cash_count_overrides.push({
      id: 'ov-1',
      user_id: 'staff-2',
      punch_type: 'in',
      reason: 'Till jammed, manager verified by eye',
      granted_by: 'mgr-1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      created_at: new Date().toISOString(),
    });
    await recordOverride(admin, { userId: 'staff-2', punchType: 'in' });
    expect(tables.cash_counts.some((c) => c.kind === 'override')).toBe(true);

    const third = await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 4 } }); // 2000 again
    // previous_count_id must point at the first REAL count, not the override.
    const thirdRow = tables.cash_counts.find((c) => c.id === third.id);
    expect(thirdRow?.previous_count_id).toBe(first.id);
    expect(third.expectedTotalInr).toBe(2000); // no activity since the first count
    expect(third.varianceInr).toBe(0);
  });

});

describe('recordCount — shortage row', () => {
  it('a shortfall beyond tolerance charges the FULL shortfall to the counter and raises a cash_shortages row', async () => {
    tables.attendance_settings[0].cash_count_tolerance_inr = 0;
    const first = await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 4 } }); // 2000
    const afterFirst = new Date(Date.parse(tables.cash_counts[0].created_at as string) + 500).toISOString();
    tables.order_payments.push({ order_id: 'o1', method: 'cash', amount_inr: 500, created_at: afterFirst }); // expected 2500

    const short = await recordCount(admin, { kind: 'manual', userId: 'staff-2', denoms: { '500': 4, '100': 2 } }); // 2200
    expect(short.expectedTotalInr).toBe(2500);
    expect(short.varianceInr).toBe(-300);
    expect(short.shortageInr).toBe(300);

    const shortageRow = tables.cash_shortages.find((s) => s.count_id === short.id);
    expect(shortageRow).toBeTruthy();
    expect(shortageRow?.user_id).toBe('staff-2');
    expect(shortageRow?.original_user_id).toBe('staff-2');
    expect(shortageRow?.amount_inr).toBe(300);
    void first;
  });

  it('a variance within tolerance does not insert a cash_shortages row', async () => {
    tables.attendance_settings[0].cash_count_tolerance_inr = 100;
    await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 4 } }); // 2000
    // No settle activity — expected stays 2000. Count 1950 → short by 50, within ₹100 tolerance.
    const result = await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 3, '100': 4, '50': 1 } }); // 1950
    expect(result.varianceInr).toBe(-50);
    expect(result.shortageInr).toBe(0);
    expect(tables.cash_shortages).toHaveLength(0);
  });

  it('an overage is recorded but never charged', async () => {
    await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 4 } }); // 2000
    const result = await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 4, '100': 1 } }); // 2100
    expect(result.varianceInr).toBe(100);
    expect(result.shortageInr).toBe(0);
    expect(tables.cash_shortages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// recordOverride — consumption
// ---------------------------------------------------------------------------
describe('recordOverride', () => {
  function grantOverride(over: Row = {}) {
    tables.cash_count_overrides.push({
      id: 'ov-1',
      user_id: 'staff-2',
      punch_type: 'in',
      reason: 'Register jammed; manager verified the float by eye',
      granted_by: 'mgr-1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      created_at: new Date().toISOString(),
      ...over,
    });
  }

  it('records a checkpoint with nothing counted and marks the grant used', async () => {
    grantOverride();
    const result = await recordOverride(admin, { userId: 'staff-2', punchType: 'in' });
    expect(result.kind).toBe('override');
    expect(result.countedTotalInr).toBeNull();
    expect(result.shortageInr).toBe(0);
    expect(tables.cash_count_overrides[0].used_at).not.toBeNull();
    expect(tables.cash_count_overrides[0].used_count_id).toBe(result.id);
  });

  it('a consumed override cannot be used a second time', async () => {
    grantOverride();
    await recordOverride(admin, { userId: 'staff-2', punchType: 'in' });
    await expect(recordOverride(admin, { userId: 'staff-2', punchType: 'in' })).rejects.toThrow();
  });

  it('an expired grant is not usable', async () => {
    grantOverride({ expires_at: new Date(Date.now() - 1000).toISOString() });
    await expect(recordOverride(admin, { userId: 'staff-2', punchType: 'in' })).rejects.toThrow();
  });

  it('a grant for the other punch type is not usable', async () => {
    grantOverride({ punch_type: 'out' });
    await expect(recordOverride(admin, { userId: 'staff-2', punchType: 'in' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cashRequirementFor
// ---------------------------------------------------------------------------
describe('cashRequirementFor', () => {
  it('is not required when the global switch is off', async () => {
    const req = await cashRequirementFor(admin, 'staff-1');
    expect(req.required).toBe(false);
  });

  it('is required when the switch is on and the staffer has no exemption row (default: handles cash)', async () => {
    tables.attendance_settings[0].cash_count_required = true;
    const req = await cashRequirementFor(admin, 'staff-1');
    expect(req.required).toBe(true);
  });

  it('is NOT required for a staffer marked handles_cash: false', async () => {
    tables.attendance_settings[0].cash_count_required = true;
    tables.staff_accounts.push({ user_id: 'staff-1', handles_cash: false, status: 'active' });
    const req = await cashRequirementFor(admin, 'staff-1');
    expect(req.required).toBe(false);
  });

  it('surfaces a usable override for the matching punch type', async () => {
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
    const req = await cashRequirementFor(admin, 'staff-1');
    expect(req.override?.punchType).toBe('out');
    expect(req.override?.grantedByName).toBe('Manager Meera');
  });

  it('fails safe (not required, no override) on an unexpected error', async () => {
    const throwingAdmin = {
      from() {
        throw new Error('boom');
      },
    };
    const req = await cashRequirementFor(throwingAdmin as never, 'staff-1');
    expect(req).toEqual({ required: false, override: null });
  });
});

// ---------------------------------------------------------------------------
// lastRealCount
// ---------------------------------------------------------------------------
describe('lastRealCount', () => {
  it('returns null when nothing has been counted yet', async () => {
    expect(await lastRealCount(admin)).toBeNull();
  });

  it('ignores override checkpoints', async () => {
    await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 1 } });
    tables.cash_count_overrides.push({
      id: 'ov-1',
      user_id: 'staff-2',
      punch_type: 'in',
      reason: 'Register jammed; manager verified the float by eye',
      granted_by: 'mgr-1',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
      created_at: new Date().toISOString(),
    });
    await recordOverride(admin, { userId: 'staff-2', punchType: 'in' });

    const last = await lastRealCount(admin);
    expect(last?.kind).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// Routes built on the engine: manager-only gates.
// ---------------------------------------------------------------------------
vi.mock('@/lib/api/auth', () => ({
  getStaffUser: () => Promise.resolve(routeState.staffUser),
  getManagerUser: () => Promise.resolve(routeState.managerUser),
  // PIN-3: /api/cash-counts (unlike overrides/movements, unmigrated here) now
  // resolves via getCounterActor()/getCounterManager() — mirrored 1:1 off the
  // same routeState so every existing case above keeps meaning what it did.
  getCounterActor: () =>
    Promise.resolve(routeState.staffUser ? { user: routeState.staffUser, role: 'staff', via: 'session' } : null),
  getCounterManager: () =>
    Promise.resolve(routeState.managerUser ? { user: routeState.managerUser, role: 'manager', via: 'session' } : null),
}));

const routeState: { staffUser: Row | null; managerUser: Row | null } = {
  staffUser: null,
  managerUser: null,
};

function jsonReq(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const cashCountsRoute = await import('@/app/api/cash-counts/route');
const cashCountOverridesRoute = await import('@/app/api/cash-counts/overrides/route');
const cashMovementsRoute = await import('@/app/api/cash-movements/route');

describe('POST/GET /api/cash-counts', () => {
  const { POST, GET } = cashCountsRoute;

  beforeEach(() => {
    routeState.staffUser = { id: 'staff-1' };
    routeState.managerUser = null;
  });

  it('401s a manual count without a staff session', async () => {
    routeState.staffUser = null;
    const res = await POST(jsonReq('http://t/api/cash-counts', 'POST', { denoms: { '500': 1 } }));
    expect(res.status).toBe(401);
  });

  it('any staff session can record a manual count', async () => {
    const res = await POST(jsonReq('http://t/api/cash-counts', 'POST', { denoms: { '500': 2 } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cashCount.kind).toBe('manual');
    expect(body.cashCount.countedTotalInr).toBe(1000);
  });

  it('401s the listing for a staff session (manager/owner only — getManagerUser gate)', async () => {
    const res = await GET(jsonReq('http://t/api/cash-counts?limit=10', 'GET'));
    expect(res.status).toBe(401);
  });

  it('a manager sees recent counts with names resolved', async () => {
    routeState.managerUser = { id: 'mgr-1' };
    await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 1 } });
    const res = await GET(jsonReq('http://t/api/cash-counts?limit=10', 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toHaveLength(1);
    expect(body.counts[0].userName).toBe('Priya');
  });
});

describe('POST/GET /api/cash-counts/overrides', () => {
  const { POST, GET } = cashCountOverridesRoute;

  // The route validates userId with isUuid() — real staff ids ARE Supabase
  // auth UUIDs in production, so these tests use UUID-shaped ids rather than
  // the plain 'staff-1'-style labels the engine-level tests above use (those
  // never pass through isUuid()).
  const MGR_ID = '00000000-0000-0000-0000-0000000000a1';
  const STAFF2_ID = '00000000-0000-0000-0000-0000000000a2';
  const STAFF3_ID = '00000000-0000-0000-0000-0000000000a3';

  beforeEach(() => {
    routeState.staffUser = null;
    routeState.managerUser = { id: MGR_ID };
    tables.staff_accounts.push({ user_id: STAFF2_ID, status: 'active', handles_cash: true });
    tables.profiles.push({ id: MGR_ID, name: 'Manager Meera' }, { id: STAFF2_ID, name: 'Rohan' });
  });

  it('401s without a manager/owner session (getManagerUser gate)', async () => {
    routeState.managerUser = null;
    const res = await POST(
      jsonReq('http://t/api/cash-counts/overrides', 'POST', {
        userId: STAFF2_ID,
        punchType: 'in',
        reason: 'Till jammed, verified by eye',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('grants an override to an active staff account', async () => {
    const res = await POST(
      jsonReq('http://t/api/cash-counts/overrides', 'POST', {
        userId: STAFF2_ID,
        punchType: 'in',
        reason: 'Till jammed, verified by eye',
      }),
    );
    expect(res.status).toBe(200);
    expect(tables.cash_count_overrides).toHaveLength(1);
    expect(tables.cash_count_overrides[0].granted_by).toBe(MGR_ID);
  });

  it('400s a reason that is too short', async () => {
    const res = await POST(
      jsonReq('http://t/api/cash-counts/overrides', 'POST', { userId: STAFF2_ID, punchType: 'in', reason: 'ok' }),
    );
    expect(res.status).toBe(400);
  });

  it('400s granting to self', async () => {
    const res = await POST(
      jsonReq('http://t/api/cash-counts/overrides', 'POST', {
        userId: MGR_ID,
        punchType: 'in',
        reason: 'Till jammed, verified by eye',
      }),
    );
    expect(res.status).toBe(400);
    expect(tables.cash_count_overrides).toHaveLength(0);
  });

  it('400s a target with no active staff_accounts row', async () => {
    const res = await POST(
      jsonReq('http://t/api/cash-counts/overrides', 'POST', {
        userId: STAFF3_ID,
        punchType: 'in',
        reason: 'Till jammed, verified by eye',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('lists active overrides', async () => {
    await POST(
      jsonReq('http://t/api/cash-counts/overrides', 'POST', {
        userId: STAFF2_ID,
        punchType: 'in',
        reason: 'Till jammed, verified by eye',
      }),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.overrides).toHaveLength(1);
    expect(body.overrides[0].grantedByName).toBe('Manager Meera');
  });
});

describe('POST/GET /api/cash-movements', () => {
  const { POST, GET } = cashMovementsRoute;

  beforeEach(() => {
    routeState.staffUser = null;
    routeState.managerUser = { id: 'mgr-1' };
  });

  it('401s without a manager/owner session (getManagerUser gate)', async () => {
    routeState.managerUser = null;
    const res = await POST(
      jsonReq('http://t/api/cash-movements', 'POST', { direction: 'out', amountInr: 500, reason: 'Bank deposit' }),
    );
    expect(res.status).toBe(401);
  });

  it('records a cash-out movement', async () => {
    const res = await POST(
      jsonReq('http://t/api/cash-movements', 'POST', { direction: 'out', amountInr: 500, reason: 'Bank deposit' }),
    );
    expect(res.status).toBe(200);
    expect(tables.cash_movements).toHaveLength(1);
    expect(tables.cash_movements[0].amount_inr).toBe(500);
  });

  it('400s a reason under 5 characters', async () => {
    const res = await POST(jsonReq('http://t/api/cash-movements', 'POST', { direction: 'in', amountInr: 100, reason: 'ok' }));
    expect(res.status).toBe(400);
  });

  it('400s a non-integer or out-of-range amount', async () => {
    const tooBig = await POST(
      jsonReq('http://t/api/cash-movements', 'POST', { direction: 'in', amountInr: 2_000_000, reason: 'Owner top-up' }),
    );
    expect(tooBig.status).toBe(400);
    const zero = await POST(
      jsonReq('http://t/api/cash-movements', 'POST', { direction: 'in', amountInr: 0, reason: 'Owner top-up' }),
    );
    expect(zero.status).toBe(400);
  });

  it('lists recent movements with the recorder named', async () => {
    await POST(jsonReq('http://t/api/cash-movements', 'POST', { direction: 'in', amountInr: 300, reason: 'Owner top-up' }));
    const res = await GET(jsonReq('http://t/api/cash-movements?limit=5', 'GET'));
    const body = await res.json();
    expect(body.movements).toHaveLength(1);
    expect(body.movements[0].recordedByName).toBe('Manager Meera');
  });
});
