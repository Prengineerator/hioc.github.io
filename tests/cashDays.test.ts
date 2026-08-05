import { beforeEach, describe, expect, it, vi } from 'vitest';

// Cash management: day-open / day-close by denomination (OPS-2, STF-045). Two
// layers, house style:
//  1. Pure money on lib/cash/denoms.ts — no mocks: denomsTotalInr across the
//     note counts + coins ₹-amount bucket, and the expected-cash / over-short
//     formulas.
//  2. Handler-level integration for GET/POST/PATCH /api/cash-days against a
//     mocked Supabase admin client + auth + permission matrix, so the route's
//     server-authoritative totals, one-open-day rule, variance-notes rule,
//     immutability, and permission gates are exercised end-to-end.

import {
  denomsTotalInr,
  sanitizeDenoms,
  expectedCashInr,
  overShortInr,
} from '@/lib/cash/denoms';

// --- Shared, per-test mutable state the route mocks read from. ---------------
const state: {
  user: { id: string } | null;
  perms: Record<string, boolean>;
  openDay: Record<string, unknown> | null; // the currently-open cash day (or null)
  todayRow: Record<string, unknown> | null; // a same-date row (open or closed)
  history: Record<string, unknown>[]; // recent closed days
  cashOrders: Record<string, unknown>[]; // settled orders for the day
  orderPayments: Record<string, unknown>[]; // POS4-1 split parts for those orders
  refunds: Record<string, unknown>[]; // processed refunds on those cash orders
  insertedDay: Record<string, unknown> | null; // day-open insert result
  insertError: { code?: string; message?: string } | null; // e.g. 23505 race
  closeResult: Record<string, unknown> | null; // guarded close update (null = lost race)
  openInsert?: Record<string, unknown>; // captured day-open payload
  closePatch?: Record<string, unknown>; // captured day-close payload
} = {
  user: null,
  perms: {},
  openDay: null,
  todayRow: null,
  history: [],
  cashOrders: [],
  orderPayments: [],
  refunds: [],
  insertedDay: null,
  insertError: null,
  closeResult: null,
};

function resolveValue(table: string, op: string, filters: [string, unknown][]) {
  const filterVal = (col: string) => filters.find((f) => f[0] === col)?.[1];
  if (table === 'cash_days') {
    if (op === 'insert') {
      return state.insertError
        ? { data: null, error: state.insertError }
        : { data: state.insertedDay, error: null };
    }
    if (op === 'update') return { data: state.closeResult, error: null };
    // select
    if (filterVal('status') === 'open') return { data: state.openDay, error: null };
    if (filterVal('status') === 'closed') return { data: state.history, error: null };
    if (filters.some((f) => f[0] === 'business_date')) {
      return { data: state.todayRow, error: null };
    }
    return { data: null, error: null };
  }
  if (table === 'orders') return { data: state.cashOrders, error: null };
  // POS4-1: the route now reads split parts and prefers them over the order total.
  if (table === 'order_payments') return { data: state.orderPayments, error: null };
  if (table === 'refunds') return { data: state.refunds, error: null };
  return { data: null, error: null };
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const ctx = { op: 'select' };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        insert: (p: Record<string, unknown>) => {
          ctx.op = 'insert';
          if (table === 'cash_days') state.openInsert = p;
          return chain;
        },
        update: (p: Record<string, unknown>) => {
          ctx.op = 'update';
          if (table === 'cash_days') state.closePatch = p;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return chain;
        },
        in: () => chain,
        gte: () => chain,
        lt: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(resolveValue(table, ctx.op, filters)),
        single: () => Promise.resolve(resolveValue(table, ctx.op, filters)),
        // Makes a terminal-less query (orders/refunds/history) awaitable.
        then: (resolve: (v: unknown) => void) => resolve(resolveValue(table, ctx.op, filters)),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getStaffUser: () => Promise.resolve(state.user),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: (_user: unknown, key: string) => Promise.resolve(state.perms[key] ?? false),
}));

// Imported after mocks are registered (vi.mock is hoisted).
const { GET, POST, PATCH } = await import('@/app/api/cash-days/route');

