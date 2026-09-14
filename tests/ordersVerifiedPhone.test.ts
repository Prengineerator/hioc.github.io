import { beforeEach, describe, expect, it, vi } from 'vitest';

// VERIFY-1 — POST /api/orders must ENFORCE the verified-number rule, not merely
// display it. Before this, the only gate was CheckoutForm's disabled button:
// this route never asked, and the table-QR checkout did not even have a button.
// So what is under test here is the route asking at all, on the real request
// path, with the order insert asserted to have not happened.
//
// Mirrors the harness in ordersCreateStaff.test.ts, plus a `profiles` row and a
// flippable flag.

const MENU_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';

const state: {
  verifiedOrders: boolean;
  actor: { user: { id: string }; role: string } | null;
  sessionUser: { id: string } | null;
  profile: { phone: string | null; phone_verified: boolean } | null;
  profileError: { message: string } | null;
  menuRows: Record<string, unknown>[];
  orderInsert?: Record<string, unknown>;
} = {
  verifiedOrders: true,
  actor: null,
  sessionUser: null,
  profile: null,
  profileError: null,
  menuRows: [],
};

vi.mock('@/lib/flags', () => ({
  flags: {
    get verifiedOrders() {
      return state.verifiedOrders;
    },
    ownerDashboard: true,
    realtime: false,
    notifications: false,
    staffPos: true,
    tableQr: false,
    attendance: false,
    posV2: false,
  },
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
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
        maybeSingle: () => {
          if (table === 'profiles') {
            return Promise.resolve({ data: state.profile, error: state.profileError });
          }
          return Promise.resolve({ data: null, error: null });
        },
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
  getStaffOrOwner: () => Promise.resolve(state.actor),
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

const oneLatte = [{ menu_item_id: MENU_ID, variant_id: VARIANT_ID, quantity: 1, addon_option_ids: [] }];

function order(phone = '9876543210') {
  return new Request('http://t/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Ayush',
      customer_phone: phone,
      pickup_slot_label: 'ASAP',
      items: oneLatte,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.verifiedOrders = true;
  state.actor = null;
  state.sessionUser = null;
  state.profile = null;
  state.profileError = null;
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

describe('POST /api/orders — the verified-number rule is enforced server-side', () => {
  it('refuses an anonymous guest, and creates nothing', async () => {
    const res = await POST(order());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('no_session');
    // The assertion that matters: not merely a 403, but no order row.
    expect(state.orderInsert).toBeUndefined();
  });

  it('refuses a signed-in customer who has never verified a number', async () => {
    state.sessionUser = { id: 'u1' };
    state.profile = { phone: null, phone_verified: false };
    const res = await POST(order());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('not_verified');
    expect(state.orderInsert).toBeUndefined();
  });

  it('refuses an order addressed to a number other than the verified one', async () => {
    state.sessionUser = { id: 'u1' };
    state.profile = { phone: '+919876543210', phone_verified: true };
    const res = await POST(order('9000000001'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('phone_mismatch');
    expect(state.orderInsert).toBeUndefined();
  });

  it('accepts a verified customer ordering against their own number', async () => {
    state.sessionUser = { id: 'u1' };
    state.profile = { phone: '+919876543210', phone_verified: true };
    const res = await POST(order('9876543210'));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.customer_phone).toBe('+919876543210');
    expect(state.orderInsert?.channel).toBe('customer_web');
  });

  it('fails CLOSED when the verification lookup itself errors', async () => {
    // A lookup that cannot answer "has this number been verified?" must never
    // be read as "yes" — an unverified number reaching the WhatsApp sender is
    // the exact outcome this rule exists to prevent.
    state.sessionUser = { id: 'u1' };
    state.profileError = { message: 'connection reset' };
    const res = await POST(order());
    expect(res.status).toBe(503);
    expect(state.orderInsert).toBeUndefined();
  });

  it('never asks a staff order at the counter', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.sessionUser = { id: 'staff-1' };
    state.profile = { phone: null, phone_verified: false };
    const res = await POST(
      new Request('http://t/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: oneLatte, pickup_slot_label: 'ASAP' }),
      }),
    );
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('staff_pos');
    // An anonymous walk-in carries no number at all, which is exactly the case
    // the rule must not apply to.
    expect(state.orderInsert?.customer_phone).toBe('');
  });

  it('changes nothing at all while the flag is off', async () => {
    // The state production ships in. A guest checkout keeps working exactly as
    // it does today until an OTP has been proven to arrive.
    state.verifiedOrders = false;
    const res = await POST(order());
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('customer_web');
  });
});
