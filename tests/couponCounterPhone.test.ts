import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb, Row } from './helpers/marketingDb';
import { newDb } from './helpers/marketingWorld';

// A marketing coupon is locked to the phone it was sent to, and its message says "show it at the counter". A
// first-visit customer has no account yet, so the counter must be able to vouch for the number the STAFFER typed —
// but ONLY an authenticated counter actor, and never a number a customer's own request body claims.
// Real coupons.ts + the real /api/orders/quote route over the in-memory database.

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  sessionUser: null as { id: string } | null,
  actor: null as { user: { id: string }; role: string; via: 'session' | 'device' } | null,
}));

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(h.sessionUser),
  getCounterActor: () => Promise.resolve(h.actor),
}));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 20 }),
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: () => Promise.resolve(0),
  quoteRedemption: () => Promise.resolve({ ok: false, reason: 'n/a' }),
}));

const { POST } = await import('@/app/api/orders/quote/route');
const { PHONE_LOCK_REASON } = await import('@/lib/promotions/coupons');

const ASSIGNED = '+919876543210';
const coupon = (over: Row = {}): Row => ({
  id: 'cp1', code: 'WBK7M3QX', description: 'Marketing: Win-back', discount_type: 'percent', discount_value: 10, min_order_inr: 100, max_discount_inr: 60,
  scope: {}, valid_from: null, valid_to: null, usage_limit: 1, per_user_limit: 1, is_auto: false, active: true, created_at: '2026-10-01T00:00:00.000Z',
  campaign_id: 'camp-1', assigned_phone: ASSIGNED, ...over,
});

const quote = async (body: Record<string, unknown>) => {
  const res = await POST(
    new Request('https://hioc.in/api/orders/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subtotal_inr: 400, coupon_code: 'WBK7M3QX', ...body }),
    }),
  );
  return (await res.json()).coupon as { ok: boolean; discountInr: number; reason?: string };
};

beforeEach(() => {
  h.db = newDb();
  h.db.tables.coupons = [coupon()];
  h.db.tables.profiles = []; // nobody has an account for this number yet
  h.sessionUser = null;
  h.actor = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/orders/quote — the typed phone counts only for a counter actor', () => {
  it('counter actor + the assigned phone typed + no account yet → the coupon applies', async () => {
    h.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    h.sessionUser = { id: 'staff-1' };
    expect(await quote({ customer_phone: '9876543210' })).toMatchObject({ ok: true, discountInr: 40 });
  });

  it('an enrolled device\'s PIN operator is a counter actor too', async () => {
    h.actor = { user: { id: 'op-1' }, role: 'staff', via: 'device' };
    expect(await quote({ customer_phone: '+91 98765 43210' })).toMatchObject({ ok: true, discountInr: 40 });
  });

  it('counter actor + a DIFFERENT phone → refused', async () => {
    h.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    expect(await quote({ customer_phone: '9876543211' })).toMatchObject({ ok: false, reason: PHONE_LOCK_REASON });
  });

  it('counter actor + a foreign number that shares the ten digits → refused', async () => {
    h.db.tables.coupons = [coupon({ assigned_phone: '+916581234567' })];
    h.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    expect(await quote({ customer_phone: '+6581234567' })).toMatchObject({ ok: false, reason: PHONE_LOCK_REASON });
    expect(await quote({ customer_phone: '6581234567' })).toMatchObject({ ok: true });
  });

  it('counter actor and NO phone typed → refused', async () => {
    h.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    expect(await quote({})).toMatchObject({ ok: false, reason: PHONE_LOCK_REASON });
  });

  it('a customer web session with the assigned phone in the request body is STILL refused', async () => {
    h.sessionUser = { id: 'someone' };
    expect(await quote({ customer_phone: '9876543210', counterPhone: ASSIGNED })).toMatchObject({ ok: false, reason: PHONE_LOCK_REASON });
  });

  it('an anonymous caller with the assigned phone in the body is refused too', async () => {
    expect(await quote({ customer_phone: '9876543210', counterPhone: ASSIGNED })).toMatchObject({ ok: false, reason: PHONE_LOCK_REASON });
  });

  it('a customer whose own VERIFIED profile holds the number is unaffected (still works, with or without a typed phone)', async () => {
    h.db.tables.profiles = [{ id: 'cust', phone: ASSIGNED, phone_verified: true }];
    h.sessionUser = { id: 'cust' };
    expect(await quote({})).toMatchObject({ ok: true, discountInr: 40 });
  });

  it('a counter order for a customer who HAS a verified account still resolves through that account', async () => {
    h.db.tables.profiles = [{ id: 'cust', phone: ASSIGNED, phone_verified: true }];
    h.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    expect(await quote({ customer_phone: '9876543210' })).toMatchObject({ ok: true, discountInr: 40 });
  });
});
