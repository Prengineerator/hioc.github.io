import { beforeEach, describe, expect, it, vi } from 'vitest';
import { receivedByMethod } from '@/lib/orders/paymentTotals';
import { canChangePayment } from '@/lib/orders/settleList';
import { describeBillPayment, describeOrderPayment } from '@/lib/orders/paymentLabel';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';

// App paid (2026-11-27): a Razorpay capture leaves orders.payment_method = 'online'
// whatever the sub-method; the payments row keeps 'upi' / 'card'.

const state: { paymentPatch: Record<string, unknown> | null; orderPatch: Record<string, unknown> | null } = {
  paymentPatch: null,
  orderPatch: null,
};

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      let isUpdate = false;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        update: (patch: Record<string, unknown>) => {
          isUpdate = true;
          if (table === 'payments') state.paymentPatch = patch;
          if (table === 'orders') state.orderPatch = patch;
          return chain;
        },
        insert: () => Promise.resolve({ error: null }),
        maybeSingle: () => {
          if (table === 'payments') return Promise.resolve({ data: { id: 'p1', order_id: 'o1', status: 'payment_pending', amount_inr: 412 }, error: null });
          const base = { id: 'o1', status: 'placed', version: 1, payment_status: 'payment_pending' };
          return Promise.resolve({ data: isUpdate ? { ...base, ...state.orderPatch } : base, error: null });
        },
        single: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification: vi.fn(() => Promise.resolve()) }));

const { captureGatewayPayment } = await import('@/lib/payments/reconcile');

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.paymentPatch = null;
  state.orderPatch = null;
});

describe('captureGatewayPayment keeps the order on "online"', () => {
  it.each(['upi', 'card', 'netbanking', undefined])('Razorpay method %s -> order online', async (m) => {
    const r = await captureGatewayPayment({
      gatewayOrderId: 'order_x',
      gatewayPaymentId: 'pay_x',
      method: m,
      signatureOk: true,
      capturedAmountPaise: 41200,
    });
    expect(r.ok).toBe(true);
    expect(state.orderPatch?.payment_method).toBe('online');
    expect(state.orderPatch?.payment_status).toBe('paid');
    const expectedRow = m === 'upi' || m === 'card' ? m : 'online';
    expect(state.paymentPatch?.method).toBe(expectedRow);
  });
});

describe('app-paid orders on staff screens', () => {
  const appPaid = { status: 'received', payment_status: 'paid', payment_method: 'online', total_inr: 412, subtotal_inr: 412 } as never;
  const counterUpi = { status: 'received', payment_status: 'paid', payment_method: 'upi', total_inr: 188, subtotal_inr: 188 } as never;

  it('tallies app paid apart from counter UPI', () => {
    const t = receivedByMethod([appPaid, counterUpi]);
    expect(t.online).toEqual({ amount_inr: 412, orders: 1 });
    expect(t.upi).toEqual({ amount_inr: 188, orders: 1 });
  });

  it('cannot change payment on an app-paid order, but can on counter UPI', () => {
    expect(canChangePayment(appPaid)).toBe(false);
    expect(canChangePayment(counterUpi)).toBe(true);
  });

  it('staff say "App paid", the printed bill says "HIOC app"', () => {
    expect(PAYMENT_METHOD_LABEL.online).toBe('App paid');
    expect(describeOrderPayment(appPaid)).toBe('App paid');
    expect(describeBillPayment(appPaid)).toBe('HIOC app');
    expect(describeBillPayment(counterUpi)).toBe('UPI');
  });
});
