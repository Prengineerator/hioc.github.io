import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';

// Cash day: Open → Close → Handover (OPS-2, STF-045; reworked 2026-09-29). Two
// layers, house style:
//  1. Pure money on lib/cash/denoms.ts — no mocks: denomsTotalInr across the
//     note and coin counts (a legacy lump 'coins' amount still re-totals), and the
//     expected-cash / over-short formulas. The lifecycle rules themselves
//     (Match column, handover split, unpaid gate) are in cashDayLifecycle.test.ts.
//  2. Handler-level integration for /api/cash-days (GET/POST/PATCH), /reopen and
//     /log against an in-memory fake Postgres driving the REAL lib/cash queries
//     (cashActivityBetween etc.), with auth + the permission matrix mocked, so
//     the route's server-authoritative totals, windowing by payment time, the
//     open-vs-float-left comparison, the close gates, the handover and the
//     checkpoint-chain consistency are exercised end-to-end.

import {
  denomsTotalInr,
  sanitizeDenoms,
  expectedCashInr,
  overShortInr,
} from '@/lib/cash/denoms';

// --- Per-test mutable state the mocks read from. ------------------------------
const auth: {
  user: { id: string } | null;
  role: 'staff' | 'manager' | 'owner';
  perms: Record<string, boolean>;
} = { user: null, role: 'staff', perms: {} };

let admin: SupabaseClient;
let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => admin,
}));

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () =>
    Promise.resolve(auth.user ? { user: auth.user, role: auth.role, via: 'session' } : null),
  getCounterManager: () =>
    Promise.resolve(
      auth.user && (auth.role === 'manager' || auth.role === 'owner')
        ? { user: auth.user, role: auth.role, via: 'session' }
        : null,
    ),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: (_user: unknown, key: string) => Promise.resolve(auth.perms[key] ?? false),
}));

// Imported after mocks are registered (vi.mock is hoisted).
const { GET, POST, PATCH } = await import('@/app/api/cash-days/route');
const { POST: REOPEN } = await import('@/app/api/cash-days/reopen/route');
const { GET: LOG } = await import('@/app/api/cash-days/log/route');
const { recordCount } = await import('@/lib/cash/checkpoints');

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

  it('counts ₹5/₹2/₹1 coins individually', () => {
    // 5·3 + 2·4 + 1·7 = 30
    expect(denomsTotalInr({ '5': 3, '2': 4, '1': 7 })).toBe(30);
    // 500·1 + 100·3 + 10·5 + 5·2 + 1·2 = 862
    expect(denomsTotalInr({ '500': 1, '100': 3, '10': 5, '5': 2, '1': 2 })).toBe(862);
  });

  it('still re-totals a legacy row that stored coins as one lump ₹ amount', () => {
    expect(denomsTotalInr({ coins: 47 })).toBe(47);
    expect(denomsTotalInr({ '500': 1, '100': 3, '10': 5, coins: 47 })).toBe(897);
  });

  it('ignores unknown denominations and non-positive / garbage counts', () => {
    expect(denomsTotalInr({ '2000': 5, '500': 1 })).toBe(500); // ₹2000 not in the set
    expect(denomsTotalInr({ '500': -3, '100': 2 })).toBe(200); // negative floored to 0
    expect(denomsTotalInr({ '500': 1.9 })).toBe(500); // fractions floored
    expect(denomsTotalInr({ '100': 'x' } as never)).toBe(0);
  });

  it('sanitizeDenoms coerces to exactly the known keys as non-negative ints', () => {
    // Unknown keys (a stray "2000", the retired lump "coins") are dropped from
    // new input; counts floor to non-negative integers.
    const clean = sanitizeDenoms({ '500': 2, '2000': 9, '100': -1, '5': 3.7, coins: 40 });
    expect(clean).toEqual({ '500': 2, '200': 0, '100': 0, '50': 0, '20': 0, '10': 0, '5': 3, '2': 0, '1': 0 });
    // The stored denoms always re-total to the stored total.
    expect(denomsTotalInr(clean)).toBe(1015); // 500·2 + 5·3
  });
});

