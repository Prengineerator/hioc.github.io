import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import { shopOrder } from './helpers/shopFixture';

// The shop's side of Razorpay (lib/shop/payments.ts) on an in-memory database:
// a captured payment marks the order paid once, sends the "new order" emails
// once, and a Razorpay order that isn't a shop order is left for the café.

const state: {
  tables: Record<string, Row[]>;
  admin: ReturnType<typeof makeFakeAdmin>;
  emails: string[];
  attempts: Record<string, unknown>[];
} = { tables: {}, admin: makeFakeAdmin({}, { startMs: 0 }), emails: [], attempts: [] };

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => state.admin }));
vi.mock('@/lib/api/background', () => ({ runAfterResponse: (p: Promise<unknown>) => void p }));
vi.mock('@/lib/shop/emails', () => ({
  sendShopPaidEmails: (o: { id: string }) => {
    state.emails.push(o.id);
    return Promise.resolve();
  },
}));

process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';

const { captureShopPayment, reconcileShopOrder } = await import('@/lib/shop/payments');

beforeEach(() => {
  const pending = { ...shopOrder({ status: 'payment_pending', paid_at: null, razorpay_payment_id: null, payment_method: null }) } as unknown as Row;
  state.tables = { shop_orders: [pending] };
  state.admin = makeFakeAdmin(state.tables, { startMs: Date.parse('2026-11-12T08:00:00Z') });
  state.emails = [];
  state.attempts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify({ items: state.attempts }), { status: 200 }))),
  );
});

describe('captureShopPayment', () => {
  it('leaves a Razorpay order that is not a shop order to the café', async () => {
    const r = await captureShopPayment({ gatewayOrderId: 'order_CAFE', gatewayPaymentId: 'pay_1' });
    expect(r).toEqual({ handled: false });
    expect(state.tables.shop_orders[0].status).toBe('payment_pending');
  });

  it('marks the order paid once and sends the emails once', async () => {
    const first = await captureShopPayment({ gatewayOrderId: 'order_R1', gatewayPaymentId: 'pay_P9', method: 'upi', capturedAmountPaise: 84700 });
    expect(first).toMatchObject({ handled: true, newlyPaid: true, order: { status: 'paid', razorpay_payment_id: 'pay_P9', payment_method: 'upi' } });
    expect(state.tables.shop_orders[0]).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_P9' });
    expect(state.tables.shop_orders[0].paid_at).toBeTruthy();

    const again = await captureShopPayment({ gatewayOrderId: 'order_R1', gatewayPaymentId: 'pay_P9' });
    expect(again).toMatchObject({ handled: true, newlyPaid: false });
    expect(state.emails).toHaveLength(1);
  });

  it('records a payment whose amount looks wrong (the money moved), and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await captureShopPayment({ gatewayOrderId: 'order_R1', gatewayPaymentId: 'pay_P9', capturedAmountPaise: 100 });
    expect(r).toMatchObject({ handled: true, newlyPaid: true });
    expect(log.mock.calls.some((c) => String(c[0]).includes('AMOUNT MISMATCH'))).toBe(true);
    log.mockRestore();
  });
});

describe('reconcileShopOrder', () => {
  it('finds a captured payment on Razorpay and records it', async () => {
    state.attempts = [
      { id: 'pay_F', order_id: 'order_R1', status: 'failed', amount: 84700 },
      { id: 'pay_OK', order_id: 'order_R1', status: 'captured', method: 'card', amount: 84700 },
    ];
    const order = shopOrder({ status: 'payment_pending', paid_at: null, razorpay_payment_id: null });
    const after = await reconcileShopOrder(order);
    expect(after).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_OK', payment_method: 'card' });
  });

  it('leaves it waiting when nothing is captured, and never asks for a paid order', async () => {
    const order = shopOrder({ status: 'payment_pending', paid_at: null });
    expect((await reconcileShopOrder(order)).status).toBe('payment_pending');
    const fetchCalls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await reconcileShopOrder(shopOrder({ status: 'paid' }));
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(fetchCalls);
  });
});

