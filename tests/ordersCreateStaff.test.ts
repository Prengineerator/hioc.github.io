import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Staff surface (lib/staff/surface.ts): these requests come from the POS unless
// a test sets globalThis.__staffSurface = 'web'.
vi.mock('@/lib/staff/surface', () => ({
  getStaffSurface: () =>
    Promise.resolve((globalThis as { __staffSurface?: 'pos' | 'web' }).__staffSurface ?? 'pos'),
}));


// Handler-level integration test for POST /api/orders — the FND3-2/3 staff
// order-creation path — exercised end-to-end against a mocked Supabase admin
// client. Verifies that:
//  * the web channel is untouched (customer_web, received, name/phone required),
//    and a website dine-in is a counter pickup with no packaging charge (D5);
//  * a staff session opens the second channel (staff_pos, starts 'accepted',
//    attributed via created_by, user_id stays null, no bill at creation);
//  * dine-in requires a valid active table, snapshots its label, and drops the
//    packaging charge (D5); a walk-in staff takeaway keeps the token/pickup flow.
// computeBill is exercised for real (only computeStoreOpenState is stubbed so the
// guest path is deterministic regardless of wall-clock).

const MENU_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const TABLE_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';

const state: {
  actor: { user: { id: string }; role: string; via?: 'session' | 'device' } | null;
  sessionUser: { id: string } | null;
  tableRow: Record<string, unknown> | null;
  menuRows: Record<string, unknown>[];
  orderInsert?: Record<string, unknown>;
  /** The order_items bulk insert (one row per line). */
  itemsInsert?: Record<string, unknown>[];
  eventRow?: Record<string, unknown>;
  /** What the route handed validateAndComputeCoupon (the coupon itself is stubbed to refuse). */
  couponCtx?: Record<string, unknown>;
} = { actor: null, sessionUser: null, tableRow: null, menuRows: [] };

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
        in: () =>
          // The only `.in()` caller is the menu_items validation fetch.
          Promise.resolve({ data: state.menuRows, error: null }),
        insert: (payload: Record<string, unknown>) => {
          if (table === 'orders') state.orderInsert = payload;
          if (table === 'order_items') state.itemsInsert = payload as unknown as Record<string, unknown>[];
          if (table === 'order_status_events') state.eventRow = payload;
          // orders / order_items chain on into `.select().single()`; the addon
          // and event inserts are awaited directly and resolve here.
          if (table === 'orders' || table === 'order_items') {
            ctx.inserted = true;
            return chain;
          }
          return Promise.resolve({ error: null });
        },
        maybeSingle: () =>
          table === 'profiles'
            ? // The verified-number check (VERIFY-1) for a web customer.
              Promise.resolve({ data: { phone: '+919000000000', phone_verified: true }, error: null })
            : Promise.resolve({ data: state.tableRow, error: null }),
        single: () => {
          if (table === 'order_items') {
            return Promise.resolve({ data: { id: 'oi-1' }, error: null });
          }
          if (table === 'orders' && ctx.inserted) {
            // The just-created order row (insert → select → single).
            return Promise.resolve({ data: { ...state.orderInsert, id: ORDER_ID }, error: null });
          }
          // The reload (select → eq → single) that feeds toOrderResponse.
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
  getCounterActor: () => Promise.resolve(state.actor),
  getAuthUser: () => Promise.resolve(state.sessionUser),
  getStaffUser: () => Promise.resolve(null),
  actorRoleFor: (role: string) => (role === 'owner' || role === 'manager' ? 'owner' : 'staff'),
}));

// Keep computeBill real (GST + packaging math is under test); only force the
// store-open gate open so the guest path is deterministic.
vi.mock('@/lib/store/hours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/store/hours')>();
  return { ...actual, computeStoreOpenState: () => ({ acceptingOrders: true, reason: null }) };
});
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({
      gst_percent: 5,
      gst_inclusive: false,
      packaging_charge_inr: 20,
      pickup_slot_capacity: 0,
      staff_web_ordering: (globalThis as { __staffWebOrdering?: boolean }).__staffWebOrdering,
    }),
}));

vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/promotions/coupons', () => ({
  validateAndComputeCoupon: (_code: string, ctx: Record<string, unknown>) => {
    state.couponCtx = ctx;
    return Promise.resolve({ ok: false });
  },
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  quoteRedemption: () => Promise.resolve({ ok: false }),
  redeemForOrder: () => Promise.resolve(),
}));
vi.mock('@/lib/payments/gateway', () => ({ createPaymentIntent: () => Promise.resolve(null) }));
// No counter customer is opened or looked up here (the admin stub has no .limit()): a phone typed at the counter just finds no account.
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(null),
  createCounterCustomer: () => Promise.resolve(null),
}));

const { POST } = await import('@/app/api/orders/route');
const { sendBillNotification } = await import('@/lib/notifications/engine');

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
  state.actor = null;
  state.sessionUser = null;
  state.orderInsert = undefined;
  state.itemsInsert = undefined;
  state.eventRow = undefined;
  state.couponCtx = undefined;
  state.tableRow = { id: TABLE_ID, label: 'T1', is_active: true };
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

describe('POST /api/orders — web channel (unchanged, FND3-2)', () => {
  it('creates a verified customer\'s takeaway order as customer_web / received, unpaid, and sends NO bill yet (issue-3)', async () => {
    // Web orders need a WhatsApp-verified number (VERIFY-1); a customer who
    // was logged in before checkout may still pay at the counter. That order
    // is unpaid at creation — its bill must wait until a payment is actually
    // recorded (staff settlement or the completed transition), not fire here.
    state.sessionUser = { id: 'cust-1' };
    const res = await POST(req({ customer_name: 'Asha', customer_phone: '9000000000', pickup_slot_label: 'ASAP', items: oneLatte }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('customer_web');
    expect(state.orderInsert?.status).toBe('received');
    expect(state.orderInsert?.payment_status).toBe('unpaid');
    expect(state.orderInsert?.table_id).toBeNull();
    expect(state.orderInsert?.created_by).toBeNull();
    expect(state.orderInsert?.packaging_inr).toBe(20); // takeaway keeps packaging
    expect(state.eventRow?.actor_role).toBe('system');
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('400s a guest order missing name or phone', async () => {
    const noName = await POST(req({ customer_phone: '9000000000', pickup_slot_label: 'ASAP', items: oneLatte }));
    expect(noName.status).toBe(400);
    const noPhone = await POST(req({ customer_name: 'Asha', pickup_slot_label: 'ASAP', items: oneLatte }));
    expect(noPhone.status).toBe(400);
  });

  it('takes a website dine-in order: no packaging, no table, keeps its pickup token', async () => {
    state.sessionUser = { id: 'cust-1' }; // verified web customer — past VERIFY-1
    const res = await POST(
      req({ customer_name: 'Asha', customer_phone: '9000000000', pickup_slot_label: 'ASAP', order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }),
    );
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('customer_web');
    expect(state.orderInsert?.order_type).toBe('dine_in');
    expect(state.orderInsert?.packaging_inr).toBe(0); // D5: dine-in no packaging
    expect(state.orderInsert?.total_inr).toBe(210); // 200 + 5% GST, no packaging
    // A customer cannot claim a table from the website; they collect at the counter.
    expect(state.orderInsert?.table_id).toBeNull();
    expect(state.orderInsert?.pickup_code).toMatch(/^\d{4}$/);
    expect(state.orderInsert?.pickup_slot_label).toBe('ASAP');
  });

  it('still needs a pickup time for a website dine-in order', async () => {
    state.sessionUser = { id: 'cust-1' };
    const res = await POST(req({ customer_name: 'Asha', customer_phone: '9000000000', order_type: 'dine_in', items: oneLatte }));
    expect(res.status).toBe(400);
    expect(state.orderInsert).toBeUndefined();
  });
});

describe('POST /api/orders — staff dine-in (FND3-2/3)', () => {
  beforeEach(() => {
    // Staff session; note the session user is the STAFF member, not a customer.
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.sessionUser = { id: 'staff-1' };
  });

  it('creates a dine-in order: staff_pos, accepted, table snapshot, packaging 0, no bill', async () => {
    const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('staff_pos');
    expect(state.orderInsert?.status).toBe('accepted');
    expect(state.orderInsert?.table_id).toBe(TABLE_ID);
    expect(state.orderInsert?.table_label).toBe('T1'); // snapshot
    expect(state.orderInsert?.created_by).toBe('staff-1');
    expect(state.orderInsert?.user_id).toBeNull(); // NOT the staff's session id
    expect(state.orderInsert?.packaging_inr).toBe(0); // D5: dine-in no packaging
    expect(state.orderInsert?.pickup_code).toBeNull(); // no token for dine-in
    expect(state.orderInsert?.payment_status).toBe('unpaid'); // settled later (POS-2)
    // Initial event attributed to the staff actor, null → accepted.
    expect(state.eventRow?.to_status).toBe('accepted');
    expect(state.eventRow?.actor_id).toBe('staff-1');
    expect(state.eventRow?.actor_role).toBe('staff');
    expect(sendBillNotification).not.toHaveBeenCalled(); // bill fires at settle
  });

  it('PIN-3/PIN-4: an enrolled-device operator (no classic session) creates the order, attributed to them', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.created_by).toBe('ravi');
    expect(state.eventRow?.actor_id).toBe('ravi');
  });

  it('400s a dine-in order with no table', async () => {
    const res = await POST(req({ order_type: 'dine_in', items: oneLatte }));
    expect(res.status).toBe(400);
    expect(state.orderInsert).toBeUndefined();
  });

  it('400s a dine-in order for an inactive/missing table', async () => {
    state.tableRow = { id: TABLE_ID, label: 'T1', is_active: false };
    const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
    expect(res.status).toBe(400);
    expect(state.orderInsert).toBeUndefined();
  });
});

describe('POST /api/orders — staff walk-in takeaway (FND3-3)', () => {
  it('creates an anonymous takeaway: no name/phone, keeps token + packaging, no bill', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'owner' };
    state.sessionUser = { id: 'staff-1' };
    const res = await POST(req({ items: oneLatte, pickup_slot_label: 'ASAP' }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('staff_pos');
    expect(state.orderInsert?.status).toBe('accepted');
    expect(state.orderInsert?.customer_name).toBe(''); // anonymous walk-in
    expect(state.orderInsert?.customer_phone).toBe('');
    expect(state.orderInsert?.table_id).toBeNull();
    expect(state.orderInsert?.packaging_inr).toBe(20); // takeaway keeps packaging
    expect(state.orderInsert?.pickup_code).not.toBeNull(); // token slip
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('refuses an in-store-only item on a website order', async () => {
    state.sessionUser = { id: 'cust-1' };
    state.menuRows = [{ ...state.menuRows[0], name: 'Water Bottle', in_store_only: true }];
    const res = await POST(req({ customer_name: 'Asha', customer_phone: '9000000000', pickup_slot_label: 'ASAP', items: oneLatte }));
    expect(res.status).toBe(400);
    expect(state.orderInsert).toBeUndefined();
  });

  it('lets the POS sell an in-store-only item', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.menuRows = [{ ...state.menuRows[0], name: 'Water Bottle', in_store_only: true }];
    const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('staff_pos');
  });

  it('bills no GST on a GST-exempt item', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.menuRows = [{ ...state.menuRows[0], name: 'Water Bottle', gst_exempt: true }];
    const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.subtotal_inr).toBe(200);
    expect(state.orderInsert?.tax_inr).toBe(0);
    expect(state.orderInsert?.total_inr).toBe(200);
  });

  it('still bills GST on a normal item', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.tax_inr).toBe(10);
  });

  describe('sold by weight (2026-10-sell-by-weight)', () => {
    const beansRow = () => ({
      ...state.menuRows[0],
      name: 'House Blend',
      category: 'Coffee Beans',
      sold_by_weight: true,
      menu_item_variants: [{ id: VARIANT_ID, label: 'Whole beans', price_inr: 2400, sort_order: 0 }],
    });

    it('prices a weighed line from its grams and stores weight_grams on the line', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff' };
      state.menuRows = [beansRow()];
      const items = [{ menu_item_id: MENU_ID, variant_id: VARIANT_ID, quantity: 2, weight_grams: 250 }];
      const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items }));
      expect(res.status).toBe(201);
      // 2 × 250 g at ₹2400/kg = 2 × ₹600.
      expect(state.orderInsert?.subtotal_inr).toBe(1200);
      expect(state.itemsInsert?.[0]).toMatchObject({
        variant_label_snapshot: 'Whole beans',
        weight_grams: 250,
        price_inr_snapshot: 600,
        quantity: 2,
        line_total_inr: 1200,
      });
    });

    it('refuses a weighed item sent without its grams', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff' };
      state.menuRows = [beansRow()];
      const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/sold by weight/);
      expect(state.orderInsert).toBeUndefined();
    });

    it('writes no weight_grams column for a by-the-unit line (works before the migration)', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff' };
      const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
      expect(res.status).toBe(201);
      expect(state.itemsInsert?.[0]).not.toHaveProperty('weight_grams');
    });
  });

  describe('staff website vs POS', () => {
    const web = globalThis as { __staffSurface?: 'pos' | 'web'; __staffWebOrdering?: boolean };
    afterEach(() => {
      web.__staffSurface = undefined;
      web.__staffWebOrdering = undefined;
    });

    it('refuses a staff order from the staff website while web ordering is off (the default)', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff' };
      web.__staffSurface = 'web';
      const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/switched off on the staff website/);
      expect(state.orderInsert).toBeUndefined();
    });

    it('takes it once the owner has switched web ordering on', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff' };
      web.__staffSurface = 'web';
      web.__staffWebOrdering = true;
      const res = await POST(req({ order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }));
      expect(res.status).toBe(201);
    });

    it('never gates a customer website order', async () => {
      web.__staffSurface = 'web';
      state.sessionUser = { id: 'cust-1' };
      const res = await POST(
        req({ customer_name: 'Asha', customer_phone: '9000000000', pickup_slot_label: 'ASAP', items: oneLatte }),
      );
      expect(res.status).toBe(201);
    });
  });
});


