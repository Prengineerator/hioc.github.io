import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for VAL-1/VAL-2 in POST /api/orders: a counter order linked
// to a customer's loyalty account by phone.
//
// What it is really guarding is one rule — the beneficiary is DERIVED from the
// phone, server-side, and can never be named by the caller. The mocked profiles
// query below applies the `eq` filters it is given rather than ignoring them, so
// "only a VERIFIED phone links" is actually exercised instead of asserted.
//
// (The database itself remains invisible to vitest; the column, its FK and the
// index are proven separately by `npm run verify:db`.)

const MENU_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555';
const VICTIM_ID = '66666666-6666-4666-8666-666666666666';

interface ProfileRow {
  id: string;
  name: string;
  phone: string;
  phone_verified: boolean;
}

const state: {
  actor: { user: { id: string }; role: string } | null;
  sessionUser: { id: string } | null;
  profiles: ProfileRow[];
  menuRows: Record<string, unknown>[];
  orderInsert?: Record<string, unknown>;
  rpcCalls: { name: string; args: Record<string, unknown> }[];
  pointsQuote: { ok: boolean; points?: number; discountInr?: number; reason?: string };
  quotedFor: string | null;
  /** Simulates a deploy that predates 2026-08-counter-loyalty.sql. */
  rejectLinkedInsert: boolean;
} = {
  actor: null,
  sessionUser: null,
  profiles: [],
  menuRows: [],
  rpcCalls: [],
  pointsQuote: { ok: false },
  quotedFor: null,
  rejectLinkedInsert: false,
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      return Promise.resolve({ data: true, error: null });
    },
    from: (table: string) => {
      const ctx = { inserted: false };
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        },
        not: () => chain,
        in: () => Promise.resolve({ data: state.menuRows, error: null }),
        // Only the profiles lookup ends in .limit(), and it applies the filters
        // it was given — otherwise "unverified phones must not link" would pass
        // even if the route dropped the phone_verified condition entirely.
        limit: () =>
          Promise.resolve({
            data: state.profiles
              .filter((p) =>
                Object.entries(filters).every(
                  ([column, value]) => (p as unknown as Record<string, unknown>)[column] === value,
                ),
              )
              .map((p) => ({ id: p.id, name: p.name })),
            error: null,
          }),
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
          if (table === 'orders' && ctx.inserted) {
            if (state.rejectLinkedInsert && state.orderInsert?.customer_user_id) {
              // The exact error PostgREST returns for a write naming a column
              // the schema cache doesn't have (confirmed live — NOT 42703).
              return Promise.resolve({
                data: null,
                error: {
                  code: 'PGRST204',
                  message: "Could not find the 'customer_user_id' column of 'orders' in the schema cache",
                },
              });
            }
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
  // Records WHOSE points were quoted — that is the whole question this ticket
  // turns on, and it is null for a staff order until VAL-2 links one.
  quoteRedemption: (userId: string) => {
    state.quotedFor = userId;
    return Promise.resolve(state.pointsQuote);
  },
  redeemForOrder: () => Promise.resolve(),
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
const REGULAR = '9876543210';

beforeEach(() => {
  vi.clearAllMocks();
  state.actor = { user: { id: 'staff-1' }, role: 'staff' };
  state.sessionUser = { id: 'staff-1' };
  state.orderInsert = undefined;
  state.rpcCalls = [];
  state.quotedFor = null;
  state.pointsQuote = { ok: false };
  state.rejectLinkedInsert = false;
  state.profiles = [
    { id: CUSTOMER_ID, name: 'Asha', phone: `+91${REGULAR}`, phone_verified: true },
  ];
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

describe('VAL-2 — linking a counter order to an account', () => {
  it('links a staff order whose phone matches a VERIFIED account', async () => {
    const res = await POST(req({ items: oneLatte, pickup_slot_label: 'ASAP', customer_phone: REGULAR }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.customer_user_id).toBe(CUSTOMER_ID);
    // D4-3: the two columns mean different things and must not be conflated.
    expect(state.orderInsert?.user_id).toBeNull();
    expect(state.orderInsert?.created_by).toBe('staff-1');
    expect(state.orderInsert?.channel).toBe('staff_pos');
  });

  it('does NOT link an UNVERIFIED match — anyone can type a stranger’s number', async () => {
    state.profiles = [
      { id: CUSTOMER_ID, name: 'Asha', phone: `+91${REGULAR}`, phone_verified: false },
    ];
    const res = await POST(req({ items: oneLatte, pickup_slot_label: 'ASAP', customer_phone: REGULAR }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.customer_user_id).toBeUndefined();
  });

  it('proceeds unlinked when no account holds the number, creating nothing', async () => {
    state.profiles = [];
    const res = await POST(req({ items: oneLatte, pickup_slot_label: 'ASAP', customer_phone: REGULAR }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.customer_user_id).toBeUndefined();
    expect(state.orderInsert?.customer_phone).toBe(`+91${REGULAR}`);
  });

  it('leaves an anonymous staff order unlinked', async () => {
    const res = await POST(req({ items: oneLatte, pickup_slot_label: 'ASAP' }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.customer_user_id).toBeUndefined();
  });

  it('IGNORES a customer_user_id in the request body', async () => {
    // The attack this is here for: name the account, spend its points. The
    // matched phone must win, and a body field must never reach the column.
    const res = await POST(
      req({
        items: oneLatte,
        pickup_slot_label: 'ASAP',
        customer_phone: REGULAR,
        customer_user_id: VICTIM_ID,
        user_id: VICTIM_ID,
      }),
    );
    expect(res.status).toBe(201);
    expect(state.orderInsert?.customer_user_id).toBe(CUSTOMER_ID);
    expect(state.orderInsert?.user_id).toBeNull();
  });

  it('still takes the order, unlinked, if the migration has not been applied', async () => {
    // A pending migration must not close the counter. The link is lost (and
    // logged); the customer's coffee is not.
    state.rejectLinkedInsert = true;
    const res = await POST(req({ items: oneLatte, pickup_slot_label: 'ASAP', customer_phone: REGULAR }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.customer_user_id).toBeUndefined();
    expect(state.orderInsert?.customer_phone).toBe(`+91${REGULAR}`);
  });

  it('never links a NON-staff order by phone', async () => {
    // A web guest typing a regular's number would otherwise inherit their
    // account — the counter's linkage is safe only because a staffer is
    // standing there confirming the name.
    state.actor = null;
    state.sessionUser = null;
    const res = await POST(
      req({ items: oneLatte, pickup_slot_label: 'ASAP', customer_name: 'Guest', customer_phone: REGULAR }),
    );
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('customer_web');
    expect(state.orderInsert?.customer_user_id).toBeUndefined();
    expect(state.orderInsert?.user_id).toBeNull();
  });
});

describe('VAL-1 — points at the till', () => {
  it('quotes points against the LINKED customer, not the staff session', async () => {
    state.pointsQuote = { ok: true, points: 100, discountInr: 10 };
    const res = await POST(
      req({ items: oneLatte, pickup_slot_label: 'ASAP', customer_phone: REGULAR, redeem_points: 100 }),
    );
    expect(res.status).toBe(201);
    expect(state.quotedFor).toBe(CUSTOMER_ID);
    expect(state.orderInsert?.discount_inr).toBe(10);

    // ...and the atomic redemption debits that same account.
    const redeem = state.rpcCalls.find((c) => c.name === 'try_redeem_points');
    expect(redeem?.args.p_user_id).toBe(CUSTOMER_ID);
    expect(redeem?.args.p_points).toBe(100);
  });

  it('refuses a redemption with no linked account, and says how to fix it', async () => {
    state.profiles = [];
    const res = await POST(
      req({ items: oneLatte, pickup_slot_label: 'ASAP', customer_phone: REGULAR, redeem_points: 100 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('No customer account is linked to this number');
    expect(state.orderInsert).toBeUndefined(); // nothing was created
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('passes the server-quoted discount through, never a client figure', async () => {
    state.pointsQuote = { ok: true, points: 100, discountInr: 10 };
    const res = await POST(
      req({
        items: oneLatte,
        pickup_slot_label: 'ASAP',
        customer_phone: REGULAR,
        redeem_points: 100,
        // A client trying to dictate money. Ignored: subtotal is 200 (2 x ₹100),
        // the discount is the quote's ₹10, and the total is re-derived.
        discount_inr: 199,
        total_inr: 1,
      }),
    );
    expect(res.status).toBe(201);
    expect(state.orderInsert?.subtotal_inr).toBe(200);
    expect(state.orderInsert?.discount_inr).toBe(10);
    // 200 + 5% GST on (200-10) + 20 packaging - 10 discount, all server-side.
    expect(state.orderInsert?.total_inr).toBe(220);
  });

  it('rejects a malformed redeem_points before anything is created', async () => {
    const res = await POST(
      req({ items: oneLatte, pickup_slot_label: 'ASAP', customer_phone: REGULAR, redeem_points: -5 }),
    );
    expect(res.status).toBe(400);
    expect(state.orderInsert).toBeUndefined();
  });
});
