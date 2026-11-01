import { beforeEach, describe, expect, it, vi } from 'vitest';

// Spend offers through the routes: the quote (what the counter shows), a void
// on the amend route, and the owner's app/api/spend-offers. "Spend ₹1099 on
// everything else, get one Instant Coffee jar at ₹49" — never with a coupon.

const COFFEE = '11111111-1111-4111-8111-111111111111';
const CLASSIC = '11111111-1111-4111-8111-1111111111a1';
const WAFFLE = '22222222-2222-4222-8222-222222222222';
const WAFFLE_R = '22222222-2222-4222-8222-2222222222b1';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const SPEND_ID = '66666666-6666-4666-8666-666666666666';
const WAFFLE_LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const JAR_LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const EXTRA_LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

const menuRows = [
  {
    id: COFFEE,
    name: 'Instant Coffee',
    category: 'In-store',
    is_available: true,
    unavailable_until: null,
    in_store_only: true,
    gst_exempt: true,
    menu_item_variants: [{ id: CLASSIC, label: 'Classic', price_inr: 399, sort_order: 0 }],
    menu_item_addon_groups: [],
  },
  {
    id: WAFFLE,
    name: 'Waffle',
    category: 'Stick Waffles',
    is_available: true,
    unavailable_until: null,
    menu_item_variants: [{ id: WAFFLE_R, label: 'Regular', price_inr: 157, sort_order: 0 }],
    menu_item_addon_groups: [],
  },
];
const spendRow = {
  id: SPEND_ID,
  name: 'Instant Coffee at ₹49',
  menu_item_id: COFFEE,
  min_spend_inr: 1099,
  price_inr: 49,
  active: true,
  valid_from: null,
  valid_to: null,
};

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  manager: { id: string } | null;
  current: Record<string, unknown> | null;
  spendRows: Record<string, unknown>[];
  coupon: boolean;
  /** What a read of spend_offer_redemptions answers (who has had it). */
  redemptions: Record<string, unknown>[];
  orderPatch?: Record<string, unknown>;
  inserted?: Record<string, unknown>;
  writesTo: string[];
  deletedFrom: string[];
} = { actor: null, manager: null, current: null, spendRows: [], coupon: false, redemptions: [], writesTo: [], deletedFrom: [] };

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
        insert: (p: Record<string, unknown>) => {
          ctx.isInsert = true;
          state.writesTo.push(table);
          if (table === 'spend_offers') state.inserted = p;
          return table === 'order_items' || table === 'spend_offers' ? chain : Promise.resolve({ error: null });
        },
        delete: () => {
          state.deletedFrom.push(table);
          return chain;
        },
        eq: () => chain,
        neq: () => chain,
        order: () => Promise.resolve({ data: [], error: null }),
        in: () => {
          if (table === 'menu_items') return Promise.resolve({ data: menuRows, error: null });
          if (table === 'spend_offers') return Promise.resolve({ data: state.spendRows, error: null });
          if (table === 'spend_offer_redemptions') return Promise.resolve({ data: state.redemptions, error: null });
          return Promise.resolve({ data: [], error: null }); // menu_offers: no multi-buy here
        },
        maybeSingle: () =>
          Promise.resolve(
            table === 'menu_items'
              ? { data: { id: COFFEE, sold_by_weight: false }, error: null }
              : ctx.isUpdate
                ? { data: { id: ORDER_ID }, error: null }
                : { data: state.current, error: null },
          ),
        single: () =>
          Promise.resolve({ data: { ...(state.inserted ?? {}), id: SPEND_ID, menu_items: { name: 'Instant Coffee' } }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(null),
  getCounterActor: () => Promise.resolve(state.actor),
  getManagerUser: () => Promise.resolve(state.manager),
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
  validateAndComputeCoupon: () =>
    Promise.resolve(state.coupon ? { ok: true, discountInr: 100 } : { ok: false, discountInr: 0, reason: 'Invalid coupon code' }),
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(0),
  quoteRedemption: () => Promise.resolve({ ok: false, reason: 'n/a' }),
}));