describe('expectedCashInr / overShortInr (OPS-2 formula)', () => {
  it('expected = opening + Σ cash settles − Σ cash refunds', () => {
    expect(expectedCashInr(5000, 500, 100)).toBe(5400);
    expect(expectedCashInr(0, 0, 0)).toBe(0);
    expect(expectedCashInr(2000, 0, 250)).toBe(1750); // refunds paid out of the drawer
  });

  it('cash put in adds and cash taken out subtracts', () => {
    expect(expectedCashInr(1500, 4200, 300, 500, 2000)).toBe(3900);
  });

  it('over/short = counted − expected (signed)', () => {
    expect(overShortInr(5400, 5400)).toBe(0); // ties out
    expect(overShortInr(5000, 5400)).toBe(-400); // short
    expect(overShortInr(5600, 5400)).toBe(200); // over
  });
});


// ---------------------------------------------------------------------------
// 2. Handlers — /api/cash-days (GET/POST/PATCH), /reopen, /log.
// ---------------------------------------------------------------------------
const NOW = '2026-09-02T12:00:00.000Z'; // fixed "now" for the routes' own clock
const START = '2026-09-01T09:30:00.000Z'; // virtual DB clock start (≈ 3:00 pm IST)
const OPENED = '2026-09-01T09:30:00.000Z';

let fake: ReturnType<typeof makeFakeAdmin>;

// A cash_days row as the DB would hand it back, with every new column present.
function dayRow(over: Row = {}): Row {
  return {
    id: 'cd-1',
    business_date: '2026-09-01',
    status: 'open',
    opened_by: 'staff-1',
    opened_at: OPENED,
    opening_denoms: { '500': 2, '100': 5 },
    opening_total_inr: 1500,
    closed_by: null,
    closed_at: null,
    closing_denoms: {},
    counted_total_inr: 0,
    expected_cash_inr: 0,
    over_short_inr: 0,
    notes: '',
    open_expected_total_inr: null,
    open_variance_inr: null,
    open_reason: '',
    close_reason: '',
    cash_sales_inr: null,
    cash_sales_count: null,
    cash_refunds_inr: null,
    cash_in_inr: null,
    cash_out_inr: null,
    upi_inr: null,
    card_inr: null,
    handover_inr: null,
    float_left_denoms: null,
    float_left_total_inr: null,
    unpaid_count_at_close: null,
    unpaid_override_reason: null,
    reopened_at: null,
    reopened_by: null,
    reopen_reason: null,
    reopen_log: [],
    ...over,
  };
}

// Column defaults an insert into cash_days gets from the database.
function dbDefaults(table: string, row: Row): Row {
  if (table !== 'cash_days') return row;
  return dayRow({ ...row, opened_at: row.created_at });
}

