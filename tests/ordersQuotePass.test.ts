import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/orders/quote with a cart (`items`) and HIOC Ritual cups
// (docs/COFFEE-PASS-SPEC.md §7). The quote must price the cart server-side by the
// same rules the create route charges by (lib/orders/lines.ts +
// lib/orders/passPricing.ts), ignore whatever subtotal the client sends, and add
// a `pass` block only when the feature is on and there is an account to spend
// cups from. tests/ordersQuoteRoute.test.ts keeps covering the older
// subtotal-only preview.

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

const flagState = vi.hoisted(() => ({ coffeePass: true }));
vi.mock('@/lib/flags', () => ({ flags: flagState }));

const state: {
  sessionUser: { id: string } | null;
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  linkedUserId: string | null;
  menuRows: Record<string, unknown>[];
  settings: Record<string, unknown>;
  passes: Record<string, unknown>[];
  eligible: string[];
  couponCtx?: { subtotalInr: number; itemIds: string[]; categories: string[] };
  quoteRemaining?: number;
  menuQueried: boolean;
} = {
  sessionUser: null,
  actor: null,
  linkedUserId: null,
  menuRows: [],
  settings: {},
  passes: [],
  eligible: [],
  menuQueried: false,
};

vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(state.sessionUser),
  getCounterActor: () => Promise.resolve(state.actor),
}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        in: () => {
          state.menuQueried = true;
          return Promise.resolve({ data: state.menuRows, error: null });
        },
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(state.linkedUserId ? { userId: state.linkedUserId } : null),
  toStoredPhone: (p: unknown) => (typeof p === 'string' ? p : ''),
}));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve(state.settings) }));
vi.mock('@/lib/promotions/coupons', () => ({
  // 10% of whatever subtotal it is asked about.
  validateAndComputeCoupon: (_code: string, ctx: { subtotalInr: number; itemIds: string[]; categories: string[] }) => {
    state.couponCtx = ctx;
    return Promise.resolve({ ok: true, discountInr: Math.round(ctx.subtotalInr * 0.1), coupon: { id: 'c1' } });
  },
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(500),
  quoteRedemption: (_userId: string, points: number, remaining: number) => {
    state.quoteRemaining = remaining;
    const discountInr = Math.min(points, remaining);
    return Promise.resolve({ ok: true, discountInr, points: discountInr });
  },
}));
const passesServer = vi.hoisted(() => ({
  loadUsablePassSummaries: vi.fn(),
  loadEligibleMenuIds: vi.fn(),
}));
vi.mock('@/lib/passes/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/passes/server')>();
  return { ...actual, ...passesServer };
});

const { POST } = await import('@/app/api/orders/quote/route');

