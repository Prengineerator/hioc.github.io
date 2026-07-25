import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for the owner tables registry (FND3-1). Covers the AC that
// only exist server-side: owner gating, case-insensitive duplicate blocking (PG
// 23505), the open-order deactivation guard, and QR-token regeneration. Mocks the
// Supabase admin client so the route's decision logic runs without a live DB.

const state: {
  owner: { id: string } | null;
  tableRow: Record<string, unknown> | null;
  tablesError: { code?: string; message?: string } | null;
  openOrderCount: number;
  insertPayload?: Record<string, unknown>;
  updatePatch?: Record<string, unknown>;
} = { owner: { id: 'owner-1' }, tableRow: { id: 't1', label: 'T1' }, tablesError: null, openOrderCount: 0 };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        insert: (p: Record<string, unknown>) => {
          state.insertPayload = p;
          return chain;
        },
        update: (p: Record<string, unknown>) => {
          state.updatePatch = p;
          return chain;
        },
        eq: () => chain,
        order: () => chain,
        // The only `.in()` caller is the open-order count query on `orders`.
        in: () => Promise.resolve({ count: state.openOrderCount, error: null }),
        single: () => Promise.resolve({ data: state.tableRow, error: state.tablesError }),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { GET, POST, PATCH } = await import('@/app/api/owner/tables/route');

function req(body: unknown) {
  return new Request('http://t/api/owner/tables', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.tableRow = { id: 't1', label: 'T1' };
  state.tablesError = null;
  state.openOrderCount = 0;
  state.insertPayload = undefined;
  state.updatePatch = undefined;
});

describe('owner tables registry (FND3-1)', () => {
  it('403s every method for a non-owner', async () => {
    state.owner = null;
    expect((await GET()).status).toBe(403);
    expect((await POST(req({ label: 'T2' }))).status).toBe(403);
    expect((await PATCH(req({ id: 't1', label: 'T2' }))).status).toBe(403);
  });

  it('creates a table', async () => {
    const res = await POST(req({ label: 'T2', zone: 'Terrace', capacity: 4 }));
    expect(res.status).toBe(200);
    expect(state.insertPayload?.label).toBe('T2');
    expect(state.insertPayload?.zone).toBe('Terrace');
    expect(state.insertPayload?.capacity).toBe(4);
  });

  it('400s a blank label', async () => {
    expect((await POST(req({ label: '   ' }))).status).toBe(400);
  });

  it('409s a case-insensitive duplicate label (PG 23505)', async () => {
    state.tablesError = { code: '23505' };
    const res = await POST(req({ label: 't1' }));
    expect(res.status).toBe(409);
  });

  it('blocks deactivating a table that still holds an open order', async () => {
    state.openOrderCount = 1;
    const res = await PATCH(req({ id: 't1', is_active: false }));
    expect(res.status).toBe(409);
    expect(state.updatePatch).toBeUndefined(); // no write attempted
  });

  it('allows deactivation once no open order holds the table', async () => {
    state.openOrderCount = 0;
    const res = await PATCH(req({ id: 't1', is_active: false }));
    expect(res.status).toBe(200);
    expect(state.updatePatch?.is_active).toBe(false);
  });

  it('regenerates the qr_token (32-char hex, hyphen-stripped)', async () => {
    const res = await PATCH(req({ id: 't1', regenerate_token: true }));
    expect(res.status).toBe(200);
    expect(typeof state.updatePatch?.qr_token).toBe('string');
    expect(state.updatePatch?.qr_token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('400s a PATCH with no id', async () => {
    expect((await PATCH(req({ label: 'T2' }))).status).toBe(400);
  });
});
