import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shopOrder } from './helpers/shopFixture';
import type { ShopOrderRow } from '@/lib/shop/types';

// The owner's Amazon Shipping routes with fetch (Amazon) stubbed and the
// database faked: rates books nothing, book claims once and releases on a
// failure, refresh earns Beanies once and never moves backwards, cancel-label
// works only before pickup, and Cancel order cancels an uncollected label.

const ID = '7d0c3f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
const s = {
  order: null as ShopOrderRow | null,
  earned: [] as string[],
  shippedEmails: [] as string[],
  refunds: [] as { paymentId: string; amount: number }[],
  failSave: false,
};

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve({ id: 'owner' }) }));
vi.mock('@/lib/api/background', () => ({ runAfterResponse: () => {} }));
vi.mock('@/lib/shop/emails', () => ({
  sendShopShippedEmail: (o: ShopOrderRow) => {
    s.shippedEmails.push(o.id);
    return Promise.resolve();
  },
  sendShopCancelledEmail: () => Promise.resolve(),
}));
vi.mock('@/lib/payments/gateway', () => ({
  createGatewayRefund: (paymentId: string, amount: number) => {
    s.refunds.push({ paymentId, amount });
    return Promise.resolve({ id: 'rfnd_1' });
  },
}));
vi.mock('@/lib/shop/payments', () => ({ captureShopPayment: () => Promise.resolve({ handled: false }) }));
vi.mock('@/lib/shop/lifecycle', () => ({
  onShopOrderDelivered: (o: ShopOrderRow) => {
    s.earned.push(o.id);
    return Promise.resolve({ earned: 8 });
  },
  onShopOrderCancelled: () => Promise.resolve({ beanies_returned: 0 }),
}));
vi.mock('@/lib/shop/server', async (orig) => ({
  ...(await orig<typeof import('@/lib/shop/server')>()),
  amazonColumnsReady: () => Promise.resolve(true),
  getShopOrder: () => Promise.resolve({ ok: true, order: s.order }),
  updateShopOrderIf: (_a: unknown, _id: string, from: string[], patch: Record<string, unknown>) => {
    if (s.failSave || !s.order || !from.includes(s.order.status)) return Promise.resolve(null);
    s.order = { ...s.order, ...patch } as ShopOrderRow;
    return Promise.resolve(s.order);
  },
}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => {
    const chain: Record<string, unknown> & { patch?: Record<string, unknown> } = {};
    const apply = () => {
      if (s.order && chain.patch) s.order = { ...s.order, ...chain.patch } as ShopOrderRow;
    };
    Object.assign(chain, {
      update: (patch: Record<string, unknown>) => {
        chain.patch = patch;
        return chain;
      },
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      or: () => chain,
      select: () => chain,
      // An awaited update with no select (the claim release).
      then: (resolve: (v: unknown) => void) => {
        apply();
        resolve({ data: null, error: null });
      },
      maybeSingle: () => {
        const o = s.order;
        const patch = chain.patch ?? {};
        if (typeof patch.amazon_booking_at === 'string') {
          // The booking claim: only while paid, unsent and not claimed in the last 2 minutes.
          const fresh = o?.amazon_booking_at && Date.now() - new Date(o.amazon_booking_at).getTime() < 2 * 60 * 1000;
          if (!o || o.status !== 'paid' || o.shiprocket_order_id || o.amazon_shipment_id || fresh) return Promise.resolve({ data: null, error: null });
          apply();
          return Promise.resolve({ data: { id: ID }, error: null });
        }
        if (patch.refund_id === 'pending') {
          if (!o || o.refund_id) return Promise.resolve({ data: null, error: null });
          apply();
          return Promise.resolve({ data: { id: ID }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    });
    return { from: () => chain, rpc: () => Promise.resolve({ error: null }) };
  },
}));

const { POST: rates } = await import('@/app/api/owner/shop/orders/[id]/amazon/rates/route');
const { POST: book } = await import('@/app/api/owner/shop/orders/[id]/amazon/book/route');
const { GET: label } = await import('@/app/api/owner/shop/orders/[id]/amazon/label/route');
const { POST: refresh } = await import('@/app/api/owner/shop/orders/[id]/amazon/refresh/route');
const { POST: cancelLabel } = await import('@/app/api/owner/shop/orders/[id]/amazon/cancel-label/route');
const { POST: cancelOrder } = await import('@/app/api/owner/shop/orders/[id]/cancel/route');
const { resetAmazonTokenCache } = await import('@/lib/shop/amazonShipping');

const params = { params: { id: ID } };
const req = (body?: unknown) => new Request('http://localhost/x', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const BOOK = { requestToken: 'rt-1', rateId: 'R1', serviceName: 'Standard', chargeInr: 62 };

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let tracking = 'InTransit';
let purchaseAnswer: () => Response;
let cancelAnswer: () => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const purchases = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/shipping/v2/shipments'));
const cancels = () => calls.filter((c) => c.method === 'PUT' && c.url.endsWith('/cancel'));

const ENV: Record<string, string> = {
  AMAZON_SHIPPING_CLIENT_ID: 'cid',
  AMAZON_SHIPPING_CLIENT_SECRET: 'csecret',
  AMAZON_SHIPPING_REFRESH_TOKEN: 'rtoken',
  AMAZON_SHIPPING_FROM_NAME: 'HIOC Cafe',
  AMAZON_SHIPPING_FROM_PHONE: '9811111111',
  AMAZON_SHIPPING_FROM_ADDRESS1: '5 Test Lane',
  AMAZON_SHIPPING_FROM_CITY: 'Agra',
  AMAZON_SHIPPING_FROM_STATE: 'Uttar Pradesh',
  AMAZON_SHIPPING_FROM_PINCODE: '282001',
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  resetAmazonTokenCache();
  s.order = null;
  s.earned = [];
  s.shippedEmails = [];
  s.refunds = [];
  s.failSave = false;
  calls = [];
  tracking = 'InTransit';
  purchaseAnswer = () =>
    json({ payload: { shipmentId: 'SHP1', packageDocumentDetails: [{ trackingId: 'TRK1', packageDocuments: [{ type: 'LABEL', format: 'PDF', contents: 'JVBERi0xLjQ=' }] }] } });
  cancelAnswer = () => json({});
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const raw = init.body ? String(init.body) : '';
      calls.push({ url, method: init.method ?? 'GET', body: raw && url.includes('/shipping/') ? JSON.parse(raw) : undefined });
      if (url.includes('/auth/o2/token')) return Promise.resolve(json({ access_token: 'acc1', expires_in: 3600 }));
      if (url.endsWith('/shipments/rates')) {
        return Promise.resolve(json({ payload: { requestToken: 'rt-1', rates: [
          { rateId: 'R2', serviceName: 'Express', totalCharge: { value: 95, unit: 'INR' }, promise: { deliveryWindow: { end: '2026-11-22T18:00:00Z' } } },
          { rateId: 'R1', serviceName: 'Standard', totalCharge: { value: 62, unit: 'INR' }, promise: { deliveryWindow: { end: '2026-11-24T18:00:00Z' } } },
        ] } }));
      }
      if (url.endsWith('/shipping/v2/shipments') && init.method === 'POST') return Promise.resolve(purchaseAnswer());
      if (url.includes('/documents')) return Promise.resolve(json({ payload: { shipmentId: 'SHP1', packageDocumentDetails: [{ packageDocuments: [{ type: 'LABEL', contents: 'JVBERi0xLjQ=' }] }] } }));
      if (url.includes('/shipping/v2/tracking')) return Promise.resolve(json({ payload: { trackingId: 'TRK1', summary: { status: tracking } } }));
      if (url.endsWith('/cancel')) return Promise.resolve(cancelAnswer());
      return Promise.resolve(json({}));
    }),
  );
});

