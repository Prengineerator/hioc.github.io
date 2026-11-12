import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildShiprocketOrder,
  cancelShiprocketOrder,
  createShiprocketOrder,
  fetchShiprocketOrder,
  parseCreatedOrder,
  parseOrderDetails,
  resetShiprocketTokenCache,
  shiprocketDate,
  shiprocketErrorMessage,
  SHIPROCKET_NOT_CONFIGURED,
} from '@/lib/shop/shiprocket';
import { shopOrder } from './helpers/shopFixture';

// The Shiprocket client (lib/shop/shiprocket.ts) with fetch stubbed: the order
// it builds, the login + token reuse + 401 renewal, and reading the answers
// loosely. Not a live check of Shiprocket itself (docs/INSTANT-COFFEE-SHOP.md).

const PKG = { weight_kg: 0.7, length_cm: 20, breadth_cm: 12, height_cm: 10 };

type Call = { url: string; method: string; auth: string | null; body: unknown };
let calls: Call[] = [];
let responder: (url: string, n: number) => Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  process.env.SHIPROCKET_EMAIL = 'api@hioc.test';
  process.env.SHIPROCKET_PASSWORD = 'secret';
  delete process.env.SHIPROCKET_PICKUP_LOCATION;
  resetShiprocketTokenCache();
  calls = [];
  responder = (url) => (url.endsWith('/auth/login') ? json({ token: 'tok1' }) : json({}));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init.method ?? 'GET', auth: headers.Authorization ?? null, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return Promise.resolve(responder(url, calls.length));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildShiprocketOrder', () => {
  it('builds a prepaid custom order from the shop order and the parcel', () => {
    const body = buildShiprocketOrder(shopOrder(), PKG, 'Primary');
    expect(body).toMatchObject({
      order_id: 'HIOC-S1001',
      order_date: '2026-11-12 14:05',
      pickup_location: 'Primary',
      billing_customer_name: 'Riya',
      billing_last_name: 'Sharma',
      billing_address: '12, Rose Villa, MG Road',
      billing_address_2: 'Near City Mall',
      billing_city: 'Jaipur',
      billing_pincode: '302001',
      billing_state: 'Rajasthan',
      billing_country: 'India',
      billing_email: 'riya@example.com',
      billing_phone: '9876543210',
      shipping_is_billing: true,
      payment_method: 'Prepaid',
      shipping_charges: 49,
      sub_total: 798,
      length: 20,
      breadth: 12,
      height: 10,
      weight: 0.7,
    });
    expect(body.order_items).toEqual([
      { name: 'HIOC. Premium Instant Coffee — Signature Classic (50 g)', sku: 'HIOC-IC-CLASSIC-50G', units: 2, selling_price: 399, discount: 0, tax: 0 },
    ]);
  });

  it('sends the offer as the order discount; the jars keep ₹399 each', () => {
    const body = buildShiprocketOrder(shopOrder({ jar_count: 3, subtotal_inr: 1197, discount_inr: 448, offer_name: 'Introductory offer', shipping_inr: 0, total_inr: 749, lines: [
      { product_id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', unit_price_inr: 399, quantity: 3, line_total_inr: 1197 },
    ] }), PKG, 'Primary');
    expect(body).toMatchObject({ total_discount: 448, sub_total: 749, shipping_charges: 0 });
    expect((body.order_items as { selling_price: number }[])[0].selling_price).toBe(399);
  });

  it('sends free shipping as 0 and a one-word name with an empty last name', () => {
    const body = buildShiprocketOrder(shopOrder({ customer_name: 'Riya', shipping_inr: 0 }), PKG, 'Agra Cafe');
    expect(body).toMatchObject({ billing_customer_name: 'Riya', billing_last_name: '', shipping_charges: 0, pickup_location: 'Agra Cafe' });
  });

  it('writes dates in India time', () => {
    expect(shiprocketDate('2026-11-12T20:00:00.000Z')).toBe('2026-11-13 01:30');
  });
});

describe('reading Shiprocket answers', () => {
  it('reads the create answer with numeric or string ids', () => {
    expect(parseCreatedOrder({ order_id: 281248157, shipment_id: 280640000, status: 'NEW', awb_code: '', courier_name: '' })).toEqual({
      shiprocketOrderId: '281248157',
      shipmentId: '280640000',
      status: 'NEW',
      awb: null,
      courier: null,
    });
    expect(parseCreatedOrder({ order_id: '77', awb_code: 'AWB1', courier_name: 'Delhivery' })).toMatchObject({ awb: 'AWB1', courier: 'Delhivery' });
    expect(parseCreatedOrder({ message: 'Invalid pickup location' })).toBeNull();
  });

  it('finds the AWB on a shipments object, a shipments list, or awb_data', () => {
    expect(parseOrderDetails({ data: { id: 1, status: 'SHIPPED', shipments: { id: 9, awb: 'A1', courier: 'Delhivery' } } })).toEqual({
      status: 'SHIPPED',
      awb: 'A1',
      courier: 'Delhivery',
      shipmentId: '9',
    });
    expect(parseOrderDetails({ data: { id: 1, status: 'IN TRANSIT', shipments: [{ id: 9, awb_code: 'A2', courier_name: 'Blue Dart' }] } })).toMatchObject({
      awb: 'A2',
      courier: 'Blue Dart',
    });
    expect(parseOrderDetails({ data: { id: 1, status: 'NEW', awb_data: { awb: 'A3' } } })).toMatchObject({ awb: 'A3' });
    expect(parseOrderDetails({ data: { id: 1, status: 'NEW', shipments: { id: 9, awb: '' } } })).toMatchObject({ awb: null });
    expect(parseOrderDetails('nonsense')).toBeNull();
  });

  it('turns an error body into one readable line', () => {
    expect(shiprocketErrorMessage({ message: 'Oops! Invalid Data.', errors: { billing_pincode: ['The billing pincode must be 6 digits.'] } }, 422)).toBe(
      'Shiprocket: Oops! Invalid Data. The billing pincode must be 6 digits.',
    );
    expect(shiprocketErrorMessage({}, 500)).toBe('Shiprocket answered HTTP 500');
  });
});

