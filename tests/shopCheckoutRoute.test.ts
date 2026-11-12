import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';

// Handler-level test for POST /api/shop/checkout: the real pricing, address
// checks and Razorpay order call (fetch stubbed), on an in-memory database.
// Pins the money (₹49 shipping below 3 jars, free from 3), the refusals, and
// that a failed payment start leaves no order behind.

const state: {
  flags: { shop: boolean };
  admin: ReturnType<typeof makeFakeAdmin>;
  tables: Record<string, Row[]>;
  rzpCalls: Record<string, unknown>[];
  rzpStatus: number;
} = {
  flags: { shop: true },
  admin: makeFakeAdmin({}, { startMs: 0 }),
  tables: {},
  rzpCalls: [],
  rzpStatus: 200,
};

vi.mock('@/lib/flags', () => ({ flags: state.flags }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => state.admin }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(true), clientIp: () => '203.0.113.9' }));
vi.mock('@/lib/api/auth', () => ({ getAuthUser: () => Promise.resolve(null) }));

const { POST } = await import('@/app/api/shop/checkout/route');

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

function req(body: unknown) {
  return new Request('http://localhost/api/shop/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.flags.shop = true;
  state.rzpCalls = [];
  state.rzpStatus = 200;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  let orderNumber = 1000;
  state.tables = {
    shop_products: [
      { id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1 },
      { id: 'hazelnut', name: 'Nutty Hazelnut', sku: 'HIOC-IC-HAZELNUT-50G', price_inr: 399, net_qty: '50 g', in_stock: false, sort_order: 2 },
      { id: 'vanilla', name: 'French Vanilla', sku: 'HIOC-IC-VANILLA-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 3 },
    ],
    shop_orders: [],
  };
  state.admin = makeFakeAdmin(state.tables, {
    startMs: Date.parse('2026-11-12T08:00:00Z'),
    defaults: (table, row) => (table === 'shop_orders' ? { status: 'payment_pending', order_number: ++orderNumber, ...row } : row),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      state.rzpCalls.push({ url, ...JSON.parse(String(init.body ?? '{}')) });
      if (state.rzpStatus !== 200) return Promise.resolve(new Response('{"error":{}}', { status: state.rzpStatus }));
      return Promise.resolve(new Response(JSON.stringify({ id: 'order_RZ1', amount: 0, currency: 'INR' }), { status: 200 }));
    }),
  );
});

describe('POST /api/shop/checkout', () => {
  it('404s while the shop is switched off', async () => {
    state.flags.shop = false;
    const res = await POST(req({ items: [{ product_id: 'classic', quantity: 1 }], address: ADDRESS }));
    expect(res.status).toBe(404);
  });

  it('2 jars: charges ₹798 + ₹49 shipping = ₹847 and links the Razorpay order', async () => {
    const res = await POST(
      req({
        items: [
          { product_id: 'classic', quantity: 1 },
          { product_id: 'vanilla', quantity: 1 },
        ],
        address: ADDRESS,
        expected_total_inr: 847,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      order_number: 1001,
      total_inr: 847,
      payment: { gateway: 'razorpay', gatewayOrderId: 'order_RZ1', amountInr: 847, keyId: 'rzp_test_key' },
    });

    const [order] = state.tables.shop_orders;
    expect(order).toMatchObject({
      id: body.order_id,
      status: 'payment_pending',
      customer_name: 'Riya Sharma',
      phone: '+919876543210',
      jar_count: 2,
      subtotal_inr: 798,
      shipping_inr: 49,
      total_inr: 847,
      razorpay_order_id: 'order_RZ1',
      user_id: null,
    });
    expect((order.lines as unknown[]).length).toBe(2);

    expect(state.rzpCalls).toHaveLength(1);
    expect(state.rzpCalls[0]).toMatchObject({
      url: 'https://api.razorpay.com/v1/orders',
      amount: 84700,
      currency: 'INR',
      receipt: body.order_id,
      payment_capture: 1,
      notes: { hioc_shop_order_id: body.order_id, hioc_shop_order: 'HIOC-S1001' },
    });
  });

  it('3 jars ship free: ₹1,197', async () => {
    const res = await POST(req({ items: [{ product_id: 'vanilla', quantity: 3 }], address: ADDRESS }));
    expect(res.status).toBe(201);
    expect(state.tables.shop_orders[0]).toMatchObject({ jar_count: 3, subtotal_inr: 1197, shipping_inr: 0, total_inr: 1197 });
    expect(state.rzpCalls[0]).toMatchObject({ amount: 119700 });
  });

  it('points at the wrong address field with 400 and creates nothing', async () => {
    const res = await POST(req({ items: [{ product_id: 'classic', quantity: 1 }], address: { ...ADDRESS, pincode: '12' } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter the 6-digit pincode', field: 'pincode' });
    expect(state.tables.shop_orders).toHaveLength(0);
    expect(state.rzpCalls).toHaveLength(0);
  });

  it('refuses an empty cart and an out-of-stock flavour', async () => {
    expect((await POST(req({ items: [], address: ADDRESS }))).status).toBe(400);
    const res = await POST(req({ items: [{ product_id: 'hazelnut', quantity: 1 }], address: ADDRESS }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Nutty Hazelnut is out of stock right now.');
    expect(state.tables.shop_orders).toHaveLength(0);
  });

  it('409s with the new figures when the page showed a different total', async () => {
    const res = await POST(req({ items: [{ product_id: 'classic', quantity: 1 }], address: ADDRESS, expected_total_inr: 399 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.quote).toMatchObject({ subtotal_inr: 399, shipping_inr: 49, total_inr: 448 });
    expect(state.tables.shop_orders).toHaveLength(0);
    expect(state.rzpCalls).toHaveLength(0);
  });

  it('503s before creating anything when Razorpay is not configured', async () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    const res = await POST(req({ items: [{ product_id: 'classic', quantity: 1 }], address: ADDRESS }));
    expect(res.status).toBe(503);
    expect(state.tables.shop_orders).toHaveLength(0);
  });

  it('withdraws the order when Razorpay refuses', async () => {
    state.rzpStatus = 500;
    const res = await POST(req({ items: [{ product_id: 'classic', quantity: 1 }], address: ADDRESS }));
    expect(res.status).toBe(503);
    expect(state.tables.shop_orders).toHaveLength(0);
  });
});
