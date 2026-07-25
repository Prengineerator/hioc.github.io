import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for the owner-only QR-token endpoint (QR-2). This is the
// ONE place qr_token is exposed, and only to the owner — so the tests assert the
// owner gate and that the endpoint (unlike the list endpoint) DOES return
// qr_token, filtered to active tables in display order. Mocks the Supabase admin
// client so the route's logic runs without a live DB.

const state: {
  owner: { id: string } | null;
  rows: Array<Record<string, unknown>>;
  error: { message?: string } | null;
  eqCalls: Array<[string, unknown]>;
  selectCols: string;
} = {
  owner: { id: 'owner-1' },
  rows: [],
  error: null,
  eqCalls: [],
  selectCols: '',
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: () => {
      const result = { data: state.rows, error: state.error };
      // Thenable chain: supports select/eq/order and resolves to {data,error}.
      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          state.selectCols = cols;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          state.eqCalls.push([col, val]);
          return chain;
        },
        order: () => chain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { GET } = await import('@/app/api/owner/tables/qr/route');

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.rows = [
    { id: 't1', label: 'T1', zone: 'Terrace', qr_token: 'abc123' },
    { id: 't2', label: 'T2', zone: '', qr_token: 'def456' },
  ];
  state.error = null;
  state.eqCalls = [];
  state.selectCols = '';
});

describe('owner QR-token endpoint (QR-2)', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await GET()).status).toBe(403);
  });

  it('returns qr_token per active table for the owner', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tables).toHaveLength(2);
    // The whole point of this endpoint: qr_token IS exposed here (owner-only).
    expect(body.tables[0].qr_token).toBe('abc123');
    expect(body.tables[0].label).toBe('T1');
    expect(state.selectCols).toContain('qr_token');
    // Only active tables are returned.
    expect(state.eqCalls).toContainEqual(['is_active', true]);
  });

  it('500s on a DB error', async () => {
    state.error = { message: 'boom' };
    expect((await GET()).status).toBe(500);
  });
});