const { POST: quote } = await import('@/app/api/orders/quote/route');
const { POST: amend } = await import('@/app/api/orders/[id]/amend/route');
const { POST: createSpendOffer } = await import('@/app/api/spend-offers/route');

const post = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const cart = [
  { menu_item_id: WAFFLE, variant_id: WAFFLE_R, quantity: 7, addon_option_ids: [] },
  { menu_item_id: COFFEE, variant_id: CLASSIC, quantity: 1, addon_option_ids: [] },
];

beforeEach(() => {
  state.actor = { user: { id: 'staff-1' }, role: 'manager', via: 'session' };
  state.manager = { id: 'owner-1' };
  state.spendRows = [spendRow];
  state.coupon = false;
  state.redemptions = [];
  state.orderPatch = undefined;
  state.inserted = undefined;
  state.writesTo = [];
  state.deletedFrom = [];
});

const PHONE = '9876543210';

describe('POST /api/orders/quote with a spend offer', () => {
  it('₹1099 of other items + a jar: the jar comes off to ₹49, named on the bill', async () => {
    const body = await (await quote(post('https://t/api/orders/quote', { items: cart, order_type: 'dine_in', customer_phone: PHONE }))).json();
    expect(body.bill).toMatchObject({ subtotal_inr: 1498, offer_discount_inr: 350, discount_inr: 350 });
    expect(body.offers).toEqual([
      { offer_id: SPEND_ID, menu_item_id: COFFEE, name: 'Instant Coffee at ₹49', units: 1, regular_inr: 399, offer_inr: 49, discount_inr: 350 },
    ]);
    expect(body.offer_notes).toEqual(['Instant Coffee at ₹49: no Beanies are earned on this bill.']);
  });

  it('with a coupon applied it stays off and the counter is told why', async () => {
    state.coupon = true;
    const body = await (
      await quote(post('https://t/api/orders/quote', { items: cart, order_type: 'dine_in', coupon_code: 'SAVE100', customer_phone: PHONE }))
    ).json();
    expect(body.bill).toMatchObject({ offer_discount_inr: 0, discount_inr: 100 });
    expect(body.offers).toEqual([]);
    expect(body.offer_notes).toEqual(["Instant Coffee at ₹49 isn't applied: it can't be combined with a coupon or Beanies."]);
  });

  it('a coupon that turns out invalid does not block it', async () => {
    const body = await (
      await quote(post('https://t/api/orders/quote', { items: cart, order_type: 'dine_in', coupon_code: 'NOPE', customer_phone: PHONE }))
    ).json();
    expect(body.bill.offer_discount_inr).toBe(350);
  });

  it('once per customer: no phone number, no ₹49 jar — and the counter is asked for it', async () => {
    const body = await (await quote(post('https://t/api/orders/quote', { items: cart, order_type: 'dine_in' }))).json();
    expect(body.bill.offer_discount_inr).toBe(0);
    expect(body.offer_notes).toEqual(["Instant Coffee at ₹49: add the customer's phone number to give it (once per customer)."]);
  });

  it('once per customer: a number that had it on an earlier order is refused, with the reason', async () => {
    state.redemptions = [{ spend_offer_id: SPEND_ID, order_id: 'earlier-order', orders: { status: 'completed' } }];
    const body = await (
      await quote(post('https://t/api/orders/quote', { items: cart, order_type: 'dine_in', customer_phone: PHONE }))
    ).json();
    expect(body.bill.offer_discount_inr).toBe(0);
    expect(body.offer_notes).toEqual(["Instant Coffee at ₹49 isn't applied: this customer has already had it (once per customer)."]);
  });

  it('an earlier order that was cancelled does not use it up', async () => {
    state.redemptions = [{ spend_offer_id: SPEND_ID, order_id: 'earlier-order', orders: { status: 'cancelled' } }];
    const body = await (
      await quote(post('https://t/api/orders/quote', { items: cart, order_type: 'dine_in', customer_phone: PHONE }))
    ).json();
    expect(body.bill.offer_discount_inr).toBe(350);
  });

  it('switched off (or the table not created yet), the jar is plain ₹399', async () => {
    state.spendRows = [];
    const body = await (await quote(post('https://t/api/orders/quote', { items: cart, order_type: 'dine_in', customer_phone: PHONE }))).json();
    expect(body.bill).toMatchObject({ offer_discount_inr: 0, discount_inr: 0 });
  });
});

