import { beforeEach, describe, expect, it, vi } from 'vitest';

// HIOC Ritual on POST /api/orders (docs/COFFEE-PASS-SPEC.md §6, §7, CP-D9/CP-D12).
//
// Handler-level: the route runs for real against a mocked Supabase admin client
// with the money math REAL (computeBill / composePassBill / allocatePassDrinks),
// so the bill numbers in spec §6 examples A-D are checked to the rupee through
// the route. Only the database halves of lib/passes/server.ts are stubbed (the
// passes a customer holds, which drinks are eligible, and the redeem RPC); their
// own behaviour is covered in tests/coffeePassServer.test.ts.

const MENU = {
  capp: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  lotus: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  latte: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
  sandwich: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
} as const;
const VARIANT = {
  capp: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  lotus: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  latte: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  sandwich: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
} as const;
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const TABLE_ID = '33333333-3333-4333-8333-333333333333';

const flagState = vi.hoisted(() => ({ coffeePass: true, verifiedOrders: false, suggest: false }));
vi.mock('@/lib/flags', () => ({ flags: flagState }));

const state: {
  actor: { user: { id: string }; role: string } | null;
  sessionUser: { id: string } | null;
  linkedUserId: string | null;
  menuRows: Record<string, unknown>[];
  settings: Record<string, unknown>;
  // What lib/passes/server.ts would answer.
  passes: Record<string, unknown>[];
  eligible: string[];
  redeemCode: string;
  // What the route did.
  orderInsert?: Record<string, unknown>;
  itemRows: Record<string, unknown>[];
  deleted: string[];
  calls: string[];
  couponCtx?: { subtotalInr: number };
  quoteRemaining?: number;
} = {
  actor: null,
  sessionUser: null,
  linkedUserId: null,
  menuRows: [],
  settings: {},
  passes: [],
  eligible: [],
  redeemCode: 'ok',
  itemRows: [],
  deleted: [],
  calls: [],
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    rpc: (name: string) => {
      state.calls.push(name);
      return Promise.resolve({ data: true, error: null });
    },
    from: (table: string) => {
      const ctx = { deleting: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        not: () => chain,
        // The only `.in()` caller on the create path is the menu_items fetch.
        in: () => Promise.resolve({ data: state.menuRows, error: null }),
        insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
          if (table === 'orders') {
            state.orderInsert = payload as Record<string, unknown>;
            return chain;
          }
          if (table === 'order_items') state.itemRows = payload as Record<string, unknown>[];
          return Promise.resolve({ error: null });
        },
        delete: () => {
          ctx.deleting = true;
          return chain;
        },
        maybeSingle: () =>
          table === 'profiles'
            ? Promise.resolve({ data: { phone: '+919000000000', phone_verified: true }, error: null })
            : Promise.resolve({ data: { id: TABLE_ID, label: 'T1', is_active: true }, error: null }),
        single: () =>
          Promise.resolve({
            data: {
              ...state.orderInsert,
              id: ORDER_ID,
              order_items: state.itemRows.map((r) => ({ ...r, order_item_addons: [] })),
            },
            error: null,
          }),
        // `await admin.from('orders').delete().eq(...)`.
        then: (resolve: (v: unknown) => void) => {
          if (ctx.deleting) state.deleted.push(table);
          resolve({ error: null });
        },
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  getAuthUser: () => Promise.resolve(state.sessionUser),
  actorRoleFor: () => 'staff',
}));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));
vi.mock('@/lib/store/hours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/store/hours')>();
  return { ...actual, computeStoreOpenState: () => ({ acceptingOrders: true, reason: null }) };
});
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve(state.settings) }));
const { sendBillNotification } = vi.hoisted(() => ({ sendBillNotification: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification }));

// The coupon is 10% of whatever subtotal it is asked about, so what the route
// passes it (CP-D12: subtotal less the pass) shows in the discount.
vi.mock('@/lib/promotions/coupons', () => ({
  validateAndComputeCoupon: (_code: string, ctx: { subtotalInr: number }) => {
    state.couponCtx = ctx;
    return Promise.resolve({
      ok: true,
      discountInr: Math.round(ctx.subtotalInr * 0.1),
      coupon: { id: 'coupon-1', usage_limit: null, per_user_limit: null },
    });
  },
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  // 1 Beanie = ₹1, capped at what is left to pay.
  quoteRedemption: (_userId: string, points: number, remaining: number) => {
    state.quoteRemaining = remaining;
    const discountInr = Math.min(points, remaining);
    return Promise.resolve({ ok: true, discountInr, points: discountInr });
  },
  redeemForOrder: () => Promise.resolve(),
  reverseForOrder: () => Promise.resolve(),
}));
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(state.linkedUserId ? { userId: state.linkedUserId, name: 'Regular' } : null),
  createCounterCustomer: vi.fn(() => Promise.resolve(null)),
}));
const { createPaymentIntent } = vi.hoisted(() => ({ createPaymentIntent: vi.fn((_orderId: string, _amountInr: number): Promise<unknown> => Promise.resolve(null)) }));
vi.mock('@/lib/payments/gateway', () => ({ createPaymentIntent }));

