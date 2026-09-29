import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/customers/search — the name path: `?name=` runs ilike '%term%' on
// the three sources' name columns (never the phone-prefix like), an
// unsearchable term returns nothing without touching the database or the
// rate limiter, and the same minimised shape comes back. Invented data only.

const state: {
  actor: { user: { id: string } } | null;
  calls: { table: string; op: string; args: unknown[] }[];
  rateLimitKeys: string[];
  rows: Record<string, unknown[]>;
} = { actor: null, calls: [], rateLimitKeys: [], rows: {} };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: (key: string) => {
    state.rateLimitKeys.push(key);
    return Promise.resolve(true);
  },
}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      // Every builder method records itself and returns the chain; awaiting it
      // resolves this table's canned rows.
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => unknown) => resolve({ data: state.rows[table] ?? [], error: null }),
      };
      for (const op of ['select', 'eq', 'like', 'ilike', 'not', 'order', 'limit']) {
        chain[op] = (...args: unknown[]) => {
          state.calls.push({ table, op, args });
          return chain;
        };
      }
      return chain;
    },
  }),
}));

import { GET } from '@/app/api/customers/search/route';

const call = (qs: string) => GET(new Request(`http://localhost/api/customers/search?${qs}`));

beforeEach(() => {
  state.actor = { user: { id: 'staff-1' } };
  state.calls = [];
  state.rateLimitKeys = [];
  state.rows = {};
});

describe('GET /api/customers/search?name=', () => {
  it('rejects a caller who is not counter staff', async () => {
    state.actor = null;
    expect((await call('name=asha')).status).toBe(401);
    expect(state.calls).toEqual([]);
  });

  it('returns nothing for an unsearchable term without querying or rate-limiting', async () => {
    for (const qs of ['name=a', 'name=%25%25', 'name=', '']) {
      const res = await call(qs);
      expect(await res.json()).toEqual({ customers: [] });
    }
    expect(state.calls).toEqual([]);
    expect(state.rateLimitKeys).toEqual([]);
  });

  it('matches names with ilike on all three sources and merges one row per phone', async () => {
    state.rows = {
      profiles: [{ phone: '+919876500001', name: 'Asha (account)' }],
      orders: [{ customer_phone: '+919876500001', customer_name: 'asha', created_at: '2026-09-20T10:00:00Z' }],
      legacy_customers: [{ phone: '+919876500003', name: 'Asha Old', order_count: 4, last_order_at: '2025-01-01T00:00:00Z' }],
    };
    const res = await call('name=as%25ha%20');
    expect(await res.json()).toEqual({
      customers: [
        { phone: '9876500001', name: 'Asha (account)', order_count: 1, last_order_at: '2026-09-20T10:00:00Z' },
        { phone: '9876500003', name: 'Asha Old', order_count: 4, last_order_at: '2025-01-01T00:00:00Z' },
      ],
    });
    expect(state.rateLimitKeys).toEqual(['customer-search:staff-1']);
    const ilikes = state.calls.filter((c) => c.op === 'ilike');
    expect(ilikes.map((c) => [c.table, c.args])).toEqual([
      ['profiles', ['name', '%as ha%']],
      ['orders', ['customer_name', '%as ha%']],
      ['legacy_customers', ['name', '%as ha%']],
    ]);
    expect(state.calls.some((c) => c.op === 'like')).toBe(false);
  });

  it('keeps the phone-prefix path when digits are sent', async () => {
    await call('q=98765&name=asha');
    expect(state.calls.some((c) => c.op === 'ilike')).toBe(false);
    expect(state.calls.filter((c) => c.op === 'like').map((c) => c.args)).toEqual([
      ['phone', '+9198765%'],
      ['customer_phone', '+9198765%'],
      ['phone', '+9198765%'],
    ]);
  });
});