function order(over: Row): Row {
  return {
    payment_status: 'paid',
    status: 'completed',
    payment_method: 'cash',
    total_inr: 0,
    subtotal_inr: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  auth.user = { id: 'staff-1' };
  auth.role = 'staff';
  auth.perms = { cash_day_open: true, cash_day_close: true };
  tables = {
    cash_days: [],
    cash_counts: [],
    cash_shortages: [],
    cash_movements: [],
    attendance_settings: [{ id: 's1', is_singleton: true, cash_count_required: false, cash_count_tolerance_inr: 0 }],
    orders: [],
    order_payments: [],
    refunds: [],
    profiles: [
      { id: 'staff-1', name: 'Priya' },
      { id: 'mgr-1', name: 'Meera' },
    ],
  };
  fake = makeFakeAdmin(tables, { startMs: Date.parse(START), defaults: dbDefaults });
  admin = fake as unknown as SupabaseClient;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/api/cash-days auth', () => {
  it('401s every method without a staff session', async () => {
    auth.user = null;
    expect((await GET()).status).toBe(401);
    expect((await POST(jsonReq('POST', {}))).status).toBe(401);
    expect((await PATCH(jsonReq('PATCH', {}))).status).toBe(401);
    expect((await REOPEN(jsonReq('POST', {}))).status).toBe(401);
    expect((await LOG(new Request('http://t/api/cash-days/log'))).status).toBe(401);
  });

  it('reopen and the owner log are manager-only: 403 for a plain staffer (not 401 — they are signed in)', async () => {
    auth.role = 'staff';
    const res = await REOPEN(jsonReq('POST', { reason: 'closed by mistake' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/manager or the owner/);
    expect((await LOG(new Request('http://t/api/cash-days/log'))).status).toBe(403);
  });
});

describe('GET /api/cash-days — the open day', () => {
  it('windows cash sales by when they were PAID, not when the order was created', async () => {
    tables.cash_days.push(dayRow());
    tables.orders.push(
      // Created the evening before, paid after opening → today's cash.
      order({ id: 'o1', order_number: 1001, total_inr: 400, created_at: '2026-08-31T18:00:00.000Z', paid_at: '2026-09-01T10:00:00.000Z' }),
      // Created after opening but paid BEFORE it (belongs to the previous window).
      order({ id: 'o2', order_number: 1002, total_inr: 999, created_at: '2026-09-01T09:45:00.000Z', paid_at: '2026-09-01T09:00:00.000Z' }),
      // Split ₹200 cash + ₹280 UPI, settled inside the window.
      order({ id: 'o3', order_number: 1003, total_inr: 480, payment_method: 'upi', created_at: '2026-09-01T11:00:00.000Z', paid_at: '2026-09-01T11:05:00.000Z' }),
      // Single-tender UPI and card: information only.
      order({ id: 'o4', order_number: 1004, total_inr: 350, payment_method: 'upi', paid_at: '2026-09-01T12:00:00.000Z' }),
      order({ id: 'o5', order_number: 1005, total_inr: 120, payment_method: 'card', paid_at: '2026-09-01T12:30:00.000Z' }),
    );
    tables.order_payments.push(
      { id: 'p1', order_id: 'o3', method: 'cash', amount_inr: 200, created_at: '2026-09-01T11:05:00.000Z' },
      { id: 'p2', order_id: 'o3', method: 'upi', amount_inr: 280, created_at: '2026-09-01T11:05:00.000Z' },
    );
    tables.refunds.push(
      { id: 'r1', status: 'processed', method: 'cash', amount_inr: 50, processed_at: '2026-09-01T13:00:00.000Z' },
      { id: 'r2', status: 'processed', method: 'upi', amount_inr: 70, processed_at: '2026-09-01T13:00:00.000Z' },
    );
    tables.cash_movements.push(
      { id: 'm1', direction: 'out', amount_inr: 300, reason: 'milk', recorded_by: 'mgr-1', created_at: '2026-09-01T14:00:00.000Z' },
      { id: 'm2', direction: 'in', amount_inr: 100, reason: 'top-up', recorded_by: 'mgr-1', created_at: '2026-09-01T14:30:00.000Z' },
      // Before the day opened: yesterday's handover, not part of this day.
      { id: 'm0', direction: 'out', amount_inr: 5000, reason: 'Day close handover', recorded_by: 'mgr-1', created_at: '2026-09-01T08:00:00.000Z' },
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.open_summary).toMatchObject({
      opening_total_inr: 1500,
      cash_sales_inr: 600, // 400 + 200 (split cash part); o2 excluded
      cash_sales_count: 2,
      cash_refunds_inr: 50, // the UPI reversal is not drawer cash
      cash_in_inr: 100,
      cash_out_inr: 300,
      upi_inr: 630, // 280 split part + 350
      card_inr: 120,
      expected_cash_inr: 1500 + 600 - 50 + 100 - 300,
    });
    expect(body.cash_sales).toEqual([
      { order_id: 'o1', order_number: 1001, at: '2026-09-01T10:00:00.000Z', amount_inr: 400 },
      { order_id: 'o3', order_number: 1003, at: '2026-09-01T11:05:00.000Z', amount_inr: 200 },
    ]);
  });

  it('lists unpaid orders since opening; cancelled/rejected and older ones do not count', async () => {
    tables.cash_days.push(dayRow());
    tables.orders.push(
      order({ id: 'u1', order_number: 2001, payment_status: 'unpaid', status: 'received', total_inr: 200, created_at: '2026-09-01T11:00:00.000Z' }),
      order({ id: 'u2', order_number: 2002, payment_status: 'unpaid', status: 'completed', total_inr: 300, created_at: '2026-09-01T12:00:00.000Z' }),
      order({ id: 'u3', order_number: 2003, payment_status: 'unpaid', status: 'cancelled', total_inr: 300, created_at: '2026-09-01T12:00:00.000Z' }),
      order({ id: 'u4', order_number: 2004, payment_status: 'unpaid', status: 'rejected', total_inr: 300, created_at: '2026-09-01T12:00:00.000Z' }),
      order({ id: 'u5', order_number: 2005, payment_status: 'unpaid', status: 'received', total_inr: 300, created_at: '2026-08-31T12:00:00.000Z' }),
      order({ id: 'u6', order_number: 2006, payment_status: 'paid', status: 'received', total_inr: 300, created_at: '2026-09-01T12:00:00.000Z' }),
    );
    const body = await (await GET()).json();
    expect(body.unpaid.count).toBe(2);
    expect(body.unpaid.orders.map((o: { id: string }) => o.id)).toEqual(['u1', 'u2']);
  });

  it('returns a null open day + no summary when the drawer is closed', async () => {
    const body = await (await GET()).json();
    expect(body.open_day).toBeNull();
    expect(body.open_summary).toBeNull();
    expect(body.float_left).toBeNull();
    expect(body.reopenable_day).toBeNull();
  });
});

describe('GET /api/cash-days — after a close', () => {
  const closedDay = (over: Row = {}) =>
    dayRow({
      status: 'closed',
      closed_at: '2026-09-01T18:00:00.000Z',
      counted_total_inr: 5000,
      float_left_denoms: { '500': 3 },
      float_left_total_inr: 1500,
      handover_inr: 3500,
      ...over,
    });

  it('exposes the float left at the last close for the open form', async () => {
    tables.cash_days.push(closedDay());
    const body = await (await GET()).json();
    expect(body.float_left).toMatchObject({ denoms: { '500': 3 }, total_inr: 1500, business_date: '2026-09-01' });
  });

  it('has no float to compare with after a day closed before the handover feature', async () => {
    tables.cash_days.push(closedDay({ float_left_denoms: null, float_left_total_inr: null, handover_inr: null }));
    expect((await (await GET()).json()).float_left).toBeNull();
  });

  it('offers a reopen of the latest closed day to a manager only', async () => {
    tables.cash_days.push(closedDay());
    expect((await (await GET()).json()).reopenable_day).toBeNull(); // staff
    auth.role = 'manager';
    expect((await (await GET()).json()).reopenable_day).toMatchObject({ id: 'cd-1' });
  });
});

describe('POST /api/cash-days — open', () => {
  it('computes opening_total server-side, ignores a client total, and stamps the day at open time', async () => {
    const res = await POST(
      jsonReq('POST', { opening_denoms: { '500': 4, '100': 10, '10': 5 }, opening_total_inr: 999999 }),
    );
    expect(res.status).toBe(200);
    const day = tables.cash_days[0];
    expect(day.opening_total_inr).toBe(3050); // NOT the client's 999999
    expect(day.status).toBe('open');
    expect(day.opened_by).toBe('staff-1');
    expect(day.business_date).toBe('2026-09-02'); // IST date at open time (NOW = 5:30 pm IST)
    expect(day.open_expected_total_inr).toBeNull(); // nothing to compare with yet
    expect(day.open_variance_inr).toBeNull();
    // ... and the opening count is on the drawer chain.
    expect(tables.cash_counts.map((c) => c.kind)).toEqual(['day_open']);
  });

  it('403s without the cash_day_open permission', async () => {
    auth.perms.cash_day_open = false;
    expect((await POST(jsonReq('POST', { opening_denoms: { '500': 1 } }))).status).toBe(403);
    expect(tables.cash_days).toHaveLength(0);
  });

  it('409s a second open while a day is already open', async () => {
    tables.cash_days.push(dayRow());
    expect((await POST(jsonReq('POST', { opening_denoms: { '500': 1 } }))).status).toBe(409);
    expect(tables.cash_days).toHaveLength(1);
  });

  describe('against the float left at the last close', () => {
    beforeEach(() => {
      tables.cash_days.push(
        dayRow({
          status: 'closed',
          closed_at: '2026-09-01T18:00:00.000Z',
          float_left_denoms: { '500': 2, '100': 5 },
          float_left_total_inr: 1500,
        }),
      );
    });

    it('a matching float opens without a reason', async () => {
      const res = await POST(jsonReq('POST', { opening_denoms: { '500': 2, '100': 5 } }));
      expect(res.status).toBe(200);
      const day = tables.cash_days[1];
      expect(day.open_expected_total_inr).toBe(1500);
      expect(day.open_variance_inr).toBe(0);
      expect(day.open_reason).toBe('');
    });

    it('any difference needs a reason; with one it is stored', async () => {
      const short = { opening_denoms: { '500': 2, '100': 3 } }; // 1300 vs 1500
      const res = await POST(jsonReq('POST', short));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/reason/i);
      expect(tables.cash_days).toHaveLength(1);

      const ok = await POST(jsonReq('POST', { ...short, open_reason: 'took ₹200 for milk' }));
      expect(ok.status).toBe(200);
      const day = tables.cash_days[1];
      expect(day.open_variance_inr).toBe(-200);
      expect(day.open_expected_total_inr).toBe(1500);
      expect(day.open_reason).toBe('took ₹200 for milk');
    });
  });
});

describe('PATCH /api/cash-days — close + handover', () => {
  // Float 1500, cash sales 3000 (one single-tender cash order paid in the window).
  beforeEach(() => {
    tables.cash_days.push(dayRow());
    tables.orders.push(order({ id: 'o1', order_number: 1001, total_inr: 3000, paid_at: '2026-09-01T12:00:00.000Z' }));
  });

  const closeBody = (over: Row = {}) => ({
    closing_denoms: { '500': 9 }, // 4500 = 1500 + 3000
    float_left_denoms: { '500': 3 }, // 1500
    ...over,
  });

  it('computes counted / expected / variance / handover server-side and freezes the day’s figures', async () => {
    tables.cash_movements.push(
      { id: 'm1', direction: 'out', amount_inr: 300, reason: 'milk', recorded_by: 'mgr-1', created_at: '2026-09-01T14:00:00.000Z' },
    );
    // Counted 4200 = expected (1500 + 3000 − 300).
    const res = await PATCH(
      jsonReq('PATCH', {
        closing_denoms: { '500': 8, '100': 2 },
        float_left_denoms: { '500': 3 },
        counted_total_inr: 999999, // ignored
        handover_inr: 1, // ignored
      }),
    );
    expect(res.status).toBe(200);
    const day = tables.cash_days[0];
    expect(day).toMatchObject({
      status: 'closed',
      closed_by: 'staff-1',
      counted_total_inr: 4200,
      expected_cash_inr: 4200,
      over_short_inr: 0,
      cash_sales_inr: 3000,
      cash_sales_count: 1,
      cash_refunds_inr: 0,
      cash_in_inr: 0,
      cash_out_inr: 300,
      handover_inr: 2700, // counted − float left, computed
      float_left_total_inr: 1500,
      float_left_denoms: sanitizeDenoms({ '500': 3 }),
      unpaid_count_at_close: 0,
      unpaid_override_reason: null,
    });
    const body = await res.json();
    expect(body.summary).toMatchObject({ handover_inr: 2700, float_left_total_inr: 1500, expected_cash_inr: 4200 });
    expect(body.handover_warning).toBeNull();
  });

  it('requires the float left by denomination (never defaults to "take everything")', async () => {
    const res = await PATCH(jsonReq('PATCH', { closing_denoms: { '500': 9 } }));
    expect(res.status).toBe(400);
    expect(tables.cash_days[0].status).toBe('open');
  });

  it('403s without cash_day_close; 404s when nothing is open', async () => {
    auth.perms.cash_day_close = false;
    expect((await PATCH(jsonReq('PATCH', closeBody()))).status).toBe(403);
    auth.perms.cash_day_close = true;
    tables.cash_days.length = 0;
    expect((await PATCH(jsonReq('PATCH', closeBody()))).status).toBe(404);
  });

  it('a variance needs a reason, which is stored', async () => {
    const short = closeBody({ closing_denoms: { '500': 8 }, float_left_denoms: { '500': 3 } }); // 4000 vs 4500
    const res = await PATCH(jsonReq('PATCH', short));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('REASON_REQUIRED');
    expect(tables.cash_days[0].status).toBe('open');

    const ok = await PATCH(jsonReq('PATCH', { ...short, close_reason: 'two ₹200 notes stuck together' }));
    expect(ok.status).toBe(200);
    expect(tables.cash_days[0]).toMatchObject({
      over_short_inr: -500,
      close_reason: 'two ₹200 notes stuck together',
    });
  });

  it('counted ₹0 while cash is expected needs an explicit confirmation (the production accident)', async () => {
    const zero = { closing_denoms: {}, float_left_denoms: {}, close_reason: 'closed in a hurry' };
    const res = await PATCH(jsonReq('PATCH', zero));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ZERO_COUNT_UNCONFIRMED');
    expect(tables.cash_days[0].status).toBe('open');

    const ok = await PATCH(jsonReq('PATCH', { ...zero, confirm_zero_count: true }));
    expect(ok.status).toBe(200);
    expect(tables.cash_days[0]).toMatchObject({ counted_total_inr: 0, handover_inr: 0, over_short_inr: -4500 });
  });

  it('rejects a float left that exceeds what was counted, per denomination', async () => {
    const res = await PATCH(
      jsonReq('PATCH', closeBody({ float_left_denoms: { '500': 3, '100': 1 }, closing_denoms: { '500': 9 } })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('FLOAT_EXCEEDS_COUNT');
    expect(tables.cash_days[0].status).toBe('open');
  });

  describe('unpaid orders', () => {
    beforeEach(() => {
      tables.orders.push(
        order({ id: 'u1', order_number: 3001, payment_status: 'unpaid', status: 'received', total_inr: 200, created_at: '2026-09-01T13:00:00.000Z' }),
        order({ id: 'u2', order_number: 3002, payment_status: 'unpaid', status: 'cancelled', total_inr: 200, created_at: '2026-09-01T13:00:00.000Z' }),
      );
    });

    it('block the close with a 409 and the count', async () => {
      const res = await PATCH(jsonReq('PATCH', closeBody()));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'UNPAID_ORDERS', unpaid_count: 1 });
      expect(tables.cash_days[0].status).toBe('open');
      expect(tables.cash_movements).toHaveLength(0);
    });

    it('a plain staffer cannot override', async () => {
      const res = await PATCH(jsonReq('PATCH', closeBody({ unpaid_override_reason: 'customer walked out' })));
      expect(res.status).toBe(403);
      expect(tables.cash_days[0].status).toBe('open');
    });

    it('a manager overrides with a reason, which is stored with the count', async () => {
      auth.role = 'manager';
      const res = await PATCH(jsonReq('PATCH', closeBody({ unpaid_override_reason: 'customer walked out' })));
      expect(res.status).toBe(200);
      expect(tables.cash_days[0]).toMatchObject({
        status: 'closed',
        unpaid_count_at_close: 1,
        unpaid_override_reason: 'customer walked out',
      });
    });

    it('a manager still needs a real reason', async () => {
      auth.role = 'owner';
      const res = await PATCH(jsonReq('PATCH', closeBody({ unpaid_override_reason: 'ok' })));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('UNPAID_OVERRIDE_REASON');
    });
  });

  it('409s a close that lost the status race (already closed)', async () => {
    // Another request closes the day between our read and our guarded update.
    const realFrom = fake.from.bind(fake);
    let armed = true;
    (fake as { from: typeof fake.from }).from = (table: string) => {
      const chain = realFrom(table) as Record<string, unknown>;
      if (table === 'cash_days' && armed) {
        const update = chain.update as (p: Row) => unknown;
        chain.update = (p: Row) => {
          if (p.status === 'closed') tables.cash_days[0].status = 'closed';
          armed = false;
          return update(p);
        };
      }
      return chain as ReturnType<typeof fake.from>;
    };
    expect((await PATCH(jsonReq('PATCH', closeBody()))).status).toBe(409);
  });
});

describe('the handover and the drawer checkpoint chain', () => {
  it('writes the handover as a cash-out AFTER the day_close checkpoint, so the next count ties out', async () => {
    auth.role = 'manager';
    // 1. Open with a ₹1,500 float.
    expect((await POST(jsonReq('POST', { opening_denoms: { '500': 3 } }))).status).toBe(200);

    // 2. Three hours later ₹3,000 of cash sales come in.
    fake.advance(3 * 60 * 60 * 1000);
    tables.orders.push(order({ id: 'o1', order_number: 1, total_inr: 3000, paid_at: fake.now() }));
    fake.advance(1000);

    // 3. Close: ₹4,500 counted, ₹1,500 stays, ₹3,000 goes to the owner.
    const res = await PATCH(jsonReq('PATCH', { closing_denoms: { '500': 9 }, float_left_denoms: { '500': 3 } }));
    expect(res.status).toBe(200);
    expect(tables.cash_days[0]).toMatchObject({ handover_inr: 3000, float_left_total_inr: 1500 });

    const closeCp = tables.cash_counts.find((c) => c.kind === 'day_close')!;
    expect(closeCp.counted_total_inr).toBe(4500); // the FULL drawer, before the handover
    expect(closeCp.variance_inr).toBe(0);

    const handover = tables.cash_movements.find((m) => String(m.reason).startsWith('Day close handover'))!;
    expect(handover).toMatchObject({ direction: 'out', amount_inr: 3000, recorded_by: 'staff-1' });
    // Strictly later than the checkpoint, so it falls in the NEXT window, never this day's own.
    expect(String(handover.created_at) > String(closeCp.created_at)).toBe(true);
    expect(tables.cash_days[0].cash_out_inr).toBe(0); // this day's own cash-out excludes its handover

    // 4. Next morning's count of the ₹1,500 float is NOT a ₹3,000 shortage.
    fake.advance(14 * 60 * 60 * 1000);
    const next = await recordCount(admin, { kind: 'manual', userId: 'staff-1', denoms: { '500': 3 } });
    expect(next.expectedTotalInr).toBe(1500);
    expect(next.varianceInr).toBe(0);
    expect(next.shortageInr).toBe(0);
    expect(tables.cash_shortages).toHaveLength(0);
  });

  it('records no cash-out when nothing was taken', async () => {
    tables.cash_days.push(dayRow());
    tables.orders.push(order({ id: 'o1', order_number: 1, total_inr: 3000, paid_at: '2026-09-01T12:00:00.000Z' }));
    const res = await PATCH(jsonReq('PATCH', { closing_denoms: { '500': 9 }, float_left_denoms: { '500': 9 } }));
    expect(res.status).toBe(200);
    expect(tables.cash_movements).toHaveLength(0);
    expect(tables.cash_days[0].handover_inr).toBe(0);
  });

  it('tells the closer when the handover cash-out could not be recorded', async () => {
    tables.cash_days.push(dayRow());
    tables.orders.push(order({ id: 'o1', order_number: 1, total_inr: 3000, paid_at: '2026-09-01T12:00:00.000Z' }));
    const realFrom = fake.from.bind(fake);
    (fake as { from: typeof fake.from }).from = (table: string) => {
      const chain = realFrom(table) as Record<string, unknown>;
      if (table === 'cash_movements') {
        const insert = chain.insert as (p: Row) => Record<string, unknown>;
        chain.insert = (p: Row) => {
          const c = insert(p);
          c.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'boom' } });
          return c;
        };
      }
      return chain as ReturnType<typeof fake.from>;
    };
    const body = await (
      await PATCH(jsonReq('PATCH', { closing_denoms: { '500': 9 }, float_left_denoms: { '500': 3 } }))
    ).json();
    expect(tables.cash_days[0].status).toBe('closed');
    expect(body.handover_warning).toMatch(/₹3000/);
  });
});

