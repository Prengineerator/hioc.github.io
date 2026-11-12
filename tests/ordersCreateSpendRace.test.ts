import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/orders and the once-per-number spend offer race: two orders for one
// number placed at the same moment both pass the "had it?" read, and
// recordSpendRedemption (lib/orders/offersServer.ts) answers 'taken' to the
// later one. That order is withdrawn and the counter told to re-check the bill,
// exactly as a lost coupon race is handled.

vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));

const LATTE = '11111111-1111-4111-8111-111111111111';
const LATTE_V = '22222222-2222-4222-8222-222222222222';
const JAR = '55555555-5555-4555-8555-555555555555';
const JAR_V = '66666666-6666-4666-8666-666666666666';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';

const state: {
  orderInsert?: Record<string, unknown>;
  deleted: string[];
  spendResult: 'recorded' | 'taken' | 'failed';
} = { deleted: [], spendResult: 'recorded' };

const menuRows = [
  {
    id: LATTE,
    name: 'Latte',
    category: 'Beverages',
    is_available: true,
    unavailable_until: null,
    menu_item_variants: [{ id: LATTE_V, label: 'Regular', price_inr: 600, sort_order: 0 }],
    menu_item_addon_groups: [],
  },
  {
    id: JAR,
    name: 'Instant Coffee',
    category: 'Retail',
    is_available: true,
    unavailable_until: null,
    menu_item_variants: [{ id: JAR_V, label: '50 g', price_inr: 399, sort_order: 0 }],
    menu_item_addon_groups: [],
  },
];

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { inserted: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (ctx.inserted === false && table === 'orders' && col === 'id' && (chain as { deleting?: boolean }).deleting) {
            state.deleted.push(val);
          }
          return chain;
        },
        not: () => chain,
        in: () => Promise.resolve({ data: menuRows, error: null }),
        delete: () => {
          (chain as { deleting?: boolean }).deleting = true;
          return chain;
        },
        insert: (payload: Record<string, unknown>) => {
          if (table === 'orders') state.orderInsert = payload;
          if (table === 'orders' || table === 'order_items') {
            ctx.inserted = true;
            return chain;
          }
          return Promise.resolve({ error: null });
        },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () =>
          Promise.resolve({
            data: { ...state.orderInsert, id: ORDER_ID, order_items: [] },
            error: null,
          }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: 'staff', via: 'session' }),
  getAuthUser: () => Promise.resolve({ id: 'staff-1' }),
  getStaffUser: () => Promise.resolve(null),
  actorRoleFor: () => 'staff',
}));
vi.mock('@/lib/store/hours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/store/hours')>();
  return { ...actual, computeStoreOpenState: () => ({ acceptingOrders: true, reason: null }) };
});
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0, pickup_slot_capacity: 0 }),
}));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/promotions/coupons', () => ({ validateAndComputeCoupon: () => Promise.resolve({ ok: false }) }));
vi.mock('@/lib/loyalty/ledger', () => ({
  quoteRedemption: () => Promise.resolve({ ok: false }),
  redeemForOrder: () => Promise.resolve(),
  reverseForOrder: () => Promise.resolve(),
}));
vi.mock('@/lib/payments/gateway', () => ({ createPaymentIntent: () => Promise.resolve(null) }));
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(null),
  createCounterCustomer: () => Promise.resolve(null),
}));
vi.mock('@/lib/orders/idempotency', () => ({
  readIdempotencyKey: () => null,
  claimIdempotencyKey: () => Promise.resolve({ state: 'claimed' }),
  completeIdempotencyKey: () => Promise.resolve(),
  releaseIdempotencyKey: () => Promise.resolve(),
}));
const spend = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/lib/orders/offersServer', () => ({
  loadActiveOffers: () => Promise.resolve(new Map()),
  loadActiveSpendOffers: () =>
    Promise.resolve([{ id: 'spend-1', name: 'Jar at ₹49', menu_item_id: JAR, min_spend_inr: 1099, price_inr: 49 }]),
  loadSpendOfferBlocks: () => Promise.resolve(new Map()),
  recordSpendRedemption: (...args: unknown[]) => spend.record(...args),
}));

const { POST } = await import('@/app/api/orders/route');

const order = {
  customer_name: 'Asha',
  customer_phone: '9000000000',
  pickup_slot_label: 'ASAP',
  items: [
    { menu_item_id: LATTE, variant_id: LATTE_V, quantity: 2, addon_option_ids: [] },
    { menu_item_id: JAR, variant_id: JAR_V, quantity: 1, addon_option_ids: [] },
  ],
};
const post = () =>
  POST(new Request('http://t/api/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) }));

beforeEach(() => {
  state.orderInsert = undefined;
  state.deleted = [];
  spend.record.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/orders — the once-per-number spend offer race', () => {
  it('records the offer and keeps the order when this order is the one that has it', async () => {
    spend.record.mockResolvedValue('recorded');
    const res = await post();
    expect(res.status).toBe(201);
    expect(spend.record).toHaveBeenCalledWith(expect.anything(), { offerId: 'spend-1', phone: '+919000000000', orderId: ORDER_ID });
    expect(state.deleted).toEqual([]);
  });

  it("withdraws the order and answers 409 when another order for the number got it first ('taken')", async () => {
    spend.record.mockResolvedValue('taken');
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already|just been used/);
    expect(state.deleted).toEqual([ORDER_ID]);
  });

  it("keeps the order when the record could not be written ('failed' — logged, as before)", async () => {
    spend.record.mockResolvedValue('failed');
    expect((await post()).status).toBe(201);
    expect(state.deleted).toEqual([]);
  });
});
