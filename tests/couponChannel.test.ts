import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import { newDb } from './helpers/marketingWorld';

// E7: a coupon works in the café, the shop or both. The pure rules, the café validator, the
// shop lookup and the owner-input parser must all agree on that.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  usage: { total_used: 0, mine_used: 0 } as { total_used: number; mine_used: number },
  rpcError: null as { code: string; message: string } | null,
  rpcCalls: [] as Record<string, unknown>[],
  ilikePatterns: [] as string[],
  ignoreEscapes: false,
}));
// The fake db has no coupon_usage_counts; wrap it with a scripted one.
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => admin(),
}));
function admin() {
  return {
    // Records every ilike pattern sent. The fake db's ilike treats a backslash literally, so
    // `ignoreEscapes` strips the escapes to play a database where '%' and '_' still fire: the
    // second (exact code) check must then be what refuses the probe.
    from: (table: string) => {
      const q = h.db.client.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const ilike = q.ilike;
      q.ilike = (c: unknown, pattern: unknown) => {
        h.ilikePatterns.push(String(pattern));
        return ilike(c, h.ignoreEscapes ? String(pattern).replace(/\\(.)/g, '$1') : pattern);
      };
      return q;
    },
    rpc: async (name: string, args: Row) => {
      if (name !== 'coupon_usage_counts') return h.db.client.rpc(name, args);
      h.rpcCalls.push(args);
      return h.rpcError ? { data: null, error: h.rpcError } : { data: [h.usage], error: null };
    },
  };
}

const rules = await import('@/lib/promotions/couponRules');
const { validateAndComputeCoupon } = await import('@/lib/promotions/coupons');
const { findShopCoupon, loadAutoShopCoupons } = await import('@/lib/promotions/shopCoupons');
const { parseCouponInput } = await import('@/lib/promotions/validate');

const NOW = Date.parse('2026-11-18T10:00:00Z');
function coupon(over: Row = {}): Row {
  return {
    id: 'cp1', code: 'SHOP10', description: '', discount_type: 'percent', discount_value: 10, min_order_inr: 0, max_discount_inr: 0,
    scope: {}, valid_from: null, valid_to: null, usage_limit: 0, per_user_limit: 0, is_auto: false, active: true,
    created_at: '2026-10-01T00:00:00.000Z', channel: 'shop', assigned_phone: null, ...over,
  };
}
type Ctx = { userId: string | null; phone: string | null; email: string | null };
const guest: Ctx = { userId: null, phone: null, email: null };
const me: Ctx = { userId: 'u1', phone: '+919876543210', email: null };
const find = (code: string, ctx: Ctx = me) => findShopCoupon(admin() as never, code, ctx, NOW);

