import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level integration test for POST /api/orders — the FND3-2/3 staff
// order-creation path — exercised end-to-end against a mocked Supabase admin
// client. Verifies that:
//  * the web channel is untouched (customer_web, received, name/phone required);
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
  actor: { user: { id: string }; role: string } | null;
  sessionUser: { id: string } | null;
  tableRow: Record<string, unknown> | null;
  menuRows: Record<string, unknown>[];
  orderInsert?: Record<string, unknown>;
  eventRow?: Record<string, unknown>;
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
          if (table === 'order_status_events') state.eventRow = payload;
          // orders / order_items chain on into `.select().single()`; the addon
          // and event inserts are awaited directly and resolve here.
          if (table === 'orders' || table === 'order_items') {
            ctx.inserted = true;
            return chain;
          }
          return Promise.resolve({ error: null });
        },
        maybeSingle: () => Promise.resolve({ data: state.tableRow, error: null }),
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
  state.eventRow = undefined;
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
  it('creates a guest takeaway order as customer_web / received and sends the bill', async () => {
    const res = await POST(req({ customer_name: 'Asha', customer_phone: '9000000000', pickup_slot_label: 'ASAP', items: oneLatte }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.channel).toBe('customer_web');
    expect(state.orderInsert?.status).toBe('received');
    expect(state.orderInsert?.table_id).toBeNull();
    expect(state.orderInsert?.created_by).toBeNull();
    expect(state.orderInsert?.packaging_inr).toBe(20); // takeaway keeps packaging
    expect(state.eventRow?.actor_role).toBe('system');
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('400s a guest order missing name or phone', async () => {
    const noName = await POST(req({ customer_phone: '9000000000', pickup_slot_label: 'ASAP', items: oneLatte }));
    expect(noName.status).toBe(400);
    const noPhone = await POST(req({ customer_name: 'Asha', pickup_slot_label: 'ASAP', items: oneLatte }));
    expect(noPhone.status).toBe(400);
  });

  it('400s a guest attempting a dine-in order (staff-only channel)', async () => {
    const res = await POST(
      req({ customer_name: 'Asha', customer_phone: '9000000000', pickup_slot_label: 'ASAP', order_type: 'dine_in', table_id: TABLE_ID, items: oneLatte }),
    );
    expect(res.status).toBe(400);
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
});
