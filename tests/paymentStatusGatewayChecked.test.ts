import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/payments/[orderId]/status — `gateway_checked`.
//
// The Ritual page's "don't start a second sale while the first may be paid"
// guard (components/passes/ritualSaleGuard.ts) sells again when the earlier
// sale answers 'payment_pending'. That is only safe when the server actually
// confirmed with Razorpay that nothing was paid; when the lookup failed (or a
// payment is authorized and still capturing, or a capture couldn't be
// recorded) the same 'payment_pending' must say so, or a gateway outage turns
// into a double charge.

const UUID = '5f9d3b2a-1e4c-4a7b-9c3d-2b1a4e6f7c8d';

type Attempt = { id: string; status: string; method?: string; amount: number };

const state: {
  order: Record<string, unknown> | null;
  payment: Record<string, unknown> | null;
  attempts: Attempt[] | null;
  captureOrder: Record<string, unknown> | null;
  captureCalls: number;
} = { order: null, payment: null, attempts: [], captureOrder: null, captureCalls: 0 };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () =>
          Promise.resolve({ data: table === 'payments' ? state.payment : state.order, error: null }),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
vi.mock('@/lib/payments/gateway', () => ({
  createPaymentIntent: () => Promise.resolve(null),
  fetchOrderPaymentAttempts: () => Promise.resolve(state.attempts),
}));
vi.mock('@/lib/payments/reconcile', () => ({
  captureGatewayPayment: () => {
    state.captureCalls++;
    return Promise.resolve({ ok: state.captureOrder !== null, order: state.captureOrder });
  },
}));

const { GET } = await import('@/app/api/payments/[orderId]/status/route');

async function get(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await GET(new Request(`http://t/api/payments/${UUID}/status`), { params: { orderId: UUID } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  state.order = { id: UUID, status: 'placed', payment_status: 'payment_pending' };
  state.payment = { gateway_order_id: 'order_rzp_1' };
  state.attempts = [];
  state.captureOrder = null;
  state.captureCalls = 0;
});

describe('GET /api/payments/[orderId]/status — gateway_checked', () => {
  it('a stored outcome is final without asking the gateway', async () => {
    state.order = { id: UUID, status: 'received', payment_status: 'paid' };
    const { body } = await get();
    expect(body).toMatchObject({ payment_status: 'paid', gateway_checked: true });
  });

  it('pending, and Razorpay holds no payment → confirmed (safe to start again)', async () => {
    state.attempts = [{ id: 'pay_1', status: 'failed', amount: 49900 }];
    const { body } = await get();
    expect(body).toMatchObject({ payment_status: 'payment_pending', gateway_checked: true });
  });

  it('pending, and no gateway order was ever created → confirmed', async () => {
    state.payment = null;
    const { body } = await get();
    expect(body).toMatchObject({ payment_status: 'payment_pending', gateway_checked: true });
  });

  it('pending, but the Razorpay lookup failed → NOT confirmed', async () => {
    state.attempts = null;
    const { body } = await get();
    expect(body).toMatchObject({ payment_status: 'payment_pending', gateway_checked: false });
  });

  it('pending, with an authorized payment still capturing → NOT confirmed', async () => {
    state.attempts = [{ id: 'pay_1', status: 'authorized', amount: 49900 }];
    const { body } = await get();
    expect(body).toMatchObject({ payment_status: 'payment_pending', gateway_checked: false });
  });

  it('a captured payment is recorded and its outcome returned as final', async () => {
    state.attempts = [{ id: 'pay_1', status: 'captured', method: 'upi', amount: 49900 }];
    state.captureOrder = { id: UUID, status: 'completed', payment_status: 'paid' };
    const { body } = await get();
    expect(state.captureCalls).toBe(1);
    expect(body).toMatchObject({ payment_status: 'paid', gateway_checked: true });
  });

  it('a captured payment that could not be recorded → still pending, NOT confirmed', async () => {
    state.attempts = [{ id: 'pay_1', status: 'captured', method: 'upi', amount: 49900 }];
    state.captureOrder = null;
    const { body } = await get();
    expect(body).toMatchObject({ payment_status: 'payment_pending', gateway_checked: false });
  });
});