beforeEach(() => {
  h.db = newDb();
  h.db.tables.coupons = [coupon()];
  h.db.tables.profiles = [{ id: 'u1', phone: '+919876543210', phone_verified: true }];
  h.usage = { total_used: 0, mine_used: 0 };
  h.rpcError = null;
  h.rpcCalls = [];
  h.ilikePatterns = [];
  h.ignoreEscapes = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('couponRules', () => {
  it('reads a missing or unknown channel as café', () => {
    expect(rules.couponChannelOf({})).toBe('cafe');
    expect(rules.couponChannelOf({ channel: null })).toBe('cafe');
    expect(rules.couponChannelOf({ channel: 'weird' })).toBe('cafe');
    expect(rules.couponChannelOf({ channel: 'shop' })).toBe('shop');
    expect(rules.couponChannelOf({ channel: 'both' })).toBe('both');
  });

  it('works-in matrix', () => {
    const cases: [string | undefined, boolean, boolean][] = [
      [undefined, true, false],
      ['cafe', true, false],
      ['shop', false, true],
      ['both', true, true],
    ];
    for (const [channel, cafe, shop] of cases) {
      expect(rules.couponWorksIn({ channel }, 'cafe')).toBe(cafe);
      expect(rules.couponWorksIn({ channel }, 'shop')).toBe(shop);
    }
  });

  it('window problems use the café strings', () => {
    const base = { active: true, valid_from: null, valid_to: null };
    expect(rules.couponWindowProblem(base, NOW)).toBeNull();
    expect(rules.couponWindowProblem({ ...base, active: false }, NOW)).toBe('This coupon is no longer active');
    expect(rules.couponWindowProblem({ ...base, valid_from: '2026-12-01T00:00:00Z' }, NOW)).toBe('This coupon is not active yet');
    expect(rules.couponWindowProblem({ ...base, valid_to: '2026-11-01T00:00:00Z' }, NOW)).toBe('This coupon has expired');
  });

  it('maps a coupon to shop terms and labels the channels', () => {
    const c = coupon({ scope: { shop_product_ids: ['a', 'b'], item_ids: ['x'] }, is_auto: true, max_discount_inr: 50, min_order_inr: 200 });
    expect(rules.toShopCouponTerms(c as never)).toEqual({
      id: 'cp1', code: 'SHOP10', discount_type: 'percent', discount_value: 10, min_order_inr: 200, max_discount_inr: 50,
      shop_product_ids: ['a', 'b'], is_auto: true,
    });
    expect(rules.shopScopeOf({ scope: {} })).toEqual([]);
    expect(rules.CHANNEL_LABEL).toEqual({ cafe: 'Café', shop: 'Shop', both: 'Café + Shop' });
  });
});

describe('couponCodePattern', () => {
  it('escapes backslash, % and _, and refuses * or an over-long code', () => {
    expect(rules.couponCodePattern('SHOP10')).toBe('SHOP10');
    expect(rules.couponCodePattern('A%B_C\\D')).toBe('A\\%B\\_C\\\\D');
    expect(rules.couponCodePattern('SHOP*')).toBeNull();
    expect(rules.couponCodePattern('A'.repeat(40))).toBe('A'.repeat(40));
    expect(rules.couponCodePattern('A'.repeat(41))).toBeNull();
  });
});

describe('wildcard codes are not an enumeration oracle', () => {
  const probes = ['SHOP%', 'S_OP10', 'SHOP*', '%', 'A'.repeat(41)];

  it('findShopCoupon answers not valid for every probe', async () => {
    for (const p of probes) expect(await find(p)).toEqual({ ok: false, reason: "That code isn't valid" });
    expect((await find('SHOP10')).ok).toBe(true);
  });

  it('validateAndComputeCoupon answers Invalid coupon code, with no coupon attached', async () => {
    h.db.tables.coupons = [coupon({ channel: 'both' })];
    const ctx = { subtotalInr: 400, userId: 'u1', itemIds: [], categories: [] };
    for (const p of probes) {
      const r = await validateAndComputeCoupon(p, ctx);
      expect(r).toEqual({ ok: false, discountInr: 0, reason: 'Invalid coupon code' });
      expect(r).not.toHaveProperty('coupon');
    }
  });

  it('sends the escaped pattern, and never queries for * or an over-long code', async () => {
    await find('S_OP%');
    await validateAndComputeCoupon('S_OP%', { subtotalInr: 400, userId: 'u1', itemIds: [], categories: [] });
    await find('SHOP*');
    await find('A'.repeat(41));
    expect(h.ilikePatterns).toEqual(['S\\_OP\\%', 'S\\_OP\\%']);
  });

  it('the exact-code check refuses a probe even where the wildcards still match', async () => {
    h.ignoreEscapes = true;
    for (const p of ['SHOP%', 'S_OP10', '%']) expect(await find(p)).toEqual({ ok: false, reason: "That code isn't valid" });
    h.db.tables.coupons = [coupon({ channel: 'both' })];
    const ctx = { subtotalInr: 400, userId: 'u1', itemIds: [], categories: [] };
    for (const p of ['SHOP%', 'S_OP10', '%']) {
      expect(await validateAndComputeCoupon(p, ctx)).toEqual({ ok: false, discountInr: 0, reason: 'Invalid coupon code' });
    }
    expect((await find('shop10')).ok).toBe(true);
  });
});

describe('café validator', () => {
  const ctx = { subtotalInr: 400, userId: 'u1', itemIds: [], categories: [] };

  it("treats a 'shop' coupon as an unknown code, with no coupon attached", async () => {
    expect(await validateAndComputeCoupon('SHOP10', ctx)).toEqual({ ok: false, discountInr: 0, reason: 'Invalid coupon code' });
  });

  it("accepts 'both' and 'cafe' (and a coupon with no channel)", async () => {
    for (const channel of ['both', 'cafe', undefined]) {
      h.db.tables.coupons = [coupon({ channel })];
      expect(await validateAndComputeCoupon('SHOP10', ctx)).toMatchObject({ ok: true, discountInr: 40 });
    }
  });

  it("counts a 'both' coupon's uses through the shared function", async () => {
    h.db.tables.coupons = [coupon({ channel: 'both', usage_limit: 5, per_user_limit: 1 })];
    h.usage = { total_used: 5, mine_used: 0 };
    expect((await validateAndComputeCoupon('SHOP10', ctx)).reason).toBe('This coupon has reached its usage limit');
    h.usage = { total_used: 1, mine_used: 1 };
    expect((await validateAndComputeCoupon('SHOP10', ctx)).reason).toBe("You've already used this coupon the maximum number of times");
    expect(h.rpcCalls.length).toBe(2);
  });

  it.each(['42883', 'PGRST202'])('falls back to the redemption queries when the function is missing (%s)', async (code) => {
    h.db.tables.coupons = [coupon({ channel: 'both', usage_limit: 1 })];
    h.rpcError = { code, message: 'missing' };
    h.db.tables.orders = [{ id: 'o1', status: 'completed' }];
    h.db.tables.coupon_redemptions = [{ id: 'cr1', coupon_id: 'cp1', order_id: 'o1', user_id: 'u9' }];
    expect((await validateAndComputeCoupon('SHOP10', ctx)).reason).toBe('This coupon has reached its usage limit');
    h.db.tables.orders = [{ id: 'o1', status: 'cancelled' }];
    expect((await validateAndComputeCoupon('SHOP10', ctx)).ok).toBe(true);
  });

  it('asks to try again on any other function error', async () => {
    h.db.tables.coupons = [coupon({ channel: 'both', usage_limit: 5 })];
    h.rpcError = { code: 'XX000', message: 'boom' };
    expect((await validateAndComputeCoupon('SHOP10', ctx)).reason).toBe('Could not validate coupon — please try again');
  });

  it('a counter-linked phone holder with no account uses total_used for per_user_limit', async () => {
    h.db.tables.coupons = [coupon({ channel: 'both', per_user_limit: 1, assigned_phone: '+919876543210' })];
    const counterCtx = { ...ctx, userId: null, counterPhone: '+919876543210' };
    h.usage = { total_used: 1, mine_used: 0 };
    expect((await validateAndComputeCoupon('SHOP10', counterCtx)).reason).toBe("You've already used this coupon the maximum number of times");
    h.usage = { total_used: 0, mine_used: 5 };
    expect((await validateAndComputeCoupon('SHOP10', counterCtx)).ok).toBe(true);
    expect(h.rpcCalls.at(-1)).toMatchObject({ p_user_id: null, p_phone: '+919876543210' });
  });

  it("never calls the function for a café-only coupon", async () => {
    h.db.tables.coupons = [coupon({ channel: 'cafe', usage_limit: 5 })];
    h.db.tables.coupon_redemptions = [];
    expect((await validateAndComputeCoupon('SHOP10', ctx)).ok).toBe(true);
    expect(h.rpcCalls).toEqual([]);
  });
});

describe('findShopCoupon', () => {
  it('asks for a code', async () => {
    expect(await find('  ')).toEqual({ ok: false, reason: 'Enter a code' });
  });

  it("refuses a café-only or unknown code as not valid", async () => {
    h.db.tables.coupons = [coupon({ channel: 'cafe' })];
    expect(await find('SHOP10')).toEqual({ ok: false, reason: "That code isn't valid" });
    expect(await find('NOPE')).toEqual({ ok: false, reason: "That code isn't valid" });
  });

  it("accepts 'shop' and 'both', case-insensitively, with the terms", async () => {
    for (const channel of ['shop', 'both']) {
      h.db.tables.coupons = [coupon({ channel, scope: { shop_product_ids: ['p1'] } })];
      const r = await find('shop10');
      expect(r).toMatchObject({ ok: true, terms: { code: 'SHOP10', shop_product_ids: ['p1'], discount_value: 10 } });
    }
  });

  it('refuses an expired or switched-off code', async () => {
    h.db.tables.coupons = [coupon({ valid_to: '2026-11-01T00:00:00Z' })];
    expect(await find('SHOP10')).toEqual({ ok: false, reason: 'This coupon has expired' });
    h.db.tables.coupons = [coupon({ active: false })];
    expect(await find('SHOP10')).toEqual({ ok: false, reason: 'This coupon is no longer active' });
  });

  it('enforces the phone lock without revealing the number', async () => {
    h.db.tables.coupons = [coupon({ assigned_phone: '+919876543210' })];
    expect((await find('SHOP10')).ok).toBe(true);
    const stranger = await find('SHOP10', { userId: null, phone: '+919876543210', email: null } as Ctx);
    expect(stranger).toMatchObject({ ok: false });
    expect(JSON.stringify(stranger)).not.toContain('9876543210');
  });

  it('enforces usage_limit and per_user_limit through the function', async () => {
    h.db.tables.coupons = [coupon({ usage_limit: 3, per_user_limit: 1 })];
    h.usage = { total_used: 3, mine_used: 0 };
    expect(await find('SHOP10')).toEqual({ ok: false, reason: 'This code has been fully used' });
    h.usage = { total_used: 1, mine_used: 1 };
    expect(await find('SHOP10')).toEqual({ ok: false, reason: "You've already used this code" });
    h.usage = { total_used: 1, mine_used: 0 };
    expect((await find('SHOP10')).ok).toBe(true);
  });

  it('counts a guest by phone, and asks a guest with no phone for one', async () => {
    h.db.tables.coupons = [coupon({ per_user_limit: 1 })];
    expect(await find('SHOP10', guest)).toEqual({ ok: false, reason: 'Add your phone number to use this code' });
    h.usage = { total_used: 1, mine_used: 1 };
    const g: Ctx = { userId: null, phone: '+919000000001', email: null };
    expect(await find('SHOP10', g)).toEqual({ ok: false, reason: "You've already used this code" });
    expect(h.rpcCalls.at(-1)).toMatchObject({ p_user_id: null, p_phone: '+919000000001' });
  });

  it('says to try again when the count fails', async () => {
    h.db.tables.coupons = [coupon({ usage_limit: 3 })];
    h.rpcError = { code: 'XX000', message: 'boom' };
    expect(await find('SHOP10')).toEqual({ ok: false, reason: 'Could not check this code — please try again' });
  });

  it('answers not valid on a database without the channel column', async () => {
    // select('*') simply has no channel on the row: it reads as café-only.
    const { channel: _channel, ...legacy } = coupon();
    h.db.tables.coupons = [legacy];
    expect(await find('SHOP10')).toEqual({ ok: false, reason: "That code isn't valid" });
  });
});

describe('loadAutoShopCoupons', () => {
  it('keeps only usable auto-apply shop and both coupons', async () => {
    h.db.tables.coupons = [
      coupon({ id: 'ok-shop', code: 'A', is_auto: true }),
      coupon({ id: 'ok-both', code: 'B', is_auto: true, channel: 'both' }),
      coupon({ id: 'cafe', code: 'C', is_auto: true, channel: 'cafe' }),
      coupon({ id: 'typed', code: 'D', is_auto: false }),
      coupon({ id: 'off', code: 'E', is_auto: true, active: false }),
      coupon({ id: 'expired', code: 'F', is_auto: true, valid_to: '2026-11-01T00:00:00Z' }),
      coupon({ id: 'locked', code: 'G', is_auto: true, assigned_phone: '+919876543210' }),
    ];
    const out = await loadAutoShopCoupons(admin() as never, me, NOW);
    expect(out.map((t) => t.id).sort()).toEqual(['ok-both', 'ok-shop']);
  });

  it('drops one this customer has used up, and returns [] on error', async () => {
    h.db.tables.coupons = [coupon({ is_auto: true, per_user_limit: 1 })];
    h.usage = { total_used: 1, mine_used: 1 };
    expect(await loadAutoShopCoupons(admin() as never, me, NOW)).toEqual([]);
    h.usage = { total_used: 0, mine_used: 0 };
    expect(await loadAutoShopCoupons(admin() as never, me, NOW)).toHaveLength(1);
    h.db.failNext('select coupons');
    expect(await loadAutoShopCoupons(admin() as never, me, NOW)).toEqual([]);
  });

  it('returns [] without the channel column', async () => {
    h.db = newDb({ missingColumns: { coupons: ['channel'] } });
    h.db.tables.coupons = [coupon({ is_auto: true })];
    expect(await loadAutoShopCoupons(admin() as never, me, NOW)).toEqual([]);
  });
});

describe('parseCouponInput channel and scope', () => {
  const base = { code: 'x', discount_type: 'percent', discount_value: 10 };
  const parse = (body: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
    parseCouponInput({ ...base, ...body }, { partial: false, ...opts } as never);

  it('accepts the three channels and refuses others', () => {
    for (const channel of ['cafe', 'shop', 'both']) expect(parse({ channel })).toMatchObject({ channel });
    expect(parse({ channel: 'web' })).toBe("channel must be 'cafe', 'shop' or 'both'");
    expect(parse({})).not.toHaveProperty('channel');
  });

  it('validates shop_product_ids', () => {
    expect(parse({ channel: 'shop', scope: { shop_product_ids: ['jar-1', 'a'] } })).toMatchObject({
      scope: { shop_product_ids: ['jar-1', 'a'] },
    });
    expect(typeof parse({ channel: 'both', scope: { shop_product_ids: ['Bad Id'] } })).toBe('string');
    expect(typeof parse({ channel: 'both', scope: { shop_product_ids: 'a' } })).toBe('string');
    const many = Array.from({ length: 21 }, (_, i) => `p${i}`);
    expect(typeof parse({ channel: 'shop', scope: { shop_product_ids: many } })).toBe('string');
  });

  it('keeps shop products off café coupons and café scopes off shop coupons', () => {
    expect(parse({ channel: 'cafe', scope: { shop_product_ids: ['a'] } })).toBe('Shop product limits only apply to shop coupons');
    expect(parse({ scope: { shop_product_ids: ['a'] } })).toBe('Shop product limits only apply to shop coupons');
    expect(parse({ channel: 'cafe', scope: { item_ids: ['x'], shop_product_ids: [] } })).not.toBeTypeOf('string');
    expect(parse({ channel: 'shop', scope: { item_ids: ['x'] } })).toBe('Item and category limits only apply to café coupons');
    expect(parse({ channel: 'shop', scope: { category: ['c'] } })).toBe('Item and category limits only apply to café coupons');
    expect(parse({ channel: 'both', scope: { item_ids: ['x'], shop_product_ids: ['a'] } })).not.toBeTypeOf('string');
  });

  it('checks a scope-only PATCH against the stored channel', () => {
    const patch = (scope: unknown, existingChannel: string) =>
      parseCouponInput({ scope } as never, { partial: true, existingChannel } as never);
    expect(patch({ item_ids: ['x'] }, 'shop')).toBe('Item and category limits only apply to café coupons');
    expect(patch({ shop_product_ids: ['a'] }, 'cafe')).toBe('Shop product limits only apply to shop coupons');
    expect(patch({ shop_product_ids: ['a'] }, 'both')).not.toBeTypeOf('string');
  });
});
