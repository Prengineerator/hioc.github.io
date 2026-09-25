import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — GET /api/customers/lookup migrated to getCounterActor(). Focus:
// the auth gate, that the rate-limit key still uses the resolved actor's id
// (works for an operator's id just as it did for a session's), and POS-5's
// order-history fallback: no VERIFIED account still gets a "returning
// customer" answer from a past order's own customer_name, with a
// source/order_count/last_order_at the previous response never carried.
//
// Petpooja history (lib/legacy/history.ts) — default fixtures are empty/null,
// which is a no-op merge (0 count, null date never beats a real one), so
// every pre-existing test below is unaffected; the dedicated `describe`
// blocks near the bottom exercise the merge and the new 'petpooja' fallback.
// Invented data only (SPEC.md PII rule) — no real Petpooja phone/name here.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  customer: { userId: string; name: string } | null;
  rateLimitKeys: string[];
  // Orders `.or()` matched — one row per past order, newest first.
  orderRows: { created_at: string; customer_name?: string }[];
  orFilters: string[];
  // legacy_orders rows matching this phone (completed bills only, as the
  // real query filters) — newest first, same shape as legacyOrderStatsForPhone's select.
  legacyOrderRows: { ordered_at: string }[];
  // legacy_customers row for this phone, or null when Petpooja never saw it.
  legacyCustomer: { name: string; order_count: number; last_order_at: string | null } | null;
} = { actor: null, customer: null, rateLimitKeys: [], orderRows: [], orFilters: [], legacyOrderRows: [], legacyCustomer: null };

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
      if (table === 'orders') {
        const chain = {
          select: (_cols: string, _opts?: unknown) => chain,
          or: (filter: string) => {
            state.orFilters.push(filter);
            return chain;
          },
          order: () => chain,
          // `.limit(1)` is the terminal call in both branches — resolve here.
          limit: () =>
            Promise.resolve({ data: state.orderRows.slice(0, 1), count: state.orderRows.length, error: null }),
        };
        return chain;
      }
      if (table === 'legacy_orders') {
        // lib/legacy/history.ts's legacyOrderStatsForPhone: select().eq(phone).eq(status).order().limit(1).
        const chain = {
          select: (_cols: string, _opts?: unknown) => chain,
          eq: () => chain,
          order: () => chain,
          limit: () =>
            Promise.resolve({
              data: state.legacyOrderRows.slice(0, 1),
              count: state.legacyOrderRows.length,
              error: null,
            }),
        };
        return chain;
      }
      if (table === 'legacy_customers') {
        // legacyCustomerByPhone: select().eq(phone).maybeSingle().
        const chain = {
          select: (_cols: string) => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: state.legacyCustomer, error: null }),
        };
        return chain;
      }
      throw new Error(`unexpected table: ${table}`);
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
  state.legacyOrderRows = [];
  state.legacyCustomer = null;
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

  describe('Petpooja history — legacy_orders/legacy_customers merge', () => {
    it('account path: folds completed legacy bills into order_count and takes the later last_order_at', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.customer = { userId: 'cust-1', name: 'Priya' };
      state.orderRows = [{ created_at: '2026-09-10T10:00:00Z' }]; // 1 hioc order
      state.legacyOrderRows = [{ ordered_at: '2026-09-20T10:00:00Z' }, { ordered_at: '2026-01-01T10:00:00Z' }]; // 2 legacy bills, newer than the hioc one
      const res = await GET(req('9876500001'));
      const body = await res.json();
      expect(body.order_count).toBe(3); // 1 hioc + 2 legacy
      expect(body.last_order_at).toBe('2026-09-20T10:00:00Z'); // legacy is newer
    });

    it('account path: a hioc order newer than every legacy bill still wins last_order_at', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.customer = { userId: 'cust-1', name: 'Priya' };
      state.orderRows = [{ created_at: '2026-09-25T10:00:00Z' }];
      state.legacyOrderRows = [{ ordered_at: '2026-01-01T10:00:00Z' }];
      const res = await GET(req('9876500001'));
      const body = await res.json();
      expect(body.last_order_at).toBe('2026-09-25T10:00:00Z');
    });

    it('order_history path: also folds in legacy bills for a phone with no account', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.customer = null;
      state.orderRows = [{ created_at: '2026-09-01T10:00:00Z', customer_name: 'Test Customer' }];
      state.legacyOrderRows = [{ ordered_at: '2026-09-15T10:00:00Z' }];
      const res = await GET(req('9876500001'));
      const body = await res.json();
      expect(body).toMatchObject({ found: true, source: 'order_history', name: 'Test Customer' });
      expect(body.order_count).toBe(2);
      expect(body.last_order_at).toBe('2026-09-15T10:00:00Z');
      // No account, so still no balance — the merge must not smuggle one in.
      expect(body.points_balance).toBeUndefined();
    });

    it("falls back to source 'petpooja' when only legacy_customers has this phone", async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.customer = null;
      state.orderRows = [];
      state.legacyCustomer = { name: 'Test Customer', order_count: 7, last_order_at: '2026-08-01T09:00:00Z' };
      const res = await GET(req('9876500001'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        found: true,
        source: 'petpooja',
        name: 'Test Customer',
        order_count: 7,
        last_order_at: '2026-08-01T09:00:00Z',
      });
      // A Petpooja-only match is not an account — never claim a balance.
      expect(body.points_balance).toBeUndefined();
    });

    it('is "not found" when neither hioc history nor legacy_customers has anything', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.customer = null;
      state.orderRows = [];
      state.legacyCustomer = null;
      const res = await GET(req('9876500001'));
      expect(await res.json()).toEqual({ found: false });
    });
  });
});
