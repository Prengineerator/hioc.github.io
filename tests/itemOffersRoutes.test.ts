import { beforeEach, describe, expect, it, vi } from 'vitest';

// Multi-buy offers through the routes (lib/orders/offers.ts): the offer is its
// own record (menu_offers, Promotions → Offers) and the menu row is untouched.
// The quote the POS shows names the offer and keeps the jars at their regular
// price, a coupon is worked out on what is left after it, and the amend route
// works the offer out again on a void / an add and writes offer_discount_inr
// back only when it changed.

const COFFEE = '11111111-1111-4111-8111-111111111111';
const CLASSIC = '11111111-1111-4111-8111-1111111111a1';
const HAZELNUT = '11111111-1111-4111-8111-1111111111a2';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const JAR_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const JAR_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

const instantCoffeeRow = {
  id: COFFEE,
  name: 'Instant Coffee',
  category: 'In-store',
  is_available: true,
  unavailable_until: null,
  in_store_only: true,
  gst_exempt: true,
  menu_item_variants: [
    { id: CLASSIC, label: 'Classic', price_inr: 399, sort_order: 0 },
    { id: HAZELNUT, label: 'Hazelnut', price_inr: 399, sort_order: 10 },
  ],
  menu_item_addon_groups: [],
};

const OFFER_ID = '55555555-5555-4555-8555-555555555555';
const liveOffer = {
  id: OFFER_ID,
  name: 'Instant Coffee offer',
  menu_item_id: COFFEE,
  tier_prices: [299, 499, 599],
  active: true,
  valid_from: null,
  valid_to: null,
};

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  current: Record<string, unknown> | null;
  menuRows: Record<string, unknown>[];
  /** What a read of menu_offers answers. */
  offerRows: Record<string, unknown>[] | null;
  offerError?: { code: string } | null;
  orderPatch?: Record<string, unknown>;
  insertedLines: Record<string, unknown>[];
  couponSubtotal?: number;
} = { actor: null, current: null, menuRows: [], offerRows: [], insertedLines: [] };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false, isInsert: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders') state.orderPatch = p;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          ctx.isInsert = true;
          if (table === 'order_items') state.insertedLines.push(row);
          return table === 'order_items' ? chain : Promise.resolve({ error: null });
        },
        eq: () => chain,
        neq: () => chain,
        in: () =>
          table === 'menu_items'
            ? Promise.resolve({ data: state.menuRows, error: null })
            : table === 'menu_offers'
              ? Promise.resolve({ data: state.offerRows, error: state.offerError ?? null })
              : Promise.resolve({ data: null, error: null }),
        maybeSingle: () =>
          Promise.resolve(ctx.isUpdate ? { data: { id: ORDER_ID }, error: null } : { data: state.current, error: null }),
        single: () => Promise.resolve({ data: { id: 'new-line-1' }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(null),
  getCounterActor: () => Promise.resolve(state.actor),
  actorRoleFor: () => 'staff',
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 10 }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(null),
  toStoredPhone: (p: unknown) => (typeof p === 'string' ? p : ''),
}));
vi.mock('@/lib/promotions/coupons', () => ({
  // A flat ₹50 coupon; records what it was worked out on.
  validateAndComputeCoupon: (_code: string, ctx: { subtotalInr: number }) => {
    state.couponSubtotal = ctx.subtotalInr;
    return Promise.resolve({ ok: true, discountInr: 50 });
  },
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(0),
  quoteRedemption: () => Promise.resolve({ ok: false, reason: 'n/a' }),
}));

const { POST: quote } = await import('@/app/api/orders/quote/route');
const { POST: amend } = await import('@/app/api/orders/[id]/amend/route');

const post = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const jar = (variant_id: string, quantity = 1) => ({ menu_item_id: COFFEE, variant_id, quantity, addon_option_ids: [] });

beforeEach(() => {
  state.actor = { user: { id: 'staff-1' }, role: 'manager', via: 'session' };
  state.menuRows = [instantCoffeeRow];
  state.offerRows = [liveOffer];
  state.offerError = null;
  state.orderPatch = undefined;
  state.insertedLines = [];
  state.couponSubtotal = undefined;
});

