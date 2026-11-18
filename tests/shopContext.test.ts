import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';

// The server-side facts behind a shop quote (lib/shop/server.ts, lib/shop/context.ts):
// who may still have the introductory offer, who counts as a repeat customer, and
// serverQuote's coupon / Beanies decisions, on an in-memory database.

const state: { loyalty: { balance: number; config: Record<string, number> | null }; coupons: Record<string, unknown> } = {
  loyalty: { balance: 0, config: null },
  coupons: { typed: null, auto: [] },
};

vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(state.loyalty.balance),
  getLoyaltyConfig: () => Promise.resolve(state.loyalty.config),
}));
vi.mock('@/lib/promotions/shopCoupons', () => ({
  findShopCoupon: (_a: unknown, code: string) =>
    Promise.resolve(code.toUpperCase() === 'SAVE50' ? { ok: true, terms: state.coupons.typed } : { ok: false, reason: "That code isn't valid" }),
  loadAutoShopCoupons: () => Promise.resolve(state.coupons.auto),
}));

const { isIntroOfferEligible, isRepeatCustomer, loadShopProducts, loadShopPricingSettings } = await import('@/lib/shop/server');
const { serverQuote } = await import('@/lib/shop/context');

const opts = { startMs: Date.parse('2026-11-12T08:00:00Z') };
const BUYER = { userId: 'user-1', phone: '+919876543210', email: 'riya@example.com' };

/** A database where these tables answer with an error (a table not there yet, or a failure). */
function failing(admin: ReturnType<typeof makeFakeAdmin>, errors: Record<string, { code?: string; message?: string }>) {
  return {
    ...admin,
    from(table: string) {
      const err = errors[table];
      if (!err) return admin.from(table);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'neq', 'is', 'in', 'order', 'limit', 'insert', 'update', 'delete']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: err });
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: err });
      return chain;
    },
  } as unknown as ReturnType<typeof makeFakeAdmin>;
}

