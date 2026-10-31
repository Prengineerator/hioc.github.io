import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/orders with the counter's two riders (one function call per sale
// instead of three): `settlement` settles the order it has just created, by
// the same rules as PATCH /api/orders/[id]/payment (lib/orders/settlePayment,
// mocked here; its own tests are the payment route's), and
// `include_print_order` hands back the ticket data the counter prints from.
// The order must stand whatever happens to either.

vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));

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


const riders: {
  settle: ReturnType<typeof vi.fn>;
  printOrder: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  claim: { state: string; orderId?: string };
} = {
  settle: vi.fn(),
  printOrder: vi.fn(),
  release: vi.fn(),
  claim: { state: 'claimed' },
};

vi.mock('@/lib/orders/settlePayment', () => ({
  settleOrderPayment: (...args: unknown[]) => riders.settle(...args),
}));
vi.mock('@/lib/orders/getStaffPrintOrder', () => ({
  getStaffPrintOrder: (...args: unknown[]) => riders.printOrder(...args),
}));
vi.mock('@/lib/orders/idempotency', () => ({
  readIdempotencyKey: (r: Request) => r.headers.get('idempotency-key'),
  claimIdempotencyKey: () => Promise.resolve(riders.claim),
  completeIdempotencyKey: () => Promise.resolve(),
  releaseIdempotencyKey: (...args: unknown[]) => {
    riders.release(...args);
    return Promise.resolve();
  },
}));

const { POST } = await import('@/app/api/orders/route');

function req(body: unknown, key?: string) {
  return new Request('http://t/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
}

const oneLatte = [{ menu_item_id: MENU_ID, variant_id: VARIANT_ID, quantity: 2, addon_option_ids: [] }];
const counterOrder = { pickup_slot_label: 'ASAP', items: oneLatte };
const cash = { parts: [{ method: 'cash', amount_inr: 230, tendered_inr: 300 }] };
const settled = {
  ok: true,
  body: { order: { id: ORDER_ID, payment_status: 'paid', payment_method: 'cash', payments: [] }, change_due_inr: 70 },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.actor = { user: { id: 'staff-1' }, role: 'staff' };
  state.sessionUser = { id: 'staff-1' };
  state.orderInsert = undefined;
  state.tableRow = null;
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
  riders.settle.mockReset();
  riders.settle.mockResolvedValue(settled);
  riders.printOrder.mockReset();
  riders.printOrder.mockResolvedValue({ id: ORDER_ID, items: [], cashier_name: 'Asha' });
  riders.claim = { state: 'claimed' };
});

describe('POST /api/orders — settlement with the order', () => {
  it('settles the order it has just created, with the counter actor and the parts sent', async () => {
    const res = await POST(req({ ...counterOrder, settlement: cash }));
    expect(res.status).toBe(201);
    expect(riders.settle).toHaveBeenCalledTimes(1);
    expect(riders.settle).toHaveBeenCalledWith(state.actor, ORDER_ID, cash);
    const data = await res.json();
    expect(data.settlement).toEqual({ ok: true, ...settled.body });
    // The order as created: the settle's own answer carries the paid state.
    expect(data.order.payment_status).toBe('unpaid');
  });

  it('keeps the order when the settle is refused, and says why', async () => {
    riders.settle.mockResolvedValue({ ok: false, status: 400, error: 'Parts must add up to ₹230' });
    const res = await POST(req({ ...counterOrder, settlement: cash }));
    expect(res.status).toBe(201);
    expect((await res.json()).settlement).toEqual({ ok: false, status: 400, error: 'Parts must add up to ₹230' });
  });

  it('keeps the order when the settle throws', async () => {
    riders.settle.mockRejectedValue(new Error('network'));
    const res = await POST(req({ ...counterOrder, settlement: cash }));
    expect(res.status).toBe(201);
    expect((await res.json()).settlement).toEqual({ ok: false, status: 500, error: 'Failed to record payment' });
  });

  it('refuses a payment from anyone but the counter, before writing anything', async () => {
    state.actor = null;
    state.sessionUser = { id: 'cust-1' };
    const res = await POST(
      req({ customer_name: 'Asha', customer_phone: '9000000000', ...counterOrder, settlement: cash }),
    );
    expect(res.status).toBe(403);
    expect(state.orderInsert).toBeUndefined();
    expect(riders.settle).not.toHaveBeenCalled();
  });

  it('400s a settlement that is not an object', async () => {
    const res = await POST(req({ ...counterOrder, settlement: [cash] }));
    expect(res.status).toBe(400);
    expect(state.orderInsert).toBeUndefined();
  });

  it('leaves the answer as it was when no settlement is sent', async () => {
    const data = await (await POST(req(counterOrder))).json();
    expect(riders.settle).not.toHaveBeenCalled();
    expect(data).not.toHaveProperty('settlement');
    expect(data).not.toHaveProperty('print_order');
  });

  it('settles a replayed order again: the first answer may have been lost after the settle', async () => {
    riders.claim = { state: 'replay', orderId: ORDER_ID };
    state.orderInsert = { total_inr: 230, subtotal_inr: 200, payment_status: 'paid', status: 'accepted' };
    const res = await POST(req({ ...counterOrder, settlement: cash }, 'key-1'));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.replayed).toBe(true);
    expect(riders.settle).toHaveBeenCalledWith(state.actor, ORDER_ID, cash);
    expect(data.settlement.ok).toBe(true);
  });

  it('has nothing to settle on a replayed ₹0 order', async () => {
    riders.claim = { state: 'replay', orderId: ORDER_ID };
    state.orderInsert = { total_inr: 0, subtotal_inr: 0, payment_status: 'paid', status: 'accepted' };
    const data = await (await POST(req({ ...counterOrder, settlement: cash }, 'key-1'))).json();
    expect(riders.settle).not.toHaveBeenCalled();
    expect(data.settlement).toBeNull();
  });
});

