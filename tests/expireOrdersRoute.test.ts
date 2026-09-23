import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for GET /api/cron/expire-orders. Mocks Supabase, the
// Razorpay lookup and the capture logic so the route's decision — recover a
// paid order, cancel an unpaid one, leave it alone when the gateway can't
// confirm — is exercised without network or DB.

const state: {
  stale: { id: string; version: number }[];
  paymentsByOrder: Record<string, { gateway_order_id: string }[]>;
  attemptsByGatewayOrder: Record<string, { id: string; status: string; amount: number }[] | null>;
  cancelled: string[];
  captured: string[];
} = { stale: [], paymentsByOrder: {}, attemptsByGatewayOrder: {}, cancelled: [], captured: [] };

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

process.env.CRON_SECRET = 'cron_secret';

// Imported after mocks are registered (vi.mock is hoisted).
const { GET } = await import('@/app/api/cron/expire-orders/route');

const run = () =>
  GET(
    new Request('http://localhost/api/cron/expire-orders', {
      headers: { authorization: 'Bearer cron_secret' },
    }),
  );

beforeEach(() => {
  state.stale = [{ id: 'order-1', version: 1 }];
  state.paymentsByOrder = { 'order-1': [{ gateway_order_id: 'rzp_order_1' }] };
  state.attemptsByGatewayOrder = {};
  state.cancelled = [];
  state.captured = [];
});

describe('GET /api/cron/expire-orders', () => {
  it('recovers an order whose payment was captured instead of cancelling it', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [
      { id: 'pay_failed', status: 'failed', amount: 25000 },
      { id: 'pay_ok', status: 'captured', amount: 25000 },
    ];
    const res = await run();
    expect(await res.json()).toEqual({ expired: 0, recovered: 1 });
    expect(state.captured).toEqual(['rzp_order_1']);
    expect(state.cancelled).toEqual([]);
  });

  it('cancels an order with no captured payment', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [{ id: 'pay_failed', status: 'failed', amount: 25000 }];
    const res = await run();
    expect(await res.json()).toEqual({ expired: 1, recovered: 0 });
    expect(state.cancelled).toEqual(['order-1']);
  });

  it('leaves the order alone when Razorpay cannot be reached', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = null;
    const res = await run();
    expect(await res.json()).toEqual({ expired: 0, recovered: 0 });
    expect(state.cancelled).toEqual([]);
  });

  it('leaves the order alone while a payment is only authorized', async () => {
    state.attemptsByGatewayOrder.rzp_order_1 = [{ id: 'pay_auth', status: 'authorized', amount: 25000 }];
    const res = await run();
    expect(await res.json()).toEqual({ expired: 0, recovered: 0 });
    expect(state.cancelled).toEqual([]);
  });
});
