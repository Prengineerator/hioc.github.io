import { beforeEach, describe, expect, it, vi } from 'vitest';

// Manager discount through the quote and amend routes (lib/orders/manualDiscount.ts):
// the POS previews it with POST /api/orders/quote (manager or owner only, like
// create), and a void or edit on the order later keeps it — lowered only when
// the bill falls below it, and the column written back only when it changed.

const LATTE = '11111111-1111-4111-8111-111111111111';
const LATTE_R = '11111111-1111-4111-8111-1111111111a1';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const LINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const LINE_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

const latteRow = {
  id: LATTE,
  name: 'Latte',
  category: 'Coffee',
  is_available: true,
  unavailable_until: null,
  menu_item_variants: [{ id: LATTE_R, label: 'Regular', price_inr: 200, sort_order: 0 }],
  menu_item_addon_groups: [],
};

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  current: Record<string, unknown> | null;
  orderPatch?: Record<string, unknown>;
} = { actor: null, current: null };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders') state.orderPatch = p;
          return chain;
        },
        insert: () => Promise.resolve({ error: null }),
        eq: () => chain,
        neq: () => chain,
        in: () => Promise.resolve({ data: table === 'menu_items' ? [latteRow] : [], error: null }),
        maybeSingle: () =>
          Promise.resolve(ctx.isUpdate ? { data: { id: ORDER_ID }, error: null } : { data: state.current, error: null }),
        single: () => Promise.resolve({ data: { id: ORDER_ID }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(null),
  getCounterActor: () => Promise.resolve(state.actor),
  actorRoleFor: () => 'staff',
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 10 }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(null),
  toStoredPhone: (p: unknown) => (typeof p === 'string' ? p : ''),
}));
vi.mock('@/lib/promotions/coupons', () => ({
  validateAndComputeCoupon: () => Promise.resolve({ ok: true, discountInr: 50 }),
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(0),
  quoteRedemption: () => Promise.resolve({ ok: false, reason: 'n/a' }),
}));

const { POST: quote } = await import('@/app/api/orders/quote/route');
const { POST: amend } = await import('@/app/api/orders/[id]/amend/route');

const post = (url: string, body: unknown) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const lattes = (quantity: number) => [{ menu_item_id: LATTE, variant_id: LATTE_R, quantity, addon_option_ids: [] }];

beforeEach(() => {
  state.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'device' };
  state.current = null;
  state.orderPatch = undefined;
});

describe('POST /api/orders/quote with a manager discount', () => {
  it('a manager: previews it after the coupon, before GST', async () => {
    const res = await quote(
      post('https://t/api/orders/quote', {
        items: lattes(2),
        order_type: 'dine_in',
        coupon_code: 'SAVE50',
        manual_discount: { amount_inr: 30, reason: 'Regular' },
      }),
    );
    expect(res.status).toBe(200);
    // ₹400 - ₹50 coupon - ₹30 manager = ₹320, GST 5% = ₹16 → ₹336.
    expect((await res.json()).bill).toMatchObject({
      subtotal_inr: 400,
      discount_inr: 80,
      manual_discount_inr: 30,
      tax_inr: 16,
      total_inr: 336,
    });
  });

  it('staff, or nobody signed in, is refused', async () => {
    for (const actor of [{ user: { id: 'ravi' }, role: 'staff', via: 'device' as const }, null]) {
      state.actor = actor;
      const res = await quote(
        post('https://t/api/orders/quote', { items: lattes(1), manual_discount: { amount_inr: 30, reason: 'x' } }),
      );
      expect(res.status).toBe(403);
    }
  });

  it('a malformed one is a 400', async () => {
    const res = await quote(post('https://t/api/orders/quote', { items: lattes(1), manual_discount: { amount_inr: 30 } }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/orders/[id]/amend on an order with a manager discount', () => {
  const line = (id: string) => ({
    id,
    voided: false,
    quantity: 1,
    price_inr_snapshot: 200,
    line_total_inr: 200,
    menu_item_id: LATTE,
    name_snapshot: 'Latte',
  });
  const order = (manual: number | undefined, discount: number) => ({
    id: ORDER_ID,
    status: 'accepted',
    version: 1,
    order_type: 'dine_in',
    payment_status: 'unpaid',
    discount_inr: discount,
    ...(manual === undefined ? {} : { manual_discount_inr: manual }),
    order_items: [line(LINE_A), line(LINE_B)],
  });
  const voidB = () =>
    amend(post(`http://t/api/orders/${ORDER_ID}/amend`, { item_id: LINE_B, reason: 'wrong item' }), {
      params: { id: ORDER_ID },
    });

  it('a void keeps it when the bill still covers it, and does not resend the unchanged column', async () => {
    state.current = order(50, 50);
    expect((await voidB()).status).toBe(200);
    // ₹200 - ₹50 = ₹150, GST ₹7.5 → ₹8 → ₹158.
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 200, discount_inr: 50, total_inr: 158 });
    expect(state.orderPatch).not.toHaveProperty('manual_discount_inr');
  });

  it('a void that takes the bill below it lowers it, and writes the new amount', async () => {
    state.current = order(300, 300);
    expect((await voidB()).status).toBe(200);
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 200, discount_inr: 200, manual_discount_inr: 200, total_inr: 0 });
  });

  it('an order without one never sends the column', async () => {
    state.current = order(undefined, 0);
    expect((await voidB()).status).toBe(200);
    expect(state.orderPatch).not.toHaveProperty('manual_discount_inr');
  });
});
