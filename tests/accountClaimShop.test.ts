import { beforeEach, describe, expect, it, vi } from 'vitest';

// Claiming guest shop orders on login (docs/SHOP-V2-SPEC.md E4, E5).

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  introRows: [] as Record<string, unknown>[],
  introError: null as { code: string; message: string } | null,
  earned: [] as string[],
  missing: false,
}));

vi.mock('@/lib/loyalty/ledger', () => ({
  earnForShopOrder: (id: string) => {
    h.earned.push(id);
    return Promise.resolve(10);
  },
}));

import { claimGuestShopOrders } from '@/lib/account/claim';

function admin() {
  return {
    from(table: string) {
      const filters: { col: string; val: unknown }[] = [];
      let payload: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        update: (p: Record<string, unknown>) => ((payload = p), chain),
        eq: (col: string, val: unknown) => (filters.push({ col, val }), chain),
        is: (col: string, val: unknown) => (filters.push({ col: `${col}:is`, val }), chain),
        select: () => chain,
      };
      chain.then = (resolve: (v: unknown) => void) => {
        if (h.missing) return resolve({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
        if (table === 'shop_intro_claims') {
          if (h.introError) return resolve({ data: null, error: h.introError });
          for (const r of h.introRows) {
            if (r.user_id === null && filters.filter((f) => !f.col.endsWith(':is')).every((f) => r[f.col] === f.val)) Object.assign(r, payload);
          }
          return resolve({ data: null, error: null });
        }
        const hit = h.rows.filter(
          (r) => r.user_id === null && filters.filter((f) => !f.col.endsWith(':is')).every((f) => r[f.col] === f.val),
        );
        for (const r of hit) Object.assign(r, payload);
        return resolve({ data: hit.map((r) => ({ id: r.id, status: r.status })), error: null });
      };
      return chain;
    },
  } as never;
}

beforeEach(() => {
  h.earned = [];
  h.missing = false;
  h.introError = null;
  h.introRows = [{ user_id: null, phone: '+919876543210', email: 'riya@example.com' }];
  h.rows = [
    { id: 'a', user_id: null, phone: '+919876543210', email: 'x@example.com', status: 'delivered' },
    { id: 'b', user_id: null, phone: '+910000000001', email: 'riya@example.com', status: 'shipped' },
    { id: 'c', user_id: null, phone: '+910000000002', email: 'z@example.com', status: 'delivered' },
    { id: 'd', user_id: 'other', phone: '+919876543210', email: 'riya@example.com', status: 'delivered' },
  ];
});

describe('claimGuestShopOrders', () => {
  it('claims by verified phone and email, and earns for delivered ones only', async () => {
    const res = await claimGuestShopOrders(admin(), 'u1', { phone: '+919876543210', email: 'riya@example.com' });
    expect(res).toEqual({ claimed: 2, earned: 1 });
    expect(h.rows.map((r) => r.user_id)).toEqual(['u1', 'u1', null, 'other']);
    expect(h.earned).toEqual(['a']);
    expect(h.introRows[0].user_id).toBe('u1');
  });

  it('does nothing without a verified phone or email', async () => {
    const res = await claimGuestShopOrders(admin(), 'u1', { phone: null, email: null });
    expect(res).toEqual({ claimed: 0, earned: 0 });
    expect(h.rows.every((r) => r.user_id !== 'u1')).toBe(true);
  });

  it('claims by email alone', async () => {
    const res = await claimGuestShopOrders(admin(), 'u1', { phone: null, email: 'riya@example.com' });
    expect(res.claimed).toBe(1);
    expect(h.rows[1].user_id).toBe('u1');
    expect(h.rows[0].user_id).toBeNull();
  });

  it('ignores a unique violation on the intro claim', async () => {
    h.introError = { code: '23505', message: 'duplicate key' };
    const res = await claimGuestShopOrders(admin(), 'u1', { phone: '+919876543210', email: null });
    expect(res).toEqual({ claimed: 1, earned: 1 });
  });

  it('returns zeros when the shop tables are missing', async () => {
    h.missing = true;
    expect(await claimGuestShopOrders(admin(), 'u1', { phone: '+919876543210', email: 'riya@example.com' })).toEqual({
      claimed: 0,
      earned: 0,
    });
  });
});
