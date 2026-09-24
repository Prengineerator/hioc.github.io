import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 · SUG-9 — POST /api/orders' surgical additions: accepting
// `suggestion_session_ids`, writing best-effort 'ordered' events after the
// order commits, and never failing the order over any of it. Mirrors the
// mock-Supabase harness in tests/ordersVerifiedPhone.test.ts.

const MENU_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const UNKNOWN_SESSION_ID = '66666666-6666-4666-8666-666666666666';

const state: {
  menuRows: Record<string, unknown>[];
  orderInsert?: Record<string, unknown>;
  sessionRows: { id: string; pick_ids: string[]; usual_item_id: string | null; created_at: string }[];
  insertedEvents: Record<string, unknown>[];
  profileUpdates: { user_id: string; computed_at: string }[];
  sessionUser: { id: string } | null;
} = { menuRows: [], sessionRows: [], insertedEvents: [], profileUpdates: [], sessionUser: null };

vi.mock('@/lib/flags', () => ({
  flags: {
    verifiedOrders: false,
    ownerDashboard: true,
    realtime: false,
    notifications: false,
    staffPos: true,
    tableQr: false,
    attendance: false,
    posV2: false,
    suggest: true,
  },
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: { inserted: boolean; lastUserId?: string } = { inserted: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (table === 'customer_taste_profiles' && col === 'user_id') {
            ctx.lastUserId = val;
            return Promise.resolve({ error: null }).then((r) => {
              state.profileUpdates.push({ user_id: val, computed_at: new Date(0).toISOString() });
              return r;
            });
          }
          return chain;
        },
        not: () => chain,
        in: (col: string, ids: string[]) => {
          if (table === 'menu_items') return Promise.resolve({ data: state.menuRows, error: null });
          if (table === 'suggestion_sessions') {
            return Promise.resolve({ data: state.sessionRows.filter((s) => ids.includes(s.id)), error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        update: () => ({
          eq: (col: string, val: string) => {
            state.profileUpdates.push({ user_id: val, computed_at: new Date(0).toISOString() });
            return Promise.resolve({ error: null });
          },
        }),
        insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
          if (table === 'orders') state.orderInsert = payload as Record<string, unknown>;
          if (table === 'suggestion_events') {
            state.insertedEvents.push(...(Array.isArray(payload) ? payload : [payload]));
            return Promise.resolve({ error: null });
          }
          if (table === 'orders' || table === 'order_items') {
            ctx.inserted = true;
            return chain;
          }
          return Promise.resolve({ error: null });
        },
        maybeSingle: () =>
          table === 'profiles'
            ? Promise.resolve({ data: { phone: '+919876543210', phone_verified: true }, error: null })
            : Promise.resolve({ data: null, error: null }),
        single: () => {
          if (table === 'order_items') return Promise.resolve({ data: { id: 'oi-1' }, error: null });
          if (table === 'orders' && ctx.inserted) {
            return Promise.resolve({ data: { ...state.orderInsert, id: ORDER_ID }, error: null });
          }
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
  getAuthUser: () => Promise.resolve(state.sessionUser),
  getStaffUser: () => Promise.resolve(null),
  actorRoleFor: (role: string) => (role === 'owner' || role === 'manager' ? 'owner' : 'staff'),
}));

vi.mock('@/lib/store/hours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/store/hours')>();
  return { ...actual, computeStoreOpenState: () => ({ acceptingOrders: true, reason: null }) };
});
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 20, pickup_slot_capacity: 0 }),
}));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/promotions/coupons', () => ({ validateAndComputeCoupon: () => Promise.resolve({ ok: false }) }));
vi.mock('@/lib/loyalty/ledger', () => ({
  quoteRedemption: () => Promise.resolve({ ok: false }),
  redeemForOrder: () => Promise.resolve(),
}));
vi.mock('@/lib/payments/gateway', () => ({ createPaymentIntent: () => Promise.resolve(null) }));

const { POST } = await import('@/app/api/orders/route');

const oneLatte = [{ menu_item_id: MENU_ID, variant_id: VARIANT_ID, quantity: 2, addon_option_ids: [] }];

function orderRequest(body: Record<string, unknown> = {}) {
  return new Request('http://t/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Ayush',
      customer_phone: '9876543210',
      pickup_slot_label: 'ASAP',
      items: oneLatte,
      ...body,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.orderInsert = undefined;
  state.insertedEvents = [];
  state.profileUpdates = [];
  // Signed in with a verified phone: guest orders must now be paid online and
  // every web order needs a verified mobile, so a counter-paid order is placed
  // the way a real signed-in customer places it.
  state.sessionUser = { id: 'user-1' };
  state.sessionRows = [
    {
      id: SESSION_ID,
      pick_ids: [MENU_ID],
      usual_item_id: null,
      created_at: new Date().toISOString(),
    },
  ];
  state.menuRows = [
    {
      id: MENU_ID,
      name: 'Latte',
      category: 'Coffee',
      is_available: true,
      unavailable_until: null,
      menu_item_variants: [{ id: VARIANT_ID, label: 'Regular', price_inr: 100, sort_order: 0 }],
      menu_item_addon_groups: [],
    },
  ];
});

describe('POST /api/orders — SUG-9 suggestion attribution', () => {
  it('an order with no suggestion_session_ids succeeds and writes nothing', async () => {
    const res = await POST(orderRequest());
    expect(res.status).toBe(201);
    expect(state.insertedEvents).toEqual([]);
  });

  it('an unknown session id still lets the order succeed, and writes nothing for it', async () => {
    const res = await POST(orderRequest({ suggestion_session_ids: [UNKNOWN_SESSION_ID] }));
    expect(res.status).toBe(201);
    expect(state.insertedEvents).toEqual([]);
  });

  it('a matching line produces an "ordered" event with the right value_inr and order_id', async () => {
    const res = await POST(orderRequest({ suggestion_session_ids: [SESSION_ID] }));
    expect(res.status).toBe(201);
    expect(state.insertedEvents).toEqual([
      {
        session_id: SESSION_ID,
        event: 'ordered',
        menu_item_id: MENU_ID,
        order_id: ORDER_ID,
        value_inr: 200, // 2 x ₹100
      },
    ]);
  });

  it('malformed suggestion_session_ids is ignored — never a 400', async () => {
    const res = await POST(orderRequest({ suggestion_session_ids: 'not-an-array' }));
    expect(res.status).toBe(201);
    expect(state.insertedEvents).toEqual([]);

    const res2 = await POST(orderRequest({ suggestion_session_ids: [123, null, 'not-a-uuid'] }));
    expect(res2.status).toBe(201);
    expect(state.insertedEvents).toEqual([]);
  });

  it('marks the taste profile stale for a signed-in order (best-effort)', async () => {
    const res = await POST(orderRequest());
    expect(res.status).toBe(201);
    expect(state.profileUpdates.some((u) => u.user_id === 'user-1')).toBe(true);
  });
});
