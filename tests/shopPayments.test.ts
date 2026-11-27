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
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  rpcResults: Record<string, string>;
  rpcFails: Set<string>;
  addressInsertError: { code?: string; message?: string } | null;
} = {
  tables: {},
  admin: makeFakeAdmin({}, { startMs: 0 }),
  emails: [],
  attempts: [],
  rpcCalls: [],
  rpcResults: {},
  rpcFails: new Set(),
  addressInsertError: null,
};

/** The in-memory database plus the RPCs capture calls (their answers are set per test). */
function adminWithRpc() {
  const base = makeFakeAdmin(state.tables, { startMs: Date.parse('2026-11-12T08:00:00Z') });
  return {
    ...base,
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      if (state.rpcFails.has(fn)) return Promise.resolve({ data: null, error: { code: '57014', message: 'timeout' } });
      return Promise.resolve({ data: state.rpcResults[fn] ?? null, error: null });
    },
    from: (table: string) => {
      const chain = base.from(table) as Record<string, unknown>;
      if (table === 'customer_addresses' && state.addressInsertError) {
        const err = state.addressInsertError;
        chain.insert = () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: err }) }) });
      }
      return chain;
    },
  } as unknown as ReturnType<typeof makeFakeAdmin>;
}

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

const { captureShopPayment, reconcileShopOrder, applyCaptureEffects, paymentIntentFor } = await import('@/lib/shop/payments');

