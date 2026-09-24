import { beforeEach, describe, expect, it, vi } from 'vitest';

// Issue-3 regression lock, creation path: a bill must only go out once a
// payment is actually RECORDED. The one order that's genuinely settled AT
// CREATION is a fully-discounted (coupon) ₹0 order — payment_status 'paid'
// from the top of POST /api/orders — so it alone should bill immediately;
// every other web order (unpaid pay-at-counter, or the gateway-unavailable
// fallback) must NOT. Mirrors the harness in tests/ordersCreateStaff.test.ts.

const MENU_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';

const state: {
  orderInsert?: Record<string, unknown>;
  menuRows: Record<string, unknown>[];
} = { menuRows: [] };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    rpc: (name: string) =>
      name === 'try_redeem_coupon' ? Promise.resolve({ data: true, error: null }) : Promise.resolve({ data: true, error: null }),
    from: (table: string) => {
      const ctx = { inserted: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        in: () => Promise.resolve({ data: state.menuRows, error: null }),
        insert: (payload: Record<string, unknown>) => {
          if (table === 'orders') state.orderInsert = payload;
          if (table === 'orders' || table === 'order_items') {
            ctx.inserted = true;
            return chain;
          }
          return Promise.resolve({ error: null });
        },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => {
          if (table === 'order_items') return Promise.resolve({ data: { id: 'oi-1' }, error: null });
          // Both the post-insert `.select().single()` and the later reload
          // resolve to the same committed row — good enough for this test.
          return Promise.resolve({
            data: {
              ...state.orderInsert,
              id: ORDER_ID,
              order_items: [
                { id: 'oi-1', order_id: ORDER_ID, menu_item_id: MENU_ID, order_item_addons: [] },
              ],
            },
            error: null,
          });
        },
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getStaffOrOwner: () => Promise.resolve(null),
  getAuthUser: () => Promise.resolve(null),
  getStaffUser: () => Promise.resolve(null),
  actorRoleFor: () => 'staff',
}));

vi.mock('@/lib/store/hours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/store/hours')>();
  return { ...actual, computeStoreOpenState: () => ({ acceptingOrders: true, reason: null }) };
});
// No tax/packaging so a full coupon discount lands the order at exactly ₹0.
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({ gst_percent: 0, gst_inclusive: false, packaging_charge_inr: 0, pickup_slot_capacity: 0 }),
}));

const { sendBillNotification } = vi.hoisted(() => ({
  sendBillNotification: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification }));

vi.mock('@/lib/promotions/coupons', () => ({
  // A 100%-off coupon: discount equals whatever subtotal it's asked to cover.
  validateAndComputeCoupon: (_code: string, ctx: { subtotalInr: number }) =>
    Promise.resolve({
      ok: true,
      discountInr: ctx.subtotalInr,
      coupon: { id: 'coupon-1', usage_limit: null, per_user_limit: null },
    }),
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  quoteRedemption: () => Promise.resolve({ ok: false }),
  redeemForOrder: () => Promise.resolve(),
  reverseForOrder: () => Promise.resolve(),
}));
vi.mock('@/lib/payments/gateway', () => ({ createPaymentIntent: () => Promise.resolve(null) }));

const { POST } = await import('@/app/api/orders/route');

function req(body: unknown) {
  return new Request('http://t/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const oneLatte = [{ menu_item_id: MENU_ID, variant_id: VARIANT_ID, quantity: 2, addon_option_ids: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  state.orderInsert = undefined;
  state.menuRows = [
    {
      id: MENU_ID,
      name: 'Latte',
      category: 'Beverages',
      is_available: true,
      unavailable_until: null,
      menu_item_variants: [{ id: VARIANT_ID, label: 'Regular', price_inr: 100, sort_order: 0 }],
      menu_item_addon_groups: [],
    },
  ];
});

describe('POST /api/orders — issue-3: bill only when actually paid at creation', () => {
  it('a fully-discounted (₹0) guest order is paid at creation and its bill sends immediately', async () => {
    const res = await POST(
      req({
        customer_name: 'Asha',
        pickup_slot_label: 'ASAP',
        items: oneLatte,
        payment_mode: 'online',
        coupon_code: 'FREE100',
      }),
    );
    expect(res.status).toBe(201);
    expect(state.orderInsert?.total_inr).toBe(0);
    expect(state.orderInsert?.payment_status).toBe('paid');
    expect(state.orderInsert?.status).toBe('received'); // needsOnlinePayment is false when total is 0
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });
});