const amazonShipped = (patch: Partial<ShopOrderRow> = {}) =>
  shopOrder({ id: ID, status: 'shipped', carrier: 'amazon', amazon_shipment_id: 'SHP1', amazon_service_name: 'Standard', amazon_charge_inr: 62, awb_code: 'TRK1', courier_name: 'Amazon Shipping', shipped_at: '2026-11-20T05:00:00.000Z', ...patch });

describe('POST amazon/rates', () => {
  it('lists the services cheapest first and books nothing', async () => {
    s.order = shopOrder({ id: ID });
    const res = await rates(req({}), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requestToken).toBe('rt-1');
    expect(body.rates.map((r: { rateId: string; chargeInr: number }) => [r.rateId, r.chargeInr])).toEqual([['R1', 62], ['R2', 95]]);
    expect(body.parcel).toMatchObject({ weight_kg: expect.any(Number), length_cm: expect.any(Number) });
    expect(purchases()).toHaveLength(0);
    expect(cancels()).toHaveLength(0);
    expect(s.order!.status).toBe('paid');
    expect(s.order!.amazon_shipment_id).toBeNull();
  });

  it('prices the parcel the owner typed, and refuses a bad one', async () => {
    s.order = shopOrder({ id: ID });
    const res = await rates(req({ weight_kg: 1.2, length_cm: 25, breadth_cm: 15, height_cm: 10 }), params);
    expect((await res.json()).parcel).toEqual({ weight_kg: 1.2, length_cm: 25, breadth_cm: 15, height_cm: 10 });
    const sent = calls.find((c) => c.url.endsWith('/shipments/rates'))!.body as { packages: { weight: { value: number } }[] };
    expect(sent.packages[0].weight.value).toBe(1.2);
    expect((await rates(req({ weight_kg: 99, length_cm: 25, breadth_cm: 15, height_cm: 10 }), params)).status).toBe(400);
  });

  it('refuses an order that is not a paid, unsent one', async () => {
    s.order = shopOrder({ id: ID, shiprocket_order_id: 'sr1' });
    expect((await rates(req({}), params)).status).toBe(409);
    s.order = amazonShipped();
    expect((await rates(req({}), params)).status).toBe(409);
    expect(calls.filter((c) => c.url.endsWith('/shipments/rates'))).toHaveLength(0);
  });

  it('answers with the missing settings when Amazon is not set up', async () => {
    delete process.env.AMAZON_SHIPPING_CLIENT_SECRET;
    s.order = shopOrder({ id: ID });
    const res = await rates(req({}), params);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('AMAZON_SHIPPING_CLIENT_SECRET');
    expect(calls).toHaveLength(0);
  });
});

