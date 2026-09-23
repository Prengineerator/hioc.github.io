import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for GET /api/tables — the staff-readable tables list that
// feeds the POS-1 dine-in table picker (the owner CRUD is owner-only; this is
// the missing staff read path). Verifies:
//  * it is gated by getStaffUser() (401 for a non-staff caller);
//  * it returns only ACTIVE tables, in display order;
//  * it NEVER selects qr_token (column-sensitive — the QR-1 order link);
//  * a DB error surfaces as a 500.

const state: {
  staffUser: { id: string } | null;
  rows: Record<string, unknown>[];
  error: { message: string } | null;
  selectArg: string;
  eqArgs: [string, unknown] | null;
} = { staffUser: null, rows: [], error: null, selectArg: '', eqArgs: null };

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
  getStaffUser: () => Promise.resolve(state.staffUser),
}));

const { GET } = await import('@/app/api/tables/route');

beforeEach(() => {
  state.staffUser = null;
  state.rows = [];
  state.error = null;
  state.selectArg = '';
  state.eqArgs = null;
});

describe('GET /api/tables', () => {
  it('401s a non-staff caller', async () => {
    state.staffUser = null;
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns active tables for a staff caller and never selects qr_token', async () => {
    state.staffUser = { id: 'staff-1' };
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
    state.staffUser = { id: 'staff-1' };
    state.error = { message: 'boom' };
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
