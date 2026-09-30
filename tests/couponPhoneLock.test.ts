import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import { newDb } from './helpers/marketingWorld';

// Marketing coupons are issued to ONE phone (spec §1.7). validateAndComputeCoupon must
// refuse anyone whose VERIFIED profile phone is not that number — a WhatsApp message
// forwarded to a stranger is worthless to them — and GET /api/coupons must keep the
// per-recipient codes out of the owner's promotions list.

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, manager: { id: 'owner-1' } as { id: string } | null, authUser: null as { id: string } | null }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/api/auth', () => ({
  getManagerUser: () => Promise.resolve(h.manager),
  getAuthUser: () => Promise.resolve(h.authUser),
}));

const { validateAndComputeCoupon, PHONE_LOCK_REASON } = await import('@/lib/promotions/coupons');
const couponsRoute = await import('@/app/api/coupons/route');
const validateRoute = await import('@/app/api/coupons/validate/route');

const LOCK_MESSAGE = 'This code is linked to another phone number. Log in with the number it was sent to, or show it at the counter.';
const PHONE = '+919876543210';

function coupon(over: Row = {}): Row {
  return {
    id: 'cp1', code: 'WBK7M3QX', description: 'Marketing: Win-back', discount_type: 'percent', discount_value: 10, min_order_inr: 100, max_discount_inr: 60,
    scope: {}, valid_from: null, valid_to: null, usage_limit: 1, per_user_limit: 1, is_auto: false, active: true, created_at: '2026-10-01T00:00:00.000Z',
    campaign_id: 'camp-1', assigned_phone: PHONE, ...over,
  };
}
const ctx = (userId: string | null) => ({ subtotalInr: 400, userId, itemIds: [], categories: [] });

beforeEach(() => {
  h.db = newDb();
  h.db.tables.coupons = [coupon()];
  h.db.tables.profiles = [{ id: 'u-me', phone: PHONE, phone_verified: true }];
  h.manager = { id: 'owner-1' };
  h.authUser = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the phone lock', () => {
  it('lets the verified holder of the number redeem it', async () => {
    const r = await validateAndComputeCoupon('WBK7M3QX', ctx('u-me'));
    expect(r).toMatchObject({ ok: true, discountInr: 40 });
  });

  it('is case-insensitive about the code, like every coupon', async () => {
    expect((await validateAndComputeCoupon('wbk7m3qx', ctx('u-me'))).ok).toBe(true);
  });

  it('refuses a guest — no session means no proof of a phone', async () => {
    const r = await validateAndComputeCoupon('WBK7M3QX', ctx(null));
    expect(r).toEqual({ ok: false, discountInr: 0, reason: LOCK_MESSAGE });
  });

  it('refuses a signed-in customer whose verified phone is a DIFFERENT number', async () => {
    h.db.tables.profiles = [{ id: 'u-other', phone: '+919999999999', phone_verified: true }];
    expect(await validateAndComputeCoupon('WBK7M3QX', ctx('u-other'))).toEqual({ ok: false, discountInr: 0, reason: LOCK_MESSAGE });
  });

  it('refuses an UNVERIFIED profile that merely types the number (profiles.phone is free text)', async () => {
    h.db.tables.profiles = [{ id: 'u-liar', phone: PHONE, phone_verified: false }];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-liar'))).reason).toBe(LOCK_MESSAGE);
  });

  it('refuses a profile with no phone at all, and a user with no profile', async () => {
    h.db.tables.profiles = [{ id: 'u-nophone', phone: null, phone_verified: true }];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-nophone'))).reason).toBe(LOCK_MESSAGE);
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-ghost'))).reason).toBe(LOCK_MESSAGE);
  });

  it('compares NORMALISED numbers: any stored spelling of the same mobile matches', async () => {
    h.db.tables.profiles = [{ id: 'u-me', phone: '919876543210', phone_verified: true }];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-me'))).ok).toBe(true);
    h.db.tables.coupons = [coupon({ assigned_phone: '9876543210' })];
    h.db.tables.profiles = [{ id: 'u-me', phone: '+91 98765 43210', phone_verified: true }];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-me'))).ok).toBe(true);
  });

  it('an assigned phone that is not a valid mobile can never be matched', async () => {
    h.db.tables.coupons = [coupon({ assigned_phone: 'garbage' })];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-me'))).reason).toBe(LOCK_MESSAGE);
  });

  it('answers "try again" — not yes, not no — when the profile cannot be read', async () => {
    h.db.failNext('select profiles');
    const r = await validateAndComputeCoupon('WBK7M3QX', ctx('u-me'));
    expect(r).toMatchObject({ ok: false, reason: 'Could not validate coupon — please try again' });
  });

  it('is checked BEFORE everything else and never hands the coupon row (with its phone) to the caller', async () => {
    // Every other rejection returns `coupon`, which the checkout displays. The lock's must not.
    h.db.tables.coupons = [coupon({ active: false })];
    const stranger = await validateAndComputeCoupon('WBK7M3QX', ctx(null));
    expect(stranger.reason).toBe(LOCK_MESSAGE);
    expect(stranger).not.toHaveProperty('coupon');
    // The rightful owner gets the real reason.
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-me'))).reason).toBe('This coupon is no longer active');
  });

  it('a locked coupon still obeys every other rule for its owner (single use, minimum order)', async () => {
    expect((await validateAndComputeCoupon('WBK7M3QX', { ...ctx('u-me'), subtotalInr: 50 })).reason).toBe('Minimum order of ₹100 required for this coupon');
    h.db.tables.orders = [{ id: 'o1', status: 'completed' }];
    h.db.tables.coupon_redemptions = [{ id: 'cr', coupon_id: 'cp1', order_id: 'o1', user_id: 'u-me' }];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-me'))).reason).toBe('This coupon has reached its usage limit');
  });

  it('exports the message so callers and tests share it', () => {
    expect(PHONE_LOCK_REASON).toBe(LOCK_MESSAGE);
  });
});

