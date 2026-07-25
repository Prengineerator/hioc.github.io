import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level integration test for POST /api/orders — the QR-1 table
// scan-to-order channel — exercised end-to-end against a mocked Supabase admin
// client. Verifies that a NON-staff request carrying a `qr_token`:
//  * resolves the table by qr_token server-side (never a client table_id);
//  * writes channel='table_qr', order_type='dine_in', packaging ₹0 (D5),
//    created_by null, pickup_code null;
//  * pays online first (D6): starts 'placed' with a payment intent returned
//    (createPaymentIntent is mocked to a fake intent), never entering the
//    queue unpaid;
//  * 400s an unknown/inactive qr_token — no order written.
// computeBill runs for real; only the store-open gate is stubbed open.

const MENU_ID = '11111111-1111-4111-8111-111111111111';
const VARIANT_ID = '22222222-2222-4222-8222-222222222222';
const TABLE_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const QR_TOKEN = 'tok_terrace_t5_abc123';

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
        in: () => Promise.resolve({ data: state.menuRows, error: null }),
        insert: (payload: Record<string, unknown>) => {
          if (table === 'orders') state.orderInsert = payload;
          if (table === 'order_status_events') state.eventRow = payload;
          if (table === 'orders' || table === 'order_items') {
            ctx.inserted = true;
            return chain;
          }
          return Promise.resolve({ error: null });
        },
        // The only `.maybeSingle()` caller on the QR path is the table lookup
        // (by qr_token) — resolves to whatever table state the test sets.
        maybeSingle: () => Promise.resolve({ data: state.tableRow, error: null }),
        single: () => {
          if (table === 'order_items') {
            return Promise.resolve({ data: { id: 'oi-1' }, error: null });
          }
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

// No staff/owner session — a QR order is a customer request. getAuthUser returns
// the (possibly null) customer session, exactly like a web guest.
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
// D6 pay-online-first: return a fake gateway intent so the order stays 'placed'
// (no fall-back to counter) and the handler hands the intent back to the client.
vi.mock('@/lib/payments/gateway', () => ({
  createPaymentIntent: vi.fn(() =>
    Promise.resolve({ gateway: 'razorpay', gatewayOrderId: 'order_fake123', amountInr: 210, keyId: 'rzp_test_x' }),
  ),
}));

const { POST } = await import('@/app/api/orders/route');
const { sendBillNotification } = await import('@/lib/notifications/engine');
const { createPaymentIntent } = await import('@/lib/payments/gateway');

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
  state.actor = null; // never staff on this channel
  state.sessionUser = null; // anonymous QR diner
  state.orderInsert = undefined;
  state.eventRow = undefined;
  state.tableRow = { id: TABLE_ID, label: 'T5', is_active: true };
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

describe('POST /api/orders — table QR channel (QR-1 / D6)', () => {
  it('resolves the table by qr_token and creates a dine-in table_qr order that pays online first', async () => {
    const res = await POST(req({ qr_token: QR_TOKEN, items: oneLatte }));
    expect(res.status).toBe(201);

    // Channel + dine-in context.
    expect(state.orderInsert?.channel).toBe('table_qr');
    expect(state.orderInsert?.order_type).toBe('dine_in');
    expect(state.orderInsert?.table_id).toBe(TABLE_ID); // resolved from the token
    expect(state.orderInsert?.table_label).toBe('T5'); // snapshot
    expect(state.orderInsert?.packaging_inr).toBe(0); // D5: dine-in, no packaging
    expect(state.orderInsert?.pickup_code).toBeNull(); // no token slip for dine-in
    expect(state.orderInsert?.created_by).toBeNull(); // QR is not staff-attributed

    // D6: nothing enters the queue unpaid — starts 'placed', gateway-bound.
    expect(state.orderInsert?.status).toBe('placed');
    expect(state.orderInsert?.payment_status).toBe('payment_pending');
    expect(state.orderInsert?.payment_method).toBe('online');
    expect(createPaymentIntent).toHaveBeenCalledTimes(1);

    // The created payment intent is handed back to the client to open checkout.
    const payload = (await res.json()) as { payment: { gatewayOrderId?: string } | null };
    expect(payload.payment?.gatewayOrderId).toBe('order_fake123');

    // Initial lifecycle event is system-owned (no staff actor).
    expect(state.eventRow?.to_status).toBe('placed');
    expect(state.eventRow?.actor_role).toBe('system');

    // A QR customer gets the live bill link at placement (RCT-1, !isStaff).
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('keeps loyalty attribution when the QR diner is a logged-in customer', async () => {
    state.sessionUser = { id: 'cust-9' };
    const res = await POST(req({ qr_token: QR_TOKEN, items: oneLatte }));
    expect(res.status).toBe(201);
    expect(state.orderInsert?.user_id).toBe('cust-9'); // customer session, not null
    expect(state.orderInsert?.created_by).toBeNull(); // still not staff-attributed
    expect(state.orderInsert?.channel).toBe('table_qr');
  });

  it('400s an unknown qr_token — no order written', async () => {
    state.tableRow = null; // token matches nothing
    const res = await POST(req({ qr_token: 'tok_does_not_exist', items: oneLatte }));
    expect(res.status).toBe(400);
    expect(state.orderInsert).toBeUndefined();
    expect(createPaymentIntent).not.toHaveBeenCalled();
  });

  it('400s an inactive/regenerated table qr_token — no order written', async () => {
    state.tableRow = { id: TABLE_ID, label: 'T5', is_active: false };
    const res = await POST(req({ qr_token: QR_TOKEN, items: oneLatte }));
    expect(res.status).toBe(400);
    expect(state.orderInsert).toBeUndefined();
  });
});
