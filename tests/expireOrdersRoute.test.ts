import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for GET and POST /api/cron/expire-orders. Mocks Supabase, the
// Razorpay lookup and the capture logic so the route's decision — recover a
// paid order, cancel an unpaid one, leave it alone when the gateway can't
// confirm — is exercised without network or DB.

const state: {
  stale: { id: string; version: number }[];
  paymentsByOrder: Record<string, { gateway_order_id: string }[]>;
  attemptsByGatewayOrder: Record<string, { id: string; status: string; amount: number }[] | null>;
  cancelled: string[];
  captured: string[];
  shopThrows: boolean;
  shopCalls: string[];
} = { stale: [], paymentsByOrder: {}, attemptsByGatewayOrder: {}, cancelled: [], captured: [], shopThrows: false, shopCalls: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: { orderId?: string; isUpdate: boolean } = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: () => {
          ctx.isUpdate = true;
          return chain;
        },
        insert: () => Promise.resolve({ error: null }),
        eq: (col: string, val: string) => {
          if (col === 'order_id' || (col === 'id' && ctx.isUpdate)) ctx.orderId = val;
          if (table === 'payments' && col === 'gateway') {
            return Promise.resolve({ data: state.paymentsByOrder[ctx.orderId!] ?? [], error: null });
          }
          return chain;
        },
        lt: () => Promise.resolve({ data: state.stale, error: null }),
        maybeSingle: () => {
          state.cancelled.push(ctx.orderId!);
          return Promise.resolve({ data: { id: ctx.orderId }, error: null });
        },
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/payments/gateway', () => ({
  fetchOrderPaymentAttempts: (gatewayOrderId: string) =>
    Promise.resolve(
      gatewayOrderId in state.attemptsByGatewayOrder ? state.attemptsByGatewayOrder[gatewayOrderId] : [],
    ),
}));
vi.mock('@/lib/payments/reconcile', () => ({
  captureGatewayPayment: (params: { gatewayOrderId: string }) => {
    state.captured.push(params.gatewayOrderId);
    return Promise.resolve({ ok: true, order: null });
  },
}));
vi.mock('@/lib/loyalty/ledger', () => ({ reverseForOrder: () => Promise.resolve() }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));

// The shop pass is covered in tests/shopLifecycle.test.ts; here only its wiring.
vi.mock('@/lib/shop/lifecycle', () => ({
  expireStaleShopOrders: () => {
    state.shopCalls.push('expire');
    if (state.shopThrows) return Promise.reject(new Error('shop down'));
    return Promise.resolve({ expired: 2, recovered: 1 });
  },
  sweepDeliveredShopOrders: () => {
    state.shopCalls.push('sweep');
    return Promise.resolve({ checked: 4, delivered: 3 });
  },
}));

process.env.CRON_SECRET = 'cron_secret';

// Imported after mocks are registered (vi.mock is hoisted).
const { GET, POST } = await import('@/app/api/cron/expire-orders/route');

const run = () =>
  GET(
    new Request('http://localhost/api/cron/expire-orders', {
      headers: { authorization: 'Bearer cron_secret' },
    }),
  );

// pg_cron's net.http_post issues a POST, not a GET — this is the method the
// scheduled job (supabase/2026-10-expire-orders-cron.sql) actually calls.
const runPost = (auth: string | null = 'Bearer cron_secret') =>
  POST(
    new Request('http://localhost/api/cron/expire-orders', {
      method: 'POST',
      headers: auth ? { authorization: auth } : {},
    }),
  );

beforeEach(() => {
  state.stale = [{ id: 'order-1', version: 1 }];
  state.paymentsByOrder = { 'order-1': [{ gateway_order_id: 'rzp_order_1' }] };
  state.attemptsByGatewayOrder = {};
  state.cancelled = [];
  state.captured = [];
  state.shopThrows = false;
  state.shopCalls = [];
});

describe('GET /api/cron/expire-orders', () => {
  it('recovers an order whose payment was captured instead of cancelling it', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [
      { id: 'pay_failed', status: 'failed', amount: 25000 },
      { id: 'pay_ok', status: 'captured', amount: 25000 },
    ];
    const res = await run();
    expect(await res.json()).toMatchObject({ expired: 0, recovered: 1 });
    expect(state.captured).toEqual(['rzp_order_1']);
    expect(state.cancelled).toEqual([]);
  });

  it('cancels an order with no captured payment', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [{ id: 'pay_failed', status: 'failed', amount: 25000 }];
    const res = await run();
    expect(await res.json()).toMatchObject({ expired: 1, recovered: 0 });
    expect(state.cancelled).toEqual(['order-1']);
  });

  it('leaves the order alone when Razorpay cannot be reached', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = null;
    const res = await run();
    expect(await res.json()).toMatchObject({ expired: 0, recovered: 0 });
    expect(state.cancelled).toEqual([]);
  });

  it('leaves the order alone while a payment is only authorized', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [{ id: 'pay_auth', status: 'authorized', amount: 25000 }];
    const res = await run();
    expect(await res.json()).toMatchObject({ expired: 0, recovered: 0 });
    expect(state.cancelled).toEqual([]);
  });
});

describe('shop pass', () => {
  it('reports the shop counts next to the café result', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [{ id: 'pay_failed', status: 'failed', amount: 25000 }];
    const body = await (await run()).json();
    expect(body).toEqual({
      expired: 1,
      recovered: 0,
      shop: { expired: 2, recovered: 1 },
      shop_delivery: { checked: 4, delivered: 3 },
    });
    expect(state.shopCalls).toEqual(['expire', 'sweep']);
  });

  it('a throwing shop pass still returns the café result', async () => {
    state.shopThrows = true;
    state.attemptsByGatewayOrder.rzp_order_1 = [{ id: 'pay_failed', status: 'failed', amount: 25000 }];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await run();
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ expired: 1, recovered: 0, shop: { expired: 0, recovered: 0 } });
    expect(state.cancelled).toEqual(['order-1']);
  });
});

describe('POST /api/cron/expire-orders — what pg_cron actually calls', () => {
  it('a POST with a valid bearer token cancels the unpaid stale order, like the GET path', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [{ id: 'pay_failed', status: 'failed', amount: 25000 }];
    const res = await runPost();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ expired: 1, recovered: 0 });
    expect(state.cancelled).toEqual(['order-1']);
  });

  it('a POST with a valid bearer token still recovers an order whose payment was captured', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [{ id: 'pay_ok', status: 'captured', amount: 25000 }];
    const res = await runPost();
    expect(await res.json()).toMatchObject({ expired: 0, recovered: 1 });
    expect(state.captured).toEqual(['rzp_order_1']);
    expect(state.cancelled).toEqual([]);
  });

  it('POST fails CLOSED with no Authorization header', async () => {
    const res = await runPost(null);
    expect(res.status).toBe(401);
    expect(state.cancelled).toEqual([]);
  });

  it('POST fails CLOSED with a wrong bearer token', async () => {
    const res = await runPost('Bearer wrong');
    expect(res.status).toBe(401);
    expect(state.cancelled).toEqual([]);
  });

  it('POST fails CLOSED when CRON_SECRET itself is unset', async () => {
    const original = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await runPost('Bearer cron_secret');
      expect(res.status).toBe(401);
      expect(state.cancelled).toEqual([]);
    } finally {
      process.env.CRON_SECRET = original;
    }
  });
});