// The message promises "show it at the counter", but /api/orders validates the coupon BEFORE createCounterCustomer opens
// the customer's account, so a first-visit number has no VERIFIED profile yet and was refused. The counter ACTOR's typed
// phone (CouponContext.counterPhone, set only by server code after getCounterActor() succeeded) is the second way in.
describe('the counter: a first-visit customer with no account yet', () => {
  const counter = (counterPhone: string | null | undefined, userId: string | null = null) => ({ ...ctx(userId), counterPhone });

  it('a counter actor who typed the assigned phone can redeem it with NO account (userId null)', async () => {
    expect(await validateAndComputeCoupon('WBK7M3QX', counter(PHONE))).toMatchObject({ ok: true, discountInr: 40 });
  });

  it('any spelling of the same mobile matches (the server normalises both sides)', async () => {
    for (const typed of ['9876543210', '98765 43210', '+91 98765 43210', '919876543210']) {
      expect((await validateAndComputeCoupon('WBK7M3QX', counter(typed))).ok).toBe(true);
    }
  });

  it('a DIFFERENT typed phone is refused, with the lock message and no coupon row', async () => {
    const r = await validateAndComputeCoupon('WBK7M3QX', counter('+919876543211'));
    expect(r).toEqual({ ok: false, discountInr: 0, reason: LOCK_MESSAGE });
    expect(r).not.toHaveProperty('coupon');
  });

  it('a foreign number with the same ten digits is not the Indian number the code was sent to', async () => {
    h.db.tables.coupons = [coupon({ assigned_phone: '+916581234567' })];
    expect((await validateAndComputeCoupon('WBK7M3QX', counter('+6581234567'))).reason).toBe(LOCK_MESSAGE);
    expect((await validateAndComputeCoupon('WBK7M3QX', counter('+916581234567'))).ok).toBe(true);
    // The verified-profile path is '+'-aware too.
    h.db.tables.profiles = [{ id: 'u-sg', phone: '+6581234567', phone_verified: true }];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx('u-sg'))).reason).toBe(LOCK_MESSAGE);
  });

  it('no counterPhone (or an empty/garbage one) changes nothing: still refused', async () => {
    for (const cp of [undefined, null, '', '   ', 'garbage']) {
      expect((await validateAndComputeCoupon('WBK7M3QX', counter(cp))).reason).toBe(LOCK_MESSAGE);
    }
  });

  it('the code is still single use: a second redemption is refused, whoever typed the number', async () => {
    h.db.tables.orders = [{ id: 'o1', status: 'completed' }];
    h.db.tables.coupon_redemptions = [{ id: 'cr', coupon_id: 'cp1', order_id: 'o1', user_id: null }];
    expect((await validateAndComputeCoupon('WBK7M3QX', counter(PHONE))).reason).toBe('This coupon has reached its usage limit');
  });

  it('…and the per-user limit of a phone-locked code is its redemption count (every redemption is the one holder\'s)', async () => {
    h.db.tables.coupons = [coupon({ usage_limit: 0, per_user_limit: 1 })];
    expect((await validateAndComputeCoupon('WBK7M3QX', counter(PHONE))).ok).toBe(true);
    h.db.tables.orders = [{ id: 'o1', status: 'completed' }, { id: 'o2', status: 'cancelled' }];
    // A cancelled order's redemption does not burn it…
    h.db.tables.coupon_redemptions = [{ id: 'c2', coupon_id: 'cp1', order_id: 'o2', user_id: null }];
    expect((await validateAndComputeCoupon('WBK7M3QX', counter(PHONE))).ok).toBe(true);
    // …a live one does.
    h.db.tables.coupon_redemptions = [{ id: 'c1', coupon_id: 'cp1', order_id: 'o1', user_id: null }];
    expect((await validateAndComputeCoupon('WBK7M3QX', counter(PHONE))).reason).toBe("You've already used this coupon the maximum number of times");
  });

  it('every other rule still applies to it (minimum order, active)', async () => {
    expect((await validateAndComputeCoupon('WBK7M3QX', { ...counter(PHONE), subtotalInr: 50 })).reason).toBe('Minimum order of ₹100 required for this coupon');
    h.db.tables.coupons = [coupon({ active: false })];
    expect((await validateAndComputeCoupon('WBK7M3QX', counter(PHONE))).reason).toBe('This coupon is no longer active');
  });

  it('an ORDINARY per-user-limited coupon still needs a login: counterPhone opens the phone lock only', async () => {
    h.db.tables.coupons = [coupon({ assigned_phone: null, campaign_id: null })];
    expect((await validateAndComputeCoupon('WBK7M3QX', counter(PHONE))).reason).toBe('Log in to use this coupon');
  });

  it('a linked customer (verified phone) is unaffected, whatever counterPhone says', async () => {
    expect((await validateAndComputeCoupon('WBK7M3QX', counter('+919999999999', 'u-me'))).ok).toBe(true);
  });
});

