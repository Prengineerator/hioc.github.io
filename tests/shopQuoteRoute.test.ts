import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';

// Handler-level test for POST /api/shop/quote: the real serverQuote and
// quoteShopCart on an in-memory database, with the loyalty ledger and the
// coupon lookups stubbed.

const state: {
  flags: { shop: boolean };
  admin: ReturnType<typeof makeFakeAdmin>;
  tables: Record<string, Row[]>;
  user: { id: string; email: string; email_confirmed_at: string | null } | null;
  authThrows: boolean;
  limits: string[];
  limited: Set<string>;
  balance: number;
  typed: Record<string, unknown> | null;
  auto: Record<string, unknown>[];
  introBuyers: Record<string, unknown>[];
} = {
  flags: { shop: true },
  admin: makeFakeAdmin({}, { startMs: 0 }),
  tables: {},
  user: null,
  authThrows: false,
  limits: [],
  limited: new Set(),
  balance: 0,
  typed: null,
  auto: [],
  introBuyers: [],
};

vi.mock('@/lib/flags', () => ({ flags: state.flags }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => state.admin }));
vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: (key: string) => {
    state.limits.push(key);
    return Promise.resolve(![...state.limited].some((p) => key.startsWith(p)));
  },
  clientIp: () => '203.0.113.9',
}));
vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => (state.authThrows ? Promise.reject(new Error('no session')) : Promise.resolve(state.user)),
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(state.balance),
  getLoyaltyConfig: () => Promise.resolve({ points_per_inr: 0.1, inr_per_point: 1, min_redeem_points: 50 }),
}));
vi.mock('@/lib/promotions/shopCoupons', () => ({
  findShopCoupon: (_a: unknown, code: string) =>
    Promise.resolve(state.typed && code.toUpperCase() === 'SAVE50' ? { ok: true, terms: state.typed } : { ok: false, reason: "That code isn't valid" }),
  loadAutoShopCoupons: () => Promise.resolve(state.auto),
}));

const { POST } = await import('@/app/api/shop/quote/route');

const terms = (code: string, value: number, auto = false) => ({
  id: `c-${code}`,
  code,
  discount_type: 'flat',
  discount_value: value,
  min_order_inr: 0,
  max_discount_inr: 0,
  shop_product_ids: [],
  is_auto: auto,
});