function jsonReq(method: string, body: unknown) {
  return new Request('http://t/api/cash-days', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// 1. Pure denomination + expected-cash math (no mocks).
// ---------------------------------------------------------------------------
describe('denomsTotalInr (OPS-2 money, no mocks)', () => {
  it('is 0 for an empty / missing map', () => {
    expect(denomsTotalInr({})).toBe(0);
    expect(denomsTotalInr(null)).toBe(0);
    expect(denomsTotalInr(undefined)).toBe(0);
  });

  it('multiplies each note count by its face value', () => {
    expect(denomsTotalInr({ '500': 2 })).toBe(1000);
    expect(denomsTotalInr({ '500': 1, '200': 1, '100': 1, '50': 1, '20': 1, '10': 1 })).toBe(880);
  });

  it('adds the coins bucket as a rupee AMOUNT, not a count', () => {
    // coins face value is 1, so the figure is added straight through.
    expect(denomsTotalInr({ coins: 47 })).toBe(47);
    // 500·1 + 100·3 + 10·5 + coins 47 = 897
    expect(denomsTotalInr({ '500': 1, '100': 3, '10': 5, coins: 47 })).toBe(897);
  });

  it('ignores unknown denominations and non-positive / garbage counts', () => {
    expect(denomsTotalInr({ '2000': 5, '500': 1 })).toBe(500); // ₹2000 not in the set
    expect(denomsTotalInr({ '500': -3, '100': 2 })).toBe(200); // negative floored to 0
    expect(denomsTotalInr({ '500': 1.9 })).toBe(500); // fractions floored
    expect(denomsTotalInr({ '100': 'x' } as never)).toBe(0);
  });

  it('sanitizeDenoms coerces to exactly the known keys as non-negative ints', () => {
    const clean = sanitizeDenoms({ '500': 2, '2000': 9, '100': -1, coins: 3.7 });
    expect(clean).toEqual({ '500': 2, '200': 0, '100': 0, '50': 0, '20': 0, '10': 0, coins: 3 });
    // The stored denoms always re-total to the stored total.
    expect(denomsTotalInr(clean)).toBe(1003);
  });
});

describe('expectedCashInr / overShortInr (OPS-2 formula)', () => {
  it('expected = opening + Σ cash settles − Σ cash refunds', () => {
    expect(expectedCashInr(5000, 500, 100)).toBe(5400);
    expect(expectedCashInr(0, 0, 0)).toBe(0);
    expect(expectedCashInr(2000, 0, 250)).toBe(1750); // refunds paid out of the drawer
  });

  it('over/short = counted − expected (signed)', () => {
    expect(overShortInr(5400, 5400)).toBe(0); // ties out
    expect(overShortInr(5000, 5400)).toBe(-400); // short
    expect(overShortInr(5600, 5400)).toBe(200); // over
  });
});

// ---------------------------------------------------------------------------
// 2. Handler — GET/POST/PATCH /api/cash-days.
// ---------------------------------------------------------------------------
describe('/api/cash-days handlers (OPS-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user = { id: 'staff-1' };
    state.perms = { cash_day_open: true, cash_day_close: true };
    state.openDay = null;
    state.todayRow = null;
    state.history = [];
    state.cashOrders = [];
    state.orderPayments = [];
    state.refunds = [];
    state.insertedDay = null;
    state.insertError = null;
    state.closeResult = null;
    state.openInsert = undefined;
    state.closePatch = undefined;
  });

  // --- auth --------------------------------------------------------------
  it('401s every method without a staff session', async () => {
    state.user = null;
    expect((await GET()).status).toBe(401);
    expect((await POST(jsonReq('POST', {}))).status).toBe(401);
    expect((await PATCH(jsonReq('PATCH', {}))).status).toBe(401);
  });

  // --- day-open ----------------------------------------------------------
  it('day-open computes opening_total server-side and ignores any client total', async () => {
    state.insertedDay = { id: 'cd-1', status: 'open' };
    const res = await POST(
      jsonReq('POST', {
        opening_denoms: { '500': 4, '100': 10, coins: 50 },
        opening_total_inr: 999999, // a lie — must be ignored
      }),
    );
    expect(res.status).toBe(200);
    // 500·4 + 100·10 + coins 50 = 3050 (NOT the client's 999999).
    expect(state.openInsert?.opening_total_inr).toBe(3050);
    expect(state.openInsert?.status).toBe('open');
    expect(state.openInsert?.opened_by).toBe('staff-1');
    expect(typeof state.openInsert?.business_date).toBe('string');
  });

  it('403s day-open without the cash_day_open permission', async () => {
    state.perms.cash_day_open = false;
    const res = await POST(jsonReq('POST', { opening_denoms: { '500': 1 } }));
    expect(res.status).toBe(403);
    expect(state.openInsert).toBeUndefined();
  });

  it('409s a second open while a day is already open (pre-check)', async () => {
    state.openDay = { id: 'cd-open', status: 'open' };
    const res = await POST(jsonReq('POST', { opening_denoms: { '500': 1 } }));
    expect(res.status).toBe(409);
    expect(state.openInsert).toBeUndefined();
  });

  it('409s a second open on a 23505 unique-violation race (idx_cash_days_one_open)', async () => {
    state.insertError = { code: '23505', message: 'idx_cash_days_one_open' };
    const res = await POST(jsonReq('POST', { opening_denoms: { '500': 1 } }));
    expect(res.status).toBe(409);
  });

  it("409s when today's cash day has already been recorded (closed earlier)", async () => {
    state.todayRow = { id: 'cd-today', status: 'closed' };
    const res = await POST(jsonReq('POST', { opening_denoms: { '500': 1 } }));
    expect(res.status).toBe(409);
    expect(state.openInsert).toBeUndefined();
  });

  // --- day-close ---------------------------------------------------------
  it('day-close computes counted + expected + over/short and closes on a tie-out', async () => {
    state.openDay = { id: 'cd-1', status: 'open', business_date: '2026-07-26', opening_total_inr: 5000 };
    state.cashOrders = [
      { id: 'o1', total_inr: 300, payment_method: 'cash' },
      { id: 'o2', total_inr: 200, payment_method: 'cash' },
    ]; // settles 500
    state.refunds = [{ amount_inr: 100 }]; // refunds 100 → expected 5400
    state.closeResult = { id: 'cd-1', status: 'closed' };

    const res = await PATCH(
      jsonReq('PATCH', { closing_denoms: { '500': 10, '100': 4 } }), // counted 5400
    );
    expect(res.status).toBe(200);
    expect(state.closePatch?.status).toBe('closed');
    expect(state.closePatch?.closed_by).toBe('staff-1');
    expect(state.closePatch?.counted_total_inr).toBe(5400);
    expect(state.closePatch?.expected_cash_inr).toBe(5400);
    expect(state.closePatch?.over_short_inr).toBe(0);

    const bodyJson = await res.json();
    expect(bodyJson.summary.cash_settles_inr).toBe(500);
    expect(bodyJson.summary.cash_refunds_inr).toBe(100);
    expect(bodyJson.summary.over_short_inr).toBe(0);
  });

  it('400s a close with a variance and no notes; 200s once notes are supplied', async () => {
    state.openDay = { id: 'cd-1', status: 'open', business_date: '2026-07-26', opening_total_inr: 5000 };
    state.cashOrders = [
      { id: 'o1', total_inr: 300, payment_method: 'cash' },
      { id: 'o2', total_inr: 200, payment_method: 'cash' },
    ];
    state.refunds = [{ amount_inr: 100 }]; // expected 5400
    state.closeResult = { id: 'cd-1', status: 'closed' };

    // Counts to 5000 → short by 400, no notes → 400.
    const noNotes = await PATCH(jsonReq('PATCH', { closing_denoms: { '500': 10 } }));
    expect(noNotes.status).toBe(400);
    expect(state.closePatch).toBeUndefined();

    const withNotes = await PATCH(
      jsonReq('PATCH', { closing_denoms: { '500': 10 }, notes: 'Two ₹200 notes stuck together' }),
    );
    expect(withNotes.status).toBe(200);
    expect(state.closePatch?.over_short_inr).toBe(-400);
    expect(state.closePatch?.notes).toBe('Two ₹200 notes stuck together');
  });

  it('403s day-close without the cash_day_close permission (manager-only default)', async () => {
    state.perms.cash_day_close = false;
    state.openDay = { id: 'cd-1', status: 'open', business_date: '2026-07-26', opening_total_inr: 0 };
    const res = await PATCH(jsonReq('PATCH', { closing_denoms: { '500': 1 } }));
    expect(res.status).toBe(403);
    expect(state.closePatch).toBeUndefined();
  });

  it('404s a close when no cash day is open', async () => {
    state.openDay = null;
    const res = await PATCH(jsonReq('PATCH', { closing_denoms: { '500': 1 } }));
    expect(res.status).toBe(404);
  });

  it('409s a close that lost the status race (already closed — immutable)', async () => {
    state.openDay = { id: 'cd-1', status: 'open', business_date: '2026-07-26', opening_total_inr: 5000 };
    state.cashOrders = [];
    state.refunds = [];
    state.closeResult = null; // guarded update matched no open row
    const res = await PATCH(
      jsonReq('PATCH', { closing_denoms: { '500': 10 }, notes: 'irrelevant' }),
    );
    expect(res.status).toBe(409);
  });

  // --- GET summary -------------------------------------------------------
  it('GET returns the open day with a live expected-cash summary and closed history', async () => {
    state.openDay = { id: 'cd-1', status: 'open', business_date: '2026-07-26', opening_total_inr: 5000 };
    state.cashOrders = [
      { id: 'o1', total_inr: 300, payment_method: 'cash' },
      { id: 'o2', total_inr: 200, payment_method: 'cash' },
    ];
    state.refunds = [{ amount_inr: 100 }];
    state.history = [{ id: 'cd-0', status: 'closed', over_short_inr: -20 }];

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.open_day.id).toBe('cd-1');
    expect(body.open_summary.expected_cash_inr).toBe(5400); // 5000 + 500 − 100
    expect(body.open_summary.cash_settle_count).toBe(2);
    expect(body.history).toHaveLength(1);
  });

  // --- POS4-1: split settlements must not corrupt the drawer --------------
  it('counts ONLY the cash part of a split, not the whole order total', async () => {
    state.openDay = { id: 'cd-1', status: 'open', business_date: '2026-07-26', opening_total_inr: 5000 };
    // One ₹480 order settled ₹200 cash + ₹280 UPI. Its dominant method is UPI,
    // so the pre-POS4-1 query (payment_method='cash') would have missed it
    // entirely; naively counting the total would have added ₹480.
    state.cashOrders = [{ id: 'o1', total_inr: 480, payment_method: 'upi' }];
    state.orderPayments = [
      { order_id: 'o1', method: 'cash', amount_inr: 200 },
      { order_id: 'o1', method: 'upi', amount_inr: 280 },
    ];
    state.refunds = [];

    const body = await (await GET()).json();

    expect(body.open_summary.expected_cash_inr).toBe(5200); // 5000 + 200 cash only
  });

  it('adds nothing to the drawer for a fully non-cash split', async () => {
    state.openDay = { id: 'cd-1', status: 'open', business_date: '2026-07-26', opening_total_inr: 5000 };
    state.cashOrders = [{ id: 'o1', total_inr: 480, payment_method: 'card' }];
    state.orderPayments = [
      { order_id: 'o1', method: 'card', amount_inr: 300 },
      { order_id: 'o1', method: 'upi', amount_inr: 180 },
    ];
    state.refunds = [];

    const body = await (await GET()).json();

    expect(body.open_summary.expected_cash_inr).toBe(5000);
    expect(body.open_summary.cash_settle_count).toBe(0);
  });

  it('still counts a legacy order that has no parts rows', async () => {
    // Orders settled before POS4-1 have no order_payments; the old rule (whole
    // total iff payment_method='cash') must keep working for them.
    state.openDay = { id: 'cd-1', status: 'open', business_date: '2026-07-26', opening_total_inr: 5000 };
    state.cashOrders = [
      { id: 'legacy', total_inr: 300, payment_method: 'cash' },
      { id: 'o1', total_inr: 480, payment_method: 'upi' },
    ];
    state.orderPayments = [
      { order_id: 'o1', method: 'cash', amount_inr: 200 },
      { order_id: 'o1', method: 'upi', amount_inr: 280 },
    ];
    state.refunds = [];

    const body = await (await GET()).json();

    expect(body.open_summary.expected_cash_inr).toBe(5500); // 5000 + 300 legacy + 200 split cash
  });

  it('GET returns a null open day + no summary when the drawer is closed', async () => {
    state.openDay = null;
    state.history = [{ id: 'cd-0', status: 'closed' }];
    const res = await GET();
    const body = await res.json();
    expect(body.open_day).toBeNull();
    expect(body.open_summary).toBeNull();
    expect(body.history).toHaveLength(1);
  });
});
