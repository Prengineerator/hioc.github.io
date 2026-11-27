import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';

// Handler-level test for POST /api/shop/checkout (v2): the real pricing
// (serverQuote, quoteShopCart), address checks, idempotency and Razorpay order
// call (fetch stubbed), on an in-memory database. The loyalty ledger and the
// coupon lookups are stubbed. Pins the money, the refusals, the Idempotency-Key
// behaviour, the Beanies reservation, and that a failed payment start leaves no
// order (and no held Beanies) behind.

const state: {
  flags: { shop: boolean };
  admin: ReturnType<typeof makeFakeAdmin>;
  tables: Record<string, Row[]>;
  rzpCalls: Record<string, unknown>[];
  rzpStatus: number;
  user: { id: string; email: string; email_confirmed_at: string | null } | null;
  balance: number;
  redeemResult: string;
  redeemCalls: unknown[][];
  reverseCalls: { id: string; reason: string; orderStillThere: boolean }[];
  reverseResult: number;
  typed: Record<string, unknown> | null;
  auto: Record<string, unknown>[];
  raceInsert: Row | null;
} = {
  flags: { shop: true },
  admin: makeFakeAdmin({}, { startMs: 0 }),
  tables: {},
  rzpCalls: [],
  rzpStatus: 200,
  user: null,
  balance: 0,
  redeemResult: 'reserved',
  redeemCalls: [],
  reverseCalls: [],
  reverseResult: 25,
  typed: null,
  auto: [],
  raceInsert: null,
};

vi.mock('@/lib/flags', () => ({ flags: state.flags }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => state.admin }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(true), clientIp: () => '203.0.113.9' }));
vi.mock('@/lib/api/auth', () => ({ getAuthUser: () => Promise.resolve(state.user) }));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(state.balance),
  getLoyaltyConfig: () => Promise.resolve({ points_per_inr: 0.1, inr_per_point: 1, min_redeem_points: 50 }),
  redeemForShopOrder: (...args: unknown[]) => {
    state.redeemCalls.push(args);
    return Promise.resolve(state.redeemResult);
  },
  reverseForShopOrder: (id: string, reason: string) => {
    state.reverseCalls.push({ id, reason, orderStillThere: state.tables.shop_orders.some((o) => o.id === id) });
    return Promise.resolve(state.reverseResult);
  },
}));
vi.mock('@/lib/promotions/shopCoupons', () => ({
  findShopCoupon: (_a: unknown, code: string) =>
    Promise.resolve(state.typed && code.toUpperCase() === String(state.typed.code) ? { ok: true, terms: state.typed } : { ok: false, reason: "That code isn't valid" }),
  loadAutoShopCoupons: () => Promise.resolve(state.auto),
}));

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
const KEY = '3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69';
const CLASSIC = { product_id: 'classic', quantity: 1 };
const OFFER = { is_singleton: true, offer_active: true, offer_name: 'Introductory offer', offer_tier_prices: [399, 599, 749] };

const terms = (code: string, value: number, auto = false) => ({
  id: `c-${code}`,
  code,
  discount_type: 'flat',
  discount_value: value,
  min_order_inr: 0,
  max_discount_inr: 0,
  shop_product_ids: [],
  is_auto: auto,
});

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/shop/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const withKey = (body: unknown, key = KEY) => req(body, { 'Idempotency-Key': key });