beforeEach(() => {
  const pending = { ...shopOrder({ status: 'payment_pending', paid_at: null, razorpay_payment_id: null, payment_method: null }) } as unknown as Row;
  state.tables = { shop_orders: [pending] };
  state.admin = adminWithRpc();
  state.emails = [];
  state.attempts = [];
  state.rpcCalls = [];
  state.rpcResults = { claim_shop_intro_offer: 'claimed', record_shop_coupon_redemption: 'recorded' };
  state.rpcFails = new Set();
  state.addressInsertError = null;
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

const PAY = { gatewayOrderId: 'order_R1', gatewayPaymentId: 'pay_P9', method: 'upi' };
const rpcNames = () => state.rpcCalls.map((c) => c.fn);

/** Makes the pending order a customer's, with the extras a test needs. */
function patchOrder(patch: Record<string, unknown>) {
  Object.assign(state.tables.shop_orders[0], patch);
}

describe('capture effects', () => {
  it('a plain order has nothing to do but stamp capture_effects_at, once', async () => {
    const first = await captureShopPayment(PAY);
    expect(first).toMatchObject({ newlyPaid: true, order: { capture_effects_at: expect.any(String) } });
    expect(state.tables.shop_orders[0].capture_effects_at).toBeTruthy();
    expect(state.rpcCalls).toHaveLength(0);
    await captureShopPayment(PAY);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.emails).toHaveLength(1);
  });

  it('claims the introductory offer and records the coupon once, however many paths see the payment', async () => {
    patchOrder({ intro_offer_applied: true, coupon_id: 'c1', coupon_code: 'SAVE50' });
    await captureShopPayment(PAY);
    await captureShopPayment(PAY);
    await reconcileShopOrder(state.tables.shop_orders[0] as never);
    expect(rpcNames()).toEqual(['claim_shop_intro_offer', 'record_shop_coupon_redemption']);
    expect(state.rpcCalls[0].args).toEqual({ p_shop_order_id: state.tables.shop_orders[0].id });
    expect(state.tables.shop_orders[0].capture_effects_at).toBeTruthy();
    expect(state.emails).toHaveLength(1);
  });

  it('after a crash mid-way (stamp still null) the next call finishes the job, without new emails', async () => {
    patchOrder({ intro_offer_applied: true, user_id: 'user-1', save_address_label: 'Home' });
    // The crash: paid, but the effects never ran.
    patchOrder({ status: 'paid', paid_at: '2026-11-12T08:35:00.000Z', capture_effects_at: null });
    const r = await captureShopPayment(PAY);
    expect(r).toMatchObject({ handled: true, newlyPaid: false, order: { capture_effects_at: expect.any(String) } });
    expect(rpcNames()).toEqual(['claim_shop_intro_offer']);
    expect(state.tables.customer_addresses).toHaveLength(1);
    expect(state.emails).toHaveLength(0);
  });

  it('the order page poll also repairs an order whose effects are missing', async () => {
    patchOrder({ status: 'paid', coupon_id: 'c1', capture_effects_at: null });
    const after = await reconcileShopOrder(state.tables.shop_orders[0] as never);
    expect(rpcNames()).toEqual(['record_shop_coupon_redemption']);
    expect(after.capture_effects_at).toBeTruthy();
  });

  it('a failing step leaves the stamp null (and is retried), the others still run', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    patchOrder({ intro_offer_applied: true, coupon_id: 'c1' });
    state.rpcFails.add('claim_shop_intro_offer');
    const first = await captureShopPayment(PAY);
    expect(first.handled && first.order.capture_effects_at).toBeNull();
    expect(rpcNames()).toEqual(['claim_shop_intro_offer', 'record_shop_coupon_redemption']);
    expect(state.tables.shop_orders[0].capture_effects_at ?? null).toBeNull();

    state.rpcFails.clear();
    const retry = await captureShopPayment(PAY);
    expect(retry.handled && retry.order.capture_effects_at).toBeTruthy();
    err.mockRestore();
  });

  it("flags a reused introductory offer (the order is honoured)", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    patchOrder({ intro_offer_applied: true });
    state.rpcResults.claim_shop_intro_offer = 'reused';
    const r = await captureShopPayment(PAY);
    expect(r).toMatchObject({ newlyPaid: true, order: { status: 'paid', intro_offer_reused: true, capture_effects_at: expect.any(String) } });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('second time'))).toBe(true);
    warn.mockRestore();
  });

  it('honours a coupon that went over its limit, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    patchOrder({ coupon_id: 'c1', coupon_code: 'SAVE50' });
    state.rpcResults.record_shop_coupon_redemption = 'over_limit';
    const r = await captureShopPayment(PAY);
    expect(r).toMatchObject({ newlyPaid: true, order: { status: 'paid', capture_effects_at: expect.any(String) } });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('over its limit'))).toBe(true);
    warn.mockRestore();
  });

  describe('saving the address', () => {
    it('saves it only on capture, as the first (default) address, and links it to the order', async () => {
      patchOrder({ user_id: 'user-1', save_address_label: 'Work', landmark: 'Gate 2', location_lat: 26.9124, location_lng: 75.7873, location_source: 'gps' });
      expect(state.tables.customer_addresses ?? []).toHaveLength(0); // nothing while payment is pending
      await captureShopPayment(PAY);
      expect(state.tables.customer_addresses).toHaveLength(1);
      expect(state.tables.customer_addresses[0]).toMatchObject({
        user_id: 'user-1',
        label: 'Work',
        customer_name: 'Riya Sharma',
        phone: '+919876543210',
        address_line1: '12, Rose Villa, MG Road',
        landmark: 'Gate 2',
        pincode: '302001',
        location_lat: 26.9124,
        location_source: 'gps',
        is_default: true,
        last_used_at: expect.any(String),
      });
      expect(state.tables.shop_orders[0].customer_address_id).toBe(state.tables.customer_addresses[0].id);
    });

    it('does not save twice: a repeat capture, or an address the customer already has', async () => {
      state.tables.customer_addresses = [
        { id: 'addr-old', user_id: 'user-1', label: 'Home', phone: '+919876543210', pincode: '302001', address_line1: '12, ROSE VILLA, MG road', address_line2: 'near city mall', city: 'jaipur', is_default: true, last_used_at: null },
      ];
      patchOrder({ user_id: 'user-1', save_address_label: 'Work' });
      await captureShopPayment(PAY);
      await captureShopPayment(PAY);
      expect(state.tables.customer_addresses).toHaveLength(1);
      expect(state.tables.shop_orders[0].customer_address_id).toBe('addr-old');
      expect(state.tables.customer_addresses[0].last_used_at).toBeTruthy();
    });

    it('a second, different address is not the default', async () => {
      state.tables.customer_addresses = [{ id: 'addr-old', user_id: 'user-1', label: 'Home', phone: '+919000000000', pincode: '110001', address_line1: 'Elsewhere 1', address_line2: '', city: 'Delhi', is_default: true }];
      patchOrder({ user_id: 'user-1', save_address_label: 'Work' });
      await captureShopPayment(PAY);
      expect(state.tables.customer_addresses).toHaveLength(2);
      expect(state.tables.customer_addresses[1]).toMatchObject({ label: 'Work', is_default: false });
    });

    it('skips (and still finishes) when the customer already has 10 addresses', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      state.addressInsertError = { code: 'P0001', message: 'customer_addresses_limit' };
      patchOrder({ user_id: 'user-1', save_address_label: 'Work' });
      const r = await captureShopPayment(PAY);
      expect(r).toMatchObject({ newlyPaid: true, order: { status: 'paid', capture_effects_at: expect.any(String) } });
      expect(state.tables.shop_orders[0].customer_address_id ?? null).toBeNull();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('10 saved addresses'))).toBe(true);
      warn.mockRestore();
    });

    it('retries after a real failure', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      state.addressInsertError = { code: '57014', message: 'timeout' };
      patchOrder({ user_id: 'user-1', save_address_label: 'Work' });
      const first = await captureShopPayment(PAY);
      expect(first.handled && first.order.capture_effects_at).toBeNull();
      state.addressInsertError = null;
      const again = await captureShopPayment(PAY);
      expect(again.handled && again.order.capture_effects_at).toBeTruthy();
      expect(state.tables.customer_addresses).toHaveLength(1);
      err.mockRestore();
    });

    it('never saves for a guest, or without a label', async () => {
      patchOrder({ user_id: null, save_address_label: 'Home' });
      await captureShopPayment(PAY);
      expect(state.tables.customer_addresses ?? []).toHaveLength(0);
    });

    it('an order that used a saved address just stamps its last_used_at', async () => {
      state.tables.customer_addresses = [{ id: 'addr-1', user_id: 'user-1', label: 'Home', last_used_at: null }];
      patchOrder({ user_id: 'user-1', customer_address_id: 'addr-1' });
      await captureShopPayment(PAY);
      expect(state.tables.customer_addresses).toHaveLength(1);
      expect(state.tables.customer_addresses[0].last_used_at).toBeTruthy();
    });
  });

  it('an order that expired and was then paid is honoured, loudly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    patchOrder({ status: 'expired', intro_offer_applied: true });
    const r = await captureShopPayment({ ...PAY, capturedAmountPaise: 84700 });
    expect(r).toMatchObject({ handled: true, newlyPaid: true, order: { status: 'paid', razorpay_payment_id: 'pay_P9' } });
    expect(err.mock.calls.some((c) => String(c[0]).includes('PAID AFTER EXPIRY'))).toBe(true);
    expect(rpcNames()).toEqual(['claim_shop_intro_offer']);
    expect(state.emails).toHaveLength(1);
    err.mockRestore();
  });

  it('reconcile checks the Razorpay attempts of an expired order too', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    patchOrder({ status: 'expired' });
    state.attempts = [{ id: 'pay_LATE', order_id: 'order_R1', status: 'captured', method: 'upi', amount: 84700 }];
    const after = await reconcileShopOrder(state.tables.shop_orders[0] as never);
    expect(after).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_LATE' });
    err.mockRestore();
  });

  it('a cancelled order is left alone', async () => {
    patchOrder({ status: 'cancelled', intro_offer_applied: true });
    const r = await captureShopPayment(PAY);
    expect(r).toMatchObject({ handled: true, newlyPaid: false, order: { status: 'cancelled' } });
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('applyCaptureEffects does nothing for an unpaid order or one already done', async () => {
    const pending = shopOrder({ status: 'payment_pending', intro_offer_applied: true });
    expect(await applyCaptureEffects(state.admin as never, pending)).toBe(pending);
    const done = shopOrder({ status: 'paid', intro_offer_applied: true, capture_effects_at: '2026-11-12T09:00:00.000Z' });
    expect(await applyCaptureEffects(state.admin as never, done)).toBe(done);
    expect(state.rpcCalls).toHaveLength(0);
  });
});

describe('paymentIntentFor', () => {
  it('rebuilds the Razorpay intent from the order, or null before it is linked', () => {
    process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID = 'rzp_test_public';
    expect(paymentIntentFor(shopOrder({ razorpay_order_id: 'order_R1', total_inr: 847 }))).toEqual({
      gateway: 'razorpay',
      gatewayOrderId: 'order_R1',
      amountInr: 847,
      keyId: 'rzp_test_public',
    });
    delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    expect(paymentIntentFor(shopOrder({ razorpay_order_id: null }))).toBeNull();
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
