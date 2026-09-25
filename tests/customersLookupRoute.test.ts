import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — GET /api/customers/lookup migrated to getCounterActor(). Focus:
// the auth gate, and that the rate-limit key still uses the resolved actor's
// id (works for an operator's id just as it did for a session's).

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  customer: { userId: string; name: string } | null;
  rateLimitKeys: string[];
} = { actor: null, customer: null, rateLimitKeys: [] };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => ({}) }));
vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: (key: string) => {
    state.rateLimitKeys.push(key);
    return Promise.resolve(true);
  },
}));
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(state.customer),
}));
vi.mock('@/lib/loyalty/ledger', () => ({ getBalance: () => Promise.resolve(50) }));

const { GET } = await import('@/app/api/customers/lookup/route');

function req(phone: string) {
  return new Request(`https://hioc.in/api/customers/lookup?phone=${phone}`);
}

beforeEach(() => {
  state.actor = null;
  state.customer = null;
  state.rateLimitKeys = [];
});

describe('GET /api/customers/lookup', () => {
  it('401s with no session and no operator', async () => {
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(401);
  });

  it('looks up for a classic staff session', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.customer = { userId: 'cust-1', name: 'Priya' };
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe('Priya');
    expect(state.rateLimitKeys[0]).toBe('customer-lookup:staff-1');
  });

  it('PIN-3: an enrolled-device operator (no classic session) can look up too', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    state.customer = { userId: 'cust-1', name: 'Priya' };
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(200);
    expect(state.rateLimitKeys[0]).toBe('customer-lookup:ravi');
  });
});