const passesServer = vi.hoisted(() => ({
  loadUsablePassSummaries: vi.fn(),
  loadEligibleMenuIds: vi.fn(),
  redeemPassDrinks: vi.fn(),
}));
vi.mock('@/lib/passes/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/passes/server')>();
  return { ...actual, ...passesServer };
});

const { POST } = await import('@/app/api/orders/route');
const { createCounterCustomer } = await import('@/lib/loyalty/customerLink');

function req(body: unknown) {
  return new Request('http://t/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const line = (key: keyof typeof MENU, quantity = 1) => ({
  menu_item_id: MENU[key],
  variant_id: VARIANT[key],
  quantity,
  addon_option_ids: [],
});

function menuRow(key: keyof typeof MENU, name: string, price: number) {
  return {
    id: MENU[key],
    name,
    category: 'Beverages',
    is_available: true,
    unavailable_until: null,
    menu_item_variants: [{ id: VARIANT[key], label: 'L', price_inr: price, sort_order: 0 }],
    menu_item_addon_groups: [],
  };
}

function pass(over: Record<string, unknown> = {}) {
  return {
    id: 'pass-1',
    plan_id: 'plan-weekly',
    plan_name: 'Weekly Ritual',
    drinks_total: 7,
    drinks_used: 2,
    drinks_credited: 0,
    drinks_remaining: 5,
    drink_value_inr: 150,
    max_per_day: null,
    used_today: 0,
    price_inr: 750,
    starts_at: new Date(Date.now() - 864e5).toISOString(),
    expires_at: new Date(Date.now() + 5 * 864e5).toISOString(),
    status: 'active',
    state: 'active',
    order_id: 'sale-1',
    ...over,
  };
}

// A signed-in web customer paying at the counter.
const web = (extra: Record<string, unknown> = {}) => ({
  customer_name: 'Asha',
  customer_phone: '9000000000',
  pickup_slot_label: 'ASAP',
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  flagState.coffeePass = true;
  state.actor = null;
  state.sessionUser = { id: 'cust-1' };
  state.linkedUserId = null;
  state.settings = { gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0, pickup_slot_capacity: 0 };
  state.menuRows = [
    menuRow('capp', 'Cappuccino', 120),
    menuRow('lotus', 'Lotus Biscoff Latte', 215),
    menuRow('latte', 'Latte', 140),
    menuRow('sandwich', 'Sandwich', 180),
  ];
  state.passes = [pass()];
  state.eligible = [MENU.capp, MENU.lotus, MENU.latte]; // the sandwich is not a drink a pass can pay for
  state.redeemCode = 'ok';
  state.orderInsert = undefined;
  state.itemRows = [];
  state.deleted = [];
  state.calls = [];
  state.couponCtx = undefined;
  state.quoteRemaining = undefined;
  passesServer.loadUsablePassSummaries.mockImplementation(() => Promise.resolve(state.passes));
  passesServer.loadEligibleMenuIds.mockImplementation((_admin: unknown, ids?: string[]) =>
    Promise.resolve(new Set(state.eligible.filter((id) => !ids || ids.includes(id)))),
  );
  passesServer.redeemPassDrinks.mockImplementation(() => {
    state.calls.push('pass_redeem');
    return Promise.resolve(state.redeemCode);
  });
});

