import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-2 — getDeviceRegistryState() / isMissingTableError(), the shared answer
// to "is the pos_devices table set up at all" that
// app/staff/settings/counter/page.tsx (in-app enrolment, formerly
// app/staff/device/page.tsx) needs and app/api/owner/devices' route also
// uses, so the two never drift on what counts as "the migration hasn't been
// applied yet".

const state: {
  cookieToken: string | undefined;
  queryError: { code?: string; message?: string } | null;
  queryData: unknown;
} = { cookieToken: undefined, queryError: null, queryData: null };

vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name: string) => (name === 'hioc_device' && state.cookieToken ? { value: state.cookieToken } : undefined),
  }),
}));

// Records which query shape was used (probe vs. lookup-by-token) so the
// "no cookie" path can be asserted to still hit the table.
const calls: { select: unknown[] } = { select: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => ({
      select: (cols: string) => {
        calls.select.push(cols);
        const builder = {
          limit: () => Promise.resolve({ error: state.queryError, data: state.queryData }),
          eq: () => builder,
          is: () => builder,
          maybeSingle: () => Promise.resolve({ error: state.queryError, data: state.queryData }),
        };
        return builder;
      },
    }),
  }),
}));

const { getDeviceRegistryState, isMissingTableError } = await import('@/lib/api/device');

beforeEach(() => {
  state.cookieToken = undefined;
  state.queryError = null;
  state.queryData = null;
  calls.select = [];
});

describe('isMissingTableError', () => {
  it('matches PostgREST\'s missing-table code', () => {
    expect(isMissingTableError({ code: 'PGRST205' })).toBe(true);
  });

  it('matches the plain Postgres relation-missing code', () => {
    expect(isMissingTableError({ code: '42P01' })).toBe(true);
  });

  it('matches the generic message as a fallback', () => {
    expect(isMissingTableError({ message: "Could not find the table 'public.pos_devices'" })).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isMissingTableError({ code: '23505', message: 'duplicate key' })).toBe(false);
  });

  it('handles null/undefined without throwing', () => {
    expect(isMissingTableError(null)).toBe(false);
    expect(isMissingTableError(undefined)).toBe(false);
  });
});

describe('getDeviceRegistryState', () => {
  it('reports unavailable when the table does not exist, even with no cookie', async () => {
    state.cookieToken = undefined;
    state.queryError = { code: 'PGRST205', message: "Could not find the table 'public.pos_devices'" };
    const result = await getDeviceRegistryState();
    expect(result).toEqual({ available: false, device: null });
    // Probed the table directly rather than skipping the query just because
    // there was nothing to look up by.
    expect(calls.select.length).toBeGreaterThan(0);
  });

  it('reports available + no device when there is no cookie and the table exists', async () => {
    state.cookieToken = undefined;
    state.queryError = null;
    const result = await getDeviceRegistryState();
    expect(result).toEqual({ available: true, device: null });
  });

  it('reports the enrolled device when the cookie resolves to one', async () => {
    state.cookieToken = 'sometoken';
    state.queryData = { id: 'd1', name: 'Counter 1', enrolled_at: '2026-08-20T00:00:00Z' };
    const result = await getDeviceRegistryState();
    expect(result.available).toBe(true);
    expect(result.device).toEqual(state.queryData);
  });

  it('reports unavailable when the table is missing on the token-lookup path too', async () => {
    state.cookieToken = 'sometoken';
    state.queryError = { code: '42P01' };
    const result = await getDeviceRegistryState();
    expect(result).toEqual({ available: false, device: null });
  });

  it('fails to "available, not enrolled" on any other lookup error', async () => {
    state.cookieToken = 'sometoken';
    state.queryError = { code: '08006', message: 'connection reset' };
    const result = await getDeviceRegistryState();
    expect(result).toEqual({ available: true, device: null });
  });
});
