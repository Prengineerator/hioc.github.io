import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — POST /api/orders/quote migrated so "is this caller staff" comes
// from getCounterActor() rather than a raw session role check, so a PIN
// operator on an enrolled device gets the same counter-preview behaviour
// (VAL-1: coupon/points preview against the LINKED customer's phone, not the
// operator's own account) as a classic staff session — while an anonymous or
// customer caller is completely unaffected.

const state: {
  sessionUser: { id: string } | null;
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  linkedUserId: string | null;
  balance: number | null;
  balanceCalledWith: string | null;
} = { sessionUser: null, actor: null, linkedUserId: null, balance: null, balanceCalledWith: null };

vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(state.sessionUser),
  getCounterActor: () => Promise.resolve(state.actor),
}));

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => ({}) }));

vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(state.linkedUserId ? { userId: state.linkedUserId } : null),
  toStoredPhone: (p: unknown) => (typeof p === 'string' ? p : ''),
}));

vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 20 }),
}));

vi.mock('@/lib/promotions/coupons', () => ({
  validateAndComputeCoupon: () => Promise.resolve({ ok: false, reason: 'no coupon' }),
}));

vi.mock('@/lib/loyalty/ledger', () => ({
  getBalance: (userId: string) => {
    state.balanceCalledWith = userId;
    return Promise.resolve(state.balance ?? 0);
  },
  quoteRedemption: () => Promise.resolve({ ok: false, reason: 'n/a' }),
}));

const { POST } = await import('@/app/api/orders/quote/route');

function req(body: unknown) {
  return new Request('https://hioc.in/api/orders/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.sessionUser = null;
  state.actor = null;
  state.linkedUserId = null;
  state.balance = null;
  state.balanceCalledWith = null;
});

describe('POST /api/orders/quote', () => {
  it('an anonymous caller gets a plain preview with no balance', async () => {
    const res = await POST(req({ subtotal_inr: 300 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.balance).toBeNull();
    expect(body.bill.subtotal_inr).toBe(300);
  });

  it('a classic staff session resolves the balance for the LINKED phone, not itself', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.linkedUserId = 'customer-42';
    state.balance = 150;

    const res = await POST(req({ subtotal_inr: 300, customer_phone: '9876543210' }));
    expect(res.status).toBe(200);
    expect((await res.json()).balance).toBe(150);
  });

  it('PIN-3: an enrolled-device operator (no classic session) gets the same counter preview', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    state.linkedUserId = 'customer-42';
    state.balance = 90;

    const res = await POST(req({ subtotal_inr: 300, customer_phone: '9876543210' }));
    expect(res.status).toBe(200);
    expect((await res.json()).balance).toBe(90);
  });

  it('a signed-in CUSTOMER (not staff) never triggers the phone-link lookup', async () => {
    state.sessionUser = { id: 'cust-1' };
    state.actor = null; // customer role fails getCounterActor()
    state.linkedUserId = 'someone-elses-account'; // would be wrong to use
    state.balance = 500;

    const res = await POST(req({ subtotal_inr: 300, customer_phone: '9876543210' }));
    expect(res.status).toBe(200);
    // The balance is looked up for the CUSTOMER'S OWN session id — the
    // phone-linked lookup is never reached because isStaff is false.
    expect(state.balanceCalledWith).toBe('cust-1');
    expect((await res.json()).balance).toBe(500);
  });
});