describe('coupons that are NOT locked are unchanged', () => {
  it('a database without the column has assigned_phone undefined: no lock, and no profile lookup', async () => {
    const { assigned_phone: _a, campaign_id: _c, ...legacy } = coupon();
    void _a;
    void _c;
    h.db.tables.coupons = [{ ...legacy, per_user_limit: 0, usage_limit: 0 }];
    h.db.log.length = 0;
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx(null))).ok).toBe(true);
  });

  it('a coupon with a NULL assigned_phone (an ordinary owner coupon) works for a guest', async () => {
    h.db.tables.coupons = [coupon({ assigned_phone: null, campaign_id: null, per_user_limit: 0, usage_limit: 0 })];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx(null))).ok).toBe(true);
  });

  it('an empty-string assigned_phone is not a lock either', async () => {
    h.db.tables.coupons = [coupon({ assigned_phone: '', per_user_limit: 0, usage_limit: 0 })];
    expect((await validateAndComputeCoupon('WBK7M3QX', ctx(null))).ok).toBe(true);
  });
});

describe('POST /api/coupons/validate — the checkout endpoint', () => {
  const post = (code: string) =>
    validateRoute.POST(new Request('http://t/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code, subtotal_inr: 400 }) }));

  it('uses the SESSION user: the holder redeems, a guest is refused, and the refusal carries no coupon', async () => {
    h.authUser = { id: 'u-me' };
    expect(await (await post('WBK7M3QX')).json()).toMatchObject({ ok: true, discount_inr: 40 });

    h.authUser = null;
    const body = await (await post('WBK7M3QX')).json();
    expect(body).toMatchObject({ ok: false, reason: LOCK_MESSAGE });
    expect(body.coupon).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('9876543210');
  });

  it('a guest cannot vouch for a number: a phone in the request body changes nothing', async () => {
    h.authUser = null;
    const res = await validateRoute.POST(
      new Request('http://t/api/coupons/validate', {
        method: 'POST',
        body: JSON.stringify({ code: 'WBK7M3QX', subtotal_inr: 400, customer_phone: PHONE, counterPhone: PHONE, counter_phone: PHONE }),
      }),
    );
    expect(await res.json()).toMatchObject({ ok: false, reason: LOCK_MESSAGE });
  });
});

describe('GET /api/coupons — campaign coupons are hidden by default', () => {
  const list = async (query = '') => {
    const res = await couponsRoute.GET(new Request(`http://t/api/coupons${query}`));
    return { res, codes: ((await res.json()).coupons as Row[] | undefined)?.map((c) => c.code).sort() };
  };

  beforeEach(() => {
    h.db.tables.coupons = [
      coupon({ id: 'a', code: 'WELCOME10', campaign_id: null, assigned_phone: null }),
      coupon({ id: 'b', code: 'WBAAAAAA', campaign_id: 'camp-1' }),
      coupon({ id: 'c', code: 'WBBBBBBB', campaign_id: 'camp-1', assigned_phone: '+919111111111' }),
      coupon({ id: 'd', code: 'FESTIVE', campaign_id: null, assigned_phone: null }),
    ];
  });

  it('shows only the coupons the owner manages', async () => {
    expect((await list()).codes).toEqual(['FESTIVE', 'WELCOME10']);
  });

  it('?include_campaign=1 shows the per-recipient codes too', async () => {
    expect((await list('?include_campaign=1')).codes).toEqual(['FESTIVE', 'WBAAAAAA', 'WBBBBBBB', 'WELCOME10']);
  });

  it('only the exact value 1 opts in', async () => {
    expect((await list('?include_campaign=true')).codes).toEqual(['FESTIVE', 'WELCOME10']);
    expect((await list('?include_campaign=0')).codes).toEqual(['FESTIVE', 'WELCOME10']);
  });

  it('a database WITHOUT the campaign_id column (42703) retries without the filter and lists everything', async () => {
    h.db = newDb({ missingColumns: { coupons: ['campaign_id', 'assigned_phone'] } });
    h.db.tables.coupons = [
      { id: 'a', code: 'WELCOME10', created_at: '2026-10-01T00:00:00.000Z' },
      { id: 'd', code: 'FESTIVE', created_at: '2026-10-02T00:00:00.000Z' },
    ];
    const { res, codes } = await list();
    expect(res.status).toBe(200);
    expect(codes).toEqual(['FESTIVE', 'WELCOME10']);
    expect((await list('?include_campaign=1')).codes).toEqual(['FESTIVE', 'WELCOME10']);
  });

  it('any other database error is still a 500', async () => {
    h.db.failNext('select coupons', { code: 'XX000', message: 'boom' });
    expect((await list()).res.status).toBe(500);
  });

  it('is manager-only', async () => {
    h.manager = null;
    expect((await list()).res.status).toBe(401);
  });

  it('newest first, as before', async () => {
    h.db.tables.coupons = [
      coupon({ id: 'a', code: 'OLD', campaign_id: null, created_at: '2026-09-01T00:00:00.000Z' }),
      coupon({ id: 'b', code: 'NEW', campaign_id: null, created_at: '2026-10-01T00:00:00.000Z' }),
    ];
    const res = await couponsRoute.GET(new Request('http://t/api/coupons'));
    expect(((await res.json()).coupons as Row[]).map((c) => c.code)).toEqual(['NEW', 'OLD']);
  });
});
