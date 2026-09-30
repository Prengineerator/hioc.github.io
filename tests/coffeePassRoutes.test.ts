import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';
import { makePassAdmin, type Call, type DbError, type Row } from './helpers/passAdmin';

// Handler-level tests for the customer and counter HIOC Ritual routes
// (docs/COFFEE-PASS-SPEC.md §7):
//   GET  /api/passes/plans          public
//   GET  /api/passes/mine           signed-in customer
//   POST /api/passes/checkout       signed-in customer, Razorpay
//   GET  /api/passes/holder         counter actor
//   POST /api/passes/sell           counter actor, pass_sell, canTakeOrders, Idempotency-Key
//   POST /api/passes/[id]/adjust    counter actor, pass_manage
//
// What they guard: the flag (404 while off), each route's gate (401 / 403),
// validation before anything is written, the rows a sale really creates, that a
// failed payment intent takes the order back out, idempotent replays, and that the
// counter's holder lookup never returns a user id. The Supabase admin client is an
// in-memory fake (tests/helpers/passAdmin.ts) that runs the routes' real filter
// chains; auth, permissions, the rate limiter, the gateway and the store settings
// are mocked, as in tests/cashExpenses.test.ts.

const CUSTOMER = '00000000-0000-4000-8000-000000000001';
const STAFF = '00000000-0000-4000-8000-000000000002';
const ACCOUNT = '00000000-0000-4000-8000-000000000003';
const OTHER = '00000000-0000-4000-8000-000000000004';
const PLAN_ID = '00000000-0000-4000-8000-0000000000a1';
const MONTHLY_ID = '00000000-0000-4000-8000-0000000000a2';
const INACTIVE_ID = '00000000-0000-4000-8000-0000000000a3';
const PASS_ID = '00000000-0000-4000-8000-0000000000b1';
const PHONE = '+919876543210';
const KEY = 'key-abcdefgh-0001';

type Actor = { user: { id: string }; role: string; via: string };

const state: {
  flag: boolean;
  user: { id: string; email?: string | null } | null;
  actor: Actor | null;
  perms: Record<string, boolean>;
  permCalls: unknown[][];
  surface: 'pos' | 'web';
  settings: StoreSettings;
  rateOk: boolean;
  rateCalls: [string, number, number][];
  gatewayConfigured: boolean;
  intent: Row | null;
  intentCalls: [string, number][];
  counterCustomer: { userId: string; name: string; created: boolean } | null;
  counterCalls: unknown[][];
  rpcResult: { data: unknown; error: DbError };
  admin: ReturnType<typeof makePassAdmin>;
} = {
  flag: true,
  user: null,
  actor: null,
  perms: {},
  permCalls: [],
  surface: 'pos',
  settings: FALLBACK_STORE_SETTINGS,
  rateOk: true,
  rateCalls: [],
  gatewayConfigured: true,
  intent: null,
  intentCalls: [],
  counterCustomer: null,
  counterCalls: [],
  rpcResult: { data: 'ok', error: null },
  admin: makePassAdmin({}),
};

vi.mock('@/lib/flags', () => ({
  flags: new Proxy({}, { get: (_t, key) => (key === 'coffeePass' ? state.flag : true) }),
}));
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => state.admin,
}));
vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>();
  return {
    ...actual,
    getAuthUser: () => Promise.resolve(state.user),
    getCounterActor: () => Promise.resolve(state.actor),
  };
});
vi.mock('@/lib/permissions', () => ({
  hasPermission: (...args: unknown[]) => {
    state.permCalls.push(args);
    return Promise.resolve(state.perms[args[1] as string] ?? false);
  },
}));
vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: (key: string, max: number, windowSecs: number) => {
    state.rateCalls.push([key, max, windowSecs]);
    return Promise.resolve(state.rateOk);
  },
}));
vi.mock('@/lib/payments/gateway', () => ({
  isGatewayConfigured: () => state.gatewayConfigured,
  createPaymentIntent: (orderId: string, amount: number) => {
    state.intentCalls.push([orderId, amount]);
    return Promise.resolve(state.intent);
  },
}));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve(state.surface) }));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve(state.settings) }));
vi.mock('@/lib/loyalty/customerLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loyalty/customerLink')>();
  return {
    ...actual,
    createCounterCustomer: (...args: unknown[]) => {
      state.counterCalls.push(args);
      return Promise.resolve(state.counterCustomer);
    },
  };
});

const plansRoute = await import('@/app/api/passes/plans/route');
const mineRoute = await import('@/app/api/passes/mine/route');
const checkoutRoute = await import('@/app/api/passes/checkout/route');
const holderRoute = await import('@/app/api/passes/holder/route');
const sellRoute = await import('@/app/api/passes/sell/route');
const adjustRoute = await import('@/app/api/passes/[id]/adjust/route');
const { loadPassSummaryById } = await import('@/lib/passes/server');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plan(over: Row = {}): Row {
  return {
    id: PLAN_ID,
    name: 'Weekly Ritual',
    description: '7 cups for the price of 5',
    drinks_total: 7,
    drinks_paid: 5,
    validity_days: 7,
    drink_value_inr: 150,
    price_inr: 750,
    max_per_day: null,
    gst_exempt: false,
    is_active: true,
    sort_order: 10,
    ...over,
  };
}

/** A v_coffee_pass_balances row (the view is just a table to the fake). */
function balance(over: Row = {}): Row {
  return {
    id: PASS_ID,
    user_id: ACCOUNT,
    plan_id: PLAN_ID,
    plan_name: 'Weekly Ritual',
    drinks_total: 7,
    drinks_used: 2,
    drinks_credited: 0,
    drinks_remaining: 5,
    drink_value_inr: 150,
    max_per_day: null,
    used_today: 0,
    price_inr: 750,
    starts_at: '2026-10-05T04:30:00.000Z',
    expires_at: '2099-01-01T18:30:00.000Z',
    status: 'active',
    state: 'active',
    order_id: 'order-sale-1',
    created_at: '2026-10-05T04:30:00.000Z',
    ...over,
  };
}