/** The in-memory database; a racing tap's row is slipped in at insert time when raceInsert is set. */
function buildAdmin() {
  const base = makeFakeAdmin(state.tables, {
    startMs: Date.parse('2026-11-12T08:00:00Z'),
    defaults: (table, row) => (table === 'shop_orders' ? { status: 'payment_pending', order_number: 1000 + state.tables.shop_orders.length + 1, ...row } : row),
  });
  return {
    ...base,
    from: (table: string) => {
      const chain = base.from(table) as Record<string, unknown>;
      if (table === 'shop_orders' && state.raceInsert) {
        chain.insert = () => {
          state.tables.shop_orders.push(state.raceInsert as Row);
          state.raceInsert = null;
          return { select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "shop_orders_idempotency_key"' } }) }) };
        };
      }
      return chain;
    },
  } as unknown as ReturnType<typeof makeFakeAdmin>;
}

beforeEach(() => {
  state.flags.shop = true;
  state.rzpCalls = [];
  state.rzpStatus = 200;
  state.user = null;
  state.balance = 0;
  state.redeemResult = 'reserved';
  state.redeemCalls = [];
  state.reverseCalls = [];
  state.reverseResult = 25;
  state.typed = null;
  state.auto = [];
  state.raceInsert = null;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  state.tables = {
    shop_products: [
      { id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1 },
      { id: 'hazelnut', name: 'Nutty Hazelnut', sku: 'HIOC-IC-HAZELNUT-50G', price_inr: 399, net_qty: '50 g', in_stock: false, sort_order: 2 },
      { id: 'vanilla', name: 'French Vanilla', sku: 'HIOC-IC-VANILLA-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 3 },
      {
        id: 'home-blend-250',
        name: 'Signature Home Blend 250 g',
        sku: 'HIOC-HB-250G',
        price_inr: 550,
        net_qty: '250 g',
        in_stock: true,
        sort_order: 4,
        line: 'home_blend',
        display_name: 'Signature Home Blend 250 g',
        pack_grams: 250,
        ship_weight_kg: 0.25,
        listed: true,
        requires_grind: true,
        description: '',
      },
      { id: 'home-blend-1kg', name: 'Signature Home Blend 1 kg', sku: 'HIOC-HB-1KG', price_inr: 1, net_qty: '1 kg', in_stock: true, sort_order: 5, line: 'home_blend', display_name: 'Signature Home Blend 1 kg', pack_grams: 1000, ship_weight_kg: 1, listed: false, requires_grind: true, description: '' },
    ],
    shop_orders: [],
    shop_settings: [],
    shop_intro_claims: [],
    orders: [],
    customer_addresses: [],
  };
  state.admin = buildAdmin();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      state.rzpCalls.push({ url, ...JSON.parse(String(init.body ?? '{}')) });
      if (state.rzpStatus !== 200) return Promise.resolve(new Response('{"error":{}}', { status: state.rzpStatus }));
      return Promise.resolve(new Response(JSON.stringify({ id: `order_RZ${state.rzpCalls.length}`, amount: 0, currency: 'INR' }), { status: 200 }));
    }),
  );
});