describe('POST /api/orders — HIOC Ritual cups (spec §6 examples through the route)', () => {
  it('A: one cup pays for a whole Cappuccino, so the order is ₹0 and starts paid (web)', async () => {
    const res = await POST(req(web({ items: [line('capp')], pass_drinks: 1 })));
    expect(res.status).toBe(201);
    expect(state.orderInsert).toMatchObject({
      subtotal_inr: 120,
      tax_inr: 0,
      discount_inr: 0,
      pass_discount_inr: 120,
      total_inr: 0,
      payment_status: 'paid', // the existing ₹0 path
      status: 'received',
    });
    // The line records what the cup covered.
    expect(state.itemRows).toHaveLength(1);
    expect(state.itemRows[0]).toMatchObject({ pass_drinks: 1, pass_covered_inr: 120 });
    // Nothing to collect, so there is no gateway intent and the bill goes out at once.
    const body = await res.json();
    expect(body.payment).toBeNull();
    expect(body.payment_unavailable).toBe(false);
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('B paid online: the gateway is asked for the top-up (₹68), not the drink value, and the order waits at placed', async () => {
    createPaymentIntent.mockResolvedValueOnce({ id: 'order_rzp_1', amount: 6800 });
    const res = await POST(req(web({ items: [line('lotus'), line('capp')], pass_drinks: 2, payment_mode: 'online' })));
    expect(res.status).toBe(201);
    expect(createPaymentIntent).toHaveBeenCalledWith(ORDER_ID, 68);
    expect(state.orderInsert).toMatchObject({ status: 'placed', payment_status: 'payment_pending', payment_method: 'online', total_inr: 68 });
    // The cups were spent before the customer was sent to pay.
    expect(passesServer.redeemPassDrinks).toHaveBeenCalledTimes(1);
  });

  it('A paid online: nothing is left to pay, so no gateway intent is made and the order is not held at placed', async () => {
    const res = await POST(req(web({ items: [line('capp')], pass_drinks: 1, payment_mode: 'online' })));
    expect(res.status).toBe(201);
    expect(createPaymentIntent).not.toHaveBeenCalled();
    expect(state.orderInsert).toMatchObject({ status: 'received', payment_status: 'paid', payment_method: null });
  });

  it('A at the counter: the same ₹0 order is paid and accepted, and no bill is sent at creation', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.sessionUser = { id: 'staff-1' };
    state.linkedUserId = 'cust-9';
    const res = await POST(
      req({ customer_phone: '9000000000', order_type: 'dine_in', table_id: TABLE_ID, items: [line('capp')], pass_drinks: 1 }),
    );
    expect(res.status).toBe(201);
    expect(state.orderInsert).toMatchObject({
      channel: 'staff_pos',
      status: 'accepted',
      total_inr: 0,
      payment_status: 'paid',
      pass_discount_inr: 120,
      customer_user_id: 'cust-9',
      user_id: null,
    });
    // The cups are the LINKED customer's, never the staffer's.
    expect(passesServer.loadUsablePassSummaries.mock.calls[0][1]).toBe('cust-9');
    expect(passesServer.redeemPassDrinks.mock.calls[0][1]).toMatchObject({ userId: 'cust-9', orderId: ORDER_ID });
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('B: two cups on a ₹215 and a ₹120 drink cover ₹150 + ₹120, and GST is charged only on the ₹65 left: total ₹68', async () => {
    const res = await POST(req(web({ items: [line('lotus'), line('capp')], pass_drinks: 2 })));
    expect(res.status).toBe(201);
    expect(state.orderInsert).toMatchObject({
      subtotal_inr: 335,
      tax_inr: 3, // 5% of (335 - 270) = 3.25, rounded
      discount_inr: 0,
      pass_discount_inr: 270,
      total_inr: 68,
      payment_status: 'unpaid', // a top-up is still owed
    });
    expect(state.itemRows.find((r) => r.menu_item_id === MENU.lotus)).toMatchObject({ pass_drinks: 1, pass_covered_inr: 150 });
    expect(state.itemRows.find((r) => r.menu_item_id === MENU.capp)).toMatchObject({ pass_drinks: 1, pass_covered_inr: 120 });
  });

  it('C: one cup + a 10% coupon: the coupon is on the ₹180 left after the pass (₹18), total ₹171', async () => {
    const res = await POST(req(web({ items: [line('latte'), line('sandwich')], pass_drinks: 1, coupon_code: 'TEN' })));
    expect(res.status).toBe(201);
    expect(state.couponCtx?.subtotalInr).toBe(180); // 320 - 140, CP-D12
    expect(state.orderInsert).toMatchObject({
      subtotal_inr: 320,
      tax_inr: 9,
      discount_inr: 18, // coupon only, never the pass
      pass_discount_inr: 140,
      total_inr: 171,
    });
    // Only the drink took the cup.
    expect(state.itemRows.find((r) => r.menu_item_id === MENU.latte)).toMatchObject({ pass_drinks: 1, pass_covered_inr: 140 });
    expect(state.itemRows.find((r) => r.menu_item_id === MENU.sandwich)).not.toHaveProperty('pass_drinks');
  });

  it('D: three Cappuccinos and one cup left: one unit is covered (₹120), the other two are taxed and paid: total ₹252', async () => {
    state.passes = [pass({ drinks_remaining: 1 })];
    const res = await POST(req(web({ items: [line('capp', 3)], pass_drinks: 1 })));
    expect(res.status).toBe(201);
    expect(state.orderInsert).toMatchObject({
      subtotal_inr: 360,
      tax_inr: 12,
      pass_discount_inr: 120,
      total_inr: 252,
    });
    // One of the three units, not the whole line.
    expect(state.itemRows[0]).toMatchObject({ quantity: 3, pass_drinks: 1, pass_covered_inr: 120 });
  });

  it('the pass comes first, then the coupon, then Beanies (CP-D12)', async () => {
    // Latte ₹140 + Sandwich ₹180, one cup, a 10% coupon and 50 Beanies.
    const res = await POST(
      req(web({ items: [line('latte'), line('sandwich')], pass_drinks: 1, coupon_code: 'TEN', redeem_points: 50 })),
    );
    expect(res.status).toBe(201);
    // Beanies are asked about what is left after BOTH the pass and the coupon.
    expect(state.quoteRemaining).toBe(180 - 18);
    expect(state.orderInsert).toMatchObject({
      subtotal_inr: 320,
      tax_inr: 9,
      discount_inr: 68, // coupon 18 + Beanies 50
      pass_discount_inr: 140,
      total_inr: 320 + 9 - 68 - 140,
    });
    // And they are applied in that order in the database, the cups first so
    // that anything failing after them takes them back with the order.
    expect(state.calls).toEqual(['pass_redeem', 'try_redeem_coupon', 'try_redeem_points']);
  });

  it('a dine-in order keeps the packaging rule (none) alongside the pass', async () => {
    state.settings = { ...state.settings, packaging_charge_inr: 20 };
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.linkedUserId = 'cust-9';
    const res = await POST(
      req({ customer_phone: '9000000000', order_type: 'dine_in', table_id: TABLE_ID, items: [line('latte'), line('sandwich')], pass_drinks: 1 }),
    );
    expect(res.status).toBe(201);
    expect(state.orderInsert).toMatchObject({ packaging_inr: 0, total_inr: 320 + 9 - 140 });
  });

  it('sends the allocations the redeem function needs: pass id, the order line id, cups and rupees', async () => {
    await POST(req(web({ items: [line('lotus'), line('capp')], pass_drinks: 2 })));
    const args = passesServer.redeemPassDrinks.mock.calls[0][1] as {
      userId: string;
      orderId: string;
      allocations: { pass_id: string; order_item_id: string; drinks: number; covered_inr: number }[];
    };
    expect(args.userId).toBe('cust-1');
    expect(args.orderId).toBe(ORDER_ID);
    // Each allocation names a line by the id it was inserted with.
    const ids = state.itemRows.map((r) => r.id);
    expect(args.allocations).toHaveLength(2);
    for (const a of args.allocations) {
      expect(a.pass_id).toBe('pass-1');
      expect(ids).toContain(a.order_item_id);
    }
    expect(args.allocations.map((a) => a.covered_inr).sort()).toEqual([120, 150]);
  });
});

describe('POST /api/orders — HIOC Ritual refusals', () => {
  it('400s a request for cups while the feature is off', async () => {
    flagState.coffeePass = false;
    const res = await POST(req(web({ items: [line('capp')], pass_drinks: 1 })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("HIOC Ritual isn't available yet");
    expect(state.orderInsert).toBeUndefined();
    expect(passesServer.redeemPassDrinks).not.toHaveBeenCalled();
  });

  it('400s a malformed pass_drinks whatever the flag says', async () => {
    for (const bad of [1.5, -1, 21, '2']) {
      const res = await POST(req(web({ items: [line('capp')], pass_drinks: bad })));
      expect(res.status).toBe(400);
    }
    expect(state.orderInsert).toBeUndefined();
  });

  it('a counter number with no account has no cups: 400 with a message the staffer can act on, and nothing is created', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff' };
    state.sessionUser = { id: 'staff-1' };
    state.linkedUserId = null;
    const res = await POST(
      req({ customer_phone: '9111111111', order_type: 'dine_in', table_id: TABLE_ID, items: [line('capp')], pass_drinks: 1 }),
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/No customer account is linked to this number/);
    expect(error).toMatch(/HIOC Ritual/);
    expect(state.orderInsert).toBeUndefined();
    expect(createCounterCustomer).not.toHaveBeenCalled(); // no account is opened for a refused order
  });

  it('a guest cannot use cups', async () => {
    state.sessionUser = null;
    const res = await POST(
      req({ customer_name: 'Guest', pickup_slot_label: 'ASAP', payment_mode: 'online', items: [line('capp')], pass_drinks: 1 }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/logged in to use your HIOC Ritual/);
    expect(state.orderInsert).toBeUndefined();
  });

  it('400s when fewer cups can be applied than were asked for, saying why, and creates nothing', async () => {
    state.passes = [pass({ drinks_remaining: 2 })];
    const res = await POST(req(web({ items: [line('capp', 3)], pass_drinks: 3 })));
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('You have 2 cups left on your HIOC Ritual pass, so 2 cups can be used.');
    expect(state.orderInsert).toBeUndefined();
    expect(passesServer.redeemPassDrinks).not.toHaveBeenCalled();
  });

  it('400s when nothing in the cart is eligible', async () => {
    const res = await POST(req(web({ items: [line('sandwich')], pass_drinks: 1 })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Nothing in this order can be paid with a HIOC Ritual pass/);
    expect(state.orderInsert).toBeUndefined();
  });

  it('400s a customer who has no pass at all', async () => {
    state.passes = [];
    const res = await POST(req(web({ items: [line('capp')], pass_drinks: 1 })));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no HIOC Ritual cups to use/);
  });
});

describe('POST /api/orders — the redeem call refusing (a cup spent elsewhere first)', () => {
  it('rolls the order back and answers 409 in the same shape as the coupon and Beanies races', async () => {
    state.redeemCode = 'insufficient';
    const res = await POST(req(web({ items: [line('capp')], pass_drinks: 1, coupon_code: 'TEN', redeem_points: 10 })));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not have enough cups left/);
    expect(state.deleted).toEqual(['orders']); // the order is withdrawn (its redemptions cascade)
    // Nothing that comes after the cups is attempted.
    expect(state.calls).toEqual(['pass_redeem']);
  });

  it.each([
    ['expired', /has expired/],
    ['daily_limit', /today's limit/],
    ['inactive', /no longer active/],
    ['not_owner', /not on your account/],
    ['bad_input', /could not apply/],
  ])('maps %s to a readable 409', async (code, message) => {
    state.redeemCode = code;
    const res = await POST(req(web({ items: [line('capp')], pass_drinks: 1 })));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
    expect(state.deleted).toEqual(['orders']);
  });

  it("an 'error' (the function is missing or the database is down) deletes the order and answers 503", async () => {
    state.redeemCode = 'error';
    const res = await POST(req(web({ items: [line('capp')], pass_drinks: 1 })));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('HIOC Ritual is temporarily unavailable');
    expect(state.deleted).toEqual(['orders']);
  });
});

describe('POST /api/orders — inert when no cups are used', () => {
  it('flag on, pass_drinks absent: no pass query, no pass columns, no redeem', async () => {
    const res = await POST(req(web({ items: [line('latte'), line('sandwich')] })));
    expect(res.status).toBe(201);
    expect(state.orderInsert).not.toHaveProperty('pass_discount_inr');
    for (const row of state.itemRows) {
      expect(row).not.toHaveProperty('pass_drinks');
      expect(row).not.toHaveProperty('pass_covered_inr');
    }
    expect(passesServer.loadUsablePassSummaries).not.toHaveBeenCalled();
    expect(passesServer.loadEligibleMenuIds).not.toHaveBeenCalled();
    expect(passesServer.redeemPassDrinks).not.toHaveBeenCalled();
    // The bill is the one this route has always made: 320 + 5% GST.
    expect(state.orderInsert).toMatchObject({ subtotal_inr: 320, tax_inr: 16, discount_inr: 0, total_inr: 336 });
  });

  it('flag off and pass_drinks 0: identical, and the pass tables are never touched', async () => {
    flagState.coffeePass = false;
    const res = await POST(req(web({ items: [line('latte')], pass_drinks: 0 })));
    expect(res.status).toBe(201);
    expect(state.orderInsert).not.toHaveProperty('pass_discount_inr');
    expect(passesServer.loadUsablePassSummaries).not.toHaveBeenCalled();
    expect(passesServer.redeemPassDrinks).not.toHaveBeenCalled();
  });

  it('a coupon and Beanies without a pass are computed on the whole subtotal, exactly as before', async () => {
    const res = await POST(req(web({ items: [line('latte'), line('sandwich')], coupon_code: 'TEN', redeem_points: 50 })));
    expect(res.status).toBe(201);
    expect(state.couponCtx?.subtotalInr).toBe(320);
    expect(state.quoteRemaining).toBe(320 - 32);
    expect(state.orderInsert).toMatchObject({ discount_inr: 82, total_inr: 320 + 16 - 82 });
    expect(state.orderInsert).not.toHaveProperty('pass_discount_inr');
  });
});
