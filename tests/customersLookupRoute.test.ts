import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — GET /api/customers/lookup migrated to getCounterActor(). Focus:
// the auth gate, that the rate-limit key still uses the resolved actor's id
// (works for an operator's id just as it did for a session's), and POS-5's
// order-history fallback: no VERIFIED account still gets a "returning
// customer" answer from a past order's own customer_name, with a
// source/order_count/last_order_at the previous response never carried.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  customer: { userId: string; name: string } | null;
  rateLimitKeys: string[];
  // Orders `.or()` matched — one row per past order, newest first.
  orderRows: { created_at: string; customer_name?: string }[];
  orFilters: string[];
} = { actor: null, customer: null, rateLimitKeys: [], orderRows: [], orFilters: [] };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: (key: string) => {
    state.rateLimitKeys.push(key);
    return Promise.resolve(true);
  },
}));
vi.mock('@/lib/loyalty/customerLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loyalty/customerLink')>();
  return {
    ...actual, // keep the real orderMatchFilter — it's exercised, not mocked
    findVerifiedCustomerByPhone: () => Promise.resolve(state.customer),
  };
});
vi.mock('@/lib/loyalty/ledger', () => ({ getBalance: () => Promise.resolve(50) }));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      expect(table).toBe('orders');
      const chain = {
        select: (_cols: string, _opts?: unknown) => chain,
        or: (filter: string) => {
          state.orFilters.push(filter);
          return chain;
        },
        order: () => chain,
        // `.limit(1)` is the terminal call in both branches — resolve here.
        limit: () => Promise.resolve({ data: state.orderRows.slice(0, 1), count: state.orderRows.length, error: null }),
      };
      return chain;
    },
  }),
}));

const { GET } = await import('@/app/api/customers/lookup/route');

function req(phone: string) {
  return new Request(`https://hioc.in/api/customers/lookup?phone=${phone}`);
}

beforeEach(() => {
  state.actor = null;
  state.customer = null;
  state.rateLimitKeys = [];
  state.orderRows = [];
  state.orFilters = [];
});

describe('GET /api/customers/lookup', () => {
  it('401s with no session and no operator', async () => {
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(401);
  });

  it('looks up an account for a classic staff session, with order_count/last_order_at', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.customer = { userId: 'cust-1', name: 'Priya' };
    state.orderRows = [
      { created_at: '2026-09-20T10:00:00Z' },
      { created_at: '2026-09-10T10:00:00Z' },
    ];
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      found: true,
      source: 'account',
      name: 'Priya',
      points_balance: 50,
      order_count: 2,
      last_order_at: '2026-09-20T10:00:00Z',
    });
    expect(state.rateLimitKeys[0]).toBe('customer-lookup:staff-1');
    // The account's own userId widens the match beyond the phone alone.
    expect(state.orFilters[0]).toContain('customer_user_id.eq.cust-1');
    expect(state.orFilters[0]).toContain('user_id.eq.cust-1');
  });

  it('PIN-3: an enrolled-device operator (no classic session) can look up too', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    state.customer = { userId: 'cust-1', name: 'Priya' };
    state.orderRows = [{ created_at: '2026-09-20T10:00:00Z' }];
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(200);
    expect(state.rateLimitKeys[0]).toBe('customer-lookup:ravi');
  });

  it('an account with no past orders still answers, with order_count 0 and no button to offer', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.customer = { userId: 'cust-1', name: 'Priya' };
    state.orderRows = [];
    const res = await GET(req('9876543210'));
    const body = await res.json();
    expect(body.order_count).toBe(0);
    expect(body.last_order_at).toBeNull();
  });

  describe('order-history fallback — no VERIFIED account', () => {
    it('finds the most recent past order by this exact phone and answers with its name', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.customer = null;
      state.orderRows = [
        { created_at: '2026-09-22T09:00:00Z', customer_name: 'Ravi Kumar' },
        { created_at: '2026-09-01T09:00:00Z', customer_name: 'Ravi Kumar' },
      ];
      const res = await GET(req('9876543210'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        found: true,
        source: 'order_history',
        name: 'Ravi Kumar',
        order_count: 2,
        last_order_at: '2026-09-22T09:00:00Z',
      });
      // No account, so points_balance must never appear — never claim a
      // balance nobody actually has.
      expect(body.points_balance).toBeUndefined();
      // Unwidened: only the phone itself, never a wildcard user match.
      expect(state.orFilters[0]).toBe('customer_phone.in.("+919876543210","9876543210")');
    });

    it('is "not found" when neither an account nor a past order matches', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.customer = null;
      state.orderRows = [];
      const res = await GET(req('9876543210'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ found: false });
    });
  });

  it('400s a malformed phone before touching the database', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    const res = await GET(req('123'));
    expect(res.status).toBe(400);
    expect(state.orFilters).toEqual([]);
  });
});