function req(body: unknown) {
  return new Request('http://localhost/api/shop/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const ONE = [{ product_id: 'classic', quantity: 1 }];

beforeEach(() => {
  state.flags.shop = true;
  state.user = null;
  state.authThrows = false;
  state.limits = [];
  state.limited = new Set();
  state.balance = 0;
  state.typed = null;
  state.auto = [];
  state.tables = {
    shop_products: [
      { id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1 },
      { id: 'hazelnut', name: 'Nutty Hazelnut', sku: 'HIOC-IC-HAZELNUT-50G', price_inr: 399, net_qty: '50 g', in_stock: false, sort_order: 2 },
    ],
    shop_settings: [],
    shop_intro_claims: [],
    shop_orders: [],
    orders: [],
    profiles: [],
  };
  state.admin = makeFakeAdmin(state.tables, { startMs: Date.parse('2026-11-12T08:00:00Z') });
});

describe('POST /api/shop/quote', () => {
  it('404s while the shop is switched off', async () => {
    state.flags.shop = false;
    expect((await POST(req({ items: ONE }))).status).toBe(404);
  });

  it('prices a guest cart, never cached', async () => {
    const res = await POST(req({ items: ONE }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      signed_in: false,
      coupon_error: null,
      quote: { subtotal_inr: 399, shipping_inr: 49, total_inr: 448, beanies: { state: 'guest' } },
    });
  });

  it('400s on a bad cart, an unsellable item and a missing body', async () => {
    expect((await POST(req({ items: [] }))).status).toBe(400);
    const gone = await POST(req({ items: [{ product_id: 'hazelnut', quantity: 1 }] }));
    expect(gone.status).toBe(400);
    expect((await gone.json()).error).toBe('Nutty Hazelnut is out of stock right now.');
    expect((await POST(new Request('http://localhost/api/shop/quote', { method: 'POST', body: 'nope' }))).status).toBe(400);
  });

  it('treats a failing session lookup as a guest', async () => {
    state.authThrows = true;
    const body = await (await POST(req({ items: ONE }))).json();
    expect(body.signed_in).toBe(false);
  });

  it('a signed-in repeat customer sees their Beanies applied (and can turn them off)', async () => {
    state.user = { id: 'user-1', email: 'riya@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
    state.balance = 400;
    state.tables.orders.push({ id: 'o1', user_id: 'user-1', payment_status: 'paid' });
    const on = await (await POST(req({ items: ONE }))).json();
    expect(on).toMatchObject({ signed_in: true, quote: { beanies: { state: 'applied', points: 19 }, total_inr: 429 } });
    const off = await (await POST(req({ items: ONE, use_beanies: false }))).json();
    expect(off.quote).toMatchObject({ beanies: { state: 'available_off' }, total_inr: 448 });
  });

  it('a signed-in first-time customer is told it is their first order', async () => {
    state.user = { id: 'user-2', email: 'new@example.com', email_confirmed_at: null };
    state.balance = 400;
    const body = await (await POST(req({ items: ONE }))).json();
    expect(body.quote.beanies.state).toBe('first_order');
  });

  it('uses the verified profile phone and login email for the intro-offer check, the body first', async () => {
    state.tables.shop_settings.push({ is_singleton: true, offer_active: true, offer_name: 'Introductory offer', offer_tier_prices: [299, 599, 749] });
    state.tables.shop_intro_claims.push({ shop_order_id: 'o', user_id: null, phone: '+919876543210', email: 'old@example.com' });
    // A guest typing a number that has claimed it: no offer.
    const typed = await (await POST(req({ items: ONE, phone: '98765 43210', email: 'new@example.com' }))).json();
    expect(typed.quote.intro_offer_applied).toBe(false);
    // The same guest with another number: offer.
    const other = await (await POST(req({ items: ONE, phone: '9000000001' }))).json();
    expect(other.quote.intro_offer_applied).toBe(true);
    // A signed-in customer whose VERIFIED profile phone has claimed it.
    state.user = { id: 'user-3', email: 'x@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
    state.tables.profiles.push({ id: 'user-3', phone: '+919876543210', phone_verified: true });
    const profile = await (await POST(req({ items: ONE }))).json();
    expect(profile.quote.intro_offer_applied).toBe(false);
    // An unverified profile phone is not used.
    state.tables.profiles[0].phone_verified = false;
    const unverified = await (await POST(req({ items: ONE }))).json();
    expect(unverified.quote.intro_offer_applied).toBe(true);
  });

  it('a typed code that works is applied; one that fails falls back to the best auto coupon with coupon_error', async () => {
    state.typed = terms('SAVE50', 50);
    state.auto = [terms('AUTO20', 20, true)];
    const ok = await (await POST(req({ items: ONE, coupon_code: 'save50' }))).json();
    expect(ok).toMatchObject({ coupon_error: null, quote: { coupon_code: 'SAVE50', coupon_discount_inr: 50, total_inr: 398 } });
    const bad = await (await POST(req({ items: ONE, coupon_code: 'WRONG' }))).json();
    expect(bad).toMatchObject({ coupon_error: "That code isn't valid", quote: { coupon_code: 'AUTO20', coupon_discount_inr: 20 } });
  });

  it('is rate limited, with a tighter bound on typed codes', async () => {
    await POST(req({ items: ONE }));
    expect(state.limits).toEqual(['shop-quote:203.0.113.9']);
    await POST(req({ items: ONE, coupon_code: 'SAVE50' }));
    expect(state.limits).toContain('shop-coupon:203.0.113.9');

    state.limited.add('shop-coupon:');
    const coupon = await POST(req({ items: ONE, coupon_code: 'SAVE50' }));
    expect(coupon.status).toBe(429);
    expect((await coupon.json()).error).toBe('Too many tries — please wait a few minutes.');
    expect((await POST(req({ items: ONE }))).status).toBe(200); // no code, no coupon bound

    state.limited.add('shop-quote:');
    expect((await POST(req({ items: ONE }))).status).toBe(429);
  });
});