describe('isIntroOfferEligible', () => {
  let tables: Record<string, Row[]>;
  beforeEach(() => {
    tables = { shop_intro_claims: [], shop_orders: [] };
  });

  it('is true for a customer with no claim, and for someone with nothing to match on', async () => {
    const admin = makeFakeAdmin(tables, opts);
    expect(await isIntroOfferEligible(admin as never, BUYER)).toBe(true);
    expect(await isIntroOfferEligible(admin as never, { userId: null, phone: null, email: null })).toBe(true);
  });

  it.each([
    ['account', { user_id: 'user-1', phone: '+910000000000', email: 'x@y.in' }],
    ['phone', { user_id: null, phone: '+919876543210', email: 'x@y.in' }],
    ['email', { user_id: null, phone: '+910000000000', email: 'riya@example.com' }],
  ])('is false once the %s has claimed it', async (_k, claim) => {
    tables.shop_intro_claims.push({ shop_order_id: 'o1', ...claim });
    expect(await isIntroOfferEligible(makeFakeAdmin(tables, opts) as never, BUYER)).toBe(false);
  });

  it('matches the email in lower case', async () => {
    tables.shop_intro_claims.push({ shop_order_id: 'o1', user_id: null, phone: '+910000000000', email: 'riya@example.com' });
    expect(await isIntroOfferEligible(makeFakeAdmin(tables, opts) as never, { ...BUYER, userId: null, phone: null, email: 'Riya@Example.com' })).toBe(false);
  });

  it('without the claims table, looks at paid shop orders that took the offer', async () => {
    const admin = failing(makeFakeAdmin(tables, opts), { shop_intro_claims: { code: '42P01', message: 'relation does not exist' } });
    expect(await isIntroOfferEligible(admin as never, BUYER)).toBe(true);
    tables.shop_orders.push({ id: 'a', status: 'payment_pending', intro_offer_applied: true, phone: BUYER.phone, email: BUYER.email, user_id: null });
    expect(await isIntroOfferEligible(admin as never, BUYER)).toBe(true); // not paid
    tables.shop_orders.push({ id: 'b', status: 'shipped', intro_offer_applied: true, phone: BUYER.phone, email: 'other@example.com', user_id: null });
    expect(await isIntroOfferEligible(admin as never, BUYER)).toBe(false);
  });

  it('with neither table, behaves as v1 (eligible)', async () => {
    const missing = { code: '42P01', message: 'does not exist' };
    const admin = failing(makeFakeAdmin(tables, opts), { shop_intro_claims: missing, shop_orders: missing });
    expect(await isIntroOfferEligible(admin as never, BUYER)).toBe(true);
  });

  it('never blocks a sale on a read failure, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const admin = failing(makeFakeAdmin(tables, opts), { shop_intro_claims: { code: '57014', message: 'timeout' } });
    expect(await isIntroOfferEligible(admin as never, BUYER)).toBe(true);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('isRepeatCustomer', () => {
  let tables: Record<string, Row[]>;
  beforeEach(() => {
    tables = { orders: [], shop_orders: [] };
  });

  it('is false for a customer with nothing paid, and for no user', async () => {
    const admin = makeFakeAdmin(tables, opts);
    tables.orders.push({ id: 'o1', user_id: 'user-1', payment_status: 'pending' });
    tables.shop_orders.push({ id: 's1', user_id: 'user-1', status: 'payment_pending' }, { id: 's2', user_id: 'user-1', status: 'cancelled' });
    expect(await isRepeatCustomer(admin as never, 'user-1')).toBe(false);
    expect(await isRepeatCustomer(admin as never, '')).toBe(false);
  });

  it('is true after a paid café order, by account or by a staffer-linked account', async () => {
    tables.orders.push({ id: 'o1', user_id: 'user-1', payment_status: 'paid' });
    expect(await isRepeatCustomer(makeFakeAdmin(tables, opts) as never, 'user-1')).toBe(true);
    tables.orders = [{ id: 'o2', user_id: null, customer_user_id: 'user-1', payment_status: 'paid' }];
    expect(await isRepeatCustomer(makeFakeAdmin(tables, opts) as never, 'user-1')).toBe(true);
  });

  it('is true after a paid shop order', async () => {
    tables.shop_orders.push({ id: 's1', user_id: 'user-1', status: 'delivered' });
    expect(await isRepeatCustomer(makeFakeAdmin(tables, opts) as never, 'user-1')).toBe(true);
  });

  it('tolerates a database without customer_user_id', async () => {
    const admin = failing(makeFakeAdmin(tables, opts), {});
    const wrapped = {
      from: (t: string) => {
        const real = admin.from(t) as unknown as { eq: (c: string, v: unknown) => unknown };
        if (t !== 'orders') return real;
        // the café `orders` table answers a missing-column error when customer_user_id is asked for
        const chain: Record<string, unknown> = {};
        let asksLinked = false;
        for (const m of ['select', 'is', 'in', 'order', 'limit']) chain[m] = () => chain;
        chain.eq = (c: string) => {
          if (c === 'customer_user_id') asksLinked = true;
          return chain;
        };
        chain.then = (resolve: (v: unknown) => void) =>
          resolve(asksLinked ? { data: null, error: { code: '42703', message: 'column customer_user_id does not exist' } } : { data: [], error: null });
        return chain;
      },
    };
    tables.shop_orders.push({ id: 's1', user_id: 'user-1', status: 'paid' });
    expect(await isRepeatCustomer(wrapped as never, 'user-1')).toBe(true);
  });

  it('answers false when the lookups fail', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = { code: '57014', message: 'timeout' };
    const admin = failing(makeFakeAdmin(tables, opts), { orders: err, shop_orders: err });
    expect(await isRepeatCustomer(admin as never, 'user-1')).toBe(false);
    log.mockRestore();
  });
});

describe('loadShopProducts / loadShopPricingSettings', () => {
  it('fills v1 rows with the instant-coffee defaults and coerces numeric strings', async () => {
    const tables = {
      shop_products: [{ id: 'classic', name: 'Signature Classic', sku: 'S', price_inr: '399', net_qty: '50 g', in_stock: true, sort_order: '1' }],
    };
    const r = await loadShopProducts(makeFakeAdmin(tables, opts) as never);
    expect(r.ok && r.products[0]).toMatchObject({
      price_inr: 399,
      sort_order: 1,
      line: 'instant',
      display_name: 'Signature Classic',
      pack_grams: 50,
      ship_weight_kg: 0.3,
      listed: true,
      requires_grind: false,
      description: '',
    });
  });

  it('falls back to the v1 select when a v2 column is missing', async () => {
    const selects: string[] = [];
    const rows = [{ id: 'classic', name: 'C', sku: 'S', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1 }];
    const admin = {
      from: () => ({
        select: (cols: string) => {
          selects.push(cols);
          const v2 = cols.includes('display_name');
          return {
            order: () =>
              Promise.resolve(v2 ? { data: null, error: { code: '42703', message: 'column display_name does not exist' } } : { data: rows, error: null }),
          };
        },
      }),
    };
    const r = await loadShopProducts(admin as never);
    expect(selects).toHaveLength(2);
    expect(r.ok && r.products).toHaveLength(1);
  });

  it('reads the shipping and Beanies settings, defaults when the row is missing', async () => {
    const tables = { shop_settings: [{ is_singleton: true, offer_active: true, offer_name: 'Hello', offer_tier_prices: [399, 599, 749], shipping_fee_inr: 59, free_shipping_min_inr: '800', beanies_max_redeem_pct: 10 }] };
    const s = await loadShopPricingSettings(makeFakeAdmin(tables, opts) as never);
    expect(s).toMatchObject({ shipping_fee_inr: 59, free_shipping_min_inr: 800, beanies_max_redeem_pct: 10, offer: { name: 'Hello' } });
    expect(await loadShopPricingSettings(makeFakeAdmin({}, opts) as never)).toMatchObject({ shipping_fee_inr: 49, free_shipping_min_inr: 749, offer: null });
  });
});

describe('serverQuote', () => {
  const PRODUCTS = [
    { id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1 },
  ];
  const coupon = (code: string, over: Record<string, unknown> = {}) => ({
    id: `c-${code}`,
    code,
    discount_type: 'flat',
    discount_value: 50,
    min_order_inr: 0,
    max_discount_inr: 0,
    shop_product_ids: [],
    is_auto: false,
    ...over,
  });
  let tables: Record<string, Row[]>;
  beforeEach(() => {
    tables = { shop_products: PRODUCTS.map((p) => ({ ...p })), shop_settings: [], shop_intro_claims: [], shop_orders: [], orders: [] };
    state.loyalty = { balance: 0, config: { points_per_inr: 0.1, inr_per_point: 1, min_redeem_points: 50 } };
    state.coupons = { typed: coupon('SAVE50'), auto: [] };
  });
  const quote = (over: Record<string, unknown> = {}) =>
    serverQuote(makeFakeAdmin(tables, opts) as never, {
      items: [{ product_id: 'classic', quantity: 1 }],
      buyer: { userId: null, phone: null, email: null },
      coupon_code: null,
      use_beanies: true,
      ...over,
    });

  it('503s when the shop tables are missing, 400s on a cart it cannot price', async () => {
    const missing = failing(makeFakeAdmin(tables, opts), { shop_products: { code: '42P01', message: 'relation shop_products does not exist' } });
    const r = await serverQuote(missing as never, { items: [{ product_id: 'classic', quantity: 1 }], buyer: { userId: null, phone: null, email: null }, coupon_code: null, use_beanies: true });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(r.ok === false && r.error).toContain('2026-11-shop-v2.sql');
    expect(await quote({ items: [{ product_id: 'nope', quantity: 1 }] })).toMatchObject({ ok: false, status: 400 });
  });

  it('prices a guest: Beanies are "guest", the earn estimate still uses the rate', async () => {
    const r = await quote();
    expect(r.ok && r.quote).toMatchObject({ total_inr: 448, beanies: { state: 'guest', balance: 0 }, earn_estimate_points: 39 });
    expect(r.ok && r.coupon_error).toBeNull();
  });

  it('a first-time signed-in buyer gets "first_order"; a repeat one with a balance spends up to the cap', async () => {
    state.loyalty.balance = 500;
    const first = await quote({ buyer: { ...BUYER } });
    expect(first.ok && first.quote.beanies.state).toBe('first_order');
    tables.orders.push({ id: 'o1', user_id: 'user-1', payment_status: 'paid' });
    const repeat = await quote({ buyer: { ...BUYER } });
    expect(repeat.ok && repeat.quote).toMatchObject({ beanies: { state: 'applied', points: 19 }, beanies_redeemed: 19, total_inr: 429 });
    const off = await quote({ buyer: { ...BUYER }, use_beanies: false });
    expect(off.ok && off.quote).toMatchObject({ beanies: { state: 'available_off' }, beanies_redeemed: 0, total_inr: 448 });
  });

  it('has no Beanies context when the loyalty rules are missing', async () => {
    state.loyalty.config = null;
    const r = await quote({ buyer: { ...BUYER } });
    expect(r.ok && r.quote.beanies.state).toBe('unavailable');
  });

  it('uses a typed code that works', async () => {
    const r = await quote({ coupon_code: 'save50' });
    expect(r.ok && r.quote).toMatchObject({ coupon_code: 'SAVE50', coupon_discount_inr: 50, total_inr: 398 });
    expect(r.ok && r.coupon_error).toBeNull();
  });

  it('a code that is unknown, or does not fit the cart, falls back to the best auto coupon with coupon_error', async () => {
    state.coupons = { typed: coupon('SAVE50', { min_order_inr: 5000 }), auto: [coupon('AUTO20', { is_auto: true, discount_value: 20 }), coupon('AUTO30', { is_auto: true, discount_value: 30 })] };
    const unknown = await quote({ coupon_code: 'NOPE' });
    expect(unknown.ok && unknown.coupon_error).toBe("That code isn't valid");
    expect(unknown.ok && unknown.quote).toMatchObject({ coupon_code: 'AUTO30', coupon_discount_inr: 30 });
    const tooSmall = await quote({ coupon_code: 'SAVE50' });
    expect(tooSmall.ok && tooSmall.coupon_error).toMatch(/Add ₹/);
    expect(tooSmall.ok && tooSmall.quote.coupon_code).toBe('AUTO30');
  });

  it('applies the best auto coupon when no code is typed', async () => {
    state.coupons = { typed: null, auto: [coupon('AUTO20', { is_auto: true, discount_value: 20 })] };
    const r = await quote();
    expect(r.ok && r.quote.coupon_code).toBe('AUTO20');
  });

  it('withholds the introductory offer from someone who has had it', async () => {
    tables.shop_settings.push({ is_singleton: true, offer_active: true, offer_name: 'Introductory offer', offer_tier_prices: [299, 599, 749] });
    const fresh = await quote({ buyer: { userId: null, phone: '+919000000001', email: 'new@example.com' } });
    expect(fresh.ok && fresh.quote).toMatchObject({ intro_offer_applied: true, offer_discount_inr: 100 });
    tables.shop_intro_claims.push({ shop_order_id: 'o', user_id: null, phone: '+919000000001', email: 'old@example.com' });
    const used = await quote({ buyer: { userId: null, phone: '+919000000001', email: 'new@example.com' } });
    expect(used.ok && used.quote.intro_offer_applied).toBe(false);
  });
});
