import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';

// Checkout and quote release a signed-in customer's OWN earlier unpaid shop
// orders that still hold Beanies (lib/shop/lifecycle.ts releaseOwnPendingShopBeanies),
// so a retry after a failed or abandoned payment can use them at once. The real
// handlers, serverQuote and lifecycle run on an in-memory database; Razorpay's
// payment lookup, the capture step and the loyalty ledger are stubbed (the
// ledger keeps a real balance and held-per-order map so "freed" is observable).

const AGO = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

const state: {
  flags: { shop: boolean };
  admin: ReturnType<typeof makeFakeAdmin>;
  tables: Record<string, Row[]>;
  user: { id: string; email: string; email_confirmed_at: string | null } | null;
  balance: number;
  held: Map<string, number>;
  reversed: string[];
  captured: string[];
  attempts: Record<string, { id: string; status: string; method?: string; amount: number }[] | null | 'throw'>;
} = {
  flags: { shop: true },
  admin: makeFakeAdmin({}, { startMs: 0 }),
  tables: {},
  user: null,
  balance: 0,
  held: new Map(),
  reversed: [],
  captured: [],
  attempts: {},
};

vi.mock('@/lib/flags', () => ({ flags: state.flags }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => state.admin }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(true), clientIp: () => '203.0.113.9' }));
vi.mock('@/lib/api/auth', () => ({ getAuthUser: () => Promise.resolve(state.user) }));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(state.balance),
  getLoyaltyConfig: () => Promise.resolve({ points_per_inr: 0.1, inr_per_point: 1, min_redeem_points: 50 }),
  redeemForShopOrder: (id: string, _u: string, points: number) => {
    if (points > state.balance) return Promise.resolve('insufficient');
    state.balance -= points;
    state.held.set(id, points);
    return Promise.resolve('reserved');
  },
  reverseForShopOrder: (id: string) => {
    const n = state.held.get(id) ?? 0;
    if (!n) return Promise.resolve(0);
    state.held.delete(id);
    state.balance += n;
    state.reversed.push(id);
    return Promise.resolve(n);
  },
}));
vi.mock('@/lib/promotions/shopCoupons', () => ({
  findShopCoupon: () => Promise.resolve({ ok: false, reason: "That code isn't valid" }),
  loadAutoShopCoupons: () => Promise.resolve([]),
}));
vi.mock('@/lib/payments/gateway', () => ({
  isGatewayConfigured: () => true,
  createGatewayOrder: (amountInr: number) =>
    Promise.resolve({ gateway: 'razorpay', gatewayOrderId: 'order_NEW', amountInr, currency: 'INR', keyId: 'rzp_test_key' }),
  fetchOrderPaymentAttempts: (id: string) => {
    const a = state.attempts[id];
    if (a === 'throw') return Promise.reject(new Error('gateway down'));
    return Promise.resolve(id in state.attempts ? a : []);
  },
}));
vi.mock('@/lib/shop/payments', async (orig) => ({
  ...(await orig<typeof import('@/lib/shop/payments')>()),
  captureShopPayment: (p: { gatewayOrderId: string }) => {
    state.captured.push(p.gatewayOrderId);
    const o = state.tables.shop_orders.find((r) => r.razorpay_order_id === p.gatewayOrderId);
    if (o) o.status = 'paid';
    return Promise.resolve({ handled: true });
  },
}));

const { POST: checkout } = await import('@/app/api/shop/checkout/route');
const { POST: quote } = await import('@/app/api/shop/quote/route');
const { loadReleasablePendingOrders } = await import('@/lib/shop/beaniesRelease');

const ADDRESS = {
  customer_name: 'Riya Sharma',
  phone: '9876543210',
  email: 'riya@example.com',
  address_line1: '12, Rose Villa, MG Road',
  address_line2: '',
  city: 'Jaipur',
  state: 'Rajasthan',
  pincode: '302001',
};
const KEY = '3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69';
const ITEMS = [{ product_id: 'classic', quantity: 2 }];

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const checkoutReq = (headers: Record<string, string> = {}) => post('/api/shop/checkout', { items: ITEMS, address: ADDRESS }, headers);
const quoteReq = () => post('/api/shop/quote', { items: ITEMS });