describe('POST amazon/book', () => {
  it('books once: the order ships with Amazon, the label comes back, the email goes, a second tap is 409', async () => {
    s.order = shopOrder({ id: ID });
    const res = await book(req(BOOK), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.label).toBe('JVBERi0xLjQ=');
    expect(body.order).toMatchObject({
      status: 'shipped', carrier: 'amazon', amazon_shipment_id: 'SHP1', amazon_service_name: 'Standard', amazon_charge_inr: 62,
      awb_code: 'TRK1', courier_name: 'Amazon Shipping', amazon_booking_at: null,
    });
    expect(body.order.shipped_at).toEqual(expect.any(String));
    expect(body.order.package_dims_cm).toMatch(/×/);
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0].body).toMatchObject({ requestToken: 'rt-1', rateId: 'R1' });
    expect(s.shippedEmails).toEqual([ID]);

    const again = await book(req(BOOK), params);
    expect(again.status).toBe(409);
    expect(purchases()).toHaveLength(1);
  });

  it('a double tap while the first is in flight is 409 and buys nothing', async () => {
    s.order = shopOrder({ id: ID, amazon_booking_at: new Date().toISOString() });
    expect((await book(req(BOOK), params)).status).toBe(409);
    expect(purchases()).toHaveLength(0);
    // A claim older than 2 minutes is stale: a retry may go.
    s.order = shopOrder({ id: ID, amazon_booking_at: new Date(Date.now() - 3 * 60 * 1000).toISOString() });
    expect((await book(req(BOOK), params)).status).toBe(200);
    expect(purchases()).toHaveLength(1);
  });

  it('releases the claim when Amazon refuses, so the owner can try again', async () => {
    purchaseAnswer = () => json({ errors: [{ code: 'RateExpired', message: 'The rate has expired' }] }, 400);
    s.order = shopOrder({ id: ID });
    const res = await book(req(BOOK), params);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('Amazon Shipping: The rate has expired');
    expect(s.order!.status).toBe('paid');
    expect(s.order!.amazon_booking_at).toBeNull();
    expect(s.shippedEmails).toEqual([]);
    purchaseAnswer = () => json({ payload: { shipmentId: 'SHP9', packageDocumentDetails: [{ trackingId: 'TRK9' }] } });
    expect((await book(req(BOOK), params)).status).toBe(200);
    expect(s.order!.amazon_shipment_id).toBe('SHP9');
  });

  it('trusts the charge Amazon returns over the one the owner saw', async () => {
    purchaseAnswer = () => json({ payload: { shipmentId: 'SHP1', totalCharge: { value: 58.5, unit: 'INR' }, packageDocumentDetails: [{ trackingId: 'TRK1' }] } });
    s.order = shopOrder({ id: ID });
    const body = await (await book(req(BOOK), params)).json();
    expect(body.order.amazon_charge_inr).toBe(58.5);
    expect(body.label).toBeUndefined();
  });

  it('refuses a bad request before touching Amazon', async () => {
    s.order = shopOrder({ id: ID });
    expect((await book(req({ ...BOOK, chargeInr: -5 }), params)).status).toBe(400);
    expect((await book(req({ ...BOOK, chargeInr: 'abc' }), params)).status).toBe(400);
    expect((await book(req({ ...BOOK, rateId: '' }), params)).status).toBe(400);
    expect((await book(req({ ...BOOK, requestToken: undefined }), params)).status).toBe(400);
    expect((await book(req({ ...BOOK, serviceName: '' }), params)).status).toBe(400);
    expect((await book(req({ ...BOOK, weight_kg: 0, length_cm: 1, breadth_cm: 1, height_cm: 1 }), params)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('says plainly not to book again when Amazon booked but the save failed', async () => {
    s.order = shopOrder({ id: ID });
    s.failSave = true;
    const res = await book(req(BOOK), params);
    expect(res.status).toBe(500);
    const msg = (await res.json()).error as string;
    expect(msg).toContain('SHP1');
    expect(msg).toContain("Don't book it again");
    expect(s.shippedEmails).toEqual([]);
  });

  it('refuses an order already with Shiprocket without calling Amazon', async () => {
    s.order = shopOrder({ id: ID, shiprocket_order_id: 'sr1' });
    expect((await book(req(BOOK), params)).status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe('GET amazon/label', () => {
  it('returns the label as a PDF that is not cached', async () => {
    s.order = amazonShipped();
    const res = await label(new Request('http://localhost/x'), params);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).toString('base64')).toBe('JVBERi0xLjQ=');
    expect(calls.find((c) => c.url.includes('/documents'))!.url).toContain('packageClientReferenceId=HIOC-S1001');
  });

  it('refuses an order not booked with Amazon', async () => {
    s.order = shopOrder({ id: ID, status: 'shipped', shiprocket_order_id: 'sr1' });
    expect((await label(new Request('http://localhost/x'), params)).status).toBe(409);
  });
});

describe('POST amazon/refresh', () => {
  it('Delivered moves the order to delivered and earns Beanies once', async () => {
    tracking = 'Delivered';
    s.order = amazonShipped();
    const res = await refresh(req(), params);
    expect(res.status).toBe(200);
    const { order } = await res.json();
    expect(order).toMatchObject({ status: 'delivered', amazon_status: 'Delivered' });
    expect(order.delivered_at).toEqual(expect.any(String));
    expect(s.earned).toEqual([ID]);
    // Refreshing a delivered order again moves nothing and earns nothing more.
    await refresh(req(), params);
    expect(s.earned).toEqual([ID]);
  });

  it('in transit only saves the status, and never moves a delivered order backwards', async () => {
    s.order = amazonShipped();
    const res = await refresh(req(), params);
    expect((await res.json()).order).toMatchObject({ status: 'shipped', amazon_status: 'InTransit' });
    expect(s.earned).toEqual([]);

    s.order = amazonShipped({ status: 'delivered', amazon_status: 'Delivered', delivered_at: '2026-11-22T10:00:00.000Z' });
    await refresh(req(), params);
    expect(s.order!.status).toBe('delivered');
    expect(s.earned).toEqual([]);
  });

  it.each(['Rejected', 'Undeliverable', 'Lost'])('%s is not delivered', async (status) => {
    tracking = status;
    s.order = amazonShipped();
    await refresh(req(), params);
    expect(s.order!.status).toBe('shipped');
    expect(s.order!.amazon_status).toBe(status);
    expect(s.earned).toEqual([]);
  });

  it('refuses an order that is not with Amazon', async () => {
    s.order = shopOrder({ id: ID, status: 'shipped', shiprocket_order_id: 'sr1' });
    expect((await refresh(req(), params)).status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe('POST amazon/cancel-label', () => {
  it('before pickup: cancels at Amazon, then returns the order to To ship with the Amazon fields cleared', async () => {
    s.order = amazonShipped({ amazon_status: 'PreTransit' });
    const res = await cancelLabel(req(), params);
    expect(res.status).toBe(200);
    expect((await res.json()).order).toMatchObject({
      status: 'paid', carrier: null, amazon_shipment_id: null, amazon_service_name: null, amazon_charge_inr: null,
      amazon_status: null, awb_code: null, courier_name: null, shipped_at: null,
    });
    expect(cancels()).toHaveLength(1);
    expect(cancels()[0].url).toContain('/shipments/SHP1/cancel');
    // It can go again, by either carrier.
    const rated = await rates(req({}), params);
    expect(rated.status).toBe(200);
  });

  it('after pickup: refused, and Amazon is not asked', async () => {
    s.order = amazonShipped({ amazon_status: 'InTransit' });
    expect((await cancelLabel(req(), params)).status).toBe(409);
    expect(cancels()).toHaveLength(0);
    expect(s.order!.status).toBe('shipped');
  });

  it('leaves the order alone when Amazon refuses the cancel', async () => {
    cancelAnswer = () => json({ errors: [{ message: 'Shipment already picked up' }] }, 400);
    s.order = amazonShipped();
    const res = await cancelLabel(req(), params);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('Shipment already picked up');
    expect(s.order!.status).toBe('shipped');
    expect(s.order!.amazon_shipment_id).toBe('SHP1');
  });
});

describe('POST cancel (Cancel order and refund)', () => {
  it('cancels an Amazon label the courier has not collected, and refunds ₹847', async () => {
    s.order = amazonShipped({ amazon_status: 'PreTransit' });
    const res = await cancelOrder(req({ reason: 'customer asked' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.status).toBe('cancelled');
    expect(body.warning).toBeUndefined();
    expect(cancels()).toHaveLength(1);
    expect(s.refunds).toEqual([{ paymentId: 'pay_P1', amount: 847 }]);
  });

  it('warns, still refunding, when Amazon will not cancel the label', async () => {
    cancelAnswer = () => json({ errors: [{ message: 'Try later' }] }, 500);
    s.order = amazonShipped();
    const body = await (await cancelOrder(req({}), params)).json();
    expect(body.order.status).toBe('cancelled');
    expect(body.warning).toContain("Amazon Shipping didn't cancel the label");
    expect(s.refunds).toHaveLength(1);
  });

  it('a collected parcel is not cancelled at Amazon; the owner is told to arrange the return', async () => {
    s.order = amazonShipped({ amazon_status: 'InTransit' });
    const body = await (await cancelOrder(req({}), params)).json();
    expect(cancels()).toHaveLength(0);
    expect(body.warning).toContain('already with Amazon Shipping');
  });
});