describe('POST /api/orders/[id]/amend on an order with the ₹49 jar', () => {
  const order = (wafflesQty: number) => ({
    id: ORDER_ID,
    status: 'accepted',
    version: 1,
    order_type: 'dine_in',
    payment_status: 'unpaid',
    discount_inr: 350,
    offer_discount_inr: 350,
    offer_name: 'Instant Coffee at ₹49',
    spend_offers: [{ id: SPEND_ID, name: 'Instant Coffee at ₹49', menu_item_id: COFFEE, min_spend_inr: 1099, price_inr: 49 }],
    order_items: [
      {
        id: WAFFLE_LINE,
        voided: false,
        quantity: wafflesQty,
        price_inr_snapshot: 157,
        line_total_inr: 157 * wafflesQty,
        menu_item_id: WAFFLE,
        name_snapshot: 'Waffle',
      },
      {
        id: JAR_LINE,
        voided: false,
        quantity: 1,
        price_inr_snapshot: 399,
        line_total_inr: 399,
        gst_exempt: true,
        menu_item_id: COFFEE,
        name_snapshot: 'Instant Coffee',
        offer_unit_inr: 399,
      },
    ],
  });

  it('voiding the waffles takes the bill under ₹1099: the jar is back at ₹399 and the label is cleared', async () => {
    state.current = order(7);
    const res = await amend(post(`http://t/api/orders/${ORDER_ID}/amend`, { item_id: WAFFLE_LINE, reason: 'wrong item' }), {
      params: { id: ORDER_ID },
    });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 399, discount_inr: 0, offer_discount_inr: 0, offer_name: null, total_inr: 399 });
    // The customer's once-per-customer record goes with it, so they can have it another time.
    expect(state.deletedFrom).toEqual(['spend_offer_redemptions']);
  });

  it('voiding something else while the rest still qualifies keeps the ₹49 jar and its record', async () => {
    state.current = { ...order(8), order_items: [...(order(8).order_items as object[]), { id: EXTRA_LINE, voided: false, quantity: 1, price_inr_snapshot: 157, line_total_inr: 157, menu_item_id: WAFFLE, name_snapshot: 'Waffle' }] };
    const res = await amend(post(`http://t/api/orders/${ORDER_ID}/amend`, { item_id: EXTRA_LINE, reason: 'wrong item' }), {
      params: { id: ORDER_ID },
    });
    expect(res.status).toBe(200);
    // ₹1255 of waffles still qualifies: the ₹350 stays (unchanged, so not rewritten).
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 1655, discount_inr: 350 });
    expect(state.orderPatch).not.toHaveProperty('offer_discount_inr');
    expect(state.orderPatch).not.toHaveProperty('offer_name');
    expect(state.deletedFrom).toEqual([]);
  });
});

describe('POST /api/spend-offers', () => {
  const body = { name: 'Instant Coffee at ₹49', menu_item_id: COFFEE, min_spend_inr: 1099, price_inr: 49 };

  it('creates the offer as its own record, never writing the menu item', async () => {
    const res = await createSpendOffer(post('http://t/api/spend-offers', body));
    expect(res.status).toBe(201);
    expect(state.writesTo).toEqual(['spend_offers']);
    expect(state.inserted).toMatchObject({ ...body, active: true, valid_from: null, valid_to: null });
  });

  it('is for managers and the owner, and checks the amounts', async () => {
    expect((await createSpendOffer(post('http://t/api/spend-offers', { ...body, min_spend_inr: 0 }))).status).toBe(400);
    expect((await createSpendOffer(post('http://t/api/spend-offers', { ...body, price_inr: 4.5 }))).status).toBe(400);
    state.manager = null;
    expect((await createSpendOffer(post('http://t/api/spend-offers', body))).status).toBe(401);
    expect(state.writesTo).toEqual([]);
  });
});
