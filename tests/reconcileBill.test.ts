import { beforeEach, describe, expect, it, vi } from 'vitest';

// The order confirmation (bill) for an ONLINE order is held back at placement
// and sent by captureGatewayPayment (lib/payments/reconcile.ts) when payment is
// captured and the order moves 'placed' → 'received'. Verify, webhook and the
// reconcile poll can all reach it for the same payment, so it must send exactly
// once — on the call that actually confirms the order.

const state: {
  payment: { id: string; order_id: string; status: string; amount_inr: number } | null;
  order: { id: string; status: string; version: number; payment_status: string } | null;
} = { payment: null, order: null };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: { isUpdate: boolean; patch?: Record<string, unknown> } = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        update: (patch: Record<string, unknown>) => {
          ctx.isUpdate = true;
          ctx.patch = patch;
          if (table === 'payments' && state.payment) state.payment.status = String(patch.status);
          return chain;
        },
        insert: () => Promise.resolve({ error: null }),
        maybeSingle: () => {
          if (table === 'payments') return Promise.resolve({ data: state.payment, error: null });
          if (table === 'orders' && ctx.isUpdate && state.order) {
            Object.assign(state.order, ctx.patch);
            return Promise.resolve({ data: { ...state.order }, error: null });
          }
          return Promise.resolve({ data: state.order ? { ...state.order } : null, error: null });
        },
        single: () => Promise.resolve({ data: { ...state.order, order_items: [] }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }), // awaited payments update
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification: vi.fn(() => Promise.resolve()) }));

const { captureGatewayPayment } = await import('@/lib/payments/reconcile');
const { sendBillNotification } = await import('@/lib/notifications/engine');

const capture = () =>
  captureGatewayPayment({
    gatewayOrderId: 'order_rzp_1',
    gatewayPaymentId: 'pay_1',
    method: 'upi',
    signatureOk: true,
    capturedAmountPaise: 25000,
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.payment = { id: 'p1', order_id: 'o1', status: 'payment_pending', amount_inr: 250 };
  state.order = { id: 'o1', status: 'placed', version: 1, payment_status: 'payment_pending' };
});

describe('captureGatewayPayment — order confirmation timing', () => {
  it('sends the confirmation when payment is captured and the order enters the queue', async () => {
    const result = await capture();
    expect(result.ok).toBe(true);
    expect(state.order?.status).toBe('received');
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('does not send it again when a second path (e.g. the webhook) confirms the same payment', async () => {
    await capture();
    const again = await capture();
    expect(again.alreadyProcessed).toBe(true);
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('does not send it for an order that was not waiting on payment', async () => {
    state.order = { id: 'o1', status: 'received', version: 1, payment_status: 'unpaid' };
    await capture();
    expect(sendBillNotification).not.toHaveBeenCalled();
  });
});