describe('POST /api/cash-days/reopen', () => {
  const closed = (over: Row = {}) =>
    dayRow({
      status: 'closed',
      closed_by: 'staff-1',
      closed_at: '2026-09-01T18:00:00.000Z',
      counted_total_inr: 0,
      handover_inr: 0,
      float_left_total_inr: 0,
      float_left_denoms: {},
      cash_sales_inr: 0,
      ...over,
    });

  it('reopens the most recent closed day with a reason, keeping the close it undid in the log', async () => {
    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    tables.cash_days.push(closed());
    const res = await REOPEN(jsonReq('POST', { id: 'cd-1', reason: 'closed with ₹0 by mistake' }));
    expect(res.status).toBe(200);
    expect(tables.cash_days[0]).toMatchObject({
      status: 'open',
      closed_at: null,
      closed_by: null,
      counted_total_inr: 0,
      float_left_total_inr: null,
      reopened_by: 'mgr-1',
      reopen_reason: 'closed with ₹0 by mistake',
    });
    const log = tables.cash_days[0].reopen_log as { by: string; reason: string; prev_closed_at: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ by: 'mgr-1', reason: 'closed with ₹0 by mistake', prev_closed_at: '2026-09-01T18:00:00.000Z' });
  });

  it('needs a real reason', async () => {
    auth.role = 'manager';
    tables.cash_days.push(closed());
    expect((await REOPEN(jsonReq('POST', { reason: 'no' }))).status).toBe(400);
    expect(tables.cash_days[0].status).toBe('closed');
  });

  it('refuses when a day is already open (a newer day exists)', async () => {
    auth.role = 'manager';
    tables.cash_days.push(closed({ opened_at: '2026-08-31T09:30:00.000Z' }), dayRow({ id: 'cd-2', opened_at: OPENED }));
    const res = await REOPEN(jsonReq('POST', { reason: 'closed by mistake' }));
    expect(res.status).toBe(409);
  });

  it('refuses an older day when a newer closed one exists', async () => {
    auth.role = 'owner';
    tables.cash_days.push(
      closed({ id: 'cd-old', opened_at: '2026-08-31T09:30:00.000Z' }),
      closed({ id: 'cd-new', opened_at: OPENED }),
    );
    expect((await REOPEN(jsonReq('POST', { id: 'cd-old', reason: 'closed by mistake' }))).status).toBe(409);
    expect((await REOPEN(jsonReq('POST', { id: 'cd-new', reason: 'closed by mistake' }))).status).toBe(200);
  });

  it('appends to the log on a second reopen', async () => {
    auth.role = 'manager';
    tables.cash_days.push(closed({ reopen_log: [{ at: 'x', by: 'mgr-1', reason: 'first', prev_closed_at: null, prev_counted_inr: 0, prev_handover_inr: 0 }] }));
    await REOPEN(jsonReq('POST', { reason: 'closed by mistake again' }));
    expect(tables.cash_days[0].reopen_log as unknown[]).toHaveLength(2);
  });

  it('404s when there is no day at all', async () => {
    auth.role = 'manager';
    expect((await REOPEN(jsonReq('POST', { reason: 'closed by mistake' }))).status).toBe(404);
  });
});

