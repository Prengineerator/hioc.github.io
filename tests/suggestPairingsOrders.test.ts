import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey checkout pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.3) — POST
// /api/orders' surgical addition: accepting `pairing_lines`, writing best-effort
// 'ordered' pairing_events rows after the order commits, and never failing the
// order over any of it. Same mock-Supabase harness as
// tests/suggestOrdersAttribution.test.ts.

const MENU_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const ANCHOR_ID = '55555555-5555-4555-8555-555555555555';
const NOT_ON_ORDER = '66666666-6666-4666-8666-666666666666';

const state: {
  menuRows: Record<string, unknown>[];
  orderInsert?: Record<string, unknown>;
  pairingInserts: Record<string, unknown>[];
  pairingInsertError: { message: string } | null;
  pairingInsertThrows: boolean;
  sessionUser: { id: string } | null;
} = { menuRows: [], pairingInserts: [], pairingInsertError: null, pairingInsertThrows: false, sessionUser: null };

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
    suggest: false,
    checkoutPairings: true,
  },
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: { inserted: boolean } = { inserted: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        in: () => (table === 'menu_items' ? Promise.resolve({ data: state.menuRows, error: null }) : Promise.resolve({ data: [], error: null })),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
          if (table === 'orders') state.orderInsert = payload as Record<string, unknown>;
          if (table === 'pairing_events') {
            if (state.pairingInsertThrows) throw new Error('insert exploded');
            state.pairingInserts.push(...(Array.isArray(payload) ? payload : [payload]));
            return Promise.resolve({ error: state.pairingInsertError });
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
              order_items: [{ id: 'oi-1', order_id: ORDER_ID, menu_item_id: MENU_ID, order_item_addons: [] }],
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
  getCounterActor: () => Promise.resolve(null),
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

const oneBrownie = [{ menu_item_id: MENU_ID, variant_id: VARIANT_ID, quantity: 2, addon_option_ids: [] }];

function orderRequest(body: Record<string, unknown> = {}) {
  return new Request('http://t/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Ayush',
      customer_phone: '9876543210',
      pickup_slot_label: 'ASAP',
      items: oneBrownie,
      ...body,
    }),
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  state.orderInsert = undefined;
  state.pairingInserts = [];
  state.pairingInsertError = null;
  state.pairingInsertThrows = false;
  state.sessionUser = { id: 'user-1' };
  state.menuRows = [
    {
      id: MENU_ID,
      name: 'Fudge Brownie',
      category: 'Desserts',
      is_available: true,
      unavailable_until: null,
      menu_item_variants: [{ id: VARIANT_ID, label: 'Regular', price_inr: 100, sort_order: 0 }],
      menu_item_addon_groups: [],
    },
  ];
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('POST /api/orders — checkout pairing attribution', () => {
  it('an order with no pairing_lines succeeds and writes nothing', async () => {
    const res = await POST(orderRequest());
    expect(res.status).toBe(201);
    expect(state.pairingInserts).toEqual([]);
  });

  it('a pairing line for an item on the order writes one "ordered" row: order, user and value from the order', async () => {
    const res = await POST(orderRequest({ pairing_lines: [{ menu_item_id: MENU_ID, anchor_item_id: ANCHOR_ID }] }));
    expect(res.status).toBe(201);
    expect(state.pairingInserts).toEqual([
      {
        user_id: 'user-1',
        event: 'ordered',
        menu_item_id: MENU_ID,
        anchor_item_id: ANCHOR_ID,
        order_id: ORDER_ID,
        value_inr: 200, // 2 x ₹100, the line total the order was priced with
      },
    ]);
  });

  it('a pairing line for an item that is not on the order writes nothing', async () => {
    const res = await POST(orderRequest({ pairing_lines: [{ menu_item_id: NOT_ON_ORDER, anchor_item_id: ANCHOR_ID }] }));
    expect(res.status).toBe(201);
    expect(state.pairingInserts).toEqual([]);
  });

  it('malformed pairing_lines is ignored — never a 400, nothing written', async () => {
    for (const pairing_lines of [
      'not-an-array',
      42,
      { menu_item_id: MENU_ID, anchor_item_id: ANCHOR_ID },
      [null, 7, 'x', [], {}],
      [{ menu_item_id: 'nope', anchor_item_id: ANCHOR_ID }],
      [{ menu_item_id: MENU_ID }],
    ]) {
      const res = await POST(orderRequest({ pairing_lines }));
      expect(res.status, JSON.stringify(pairing_lines)).toBe(201);
    }
    expect(state.pairingInserts).toEqual([]);
  });

  it('keeps the good entries around malformed ones', async () => {
    const res = await POST(
      orderRequest({
        pairing_lines: [{ menu_item_id: 'nope', anchor_item_id: ANCHOR_ID }, null, { menu_item_id: MENU_ID, anchor_item_id: ANCHOR_ID }],
      }),
    );
    expect(res.status).toBe(201);
    expect(state.pairingInserts.map((r) => r.menu_item_id)).toEqual([MENU_ID]);
  });

  it('the order still succeeds when the insert errors (the table may not exist yet)', async () => {
    state.pairingInsertError = { message: 'relation "pairing_events" does not exist' };
    const res = await POST(orderRequest({ pairing_lines: [{ menu_item_id: MENU_ID, anchor_item_id: ANCHOR_ID }] }));
    expect(res.status).toBe(201);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('the order still succeeds when the insert throws', async () => {
    state.pairingInsertThrows = true;
    const res = await POST(orderRequest({ pairing_lines: [{ menu_item_id: MENU_ID, anchor_item_id: ANCHOR_ID }] }));
    expect(res.status).toBe(201);
    expect(errorSpy).toHaveBeenCalled();
  });
});