describe('POST /api/orders/quote with an offer item', () => {
  it('prices the jars at ₹399 and takes the offer off as its own, named discount', async () => {
    const res = await quote(post('https://t/api/orders/quote', { items: [jar(CLASSIC), jar(HAZELNUT)], order_type: 'dine_in' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bill).toMatchObject({ subtotal_inr: 798, offer_discount_inr: 299, discount_inr: 299, tax_inr: 0, total_inr: 499 });
    expect(body.offers).toEqual([
      { menu_item_id: COFFEE, name: 'Instant Coffee offer', units: 2, regular_inr: 798, offer_inr: 499, discount_inr: 299 },
    ]);
  });

  it('with the offer switched off, ended, or the offers table not there yet, the jars are plain ₹399', async () => {
    for (const setup of [
      () => (state.offerRows = []),
      () => (state.offerRows = [{ ...liveOffer, valid_to: '2020-01-01T00:00:00Z' }]),
      () => {
        state.offerRows = null;
        state.offerError = { code: '42P01' };
      },
    ]) {
      setup();
      const body = await (
        await quote(post('https://t/api/orders/quote', { items: [jar(CLASSIC, 2)], order_type: 'dine_in' }))
      ).json();
      expect(body.bill).toMatchObject({ subtotal_inr: 798, offer_discount_inr: 0, discount_inr: 0, total_inr: 798 });
      expect(body.offers).toEqual([]);
    }
  });

  it('works a coupon out on what is left after the offer, and stacks it', async () => {
    const res = await quote(
      post('https://t/api/orders/quote', { items: [jar(CLASSIC, 3)], order_type: 'dine_in', coupon_code: 'SAVE50' }),
    );
    const body = await res.json();
    expect(state.couponSubtotal).toBe(599);
    expect(body.bill).toMatchObject({ subtotal_inr: 1197, offer_discount_inr: 598, discount_inr: 648, total_inr: 549 });
  });

  it('a legacy subtotal-only quote has no lines, so no offer', async () => {
    const body = await (await quote(post('https://t/api/orders/quote', { subtotal_inr: 399 }))).json();
    expect(body.offers).toEqual([]);
    expect(body.bill.offer_discount_inr).toBe(0);
  });
});

describe('POST /api/orders/[id]/amend with an offer on the order', () => {
  const jarLine = (id: string) => ({
    id,
    voided: false,
    quantity: 1,
    price_inr_snapshot: 399,
    line_total_inr: 399,
    gst_exempt: true,
    menu_item_id: COFFEE,
    name_snapshot: 'Instant Coffee',
    offer_prices: [299, 499, 599],
    offer_unit_inr: 399,
  });
  const order = (lines: Record<string, unknown>[], discount: number) => ({
    id: ORDER_ID,
    status: 'accepted',
    version: 1,
    order_type: 'dine_in',
    payment_status: 'unpaid',
    discount_inr: discount,
    offer_discount_inr: discount,
    order_items: lines,
  });

  it('voiding one jar of a pair re-prices the other at the 1-jar offer, even with the offer since switched off', async () => {
    state.offerRows = []; // the lines carry the offer they were sold under
    state.current = order([jarLine(JAR_A), jarLine(JAR_B)], 299);
    const res = await amend(post(`http://t/api/orders/${ORDER_ID}/amend`, { item_id: JAR_B, reason: 'wrong item' }), {
      params: { id: ORDER_ID },
    });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 399, discount_inr: 100, offer_discount_inr: 100, total_inr: 299 });
  });

  it('adding a jar to a running tab makes it a pair, and the new line carries the offer snapshot', async () => {
    state.current = order([jarLine(JAR_A)], 100);
    const res = await amend(post(`http://t/api/orders/${ORDER_ID}/amend`, { op: 'add', items: [jar(HAZELNUT)] }), {
      params: { id: ORDER_ID },
    });
    expect(res.status).toBe(200);
    expect(state.insertedLines[0]).toMatchObject({
      offer_id: OFFER_ID,
      offer_name: 'Instant Coffee offer',
      offer_prices: [299, 499, 599],
      offer_unit_inr: 399,
      line_total_inr: 399,
    });
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 798, discount_inr: 299, offer_discount_inr: 299, total_inr: 499 });
  });

  it('an order with no offer never sends the offer column', async () => {
    state.current = {
      ...order([{ ...jarLine(JAR_A), offer_prices: null }, { ...jarLine(JAR_B), offer_prices: null }], 0),
      offer_discount_inr: undefined,
    };
    const res = await amend(post(`http://t/api/orders/${ORDER_ID}/amend`, { item_id: JAR_B, reason: 'wrong item' }), {
      params: { id: ORDER_ID },
    });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 399, discount_inr: 0, total_inr: 399 });
    expect(state.orderPatch).not.toHaveProperty('offer_discount_inr');
  });
});