describe('GET /api/cash-days/log (owner page)', () => {
  it('returns each day with staff names, the handover and the reopen events; the open day gets live figures', async () => {
    auth.role = 'owner';
    tables.cash_days.push(
      dayRow({
        id: 'cd-old',
        status: 'closed',
        opened_at: '2026-08-31T09:30:00.000Z',
        closed_by: 'mgr-1',
        closed_at: '2026-08-31T18:00:00.000Z',
        counted_total_inr: 5000,
        handover_inr: 3500,
        float_left_total_inr: 1500,
        reopen_log: [{ at: '2026-08-31T18:30:00.000Z', by: 'mgr-1', reason: 'mistake', prev_closed_at: null, prev_counted_inr: 0, prev_handover_inr: 0 }],
      }),
      dayRow({ id: 'cd-open' }),
    );
    tables.orders.push(order({ id: 'o1', order_number: 1, total_inr: 400, paid_at: '2026-09-01T12:00:00.000Z' }));

    const res = await LOG(new Request('http://t/api/cash-days/log'));
    expect(res.status).toBe(200);
    const { days } = await res.json();
    expect(days.map((d: { id: string }) => d.id)).toEqual(['cd-open', 'cd-old']); // newest first

    const [open, old] = days;
    expect(open).toMatchObject({ live: true, opened_by_name: 'Priya', cash_sales_inr: 400, expected_cash_inr: 1900 });
    expect(old).toMatchObject({ live: false, closed_by_name: 'Meera', handover_inr: 3500, float_left_total_inr: 1500 });
    expect(old.reopen_log[0]).toMatchObject({ by_name: 'Meera', reason: 'mistake' });
  });
});
