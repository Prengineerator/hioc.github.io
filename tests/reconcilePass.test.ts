import { beforeEach, describe, expect, it, vi } from 'vitest';

// captureGatewayPayment and the SALE of a HIOC Ritual pass
// (docs/COFFEE-PASS-SPEC.md §7, §5.5). Capturing the payment sets
// payment_status = 'paid', and a database trigger then issues the pass, completes
// the order and logs its own status event. So this code must NOT advance the
// sale placed → received (it never enters a kitchen queue), and must not write a
// status, an event or a broadcast of its own; the customer still gets the bill.

const state: {
  payment: { id: string; order_id: string; status: string; amount_inr: number } | null;
  order: Record<string, unknown> | null;
  orderPatches: Record<string, unknown>[];
  events: Record<string, unknown>[];
  orderSelects: string[];
} = { payment: null, order: null, orderPatches: [], events: [], orderSelects: [] };

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: { isUpdate: boolean; patch?: Record<string, unknown> } = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (cols?: string) => {
          if (table === 'orders' && !ctx.isUpdate) state.orderSelects.push(cols ?? '');
          return chain;
        },
        eq: () => chain,
        update: (patch: Record<string, unknown>) => {
          ctx.isUpdate = true;
          ctx.patch = patch;
          if (table === 'payments' && state.payment) state.payment.status = String(patch.status);
          if (table === 'orders') state.orderPatches.push(patch);
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'order_status_events') state.events.push(row);
          return Promise.resolve({ error: null });
        },
        maybeSingle: () => {
          if (table === 'payments') return Promise.resolve({ data: state.payment, error: null });
          if (table === 'orders' && ctx.isUpdate && state.order) {
            Object.assign(state.order, ctx.patch);
            return Promise.resolve({ data: { ...state.order }, error: null });
          }
          return Promise.resolve({ data: state.order ? { ...state.order } : null, error: null });
        },
        single: () => Promise.resolve({ data: { ...state.order, order_items: [] }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      });
      return chain;
    },
  }),
}));
const { broadcastOrderEvent } = vi.hoisted(() => ({ broadcastOrderEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent }));
const { sendBillNotification } = vi.hoisted(() => ({ sendBillNotification: vi.fn((_order: unknown) => Promise.resolve()) }));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification }));

const { captureGatewayPayment } = await import('@/lib/payments/reconcile');

const capture = () =>
  captureGatewayPayment({
    gatewayOrderId: 'order_rzp_1',
    gatewayPaymentId: 'pay_1',
    method: 'upi',
    signatureOk: true,
    capturedAmountPaise: 78800,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.payment = { id: 'p1', order_id: 'o1', status: 'payment_pending', amount_inr: 788 };
  state.order = { id: 'o1', status: 'placed', version: 1, payment_status: 'payment_pending', order_kind: 'coffee_pass' };
  state.orderPatches = [];
  state.events = [];
  state.orderSelects = [];
});

describe('captureGatewayPayment — a HIOC Ritual sale', () => {
  it('marks it paid and leaves the status alone: no advance to received, no version bump', async () => {
    const result = await capture();
    expect(result.ok).toBe(true);
    // Only payment fields are written; the trigger does the rest.
    expect(state.orderPatches).toEqual([{ payment_status: 'paid', payment_method: 'upi' }]);
    expect(state.order?.status).toBe('placed');
    expect(state.order?.version).toBe(1);
  });

  it('writes no status event and broadcasts nothing (the trigger logs its own)', async () => {
    await capture();
    expect(state.events).toHaveLength(0);
    expect(broadcastOrderEvent).not.toHaveBeenCalled();
  });

  it('still sends the bill, with the order and its lines', async () => {
    await capture();
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
    expect(sendBillNotification.mock.calls[0][0]).toMatchObject({ id: 'o1', items: [] });
  });

  it('a failing bill send never undoes the captured payment', async () => {
    sendBillNotification.mockRejectedValueOnce(new Error('meta is down'));
    const result = await capture();
    expect(result.ok).toBe(true);
    expect(state.orderPatches).toHaveLength(1);
  });

  it('does not bill twice when a second path (the webhook) confirms the same payment', async () => {
    await capture();
    const again = await capture();
    expect(again.alreadyProcessed).toBe(true);
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
    expect(state.orderPatches).toHaveLength(1);
  });

  it('reads the order with `*`, so a capture still finds its order on a database without order_kind', async () => {
    await capture();
    expect(state.orderSelects[0]).toBe('*');
  });
});

describe('captureGatewayPayment — ordinary orders are unchanged', () => {
  it.each([
    ['a menu order', { order_kind: 'menu' }],
    ['an order from a database before the migration (no order_kind)', { order_kind: undefined }],
  ])('%s still advances placed → received, logs the event and bills', async (_label, over) => {
    state.order = { id: 'o1', status: 'placed', version: 1, payment_status: 'payment_pending', ...over };
    await capture();
    expect(state.order?.status).toBe('received');
    expect(state.orderPatches[0]).toMatchObject({ status: 'received', version: 2, payment_status: 'paid' });
    expect(state.events).toHaveLength(1);
    expect(broadcastOrderEvent).toHaveBeenCalledWith('o1', 'received');
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });
});