let orderSeq = 0;
function freshAdmin(tables: Record<string, Row[]>, extraFail?: (c: Call) => DbError) {
  state.admin = makePassAdmin(tables, {
    defaults: (table) => (table === 'orders' ? { order_number: 700 + ++orderSeq, version: 0 } : {}),
    // The idempotency_keys primary key: a second insert of a key is a 23505.
    fail: (c) => {
      if (c.table === 'idempotency_keys' && c.op === 'insert') {
        const key = (c.payload as Row).key;
        if ((tables.idempotency_keys ?? []).some((r) => r.key === key)) return { code: '23505', message: 'duplicate key' };
      }
      return extraFail?.(c) ?? null;
    },
    rpc: () => state.rpcResult,
  });
  return state.admin;
}

const jsonRequest = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

const asCustomer = (over: Partial<NonNullable<typeof state.user>> = {}) => {
  state.user = { id: CUSTOMER, email: 'asha@example.com', ...over };
};
const asStaff = (role = 'staff') => {
  state.actor = { user: { id: STAFF }, role, via: 'session' };
};

beforeEach(() => {
  state.flag = true;
  state.user = null;
  state.actor = null;
  state.perms = {};
  state.permCalls = [];
  state.surface = 'pos';
  state.settings = { ...FALLBACK_STORE_SETTINGS };
  state.rateOk = true;
  state.rateCalls = [];
  state.gatewayConfigured = true;
  state.intent = { gateway: 'razorpay', gatewayOrderId: 'order_rzp_1', amountInr: 788, keyId: 'rzp_test_key' };
  state.intentCalls = [];
  state.counterCustomer = null;
  state.counterCalls = [];
  state.rpcResult = { data: 'ok', error: null };
  freshAdmin({});
});

// ---------------------------------------------------------------------------
// Every route: 404 while the flag is off, 401 without a session
// ---------------------------------------------------------------------------

describe('the flag', () => {
  const calls: [string, () => Promise<Response>][] = [
    ['GET /api/passes/plans', () => plansRoute.GET()],
    ['GET /api/passes/mine', () => mineRoute.GET()],
    ['POST /api/passes/checkout', () => checkoutRoute.POST(jsonRequest('POST', '/api/passes/checkout', { plan_id: PLAN_ID }))],
    ['GET /api/passes/holder', () => holderRoute.GET(jsonRequest('GET', `/api/passes/holder?phone=${PHONE}`))],
    ['POST /api/passes/sell', () => sellRoute.POST(jsonRequest('POST', '/api/passes/sell', {}, { 'idempotency-key': KEY }))],
    ['POST /api/passes/[id]/adjust', () => adjustRoute.POST(jsonRequest('POST', `/api/passes/${PASS_ID}/adjust`, {}), { params: { id: PASS_ID } })],
  ];

  it.each(calls)('%s answers 404 while the flag is off, before any auth or database work', async (_name, call) => {
    state.flag = false;
    // Signed in with every right, so only the flag can be what refuses it.
    asCustomer();
    asStaff('owner');
    state.perms = { pass_sell: true, pass_manage: true };
    const res = await call();
    expect(res.status).toBe(404);
    expect(state.admin.calls).toEqual([]);
    expect(state.permCalls).toEqual([]);
    expect(state.rateCalls).toEqual([]);
  });
});