/** An earlier unpaid order of user-1 holding `beanies`, `ageSec` old. */
function pendingOrder(id: string, beanies: number, ageSec: number, extra: Row = {}) {
  state.tables.shop_orders.push({
    id,
    status: 'payment_pending',
    user_id: 'user-1',
    beanies_redeemed: beanies,
    razorpay_order_id: `rzp_${id}`,
    created_at: AGO(ageSec),
    ...extra,
  });
  state.held.set(id, beanies);
}

beforeEach(() => {
  state.flags.shop = true;
  state.user = { id: 'user-1', email: 'riya@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
  state.balance = 20; // 380 of a 400 balance are held by the earlier order below
  state.held = new Map();
  state.reversed = [];
  state.captured = [];
  state.attempts = {};
  state.tables = {
    shop_products: [{ id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1 }],
    shop_orders: [],
    shop_settings: [],
    shop_intro_claims: [],
    orders: [{ id: 'cafe-1', user_id: 'user-1', payment_status: 'paid' }],
    customer_addresses: [],
  };
  state.admin = makeFakeAdmin(state.tables, {
    startMs: Date.now(),
    defaults: (table, row) => (table === 'shop_orders' ? { status: 'payment_pending', order_number: 2000 + state.tables.shop_orders.length + 1, ...row } : row),
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('checkout releases the customer\'s own earlier pending orders', () => {
  it('expires a stale pending order and reverses its Beanies before reserving', async () => {
    pendingOrder('old', 380, 600);
    state.attempts.rzp_old = [{ id: 'pay_1', status: 'failed', amount: 1 }];
    const res = await checkout(checkoutReq());
    expect(res.status).toBe(201);
    expect(state.tables.shop_orders.find((o) => o.id === 'old')).toMatchObject({ status: 'expired', cancel_reason: 'Payment not completed in time' });
    expect(state.reversed).toEqual(['old']);
    const fresh = state.tables.shop_orders.find((o) => o.id !== 'old')!;
    expect(Number(fresh.beanies_redeemed)).toBeGreaterThan(0); // no beanies_changed 409
    expect(state.held.get(fresh.id as string)).toBe(fresh.beanies_redeemed);
  });

  it('leaves another customer\'s order, a young order (< 60 s) and a non-pending order alone', async () => {
    pendingOrder('theirs', 100, 600, { user_id: 'user-2' });
    pendingOrder('young', 100, 30);
    pendingOrder('paid', 100, 600, { status: 'paid' });
    const res = await checkout(checkoutReq());
    expect(res.status).toBe(201);
    expect(state.reversed).toEqual([]);
    expect(state.tables.shop_orders.filter((o) => o.status === 'expired')).toHaveLength(0);
  });

  it('releases at most 5 orders, oldest first', async () => {
    for (let i = 0; i < 7; i++) pendingOrder(`o${i}`, 10, 1000 - i * 10);
    await checkout(checkoutReq());
    expect(state.reversed).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
  });

  it('does not release the order the current Idempotency-Key reuses (a repeat tap)', async () => {
    const first = await checkout(checkoutReq({ 'Idempotency-Key': KEY }));
    expect(first.status).toBe(201);
    const mine = state.tables.shop_orders[0];
    mine.created_at = AGO(600); // old enough to be releasable if it were not the reused one
    pendingOrder('other', 50, 600);
    state.attempts.rzp_other = [{ id: 'p', status: 'failed', amount: 1 }];
    const again = await checkout(checkoutReq({ 'Idempotency-Key': KEY }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ reused: true, order_id: mine.id });
    expect(mine.status).toBe('payment_pending');
    expect(state.reversed).not.toContain(mine.id);
  });

  it('the loader leaves out the order of the given Idempotency-Key', async () => {
    pendingOrder('keyed', 50, 600, { idempotency_key: KEY });
    pendingOrder('plain', 50, 600);
    const ids = (await loadReleasablePendingOrders(state.admin as never, 'user-1', { excludeIdempotencyKey: KEY })).map((o) => o.id);
    expect(ids).toEqual(['plain']);
  });

  it('recovers a captured payment as paid instead of releasing its Beanies', async () => {
    pendingOrder('paidInRzp', 380, 600);
    state.attempts.rzp_paidInRzp = [{ id: 'pay_9', status: 'captured', amount: 84700 }];
    const res = await checkout(checkoutReq());
    expect(res.status).toBe(201);
    expect(state.captured).toEqual(['rzp_paidInRzp']);
    expect(state.tables.shop_orders.find((o) => o.id === 'paidInRzp')!.status).toBe('paid');
    expect(state.reversed).toEqual([]);
    expect(state.held.get('paidInRzp')).toBe(380); // the reservation is kept
  });

  it('skips an authorized payment (it may still capture)', async () => {
    pendingOrder('auth', 380, 600);
    state.attempts.rzp_auth = [{ id: 'pay_a', status: 'authorized', amount: 1 }];
    await checkout(checkoutReq());
    expect(state.tables.shop_orders.find((o) => o.id === 'auth')!.status).toBe('payment_pending');
    expect(state.reversed).toEqual([]);
  });

  it('a failing release never fails checkout (the order goes through without those Beanies)', async () => {
    pendingOrder('old', 380, 600);
    state.attempts.rzp_old = 'throw';
    const res = await checkout(checkoutReq());
    expect(res.status).toBe(201);
    expect(state.tables.shop_orders.find((o) => o.id === 'old')!.status).toBe('payment_pending');
    const fresh = state.tables.shop_orders.find((o) => o.id !== 'old')!;
    expect(Number(fresh.beanies_redeemed)).toBe(0);
    expect(console.error).toHaveBeenCalled();
  });

  it('a guest releases nothing', async () => {
    state.user = null;
    pendingOrder('old', 380, 600);
    expect((await checkout(checkoutReq())).status).toBe(201);
    expect(state.reversed).toEqual([]);
  });
});

describe('quote counts releasable Beanies', () => {
  it('balance + Beanies held by the own releasable pending orders, writing nothing', async () => {
    pendingOrder('old', 380, 600);
    pendingOrder('young', 100, 30); // not releasable yet
    pendingOrder('theirs', 100, 600, { user_id: 'user-2' });
    const body = await (await quote(quoteReq())).json();
    expect(body.quote.beanies).toMatchObject({ state: 'applied' }); // 20 alone is under the 50 minimum
    expect(body.quote.beanies_redeemed).toBeGreaterThan(0);
    expect(state.tables.shop_orders.every((o) => o.status === 'payment_pending')).toBe(true);
    expect(state.reversed).toEqual([]);
  });

  it('without a releasable order the low balance shows no Beanies, and the quote matches what checkout then reserves', async () => {
    pendingOrder('young', 380, 30);
    const q = await (await quote(quoteReq())).json();
    expect(q.quote.beanies_redeemed).toBe(0);
    const res = await checkout(checkoutReq());
    expect(res.status).toBe(201);
    expect(Number(state.tables.shop_orders.find((o) => o.id !== 'young')!.beanies_redeemed)).toBe(q.quote.beanies_redeemed);
  });

  it('quote and checkout agree: the quoted Beanies are what checkout reserves, no 409', async () => {
    pendingOrder('old', 380, 600);
    state.attempts.rzp_old = [{ id: 'p', status: 'failed', amount: 1 }];
    const q = await (await quote(quoteReq())).json();
    const res = await checkout(post('/api/shop/checkout', { items: ITEMS, address: ADDRESS, expected_total_inr: q.quote.total_inr }));
    expect(res.status).toBe(201);
    expect(Number(state.tables.shop_orders.find((o) => o.id !== 'old')!.beanies_redeemed)).toBe(q.quote.beanies_redeemed);
  });
});