// A marketing coupon is locked to the phone it was sent to. A first-visit customer has no VERIFIED account when the
// counter validates the code (createCounterCustomer runs after), so the route may pass the phone the STAFFER typed
// as `counterPhone` — and only then. A customer's own request must never be able to set it.
describe('POST /api/orders — who may vouch for a coupon\'s phone (CouponContext.counterPhone)', () => {
  const withCoupon = (extra: Record<string, unknown>) =>
    req({ coupon_code: 'WBK7M3QX', pickup_slot_label: 'ASAP', items: oneLatte, ...extra });

  it('a counter actor\'s typed phone is handed to the coupon check, normalised', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.sessionUser = { id: 'staff-1' };
    const res = await POST(withCoupon({ customer_phone: '98765 43210' }));
    expect(res.status).toBe(400); // the stubbed coupon refuses; all that matters is what it was asked
    expect(state.couponCtx?.counterPhone).toBe('+919876543210');
    // The account the order would be attributed to is still the LINKED customer's (none here), never the staffer's.
    expect(state.couponCtx?.userId).toBeNull();
  });

  it('a counter order with no phone typed passes none', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.sessionUser = { id: 'staff-1' };
    await POST(withCoupon({ order_type: 'dine_in', table_id: TABLE_ID }));
    expect(state.couponCtx?.counterPhone).toBeNull();
  });

  it('a typed foreign number is never read as the Indian number with the same digits', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.sessionUser = { id: 'staff-1' };
    await POST(withCoupon({ customer_phone: '+6581234567' }));
    expect(state.couponCtx?.counterPhone).toBeNull();
  });

  it('a customer web session never sets it — not from customer_phone, not from a body field named counterPhone', async () => {
    state.sessionUser = { id: 'cust-1' };
    // (9000000000 is the verified number the stubbed phone check accepts; the point is what ELSE the body claims.)
    await POST(withCoupon({ customer_name: 'Asha', customer_phone: '9000000000', counterPhone: '+919876543210', counter_phone: '+919876543210' }));
    expect(state.couponCtx).toBeDefined();
    expect(state.couponCtx?.counterPhone).toBeNull();
    expect(state.couponCtx?.userId).toBe('cust-1');
  });
});
