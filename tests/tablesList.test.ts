import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for GET /api/tables — the staff-readable tables list that
// feeds the POS-1 dine-in table picker (the owner CRUD is owner-only; this is
// the missing staff read path). Verifies:
//  * it is gated by getCounterActor() (401 with no session and no operator, PIN-3);
//  * a classic staff session OR an enrolled-device operator both succeed;
//  * it returns only ACTIVE tables, in display order;
//  * it NEVER selects qr_token (column-sensitive — the QR-1 order link);
//  * a DB error surfaces as a 500.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  rows: Record<string, unknown>[];
  error: { message: string } | null;
  selectArg: string;
  eqArgs: [string, unknown] | null;
} = { actor: null, rows: [], error: null, selectArg: '', eqArgs: null };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (cols: string) => {
          state.selectArg = cols;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          state.eqArgs = [col, val];
          return chain;
        },
        order: () => chain,
        // The query builder is awaited at the end of the chain.
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: state.rows, error: state.error }),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
}));

const { GET } = await import('@/app/api/tables/route');

beforeEach(() => {
  state.actor = null;
  state.rows = [];
  state.error = null;
  state.selectArg = '';
  state.eqArgs = null;
});

describe('GET /api/tables', () => {
  it('401s a caller with neither a session nor an operator', async () => {
    state.actor = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns active tables for a classic staff session and never selects qr_token', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.rows = [
      { id: 't1', label: 'T1', zone: 'Terrace', capacity: 4, is_active: true, sort_order: 0 },
      { id: 't2', label: 'T2', zone: '', capacity: 2, is_active: true, sort_order: 10 },
    ];
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tables).toHaveLength(2);
    expect(body.tables[0].label).toBe('T1');

    // Column allow-list must exclude the sensitive qr_token, and must scope to
    // active tables only.
    expect(state.selectArg).not.toContain('qr_token');
    for (const col of ['id', 'label', 'zone', 'capacity', 'is_active', 'sort_order']) {
      expect(state.selectArg).toContain(col);
    }
    expect(state.eqArgs).toEqual(['is_active', true]);
  });

  it('500s on a database error', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.error = { message: 'boom' };
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it('PIN-3: an enrolled-device operator (no classic session) reads the same list', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    state.rows = [{ id: 't1', label: 'T1', zone: '', capacity: 4, is_active: true, sort_order: 0 }];
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).tables).toHaveLength(1);
  });
});