describe('createShiprocketOrder', () => {
  it('logs in once, then creates the order with the token', async () => {
    responder = (url) =>
      url.endsWith('/auth/login') ? json({ token: 'tok1' }) : json({ order_id: 5001, shipment_id: 6001, status: 'NEW', awb_code: '' });
    const r = await createShiprocketOrder(shopOrder(), PKG);
    expect(r).toEqual({ ok: true, created: { shiprocketOrderId: '5001', shipmentId: '6001', status: 'NEW', awb: null, courier: null } });
    expect(calls.map((c) => c.url)).toEqual([
      'https://apiv2.shiprocket.in/v1/external/auth/login',
      'https://apiv2.shiprocket.in/v1/external/orders/create/adhoc',
    ]);
    expect(calls[0].body).toEqual({ email: 'api@hioc.test', password: 'secret' });
    expect(calls[1].auth).toBe('Bearer tok1');
    expect((calls[1].body as Record<string, unknown>).pickup_location).toBe('Primary');

    // The token is reused for the next call.
    await fetchShiprocketOrder('5001');
    expect(calls.filter((c) => c.url.endsWith('/auth/login'))).toHaveLength(1);
  });

  it('uses SHIPROCKET_PICKUP_LOCATION when set', async () => {
    process.env.SHIPROCKET_PICKUP_LOCATION = 'Kamla Nagar';
    responder = (url) => (url.endsWith('/auth/login') ? json({ token: 't' }) : json({ order_id: 1 }));
    await createShiprocketOrder(shopOrder(), PKG);
    expect((calls[1].body as Record<string, unknown>).pickup_location).toBe('Kamla Nagar');
  });

  it('renews the token once on a 401', async () => {
    let logins = 0;
    responder = (url) => {
      if (url.endsWith('/auth/login')) return json({ token: `tok${++logins}` });
      return logins === 1 ? json({ message: 'Unauthenticated' }, 401) : json({ order_id: 42 });
    };
    const r = await createShiprocketOrder(shopOrder(), PKG);
    expect(r.ok).toBe(true);
    expect(logins).toBe(2);
    expect(calls.at(-1)?.auth).toBe('Bearer tok2');
  });

  it('says so when the login is refused', async () => {
    responder = () => json({ message: 'Invalid email and password combination' }, 403);
    const r = await createShiprocketOrder(shopOrder(), PKG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/refused the login/);
  });

  it('passes on Shiprocket’s validation message', async () => {
    responder = (url) =>
      url.endsWith('/auth/login') ? json({ token: 't' }) : json({ message: 'Wrong Pickup location entered.' }, 422);
    const r = await createShiprocketOrder(shopOrder(), PKG);
    expect(r).toEqual({ ok: false, error: 'Shiprocket: Wrong Pickup location entered.' });
  });

  it('refuses without calling anyone when it is not configured', async () => {
    delete process.env.SHIPROCKET_EMAIL;
    const r = await createShiprocketOrder(shopOrder(), PKG);
    expect(r).toEqual({ ok: false, error: SHIPROCKET_NOT_CONFIGURED });
    expect(calls).toHaveLength(0);
  });

  it('reports a network failure plainly', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNRESET'))));
    const r = await createShiprocketOrder(shopOrder(), PKG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Could not reach Shiprocket/);
  });
});

describe('fetch and cancel', () => {
  it('reads an order back and cancels by numeric id', async () => {
    responder = (url) => {
      if (url.endsWith('/auth/login')) return json({ token: 't' });
      if (url.includes('/orders/show/')) return json({ data: { id: 5001, status: 'PICKUP SCHEDULED', shipments: { id: 6001, awb: 'AWB55', courier: 'Xpressbees' } } });
      return json({ status: 200 });
    };
    const got = await fetchShiprocketOrder('5001');
    expect(got).toEqual({ ok: true, state: { status: 'PICKUP SCHEDULED', awb: 'AWB55', courier: 'Xpressbees', shipmentId: '6001' } });
    expect(calls[1].url).toBe('https://apiv2.shiprocket.in/v1/external/orders/show/5001');

    expect(await cancelShiprocketOrder('5001')).toEqual({ ok: true });
    expect(calls.at(-1)).toMatchObject({ url: 'https://apiv2.shiprocket.in/v1/external/orders/cancel', method: 'POST', body: { ids: [5001] } });
  });
});