function req(body: unknown) {
  return new Request('https://hioc.in/api/orders/quote', {
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
function menuRow(key: keyof typeof MENU, name: string, price: number, extra: Record<string, unknown> = {}) {
  return {
    id: MENU[key],
    name,
    category: 'Beverages',
    is_available: true,
    unavailable_until: null,
    menu_item_variants: [{ id: VARIANT[key], label: 'L', price_inr: price, sort_order: 0 }],
    menu_item_addon_groups: [],
    ...extra,
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

beforeEach(() => {
  vi.clearAllMocks();
  flagState.coffeePass = true;
  state.sessionUser = { id: 'cust-1' };
  state.actor = null;
  state.linkedUserId = null;
  state.settings = { gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0 };
  state.menuRows = [
    menuRow('capp', 'Cappuccino', 120),
    menuRow('lotus', 'Lotus Biscoff Latte', 215),
    menuRow('latte', 'Latte', 140),
    menuRow('sandwich', 'Sandwich', 180, { category: 'Food', gst_exempt: false }),
  ];
  state.passes = [pass()];
  state.eligible = [MENU.capp, MENU.lotus, MENU.latte];
  state.couponCtx = undefined;
  state.quoteRemaining = undefined;
  state.menuQueried = false;
  passesServer.loadUsablePassSummaries.mockImplementation(() => Promise.resolve(state.passes));
  passesServer.loadEligibleMenuIds.mockImplementation((_admin: unknown, ids?: string[]) =>
    Promise.resolve(new Set(state.eligible.filter((id) => !ids || ids.includes(id)))),
  );
});

describe('POST /api/orders/quote — items and HIOC Ritual cups', () => {
  it('prices the cart server-side and ignores the client subtotal', async () => {
    const res = await POST(req({ items: [line('latte'), line('sandwich')], subtotal_inr: 1, taxable_subtotal_inr: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bill).toMatchObject({ subtotal_inr: 320, tax_inr: 16, total_inr: 336, pass_discount_inr: 0 });
    expect(state.menuQueried).toBe(true);
  });

  it('does not need a client subtotal at all when items are sent', async () => {
    const res = await POST(req({ items: [line('capp')] }));
    expect(res.status).toBe(200);
    expect((await res.json()).bill.subtotal_inr).toBe(120);
  });

  it('example B: 2 cups on ₹215 + ₹120 give bill ₹68 and a pass block', async () => {
    const res = await POST(req({ items: [line('lotus'), line('capp')], pass_drinks: 2 }));
    const body = await res.json();
    expect(body.bill).toMatchObject({
      subtotal_inr: 335,
      tax_inr: 3,
      discount_inr: 0,
      pass_discount_inr: 270,
      total_inr: 68,
    });
    expect(body.pass).toMatchObject({
      requested: 2,
      applied: 2,
      discount_inr: 270,
      eligible_units: 2,
      available: 5,
      max_usable: 2,
      shortfall: null,
      message: null,
    });
    expect(body.pass.passes).toHaveLength(1);
    expect(body.pass.passes[0]).toMatchObject({ id: 'pass-1', plan_name: 'Weekly Ritual', drinks_remaining: 5 });
    // A summary describes the pass; it never carries who holds it.
    expect(JSON.stringify(body.pass)).not.toContain('cust-1');
    expect(body.pass.passes[0]).not.toHaveProperty('user_id');
  });

  it('example C: coupon on what is left after the pass, so the preview matches the charge', async () => {
    const res = await POST(req({ items: [line('latte'), line('sandwich')], pass_drinks: 1, coupon_code: 'TEN' }));
    const body = await res.json();
    expect(state.couponCtx?.subtotalInr).toBe(180);
    // The coupon is judged on the cart the server priced, not client ids.
    expect(state.couponCtx?.itemIds.sort()).toEqual([MENU.latte, MENU.sandwich].sort());
    expect(state.couponCtx?.categories.sort()).toEqual(['Beverages', 'Food']);
    expect(body.bill).toMatchObject({ discount_inr: 18, pass_discount_inr: 140, tax_inr: 9, total_inr: 171 });
  });

  it('applies Beanies to what is left after the pass and the coupon', async () => {
    const res = await POST(
      req({ items: [line('latte'), line('sandwich')], pass_drinks: 1, coupon_code: 'TEN', redeem_points: 50 }),
    );
    const body = await res.json();
    expect(state.quoteRemaining).toBe(162);
    expect(body.bill.discount_inr).toBe(68);
    expect(body.bill.total_inr).toBe(320 + 9 - 68 - 140);
    expect(body.points).toMatchObject({ ok: true, discountInr: 50 });
    expect(body.balance).toBe(500);
  });

  it('example D: asking for 1 of 3 cups on three Cappuccinos, with one cup left', async () => {
    state.passes = [pass({ drinks_remaining: 1 })];
    const body = await (await POST(req({ items: [line('capp', 3)], pass_drinks: 1 }))).json();
    expect(body.bill).toMatchObject({ subtotal_inr: 360, tax_inr: 12, pass_discount_inr: 120, total_inr: 252 });
    expect(body.pass).toMatchObject({ applied: 1, eligible_units: 3, available: 1, max_usable: 1 });
  });

  it('reports the shortfall and a message when fewer cups apply than asked for', async () => {
    state.passes = [pass({ drinks_remaining: 1 })];
    const body = await (await POST(req({ items: [line('capp', 3)], pass_drinks: 3 }))).json();
    expect(body.pass).toMatchObject({ requested: 3, applied: 1, shortfall: 'not_enough_drinks' });
    expect(body.pass.message).toContain('1 cup left on your HIOC Ritual');
    expect(body.bill.pass_discount_inr).toBe(120); // it previews what WOULD apply
  });

  it('with no cups asked for it still says what is available and the most this cart could use (the checkout pre-fills it)', async () => {
    const body = await (await POST(req({ items: [line('capp', 3), line('sandwich')] }))).json();
    expect(body.pass).toMatchObject({ requested: 0, applied: 0, discount_inr: 0, eligible_units: 3, available: 5, max_usable: 3 });
    expect(body.bill.pass_discount_inr).toBe(0);
  });

  it("max_usable respects a daily limit that 'available' ignores", async () => {
    state.passes = [pass({ max_per_day: 1, used_today: 0 })];
    const body = await (await POST(req({ items: [line('capp', 3)] }))).json();
    expect(body.pass).toMatchObject({ available: 5, eligible_units: 3, max_usable: 1 });
  });

  it('a customer with no usable pass gets an empty pass block, not null (an account is known)', async () => {
    state.passes = [];
    const body = await (await POST(req({ items: [line('capp')], pass_drinks: 1 }))).json();
    expect(body.pass).toMatchObject({ requested: 1, applied: 0, available: 0, shortfall: 'no_pass', passes: [] });
    expect(passesServer.loadEligibleMenuIds).not.toHaveBeenCalled(); // nothing to allocate, so no second query
  });

  it('is null while the feature is off, and nothing is asked of the pass tables', async () => {
    flagState.coffeePass = false;
    const body = await (await POST(req({ items: [line('capp')], pass_drinks: 2 }))).json();
    expect(body.pass).toBeNull();
    expect(body.bill).toMatchObject({ subtotal_inr: 120, pass_discount_inr: 0, total_inr: 126 });
    expect(passesServer.loadUsablePassSummaries).not.toHaveBeenCalled();
  });

  it('is null with no account: an anonymous caller', async () => {
    state.sessionUser = null;
    const body = await (await POST(req({ items: [line('capp')], pass_drinks: 1 }))).json();
    expect(body.pass).toBeNull();
    expect(body.bill.pass_discount_inr).toBe(0);
    expect(passesServer.loadUsablePassSummaries).not.toHaveBeenCalled();
  });

  it('is null without items (the older subtotal-only preview cannot see which drinks are eligible)', async () => {
    const body = await (await POST(req({ subtotal_inr: 300, pass_drinks: 1 }))).json();
    expect(body.pass).toBeNull();
    expect(body.bill.subtotal_inr).toBe(300);
    expect(passesServer.loadUsablePassSummaries).not.toHaveBeenCalled();
  });

  it("at the counter, previews the LINKED customer's cups, never the staffer's", async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.sessionUser = { id: 'staff-1' };
    state.linkedUserId = 'cust-42';
    const body = await (await POST(req({ items: [line('capp')], pass_drinks: 1, customer_phone: '9000000000' }))).json();
    expect(passesServer.loadUsablePassSummaries.mock.calls[0][1]).toBe('cust-42');
    expect(body.pass).toMatchObject({ applied: 1 });
  });

  it('at the counter with no linked customer there is no pass block', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.linkedUserId = null;
    const body = await (await POST(req({ items: [line('capp')], pass_drinks: 1, customer_phone: '9111111111' }))).json();
    expect(body.pass).toBeNull();
  });

  it('dine-in drops the packaging charge from the previewed total, pass or not', async () => {
    state.settings = { ...state.settings, packaging_charge_inr: 20 };
    const dineIn = await (await POST(req({ items: [line('latte')], pass_drinks: 1, order_type: 'dine_in' }))).json();
    expect(dineIn.bill).toMatchObject({ packaging_inr: 0, total_inr: 0 });
    const takeaway = await (await POST(req({ items: [line('latte')], pass_drinks: 1 }))).json();
    expect(takeaway.bill).toMatchObject({ packaging_inr: 20, total_inr: 20 });
  });

  it('400s a malformed items array or pass_drinks, and an unknown menu item', async () => {
    expect((await POST(req({ items: [] }))).status).toBe(400);
    expect((await POST(req({ items: [{ menu_item_id: 'nope' }] }))).status).toBe(400);
    expect((await POST(req({ items: [line('capp')], pass_drinks: 99 }))).status).toBe(400);
    state.menuRows = [];
    expect((await POST(req({ items: [line('capp')] }))).status).toBe(400); // "does not exist"
  });

  it('still 400s a missing subtotal when no items were sent', async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ subtotal_inr: -5 }))).status).toBe(400);
  });
});