describe('POST /api/payments/webhook — shop first, then the café', () => {
  it('records a shop payment without touching café payments, and a café payment as before', async () => {
    vi.resetModules();
    const calls: { shop: unknown[]; cafe: unknown[] } = { shop: [], cafe: [] };
    let shopHandles = true;
    vi.doMock('@/lib/shop/payments', () => ({
      captureShopPayment: (p: unknown) => {
        calls.shop.push(p);
        return Promise.resolve(shopHandles ? { handled: true, order: {}, newlyPaid: true } : { handled: false });
      },
    }));
    vi.doMock('@/lib/payments/reconcile', () => ({
      captureGatewayPayment: (p: unknown) => {
        calls.cafe.push(p);
        return Promise.resolve({ ok: true, order: null });
      },
      markGatewayPaymentFailed: () => Promise.resolve(),
    }));
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';
    const { POST } = await import('@/app/api/payments/webhook/route');

    const event = (orderId: string) => {
      const raw = JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_W', order_id: orderId, method: 'upi', amount: 84700 } } },
      });
      return new Request('http://localhost/api/payments/webhook', {
        method: 'POST',
        headers: { 'x-razorpay-signature': createHmac('sha256', 'whsec').update(raw).digest('hex') },
        body: raw,
      });
    };

    expect((await POST(event('order_SHOP'))).status).toBe(200);
    expect(calls.shop).toEqual([{ gatewayOrderId: 'order_SHOP', gatewayPaymentId: 'pay_W', method: 'upi', capturedAmountPaise: 84700 }]);
    expect(calls.cafe).toHaveLength(0);

    shopHandles = false;
    expect((await POST(event('order_CAFE'))).status).toBe(200);
    expect(calls.cafe).toHaveLength(1);
    expect(calls.cafe[0]).toMatchObject({ gatewayOrderId: 'order_CAFE', gatewayPaymentId: 'pay_W', signatureOk: true });

    vi.doUnmock('@/lib/shop/payments');
    vi.doUnmock('@/lib/payments/reconcile');
  });
});

describe('POST /api/shop/verify', () => {
  it('checks the signature and records only a captured payment', async () => {
    vi.resetModules();
    const captured: unknown[] = [];
    vi.doMock('@/lib/shop/payments', () => ({
      captureShopPayment: (p: unknown) => {
        captured.push(p);
        return Promise.resolve({ handled: true, order: { id: 'shop-1', status: 'paid' }, newlyPaid: true });
      },
    }));
    const { POST } = await import('@/app/api/shop/verify/route');
    const sign = (o: string, p: string) => createHmac('sha256', 'rzp_test_secret').update(`${o}|${p}`).digest('hex');
    const req = (sig: string) =>
      new Request('http://localhost/api/shop/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ razorpay_order_id: 'order_R1', razorpay_payment_id: 'pay_P1', razorpay_signature: sig }),
      });

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ id: 'pay_P1', order_id: 'order_R1', status: 'captured', method: 'upi', amount: 84700 }), { status: 200 }))));
    expect((await POST(req(sign('order_R1', 'pay_OTHER')))).status).toBe(400);
    expect(captured).toHaveLength(0);

    const ok = await POST(req(sign('order_R1', 'pay_P1')));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ verified: true, status: 'paid', order_id: 'shop-1' });
    expect(captured).toEqual([{ gatewayOrderId: 'order_R1', gatewayPaymentId: 'pay_P1', method: 'upi', capturedAmountPaise: 84700 }]);

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ id: 'pay_P1', order_id: 'order_R1', status: 'authorized', amount: 84700 }), { status: 200 }))));
    const pending = await POST(req(sign('order_R1', 'pay_P1')));
    expect(await pending.json()).toEqual({ verified: true, status: 'payment_pending' });
    expect(captured).toHaveLength(1);

    vi.doUnmock('@/lib/shop/payments');
  });
});
