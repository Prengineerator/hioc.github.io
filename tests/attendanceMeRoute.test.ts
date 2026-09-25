import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — GET /api/attendance/me migrated to getCounterActor(). No route
// test existed before. Focus: the auth gate, and that the query is scoped to
// the RESOLVED actor's own id (session or device operator), never a
// client-supplied one.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  rows: Record<string, unknown>[];
  scopedTo: string[];
} = { actor: null, rows: [], scopedTo: [] };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === 'user_id') state.scopedTo.push(val);
          return chain;
        },
        gte: () => chain,
        neq: () => chain,
        order: () => Promise.resolve({ data: state.rows, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/attendance/settings', () => ({
  getAttendanceSettings: () => Promise.resolve({ store_lat: 1, store_lng: 1 }),
}));
vi.mock('@/lib/cash/checkpoints', () => ({
  cashRequirementFor: () => Promise.resolve({ required: false, override: null }),
}));

const { GET } = await import('@/app/api/attendance/me/route');

beforeEach(() => {
  state.actor = null;
  state.rows = [];
  state.scopedTo = [];
});

describe('GET /api/attendance/me', () => {
  it('401s with no session and no operator', async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('scopes the read to a classic session\'s own id', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(state.scopedTo).toEqual(['staff-1']);
  });

  it('PIN-3: an enrolled-device operator (no classic session) reads their OWN attendance — the operator IS the person', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(state.scopedTo).toEqual(['ravi']);
  });
});