describe('sign-in', () => {
  it('GET /api/passes/mine and POST /api/passes/checkout need a session (401)', async () => {
    expect((await mineRoute.GET()).status).toBe(401);
    expect((await checkoutRoute.POST(jsonRequest('POST', '/api/passes/checkout', { plan_id: PLAN_ID }))).status).toBe(401);
    expect(state.admin.calls).toEqual([]);
    expect(state.rateCalls).toEqual([]);
  });

  it('the counter routes need a counter actor (401)', async () => {
    asCustomer(); // a customer session is not a counter actor
    expect((await holderRoute.GET(jsonRequest('GET', `/api/passes/holder?phone=${PHONE}`))).status).toBe(401);
    expect((await sellRoute.POST(jsonRequest('POST', '/api/passes/sell', {}, { 'idempotency-key': KEY }))).status).toBe(401);
    expect((await adjustRoute.POST(jsonRequest('POST', `/api/passes/${PASS_ID}/adjust`, {}), { params: { id: PASS_ID } })).status).toBe(401);
    expect(state.admin.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/passes/plans
// ---------------------------------------------------------------------------

describe('GET /api/passes/plans', () => {
  const tables = () => ({
    coffee_pass_plans: [
      plan({ id: MONTHLY_ID, name: 'Monthly Ritual', price_inr: 900, validity_days: 30, drinks_paid: 6, sort_order: 20 }),
      plan(),
      plan({ id: '00000000-0000-4000-8000-0000000000a4', name: 'Mini Ritual', price_inr: 300, drinks_total: 3, drinks_paid: 2 }),
      plan({ id: INACTIVE_ID, name: 'Secret Ritual', is_active: false, sort_order: 1 }),
    ],
    menu_items: [
      { id: 'm-3', name: 'Cold Brew', category: 'cold-brews', is_available: true, sort_order: 1, pass_eligible: true },
      { id: 'm-2', name: 'Latte', category: 'coffee', is_available: false, sort_order: 2, pass_eligible: true },
      { id: 'm-1', name: 'Cappuccino', category: 'coffee', is_available: true, sort_order: 1, pass_eligible: true },
      { id: 'm-4', name: 'Croissant', category: 'bakes', is_available: true, sort_order: 1, pass_eligible: false },
    ],
  });

  it('is public: no session needed', async () => {
    freshAdmin(tables());
    expect(state.user).toBeNull();
    expect(state.actor).toBeNull();
    const res = await plansRoute.GET();
    expect(res.status).toBe(200);
  });

  it('returns the active plans by sort_order then price, and never an inactive one', async () => {
    freshAdmin(tables());
    const body = await (await plansRoute.GET()).json();
    expect(body.plans.map((p: Row) => p.name)).toEqual(['Mini Ritual', 'Weekly Ritual', 'Monthly Ritual']);
    // The plan is the app's CoffeePassPlan shape.
    expect(body.plans[1]).toEqual({
      id: PLAN_ID,
      name: 'Weekly Ritual',
      description: '7 cups for the price of 5',
      drinks_total: 7,
      drinks_paid: 5,
      validity_days: 7,
      drink_value_inr: 150,
      price_inr: 750,
      max_per_day: null,
      gst_exempt: false,
      is_active: true,
      sort_order: 10,
    });
  });

  it('lists only the eligible drinks, by category then the menu order, with availability', async () => {
    freshAdmin(tables());
    const body = await (await plansRoute.GET()).json();
    expect(body.eligible).toEqual([
      { id: 'm-1', name: 'Cappuccino', category: 'coffee', is_available: true },
      { id: 'm-2', name: 'Latte', category: 'coffee', is_available: false },
      { id: 'm-3', name: 'Cold Brew', category: 'cold-brews', is_available: true },
    ]);
  });

  it('says whether online purchase is possible, from the gateway module', async () => {
    freshAdmin(tables());
    state.gatewayConfigured = true;
    expect((await (await plansRoute.GET()).json()).online_purchase).toBe(true);
    state.gatewayConfigured = false;
    expect((await (await plansRoute.GET()).json()).online_purchase).toBe(false);
  });

  it("carries the store's GST setting", async () => {
    freshAdmin(tables());
    state.settings = { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, gst_inclusive: false };
    expect((await (await plansRoute.GET()).json()).gst).toEqual({ percent: 5, inclusive: false });
    state.settings = { ...FALLBACK_STORE_SETTINGS, gst_percent: 18, gst_inclusive: true };
    expect((await (await plansRoute.GET()).json()).gst).toEqual({ percent: 18, inclusive: true });
  });

  it('is empty, not an error, when nothing is on sale', async () => {
    freshAdmin({ coffee_pass_plans: [plan({ is_active: false })], menu_items: [] });
    const body = await (await plansRoute.GET()).json();
    expect(body).toMatchObject({ plans: [], eligible: [] });
  });

  it('answers 500 with the migration hint when the eligibility column is missing', async () => {
    freshAdmin(tables(), (c) => (c.table === 'menu_items' ? { code: '42703', message: 'column menu_items.pass_eligible does not exist' } : null));
    const res = await plansRoute.GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('2026-10-coffee-pass.sql');
  });
});

// ---------------------------------------------------------------------------
// GET /api/passes/mine
// ---------------------------------------------------------------------------

describe('GET /api/passes/mine', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  it("returns the caller's passes with history, phone_verified and pending purchases", async () => {
    asCustomer();
    freshAdmin({
      v_coffee_pass_balances: [
        balance({ id: 'p-active', user_id: CUSTOMER, drinks_remaining: 5 }),
        balance({ id: 'p-other', user_id: OTHER }), // someone else's pass
      ],
      coffee_pass_redemptions: [
        { pass_id: 'p-active', order_id: 'o-1', drinks: 1, covered_inr: 120, created_at: '2026-10-06T06:00:00.000Z', reversed_at: null },
        { pass_id: 'p-active', order_id: 'o-2', drinks: 1, covered_inr: 150, created_at: '2026-10-07T06:00:00.000Z', reversed_at: '2026-10-07T07:00:00.000Z' },
      ],
      orders: [
        { id: 'o-1', order_number: 41 },
        { id: 'o-2', order_number: 42 },
        // A purchase still waiting on the gateway, 10 minutes ago.
        { id: 'o-pending', order_number: 43, order_kind: 'coffee_pass', user_id: CUSTOMER, status: 'placed', payment_status: 'payment_pending', total_inr: 788, created_at: minutesAgo(10) },
      ],
      order_items: [{ order_id: 'o-pending', name_snapshot: 'Weekly Ritual' }],
      profiles: [{ id: CUSTOMER, phone_verified: true }],
    });

    const res = await mineRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.passes).toHaveLength(1);
    expect(body.passes[0]).toMatchObject({ id: 'p-active', drinks_remaining: 5, state: 'active', plan_name: 'Weekly Ritual' });
    expect(body.passes[0].history).toEqual([
      { order_id: 'o-2', order_number: 42, drinks: 1, covered_inr: 150, created_at: '2026-10-07T06:00:00.000Z', reversed: true },
      { order_id: 'o-1', order_number: 41, drinks: 1, covered_inr: 120, created_at: '2026-10-06T06:00:00.000Z', reversed: false },
    ]);
    expect(body.phone_verified).toBe(true);
    expect(body.pending).toEqual([
      { order_id: 'o-pending', order_number: 43, plan_name: 'Weekly Ritual', total_inr: 788, created_at: expect.any(String) },
    ]);
    // The account is the session's: no user id in the response.
    expect(JSON.stringify(body)).not.toContain(CUSTOMER);
  });

  it('shows every active pass plus only the last 10 of the others, active ones first', async () => {
    asCustomer();
    const others = Array.from({ length: 12 }, (_, i) =>
      balance({
        id: `old-${i}`,
        user_id: CUSTOMER,
        state: 'expired',
        drinks_remaining: 0,
        created_at: `2026-09-${String(10 + i).padStart(2, '0')}T04:30:00.000Z`,
      }),
    );
    freshAdmin({
      v_coffee_pass_balances: [...others, balance({ id: 'live-2', user_id: CUSTOMER, expires_at: '2099-02-01T18:30:00.000Z' }), balance({ id: 'live-1', user_id: CUSTOMER })],
    });
    const body = await (await mineRoute.GET()).json();
    const ids = body.passes.map((p: Row) => p.id);
    expect(ids.slice(0, 2)).toEqual(['live-1', 'live-2']); // soonest-expiring first
    expect(ids).toHaveLength(12);
    expect(ids[2]).toBe('old-11'); // newest of the others first
    expect(ids).not.toContain('old-0');
  });

  it('lists only recent, still-processing pass purchases of this customer', async () => {
    asCustomer();
    const sale = (over: Row) => ({
      order_kind: 'coffee_pass', user_id: CUSTOMER, status: 'placed', payment_status: 'payment_pending', total_inr: 788, order_number: 1, created_at: minutesAgo(5), ...over,
    });
    freshAdmin({
      orders: [
        sale({ id: 'ok' }),
        sale({ id: 'old', created_at: minutesAgo(90) }),
        sale({ id: 'theirs', user_id: OTHER }),
        sale({ id: 'paid', payment_status: 'paid', status: 'completed' }),
        sale({ id: 'menu', order_kind: 'menu' }),
        sale({ id: 'received', status: 'received' }),
      ],
      profiles: [{ id: CUSTOMER, phone_verified: false }],
    });
    const body = await (await mineRoute.GET()).json();
    expect(body.pending.map((p: Row) => p.order_id)).toEqual(['ok']);
    expect(body.phone_verified).toBe(false);
    expect(body.passes).toEqual([]);
  });

  it('still answers when the purchases read fails: the passes matter more', async () => {
    asCustomer();
    freshAdmin(
      { v_coffee_pass_balances: [balance({ user_id: CUSTOMER })] },
      (c) => (c.table === 'orders' ? { message: 'orders down' } : null),
    );
    const res = await mineRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.passes).toHaveLength(1);
    expect(body.pending).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/passes/checkout
// ---------------------------------------------------------------------------

describe('POST /api/passes/checkout', () => {
  const setup = (profile: Row | null = { id: CUSTOMER, name: 'Asha', phone: PHONE, phone_verified: true }) => {
    asCustomer();
    return freshAdmin({
      coffee_pass_plans: [plan(), plan({ id: INACTIVE_ID, name: 'Secret Ritual', is_active: false })],
      profiles: profile ? [profile] : [],
    });
  };
  const checkout = (body: unknown = { plan_id: PLAN_ID }) =>
    checkoutRoute.POST(jsonRequest('POST', '/api/passes/checkout', body));

  it('creates the sale order and the Razorpay intent, and returns what the payment window needs', async () => {
    const admin = setup();
    const res = await checkout();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      order_id: 'orders-1',
      order_number: expect.any(Number),
      total_inr: 788, // 750 + 5% GST
      payment: { gateway: 'razorpay', gatewayOrderId: 'order_rzp_1', amountInr: 788, keyId: 'rzp_test_key' },
    });
    expect(state.intentCalls).toEqual([['orders-1', 788]]);

    // The order: a coffee_pass sale, on the website, awaiting payment, owned by the session.
    expect(admin.tables.orders).toHaveLength(1);
    expect(admin.tables.orders[0]).toMatchObject({
      order_kind: 'coffee_pass',
      channel: 'customer_web',
      status: 'placed',
      payment_status: 'payment_pending',
      payment_method: 'online',
      user_id: CUSTOMER,
      customer_user_id: CUSTOMER,
      created_by: null,
      customer_name: 'Asha',
      customer_phone: PHONE,
      subtotal_inr: 750,
      tax_inr: 38,
      packaging_inr: 0,
      discount_inr: 0,
      total_inr: 788,
    });
    // ...with its one line, naming the plan.
    expect(admin.tables.order_items).toEqual([
      expect.objectContaining({
        order_id: 'orders-1',
        menu_item_id: null,
        name_snapshot: 'Weekly Ritual',
        variant_label_snapshot: '7 cups · 7 days',
        price_inr_snapshot: 750,
        quantity: 1,
        line_total_inr: 750,
        coffee_pass_plan_id: PLAN_ID,
      }),
    ]);
  });

  it('is limited to 10 attempts in 10 minutes per account (429), creating nothing', async () => {
    const admin = setup();
    state.rateOk = false;
    const res = await checkout();
    expect(res.status).toBe(429);
    expect(state.rateCalls).toEqual([[`pass-checkout:${CUSTOMER}`, 10, 600]]);
    expect(admin.tables.orders ?? []).toEqual([]);
  });

  it('rejects a body that is not JSON, and a plan_id that is not an id (400)', async () => {
    setup();
    expect((await checkoutRoute.POST(jsonRequest('POST', '/api/passes/checkout', '{oops'))).status).toBe(400);
    expect((await checkout({})).status).toBe(400);
    expect((await checkout({ plan_id: 'weekly' })).status).toBe(400);
    expect((await checkout({ plan_id: 42 })).status).toBe(400);
  });

  it('answers 404 for an inactive or unknown plan, and never says which exists', async () => {
    const admin = setup();
    expect((await checkout({ plan_id: INACTIVE_ID })).status).toBe(404);
    expect((await checkout({ plan_id: '00000000-0000-4000-8000-0000000000ff' })).status).toBe(404);
    expect(admin.tables.orders ?? []).toEqual([]);
  });

  it('asks for a mobile number when the profile has none (400): the order needs one', async () => {
    const admin = setup({ id: CUSTOMER, name: 'Asha', phone: '', phone_verified: false });
    const res = await checkout();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Add your mobile number in your profile first');
    expect(admin.tables.orders ?? []).toEqual([]);
    // Also when there is no profile row at all, or the number is not a valid Indian mobile.
    freshAdmin({ coffee_pass_plans: [plan()], profiles: [] });
    expect((await checkout()).status).toBe(400);
    freshAdmin({ coffee_pass_plans: [plan()], profiles: [{ id: CUSTOMER, name: 'Asha', phone: '12345' }] });
    expect((await checkout()).status).toBe(400);
  });

  it('takes an unverified number too: verification is for using the pass at the counter, not for buying', async () => {
    const admin = setup({ id: CUSTOMER, name: 'Asha', phone: '9876543210', phone_verified: false });
    expect((await checkout()).status).toBe(201);
    // Stored form, however the profile spelled it.
    expect(admin.tables.orders[0].customer_phone).toBe(PHONE);
  });

  it('names the customer from the profile, else the part of the email before @, else "Customer"', async () => {
    let admin = setup({ id: CUSTOMER, name: '  Asha K  ', phone: PHONE });
    await checkout();
    expect(admin.tables.orders[0].customer_name).toBe('Asha K');

    admin = setup({ id: CUSTOMER, name: '', phone: PHONE });
    await checkout();
    expect(admin.tables.orders[0].customer_name).toBe('asha');

    admin = setup({ id: CUSTOMER, name: '', phone: PHONE });
    state.user = { id: CUSTOMER, email: null };
    await checkout();
    expect(admin.tables.orders[0].customer_name).toBe('Customer');
  });

  it('answers 503 before creating anything when the server has no Razorpay keys', async () => {
    const admin = setup();
    state.gatewayConfigured = false;
    const res = await checkout();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(
      "Online purchase isn't available right now — buy your HIOC Ritual at the counter.",
    );
    expect(admin.tables.orders ?? []).toEqual([]);
    expect(state.intentCalls).toEqual([]);
  });

  it('deletes the order it made and answers 503 when the gateway call fails', async () => {
    const admin = setup();
    state.intent = null;
    const res = await checkout();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Online purchase isn't available right now");
    expect(state.intentCalls).toHaveLength(1); // it did try
    expect(admin.tables.orders).toEqual([]); // ...and took the order back out
    expect(admin.calls.some((c) => c.table === 'orders' && c.op === 'delete')).toBe(true);
  });

  it('answers 500 (and names the migration) when the order cannot be created on an old schema', async () => {
    setup();
    freshAdmin(
      { coffee_pass_plans: [plan()], profiles: [{ id: CUSTOMER, name: 'Asha', phone: PHONE }] },
      (c) => (c.table === 'orders' && c.op === 'insert' ? { code: '42703', message: 'column "order_kind" of relation "orders" does not exist' } : null),
    );
    const res = await checkout();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('2026-10-coffee-pass.sql');
    expect(state.intentCalls).toEqual([]);
  });

  it('charges a GST-exempt plan its price with no tax', async () => {
    asCustomer();
    const admin = freshAdmin({
      coffee_pass_plans: [plan({ gst_exempt: true })],
      profiles: [{ id: CUSTOMER, name: 'Asha', phone: PHONE }],
    });
    state.intent = { gateway: 'razorpay', gatewayOrderId: 'order_rzp_2', amountInr: 750, keyId: 'k' };
    const body = await (await checkout()).json();
    expect(body.total_inr).toBe(750);
    expect(admin.tables.orders[0]).toMatchObject({ tax_inr: 0, total_inr: 750 });
    expect(admin.tables.order_items[0]).toMatchObject({ gst_exempt: true });
  });
});

// ---------------------------------------------------------------------------
// GET /api/passes/holder
// ---------------------------------------------------------------------------

describe('GET /api/passes/holder', () => {
  const holder = (phone = '9876543210') => holderRoute.GET(jsonRequest('GET', `/api/passes/holder?phone=${encodeURIComponent(phone)}`));
  const account = { id: ACCOUNT, name: 'Asha K', phone: PHONE, phone_verified: true };

  it('rejects a missing or invalid phone (400) before spending any of the lookup budget', async () => {
    asStaff();
    freshAdmin({});
    expect((await holderRoute.GET(jsonRequest('GET', '/api/passes/holder'))).status).toBe(400);
    expect((await holder('12345')).status).toBe(400);
    expect((await holder('abcdefghij')).status).toBe(400);
    expect(state.rateCalls).toEqual([]);
    expect(state.admin.calls).toEqual([]);
  });

  it('is limited to 120 lookups in 10 minutes per staffer, the same budget as customer lookup (429)', async () => {
    asStaff();
    freshAdmin({});
    state.rateOk = false;
    expect((await holder()).status).toBe(429);
    expect(state.rateCalls).toEqual([[`customer-lookup:${STAFF}`, 120, 600]]);
    expect(state.admin.calls).toEqual([]);
  });

  it('says { found: false } when no verified account holds the number', async () => {
    asStaff();
    freshAdmin({
      // An unverified claim on the number does not count: it could be a typo or a stranger.
      profiles: [{ id: OTHER, name: 'Someone', phone: PHONE, phone_verified: false }],
    });
    const res = await holder();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: false });
  });

  it('returns the name, the passes with history and the unpaid sales', async () => {
    asStaff();
    freshAdmin({
      profiles: [account],
      v_coffee_pass_balances: [balance({ id: 'p-live', user_id: ACCOUNT })],
      coffee_pass_redemptions: [
        { pass_id: 'p-live', order_id: 'o-1', drinks: 2, covered_inr: 270, created_at: '2026-10-06T06:00:00.000Z', reversed_at: null },
      ],
      orders: [
        { id: 'o-1', order_number: 41 },
        { id: 'sale-1', order_number: 50, order_kind: 'coffee_pass', payment_status: 'unpaid', status: 'accepted', customer_user_id: ACCOUNT, customer_phone: PHONE, total_inr: 788, created_at: '2026-10-08T06:00:00.000Z' },
      ],
      order_items: [{ order_id: 'sale-1', name_snapshot: 'Weekly Ritual' }],
    });
    const res = await holder();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.name).toBe('Asha K');
    expect(body.passes).toHaveLength(1);
    expect(body.passes[0]).toMatchObject({ id: 'p-live', drinks_remaining: 5, state: 'active' });
    expect(body.passes[0].history).toEqual([
      { order_id: 'o-1', order_number: 41, drinks: 2, covered_inr: 270, created_at: '2026-10-06T06:00:00.000Z', reversed: false },
    ]);
    expect(body.unpaid_sales).toEqual([
      { order_id: 'sale-1', order_number: 50, plan_name: 'Weekly Ritual', total_inr: 788, created_at: '2026-10-08T06:00:00.000Z' },
    ]);
  });

  it('never returns a user id: not the account’s, and not as a field name', async () => {
    asStaff();
    freshAdmin({
      profiles: [account],
      v_coffee_pass_balances: [balance({ user_id: ACCOUNT })],
      orders: [
        { id: 'sale-1', order_number: 50, order_kind: 'coffee_pass', payment_status: 'unpaid', status: 'accepted', customer_user_id: ACCOUNT, user_id: ACCOUNT, customer_phone: PHONE, total_inr: 788, created_at: '2026-10-08T06:00:00.000Z' },
      ],
      order_items: [{ order_id: 'sale-1', name_snapshot: 'Weekly Ritual' }],
    });
    const text = JSON.stringify(await (await holder()).json());
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('email');
  });

  it('lists the unpaid pass sales for the account OR the phone, and nothing else', async () => {
    asStaff();
    const sale = (over: Row) => ({
      order_number: 1, order_kind: 'coffee_pass', payment_status: 'unpaid', status: 'accepted', customer_user_id: null, user_id: null,
      customer_phone: '+910000000000', total_inr: 788, created_at: '2026-10-08T06:00:00.000Z', ...over,
    });
    freshAdmin({
      profiles: [account],
      orders: [
        sale({ id: 'by-account', customer_user_id: ACCOUNT, created_at: '2026-10-08T06:00:00.000Z' }),
        sale({ id: 'by-phone', customer_phone: PHONE, created_at: '2026-10-09T06:00:00.000Z' }),
        sale({ id: 'by-bare-phone', customer_phone: '9876543210', created_at: '2026-10-10T06:00:00.000Z' }),
        sale({ id: 'by-session', user_id: ACCOUNT, created_at: '2026-10-11T06:00:00.000Z' }),
        sale({ id: 'paid', customer_user_id: ACCOUNT, payment_status: 'paid', status: 'completed' }),
        sale({ id: 'pending-online', customer_user_id: ACCOUNT, payment_status: 'payment_pending', status: 'placed' }),
        sale({ id: 'cancelled', customer_user_id: ACCOUNT, status: 'cancelled' }),
        sale({ id: 'rejected', customer_user_id: ACCOUNT, status: 'rejected' }),
        sale({ id: 'menu-order', customer_user_id: ACCOUNT, order_kind: 'menu' }),
        sale({ id: 'someone-else', customer_user_id: OTHER, customer_phone: '+911111111111' }),
      ],
      order_items: ['by-account', 'by-phone', 'by-bare-phone', 'by-session'].map((id) => ({ order_id: id, name_snapshot: 'Weekly Ritual' })),
    });
    const body = await (await holder()).json();
    expect(body.unpaid_sales.map((s: Row) => s.order_id)).toEqual(['by-account', 'by-phone', 'by-bare-phone', 'by-session']);
  });

  it('shows the usable passes first, then only the last 5 others', async () => {
    asStaff();
    const others = Array.from({ length: 8 }, (_, i) =>
      balance({ id: `old-${i}`, user_id: ACCOUNT, state: 'used_up', drinks_remaining: 0, created_at: `2026-09-${String(10 + i).padStart(2, '0')}T04:30:00.000Z` }),
    );
    freshAdmin({ profiles: [account], v_coffee_pass_balances: [...others, balance({ id: 'live', user_id: ACCOUNT })] });
    const body = await (await holder()).json();
    const ids = body.passes.map((p: Row) => p.id);
    expect(ids).toEqual(['live', 'old-7', 'old-6', 'old-5', 'old-4', 'old-3']);
  });

  it('still shows the passes when the unpaid list cannot be read', async () => {
    asStaff();
    freshAdmin(
      { profiles: [account], v_coffee_pass_balances: [balance({ user_id: ACCOUNT })] },
      (c) => (c.table === 'orders' ? { message: 'orders down' } : null),
    );
    const body = await (await holder()).json();
    expect(body.passes).toHaveLength(1);
    expect(body.unpaid_sales).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/passes/sell
// ---------------------------------------------------------------------------

describe('POST /api/passes/sell', () => {
  const sellBody = (over: Row = {}) => ({ plan_id: PLAN_ID, customer_phone: '98765 43210', customer_name: ' Asha ', ...over });
  const sell = (body: unknown = sellBody(), headers: Record<string, string> = { 'idempotency-key': KEY }) =>
    sellRoute.POST(jsonRequest('POST', '/api/passes/sell', body, headers));
  const setup = (extra: Record<string, Row[]> = {}, extraFail?: (c: Call) => DbError) => {
    asStaff();
    state.perms = { pass_sell: true };
    return freshAdmin(
      {
        coffee_pass_plans: [plan(), plan({ id: INACTIVE_ID, name: 'Secret Ritual', is_active: false })],
        profiles: [{ id: ACCOUNT, name: 'Asha K', phone: PHONE, phone_verified: true }],
        ...extra,
      },
      extraFail,
    );
  };

  describe('gates', () => {
    it('needs the pass_sell permission (403), checked with the actor’s own role', async () => {
      const admin = setup();
      state.perms = { pass_sell: false };
      state.actor = { user: { id: STAFF }, role: 'staff', via: 'device' };
      const res = await sell();
      expect(res.status).toBe(403);
      expect(state.permCalls).toEqual([[{ id: STAFF }, 'pass_sell', 'staff']]);
      expect(admin.tables.orders ?? []).toEqual([]);
    });

    it('refuses on the staff website unless web ordering is on: "Sell HIOC Ritual from the counter" (403)', async () => {
      const admin = setup();
      state.surface = 'web';
      state.settings = { ...FALLBACK_STORE_SETTINGS, staff_web_ordering: false };
      const res = await sell();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('Sell HIOC Ritual from the counter');
      expect(admin.tables.orders ?? []).toEqual([]);
    });

    it('sells on the staff website when the owner has switched web ordering on', async () => {
      setup();
      state.surface = 'web';
      state.settings = { ...FALLBACK_STORE_SETTINGS, staff_web_ordering: true };
      expect((await sell()).status).toBe(201);
    });

    it('sells at the POS whatever the web-ordering switch says', async () => {
      setup();
      state.surface = 'pos';
      state.settings = { ...FALLBACK_STORE_SETTINGS, staff_web_ordering: false };
      expect((await sell()).status).toBe(201);
    });
  });

  describe('validation', () => {
    it('requires an Idempotency-Key header (400)', async () => {
      const admin = setup();
      const res = await sell(sellBody(), {});
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Idempotency-Key');
      expect((await sell(sellBody(), { 'idempotency-key': 'short' })).status).toBe(400); // under 8 characters
      expect(admin.tables.orders ?? []).toEqual([]);
      expect(admin.tables.idempotency_keys ?? []).toEqual([]);
    });

    it('rejects a body that is not JSON, and a plan_id that is not an id (400)', async () => {
      setup();
      expect((await sell('{oops')).status).toBe(400);
      expect((await sell(sellBody({ plan_id: undefined }))).status).toBe(400);
      expect((await sell(sellBody({ plan_id: 'weekly' }))).status).toBe(400);
    });

    it('rejects a missing or invalid phone (400)', async () => {
      setup();
      expect((await sell(sellBody({ customer_phone: undefined }))).status).toBe(400);
      expect((await sell(sellBody({ customer_phone: '12345' }))).status).toBe(400);
      expect((await sell(sellBody({ customer_phone: 9876543210 }))).status).toBe(400); // a number, not text
    });

    it('rejects an empty, blank, over-long or non-text name (400); 60 characters is fine', async () => {
      setup();
      expect((await sell(sellBody({ customer_name: '' }))).status).toBe(400);
      expect((await sell(sellBody({ customer_name: '   ' }))).status).toBe(400);
      expect((await sell(sellBody({ customer_name: 'x'.repeat(61) }))).status).toBe(400);
      expect((await sell(sellBody({ customer_name: 7 }))).status).toBe(400);
      expect((await sell(sellBody({ customer_name: 'x'.repeat(60) }), { 'idempotency-key': 'key-abcdefgh-0002' })).status).toBe(201);
    });

    it('answers 404 for an inactive or unknown plan, without burning the key', async () => {
      const admin = setup();
      expect((await sell(sellBody({ plan_id: INACTIVE_ID }))).status).toBe(404);
      expect((await sell(sellBody({ plan_id: '00000000-0000-4000-8000-0000000000ff' }))).status).toBe(404);
      expect(admin.tables.idempotency_keys ?? []).toEqual([]);
      expect(admin.tables.orders ?? []).toEqual([]);
    });
  });

  describe('the sale', () => {
    it('creates an unpaid coffee_pass order for the verified account and returns it for the payment panel', async () => {
      const admin = setup();
      const res = await sell();
      expect(res.status).toBe(201);
      const body = await res.json();

      expect(admin.tables.orders).toHaveLength(1);
      expect(admin.tables.orders[0]).toMatchObject({
        order_kind: 'coffee_pass',
        channel: 'staff_pos',
        status: 'accepted',
        payment_status: 'unpaid',
        payment_method: null,
        created_by: STAFF,
        user_id: null,
        customer_user_id: ACCOUNT, // derived from the phone, never from the body
        customer_name: 'Asha', // trimmed
        customer_phone: PHONE, // stored form
        subtotal_inr: 750,
        tax_inr: 38,
        packaging_inr: 0,
        total_inr: 788,
      });
      expect(admin.tables.order_items).toEqual([
        expect.objectContaining({ menu_item_id: null, name_snapshot: 'Weekly Ritual', quantity: 1, line_total_inr: 750, coffee_pass_plan_id: PLAN_ID }),
      ]);
      expect(admin.tables.order_status_events).toEqual([
        expect.objectContaining({ to_status: 'accepted', actor_id: STAFF, actor_role: 'staff' }),
      ]);

      // The response is the order as POST /api/orders returns it (items, not order_items).
      expect(body.order).toMatchObject({
        id: 'orders-1',
        order_kind: 'coffee_pass',
        payment_status: 'unpaid',
        total_inr: 788,
        items: [expect.objectContaining({ name_snapshot: 'Weekly Ritual', coffee_pass_plan_id: PLAN_ID, addons: [] })],
      });
      expect(body.order).not.toHaveProperty('order_items');
      expect(body.customer).toEqual({ name: 'Asha K', created: false });
      expect(body).not.toHaveProperty('replayed');
      // The counter is not asked to open an account for a number that has one.
      expect(state.counterCalls).toEqual([]);
    });

    it('takes no payment and issues nothing itself: the pass is the database’s to issue once paid', async () => {
      const admin = setup();
      await sell();
      expect(admin.tables.coffee_passes ?? []).toEqual([]);
      expect(admin.tables.order_payments ?? []).toEqual([]);
      expect(admin.tables.payments ?? []).toEqual([]);
    });

    it('opens an account for a number that has none and says so', async () => {
      const admin = setup({ profiles: [] });
      state.counterCustomer = { userId: OTHER, name: 'Asha', created: true };
      const res = await sell();
      expect(res.status).toBe(201);
      expect((await res.json()).customer).toEqual({ name: 'Asha', created: true });
      expect(state.counterCalls).toEqual([[admin, PHONE, { name: 'Asha', staffUserId: STAFF }]]);
      expect(admin.tables.orders[0]).toMatchObject({ customer_user_id: OTHER });
    });

    it('adopts an existing unverified login for the number without calling it new', async () => {
      setup({ profiles: [] });
      state.counterCustomer = { userId: OTHER, name: 'Asha', created: false };
      expect((await (await sell()).json()).customer).toEqual({ name: 'Asha', created: false });
    });

    it('refuses (409) when no account can be linked or opened, creates nothing and frees the key', async () => {
      const admin = setup({ profiles: [] });
      state.counterCustomer = null;
      const res = await sell();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("Couldn't open an account for this number — check it and try again.");
      expect(admin.tables.orders ?? []).toEqual([]);
      expect(admin.tables.order_items ?? []).toEqual([]);
      // Released, so the staffer's retry (after fixing the number) is not a "duplicate".
      expect(admin.tables.idempotency_keys ?? []).toEqual([]);
      state.counterCustomer = { userId: OTHER, name: 'Asha', created: true };
      expect((await sell()).status).toBe(201);
    });

    it('does not take the number of a non-verified holder as an account', async () => {
      const admin = setup({ profiles: [{ id: OTHER, name: 'Stranger', phone: PHONE, phone_verified: false }] });
      state.counterCustomer = null;
      expect((await sell()).status).toBe(409);
      expect(admin.tables.orders ?? []).toEqual([]);
    });

    it('answers 500, creates no order and frees the key when the order cannot be written', async () => {
      const admin = setup({}, (c) => (c.table === 'order_items' && c.op === 'insert' ? { message: 'boom' } : null));
      const res = await sell();
      expect(res.status).toBe(500);
      expect(admin.tables.orders).toEqual([]);
      expect(admin.tables.idempotency_keys ?? []).toEqual([]);
    });

    it('names the migration when the database predates it', async () => {
      setup({}, (c) => (c.table === 'orders' && c.op === 'insert' ? { code: '42703', message: 'column "order_kind" does not exist' } : null));
      const res = await sell();
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain('2026-10-coffee-pass.sql');
    });
  });

  describe('idempotency', () => {
    it('claims the key and points it at the sale', async () => {
      const admin = setup();
      await sell();
      expect(admin.tables.idempotency_keys).toEqual([expect.objectContaining({ key: KEY, order_id: 'orders-1', created_by: STAFF })]);
    });

    it('replays the same key as the FIRST sale (201, replayed: true), never a second order', async () => {
      const admin = setup();
      const first = await (await sell()).json();
      const second = await sell();
      expect(second.status).toBe(201);
      const replay = await second.json();
      expect(replay.replayed).toBe(true);
      expect(replay.order.id).toBe(first.order.id);
      expect(replay.order.items).toHaveLength(1);
      expect(admin.tables.orders).toHaveLength(1);
      expect(admin.tables.order_items).toHaveLength(1);
    });

    it('rejects the same key while the first request is still being made (409 in flight)', async () => {
      const admin = setup({ idempotency_keys: [{ key: KEY, order_id: null, created_by: STAFF }] });
      const res = await sell();
      expect(res.status).toBe(409);
      expect(admin.tables.orders ?? []).toEqual([]);
    });

    it('treats a different key as a different sale', async () => {
      const admin = setup();
      await sell();
      await sell(sellBody(), { 'idempotency-key': 'key-abcdefgh-0002' });
      expect(admin.tables.orders).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/passes/[id]/adjust
// ---------------------------------------------------------------------------

describe('POST /api/passes/[id]/adjust', () => {
  const adjust = (body: unknown, id = PASS_ID) =>
    adjustRoute.POST(jsonRequest('POST', `/api/passes/${id}/adjust`, body), { params: { id } });
  const setup = () => {
    asStaff('manager');
    state.perms = { pass_manage: true };
    return freshAdmin({ v_coffee_pass_balances: [balance({ user_id: ACCOUNT, drinks_remaining: 6, drinks_credited: 1 })] });
  };

  it('needs the pass_manage permission (403), checked with the actor’s own role', async () => {
    const admin = setup();
    state.perms = { pass_manage: false };
    asStaff('staff');
    const res = await adjust({ kind: 'extend', days: 3, reason: 'Was away' });
    expect(res.status).toBe(403);
    expect(state.permCalls).toEqual([[{ id: STAFF }, 'pass_manage', 'staff']]);
    expect(admin.rpcCalls).toEqual([]);
  });

  it('answers 404 for an id that is not a pass id', async () => {
    const admin = setup();
    expect((await adjust({ kind: 'extend', days: 3, reason: 'Was away' }, 'not-an-id')).status).toBe(404);
    expect(admin.rpcCalls).toEqual([]);
  });

  it('rejects a bad body before calling the database (400)', async () => {
    const admin = setup();
    expect((await adjustRoute.POST(jsonRequest('POST', `/api/passes/${PASS_ID}/adjust`, '{oops'), { params: { id: PASS_ID } })).status).toBe(400);
    for (const body of [
      {},
      { kind: 'extend', days: 3 }, // no reason
      { kind: 'extend', days: 3, reason: 'ab' }, // reason too short
      { kind: 'extend', days: 0, reason: 'Was away' },
      { kind: 'extend', days: 61, reason: 'Was away' },
      { kind: 'extend', days: 2.5, reason: 'Was away' },
      { kind: 'credit', drinks: 0, reason: 'Spilt coffee' },
      { kind: 'credit', reason: 'Spilt coffee' },
      { kind: 'refund', days: 3, reason: 'Was away' },
    ]) {
      expect((await adjust(body)).status).toBe(400);
    }
    expect(admin.rpcCalls).toEqual([]);
  });

  it('extends a pass and returns it with its balance', async () => {
    const admin = setup();
    const res = await adjust({ kind: 'extend', days: 3, reason: '  Was away  ' });
    expect(res.status).toBe(200);
    expect(admin.rpcCalls).toEqual([
      {
        name: 'coffee_pass_adjust',
        args: { p_pass_id: PASS_ID, p_kind: 'extend', p_days: 3, p_drinks: null, p_reason: 'Was away', p_actor: STAFF },
      },
    ]);
    const body = await res.json();
    expect(body.pass).toMatchObject({ id: PASS_ID, drinks_remaining: 6, drinks_credited: 1, state: 'active' });
    expect(JSON.stringify(body)).not.toContain(ACCOUNT);
  });

  it('gives cups back', async () => {
    const admin = setup();
    const res = await adjust({ kind: 'credit', drinks: 2, reason: 'Spilt coffee' });
    expect(res.status).toBe(200);
    expect(admin.rpcCalls[0].args).toEqual({
      p_pass_id: PASS_ID, p_kind: 'credit', p_days: null, p_drinks: 2, p_reason: 'Spilt coffee', p_actor: STAFF,
    });
  });

  it.each([
    ['bad_input', 400],
    ['not_found', 404],
    ['inactive', 409],
    ['error', 500],
  ])("maps the database's %s to %i", async (code, status) => {
    setup();
    state.rpcResult = code === 'error' ? { data: null, error: { message: 'db down' } } : { data: code, error: null };
    const res = await adjust({ kind: 'extend', days: 3, reason: 'Was away' });
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.error).toEqual(expect.any(String));
    expect(body).not.toHaveProperty('pass');
    if (code === 'inactive') expect(body.error).toBe("This HIOC Ritual isn't active");
  });

  it('answers 500 rather than an empty pass if the change was saved but the pass cannot be reloaded', async () => {
    freshAdmin({ v_coffee_pass_balances: [] });
    asStaff('manager');
    state.perms = { pass_manage: true };
    const res = await adjust({ kind: 'extend', days: 3, reason: 'Was away' });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// lib/passes/server.ts loadPassSummaryById (added for the adjust route)
// ---------------------------------------------------------------------------

describe('loadPassSummaryById', () => {
  it('reads one pass with its balance, whoever holds it, and never a user id', async () => {
    const admin = freshAdmin({
      v_coffee_pass_balances: [balance({ id: 'p-1', user_id: ACCOUNT, drinks_remaining: 4 }), balance({ id: 'p-2', user_id: OTHER })],
    });
    const pass = await loadPassSummaryById(admin as never, 'p-1');
    expect(pass).toMatchObject({ id: 'p-1', drinks_remaining: 4, state: 'active', plan_name: 'Weekly Ritual' });
    expect(pass).not.toHaveProperty('user_id');
  });

  it('is null for an unknown pass and for a failed read (never throws)', async () => {
    const admin = freshAdmin({ v_coffee_pass_balances: [balance({ id: 'p-1' })] });
    expect(await loadPassSummaryById(admin as never, 'nope')).toBeNull();
    const broken = freshAdmin({ v_coffee_pass_balances: [balance({ id: 'p-1' })] }, () => ({ message: 'db down' }));
    expect(await loadPassSummaryById(broken as never, 'p-1')).toBeNull();
  });
});