describe('POST /api/orders — print order with the order', () => {
  it('returns the ticket data when the counter asks, loaded after the settle', async () => {
    const calls: string[] = [];
    riders.settle.mockImplementation(async () => {
      calls.push('settle');
      return settled;
    });
    riders.printOrder.mockImplementation(async () => {
      calls.push('print');
      return { id: ORDER_ID, items: [] };
    });
    const data = await (await POST(req({ ...counterOrder, settlement: cash, include_print_order: true }))).json();
    expect(calls).toEqual(['settle', 'print']);
    expect(riders.printOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(data.print_order).toEqual({ id: ORDER_ID, items: [] });
  });

  it('answers null, not an error, when the ticket data cannot be loaded', async () => {
    riders.printOrder.mockRejectedValue(new Error('db'));
    const res = await POST(req({ ...counterOrder, include_print_order: true }));
    expect(res.status).toBe(201);
    expect((await res.json()).print_order).toBeNull();
  });

  it('never hands staff ticket data to a customer', async () => {
    state.actor = null;
    state.sessionUser = { id: 'cust-1' };
    const res = await POST(
      req({ customer_name: 'Asha', customer_phone: '9000000000', ...counterOrder, include_print_order: true }),
    );
    expect(res.status).toBe(201);
    expect(riders.printOrder).not.toHaveBeenCalled();
    expect(await res.json()).not.toHaveProperty('print_order');
  });
});

// The POS prices a cart on its own screen (lib/pos/localQuote.ts) and sends the
// total it showed. The server stays the authority: a different total refuses
// the order before anything is written, settled or printed.
describe('POST /api/orders — expected_total_inr', () => {
  // 2 × ₹100, GST 5% on (200 + ₹20 packaging) = 11 → ₹231 (computeBill, real).
  const TOTAL = 231;

  it('places the order when the screen showed the server total', async () => {
    const res = await POST(req({ ...counterOrder, expected_total_inr: TOTAL, settlement: cash }, 'key-1'));
    expect(res.status).toBe(201);
    expect((await res.json()).order.total_inr).toBe(TOTAL);
    expect(riders.settle).toHaveBeenCalledTimes(1);
  });

  it('refuses a different total before creating, settling or printing anything, and hands back its bill', async () => {
    const res = await POST(
      req({ ...counterOrder, expected_total_inr: 210, settlement: cash, include_print_order: true }, 'key-1'),
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('total_changed');
    expect(data.bill.total_inr).toBe(TOTAL);
    expect(data.error).toContain(`₹${TOTAL}`);
    expect(state.orderInsert).toBeUndefined();
    expect(riders.settle).not.toHaveBeenCalled();
    expect(riders.printOrder).not.toHaveBeenCalled();
  });

  it('releases the key it claimed, so charging again with it is a fresh attempt', async () => {
    await POST(req({ ...counterOrder, expected_total_inr: 210 }, 'key-1'));
    expect(riders.release).toHaveBeenCalledWith(expect.anything(), 'key-1');
  });

  it('still returns a replayed order whatever total the retry carries', async () => {
    riders.claim = { state: 'replay', orderId: ORDER_ID };
    state.orderInsert = { total_inr: TOTAL, subtotal_inr: 200, payment_status: 'unpaid', status: 'accepted' };
    const res = await POST(req({ ...counterOrder, expected_total_inr: 999 }, 'key-1'));
    expect(res.status).toBe(201);
    expect((await res.json()).replayed).toBe(true);
    expect(riders.release).not.toHaveBeenCalled();
  });

  it('ignores a missing or malformed value: priced and charged as before', async () => {
    for (const expected_total_inr of [undefined, 'abc', -5, null]) {
      state.orderInsert = undefined;
      const res = await POST(req({ ...counterOrder, expected_total_inr }));
      expect(res.status).toBe(201);
    }
  });
});
