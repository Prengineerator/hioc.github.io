import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — GET /api/orders (the order board) migrated to getCounterActor().
// Focus: the auth gate (classic session OR enrolled-device operator, neither
// -> 401) and that the query still runs for either path.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  rows: Record<string, unknown>[];
  error: { message: string } | null;
} = { actor: null, rows: [], error: null };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        limit: () => chain,
        order: () => chain,
        then: (resolve: (v: unknown) => void) => resolve({ data: state.rows, error: state.error }),
      });
      return chain;
    },
  }),
}));

const { GET } = await import('@/app/api/orders/route');

function req(qs = '') {
  return new Request(`https://hioc.in/api/orders${qs}`);
}

beforeEach(() => {
  state.actor = null;
  state.rows = [];
  state.error = null;
});

describe('GET /api/orders', () => {
  it('401s with no session and no operator', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('200s and lists orders for a classic staff session', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.rows = [{ id: 'o1', order_items: [] }];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).orders).toHaveLength(1);
  });

  it('PIN-3: an enrolled-device operator (no classic session) reads the same board', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    state.rows = [{ id: 'o1', order_items: [] }];
    const res = await GET(req());
    expect(res.status).toBe(200);
  });

  it('rejects a bad status filter', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    const res = await GET(req('?status=bogus'));
    expect(res.status).toBe(400);
  });
});