describe('POST /api/shop/checkout', () => {
  it('404s while the shop is switched off', async () => {
    state.flags.shop = false;
    expect((await POST(req({ items: [CLASSIC], address: ADDRESS }))).status).toBe(404);
  });

  it('2 jars: charges ₹798 (free shipping from ₹749 of goods), freezes the v2 columns and links the Razorpay order', async () => {
    const res = await POST(
      req({ items: [CLASSIC, { product_id: 'vanilla', quantity: 1 }], address: ADDRESS, expected_total_inr: 798 }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      order_number: 1001,
      total_inr: 798,
      payment: { gateway: 'razorpay', gatewayOrderId: 'order_RZ1', amountInr: 798, keyId: 'rzp_test_key' },
    });

    const [order] = state.tables.shop_orders;
    expect(order).toMatchObject({
      id: body.order_id,
      status: 'payment_pending',
      customer_name: 'Riya Sharma',
      phone: '+919876543210',
      landmark: '',
      jar_count: 2,
      subtotal_inr: 798,
      offer_discount_inr: 0,
      coupon_discount_inr: 0,
      beanies_redeemed: 0,
      beanies_discount_inr: 0,
      discount_inr: 0,
      intro_offer_applied: false,
      shipping_inr: 0,
      total_inr: 798,
      goods_weight_kg: 0.6,
      razorpay_order_id: 'order_RZ1',
      idempotency_key: null,
      user_id: null,
    });
    expect((order.lines as unknown[]).length).toBe(2);
    expect(order.checkout_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(state.rzpCalls).toHaveLength(1);
    expect(state.rzpCalls[0]).toMatchObject({
      url: 'https://api.razorpay.com/v1/orders',
      amount: 79800,
      currency: 'INR',
      receipt: body.order_id,
      payment_capture: 1,
      notes: { hioc_shop_order_id: body.order_id, hioc_shop_order: 'HIOC-S1001' },
    });
  });

  it('a mixed cart (instant + Home Blend) freezes the grind, the line SKU and the weights', async () => {
    const res = await POST(
      req({ items: [CLASSIC, { product_id: 'home-blend-250', quantity: 1, grind: 'filter' }], address: ADDRESS, expected_total_inr: 949 }),
    );
    expect(res.status).toBe(201);
    const [order] = state.tables.shop_orders;
    expect(order).toMatchObject({ jar_count: 2, subtotal_inr: 949, shipping_inr: 0, total_inr: 949, goods_weight_kg: 0.55 });
    expect(order.lines).toEqual([
      expect.objectContaining({ product_id: 'classic', sku: 'HIOC-IC-CLASSIC-50G', line: 'instant', grind: null, ship_weight_kg: 0.3 }),
      expect.objectContaining({
        product_id: 'home-blend-250',
        name: 'Signature Home Blend 250 g',
        sku: 'HIOC-HB-250G-FLT',
        base_sku: 'HIOC-HB-250G',
        line: 'home_blend',
        pack_grams: 250,
        grind: 'filter',
        grind_label: 'Pour-over / Filter',
        ship_weight_kg: 0.25,
        line_total_inr: 550,
      }),
    ]);
    expect(state.rzpCalls[0]).toMatchObject({ amount: 94900 });
  });

  it('refuses a Home Blend without a grind, naming the pack', async () => {
    const res = await POST(req({ items: [{ product_id: 'home-blend-250', quantity: 1 }], address: ADDRESS }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Choose a grind for Signature Home Blend 250 g');
    expect(state.tables.shop_orders).toHaveLength(0);
  });

  it('refuses an unlisted product posted by hand, and a grind on an instant jar', async () => {
    const unlisted = await POST(req({ items: [{ product_id: 'home-blend-1kg', quantity: 1, grind: 'moka' }], address: ADDRESS }));
    expect(unlisted.status).toBe(400);
    const grind = await POST(req({ items: [{ product_id: 'classic', quantity: 1, grind: 'moka' }], address: ADDRESS }));
    expect(grind.status).toBe(400);
    expect(state.tables.shop_orders).toHaveLength(0);
    expect(state.rzpCalls).toHaveLength(0);
  });

  it('3 jars ship free: ₹1,197', async () => {
    const res = await POST(req({ items: [{ product_id: 'vanilla', quantity: 3 }], address: ADDRESS }));
    expect(res.status).toBe(201);
    expect(state.tables.shop_orders[0]).toMatchObject({ jar_count: 3, subtotal_inr: 1197, shipping_inr: 0, total_inr: 1197 });
  });

  describe('discounts', () => {
    it('the introductory offer is recorded as the offer column, and discount_inr is the sum', async () => {
      state.tables.shop_settings = [OFFER];
      const res = await POST(req({ items: [{ product_id: 'classic', quantity: 2 }], address: ADDRESS, expected_total_inr: 648 }));
      expect(res.status).toBe(201);
      expect(state.tables.shop_orders[0]).toMatchObject({
        subtotal_inr: 798,
        offer_name: 'Introductory offer',
        offer_discount_inr: 199,
        coupon_id: null,
        coupon_discount_inr: 0,
        intro_offer_applied: true,
        discount_inr: 199,
        shipping_inr: 49,
        total_inr: 648,
      });
      expect(state.rzpCalls[0]).toMatchObject({ amount: 64800 });
    });

    it('a customer who already had the offer pays full price', async () => {
      state.tables.shop_settings = [OFFER];
      state.tables.shop_intro_claims = [{ shop_order_id: 'old', user_id: null, phone: '+919876543210', email: 'old@example.com' }];
      const res = await POST(req({ items: [{ product_id: 'classic', quantity: 2 }], address: ADDRESS }));
      expect(res.status).toBe(201);
      expect(state.tables.shop_orders[0]).toMatchObject({ offer_discount_inr: 0, intro_offer_applied: false, offer_name: null, total_inr: 798 });
    });

    it('a bigger coupon beats the offer (no stacking) and is frozen on the order', async () => {
      state.tables.shop_settings = [OFFER];
      state.typed = terms('SAVE300', 300);
      const res = await POST(req({ items: [{ product_id: 'classic', quantity: 2 }], address: ADDRESS, coupon_code: 'save300' }));
      expect(res.status).toBe(201);
      expect(state.tables.shop_orders[0]).toMatchObject({
        offer_discount_inr: 0,
        offer_name: null,
        intro_offer_applied: false,
        coupon_id: 'c-SAVE300',
        coupon_code: 'SAVE300',
        coupon_discount_inr: 300,
        discount_inr: 300,
        total_inr: 547,
      });
    });

    it('the offer beats a smaller auto coupon', async () => {
      state.tables.shop_settings = [OFFER];
      state.auto = [terms('AUTO50', 50, true)];
      await POST(req({ items: [{ product_id: 'classic', quantity: 2 }], address: ADDRESS }));
      expect(state.tables.shop_orders[0]).toMatchObject({ offer_discount_inr: 199, coupon_id: null, coupon_discount_inr: 0, discount_inr: 199 });
    });

    it('a typed code that does not apply is a 409 with the quote, before anything is created', async () => {
      state.auto = [terms('AUTO20', 20, true)];
      const res = await POST(req({ items: [CLASSIC], address: ADDRESS, coupon_code: 'WRONG' }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ error: "That code isn't valid", code: 'coupon', quote: { coupon_code: 'AUTO20', total_inr: 428 } });
      expect(state.tables.shop_orders).toHaveLength(0);
    });

    it('409s with the new figures when the page showed a different total', async () => {
      const res = await POST(req({ items: [CLASSIC], address: ADDRESS, expected_total_inr: 399 }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({
        error: "Prices changed: here's the new total",
        code: 'price_changed',
        quote: { subtotal_inr: 399, discount_inr: 0, shipping_inr: 49, total_inr: 448 },
      });
      expect(state.tables.shop_orders).toHaveLength(0);
      expect(state.rzpCalls).toHaveLength(0);
    });
  });

  describe('Beanies', () => {
    beforeEach(() => {
      state.user = { id: 'user-1', email: 'riya@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
      state.balance = 400;
      state.tables.orders = [{ id: 'cafe-1', user_id: 'user-1', payment_status: 'paid' }];
    });

    it('are reserved through the ledger RPC and stacked with the offer; discount_inr is the sum', async () => {
      state.tables.shop_settings = [OFFER];
      const res = await POST(req({ items: [{ product_id: 'classic', quantity: 2 }], address: ADDRESS }));
      expect(res.status).toBe(201);
      // goods after the offer: 599; 5% = 29 Beanies at ₹1 each.
      expect(state.tables.shop_orders[0]).toMatchObject({
        user_id: 'user-1',
        offer_discount_inr: 199,
        beanies_redeemed: 29,
        beanies_discount_inr: 29,
        discount_inr: 228,
        total_inr: 798 - 228 + 49,
      });
      expect(state.redeemCalls).toEqual([[state.tables.shop_orders[0].id, 'user-1', 29, 29, 'HIOC-S1001']]);
      expect(state.reverseCalls).toHaveLength(0);
    });

    it('use_beanies: false spends none', async () => {
      const res = await POST(req({ items: [CLASSIC], address: ADDRESS, use_beanies: false }));
      expect(res.status).toBe(201);
      expect(state.redeemCalls).toHaveLength(0);
      expect(state.tables.shop_orders[0]).toMatchObject({ beanies_redeemed: 0, total_inr: 448 });
    });

    it("'insufficient' withdraws the order, creates no Razorpay order, and 409s with a new quote", async () => {
      state.redeemResult = 'insufficient';
      const res = await POST(req({ items: [CLASSIC], address: ADDRESS }));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: 'Your Beanies balance changed — please check the new total.',
        code: 'beanies_changed',
        quote: { total_inr: expect.any(Number) },
      });
      expect(state.tables.shop_orders).toHaveLength(0);
      expect(state.rzpCalls).toHaveLength(0);
      expect(state.reverseCalls).toHaveLength(0); // nothing was held
    });

    it('a Razorpay failure gives the Beanies back first, then deletes the order', async () => {
      state.rzpStatus = 500;
      const res = await POST(req({ items: [CLASSIC], address: ADDRESS }));
      expect(res.status).toBe(503);
      expect(state.reverseCalls).toEqual([{ id: expect.any(String), reason: 'checkout not started', orderStillThere: true }]);
      expect(state.tables.shop_orders).toHaveLength(0);
    });

    it('keeps the order (for the expiry pass) if the Beanies could not be released', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      state.rzpStatus = 500;
      state.reverseResult = 0;
      const res = await POST(req({ items: [CLASSIC], address: ADDRESS }));
      expect(res.status).toBe(503);
      expect(state.tables.shop_orders).toHaveLength(1);
      err.mockRestore();
    });

    it('a guest never reserves Beanies', async () => {
      state.user = null;
      await POST(req({ items: [CLASSIC], address: ADDRESS }));
      expect(state.redeemCalls).toHaveLength(0);
    });
  });

  describe('delivery address', () => {
    const SAVED = {
      id: '0b1c2d3e-0000-4000-8000-00000000a001',
      user_id: 'user-1',
      label: 'Home',
      customer_name: 'Riya Sharma',
      phone: '+919876543210',
      address_line1: '12, Rose Villa, MG Road',
      address_line2: '',
      landmark: 'Near the temple',
      city: 'Jaipur',
      state: 'Rajasthan',
      pincode: '302001',
      location_lat: 26.9124,
      location_lng: 75.7873,
      location_source: 'map',
    };
    beforeEach(() => {
      state.user = { id: 'user-1', email: 'login@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
      state.tables.customer_addresses = [{ ...SAVED }, { ...SAVED, id: '0b1c2d3e-0000-4000-8000-00000000a002', user_id: 'someone-else' }];
    });

    it('a saved address is read from the account, with the verified login email and its pin', async () => {
      const res = await POST(req({ items: [CLASSIC], address_id: SAVED.id }));
      expect(res.status).toBe(201);
      expect(state.tables.shop_orders[0]).toMatchObject({
        customer_name: 'Riya Sharma',
        email: 'login@example.com',
        landmark: 'Near the temple',
        pincode: '302001',
        customer_address_id: SAVED.id,
        save_address_label: null,
        location_lat: 26.9124,
        location_source: 'map',
        user_id: 'user-1',
      });
    });

    it('the typed email beats the login email; an unverified login email is not used', async () => {
      await POST(req({ items: [CLASSIC], address_id: SAVED.id, address: { email: 'Other@Example.com' } }));
      expect(state.tables.shop_orders[0].email).toBe('other@example.com');
      state.tables.shop_orders = [];
      state.user = { id: 'user-1', email: 'login@example.com', email_confirmed_at: null };
      const res = await POST(req({ items: [CLASSIC], address_id: SAVED.id }));
      expect(res.status).toBe(400);
      expect((await res.json()).field).toBe('email');
    });

    it("refuses someone else's address, an unknown one, and a guest's", async () => {
      for (const id of ['0b1c2d3e-0000-4000-8000-00000000a002', '0b1c2d3e-0000-4000-8000-00000000ffff', 'nope']) {
        const res = await POST(req({ items: [CLASSIC], address_id: id }));
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('Choose a delivery address');
      }
      state.user = null;
      expect((await POST(req({ items: [CLASSIC], address_id: SAVED.id, address: ADDRESS }))).status).toBe(400);
      expect(state.tables.shop_orders).toHaveLength(0);
    });

    it('save_address records only the label (the address is saved when the payment is captured)', async () => {
      const res = await POST(req({ items: [CLASSIC], address: ADDRESS, save_address: { label: ' Work ' } }));
      expect(res.status).toBe(201);
      expect(state.tables.shop_orders[0]).toMatchObject({ save_address_label: 'Work', customer_address_id: null });
      expect(state.tables.customer_addresses).toHaveLength(2); // nothing added yet
    });

    it('save_address is ignored for a guest, and for a saved address', async () => {
      await POST(req({ items: [CLASSIC], address_id: SAVED.id, save_address: { label: 'Work' } }));
      expect(state.tables.shop_orders[0].save_address_label).toBeNull();
      state.user = null;
      await POST(req({ items: [CLASSIC], address: ADDRESS, save_address: { label: 'Work' } }));
      expect(state.tables.shop_orders[1].save_address_label).toBeNull();
    });

    it('a label over 20 characters is refused', async () => {
      const res = await POST(req({ items: [CLASSIC], address: ADDRESS, save_address: { label: 'x'.repeat(21) } }));
      expect(res.status).toBe(400);
    });
  });

  it('stores the delivery pin, and refuses one outside India', async () => {
    const ok = await POST(req({ items: [CLASSIC], address: ADDRESS, location: { lat: 26.9124, lng: 75.7873, accuracy_m: 15, source: 'gps' } }));
    expect(ok.status).toBe(201);
    expect(state.tables.shop_orders[0]).toMatchObject({ location_lat: 26.9124, location_lng: 75.7873, location_accuracy_m: 15, location_source: 'gps' });

    const bad = await POST(req({ items: [CLASSIC], address: ADDRESS, location: { lat: 40.7, lng: -74 } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe('location');
    expect(state.tables.shop_orders).toHaveLength(1);
  });

  it('points at the wrong address field with 400 and creates nothing', async () => {
    const res = await POST(req({ items: [CLASSIC], address: { ...ADDRESS, pincode: '12' } }));
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

  it('503s before creating anything when Razorpay is not configured', async () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    const res = await POST(req({ items: [CLASSIC], address: ADDRESS }));
    expect(res.status).toBe(503);
    expect(state.tables.shop_orders).toHaveLength(0);
  });

  it('withdraws the order when Razorpay refuses', async () => {
    state.rzpStatus = 500;
    const res = await POST(req({ items: [CLASSIC], address: ADDRESS }));
    expect(res.status).toBe(503);
    expect(state.tables.shop_orders).toHaveLength(0);
    expect(state.reverseCalls).toHaveLength(0); // no Beanies were held
  });

  describe('Idempotency-Key', () => {
    const body = () => ({ items: [CLASSIC, { product_id: 'vanilla', quantity: 1 }], address: ADDRESS });

    it('refuses a key that is not a uuid', async () => {
      const res = await POST(req(body(), { 'Idempotency-Key': 'not-a-uuid' }));
      expect(res.status).toBe(400);
      expect(state.tables.shop_orders).toHaveLength(0);
    });

    it('stores the key, and a second tap of the same cart gets the same order and intent, with nothing new created', async () => {
      const first = await POST(withKey(body()));
      expect(first.status).toBe(201);
      const a = await first.json();
      expect(state.tables.shop_orders[0].idempotency_key).toBe(KEY);

      const second = await POST(withKey(body(), KEY.toUpperCase()));
      expect(second.status).toBe(200);
      const b = await second.json();
      expect(b).toEqual({ ...a, reused: true });
      expect(state.tables.shop_orders).toHaveLength(1);
      expect(state.rzpCalls).toHaveLength(1);
    });

    it('is not fooled by the order of the cart or the fields', async () => {
      await POST(withKey(body()));
      const reordered = { address: ADDRESS, items: [{ quantity: 1, product_id: 'vanilla' }, { quantity: 1, product_id: 'classic' }] };
      const again = await POST(withKey(reordered));
      expect(again.status).toBe(200);
      expect((await again.json()).reused).toBe(true);
      expect(state.tables.shop_orders).toHaveLength(1);
    });

    it('the same key with a different cart is 409 idempotency_mismatch', async () => {
      await POST(withKey(body()));
      const changed = await POST(withKey({ ...body(), items: [{ product_id: 'classic', quantity: 3 }] }));
      expect(changed.status).toBe(409);
      expect(await changed.json()).toEqual({ error: 'Your order changed — tap Pay again.', code: 'idempotency_mismatch' });
      expect(state.tables.shop_orders).toHaveLength(1);
      expect(state.rzpCalls).toHaveLength(1);
    });

    it('an order already paid answers already_paid', async () => {
      const first = await (await POST(withKey(body()))).json();
      state.tables.shop_orders[0].status = 'paid';
      const again = await POST(withKey(body()));
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ order_id: first.order_id, order_number: first.order_number, total_inr: first.total_inr, already_paid: true });
      expect(state.rzpCalls).toHaveLength(1);
    });

    it('an expired or cancelled order is 409 idempotency_expired', async () => {
      await POST(withKey(body()));
      for (const status of ['expired', 'cancelled']) {
        state.tables.shop_orders[0].status = status;
        const res = await POST(withKey(body()));
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({ error: 'That payment window closed — tap Pay again.', code: 'idempotency_expired' });
      }
    });

    it('two taps racing past the lookup: the unique-index loser answers with the winner’s order', async () => {
      const first = await (await POST(withKey(body()))).json();
      const winner = { ...state.tables.shop_orders[0] };
      state.tables.shop_orders = [];
      state.admin = buildAdmin(); // fresh handle over the emptied table
      state.raceInsert = winner;

      const loser = await POST(withKey(body()));
      expect(loser.status).toBe(200);
      expect(await loser.json()).toMatchObject({ order_id: first.order_id, reused: true, payment: { gatewayOrderId: 'order_RZ1' } });
      expect(state.tables.shop_orders).toHaveLength(1);
      expect(state.rzpCalls).toHaveLength(1); // the loser never reached Razorpay
    });

    it('works without a key, as before (nothing stored)', async () => {
      const res = await POST(req(body()));
      expect(res.status).toBe(201);
      expect(state.tables.shop_orders[0].idempotency_key).toBeNull();
    });
  });
});
