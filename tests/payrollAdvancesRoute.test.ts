import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST/DELETE /api/owner/payroll/advances — owner only, validated, and an
// advance already taken off a finalized month cannot be removed.

type Row = Record<string, unknown>;
type PgError = { code?: string; message?: string };

const state: {
  owner: { id: string } | null;
  profile: Row | null;
  advance: Row | null;
  finalizedRuns: Row[];
  insertError: PgError | null;
  selectError: PgError | null;
  inserted: Row | null;
  updated: Row | null;
  lockFilter: Row;
} = {
  owner: null,
  profile: null,
  advance: null,
  finalizedRuns: [],
  insertError: null,
  selectError: null,
  inserted: null,
  updated: null,
  lockFilter: {},
};

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      let op = 'select';
      const filters: Row = {};
      const chain: Row = {};
      const result = () => {
        if (table === 'profiles') return { data: state.profile, error: null };
        if (table === 'payroll_runs') {
          state.lockFilter = { ...filters };
          return { data: state.finalizedRuns, error: null };
        }
        if (table === 'staff_advances') {
          if (op === 'insert') {
            if (state.insertError) return { data: null, error: state.insertError };
            return { data: { id: 'adv-1', ...state.inserted }, error: null };
          }
          if (op === 'update') return { data: state.advance && !state.advance.removed_at ? { id: 'adv-1' } : null, error: null };
          if (state.selectError) return { data: null, error: state.selectError };
          return { data: state.advance, error: null };
        }
        return { data: null, error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        insert: (p: Row) => {
          op = 'insert';
          state.inserted = p;
          return chain;
        },
        update: (p: Row) => {
          op = 'update';
          state.updated = p;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          filters[c] = v;
          return chain;
        },
        gte: (c: string, v: unknown) => {
          filters[`${c}>=`] = v;
          return chain;
        },
        is: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result()),
        single: () => Promise.resolve(result()),
        then: (r: (v: unknown) => void) => r(result()),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { POST, DELETE } = await import('@/app/api/owner/payroll/advances/route');

function req(method: string, body: unknown) {
  return new Request('http://t/api/owner/payroll/advances', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const good = { user_id: 'staff-1', amount_inr: 3000, given_on: today, note: ' UPI, rent ' };

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.profile = { id: 'staff-1', role: 'staff' };
  state.advance = { id: 'adv-1', user_id: 'staff-1', given_on: '2026-11-08', created_at: '2026-11-08T06:00:00Z', removed_at: null };
  state.finalizedRuns = [];
  state.insertError = null;
  state.selectError = null;
  state.inserted = null;
  state.updated = null;
  state.lockFilter = {};
});

describe('advances route — authorization', () => {
  it('403s a non-owner on POST and DELETE', async () => {
    state.owner = null;
    expect((await POST(req('POST', good))).status).toBe(403);
    expect((await DELETE(req('DELETE', { id: 'adv-1' }))).status).toBe(403);
    expect(state.inserted).toBeNull();
    expect(state.updated).toBeNull();
  });
});

describe('advances route — POST', () => {
  it('saves a valid advance, trimming the note and recording who added it', async () => {
    const res = await POST(req('POST', good));
    expect(res.status).toBe(200);
    expect(state.inserted).toEqual({
      user_id: 'staff-1',
      amount_inr: 3000,
      given_on: today,
      note: 'UPI, rent',
      created_by: 'owner-1',
    });
  });

  it('allows a missing note', async () => {
    const res = await POST(req('POST', { ...good, note: undefined }));
    expect(res.status).toBe(200);
    expect(state.inserted?.note).toBe('');
  });

  it.each([0, -5, 1.5, 100_001, '3000', null])('rejects amount %s', async (amount_inr) => {
    expect((await POST(req('POST', { ...good, amount_inr }))).status).toBe(400);
    expect(state.inserted).toBeNull();
  });

  it('accepts the 1 and 1,00,000 limits', async () => {
    expect((await POST(req('POST', { ...good, amount_inr: 1 }))).status).toBe(200);
    expect((await POST(req('POST', { ...good, amount_inr: 100_000 }))).status).toBe(200);
  });

  it('rejects a future date', async () => {
    const tomorrow = new Date(Date.now() + 5.5 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
    const res = await POST(req('POST', { ...good, given_on: tomorrow }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/future/i);
  });

  it.each(['2026-13-01', '2026-02-30', '08/11/2026', '', 'x'])('rejects date %s', async (given_on) => {
    expect((await POST(req('POST', { ...good, given_on }))).status).toBe(400);
  });

  it('rejects a date before 2024-01-01', async () => {
    expect((await POST(req('POST', { ...good, given_on: '2023-12-31' }))).status).toBe(400);
  });

  it('rejects a note over 200 characters', async () => {
    expect((await POST(req('POST', { ...good, note: 'x'.repeat(201) }))).status).toBe(400);
    expect((await POST(req('POST', { ...good, note: 'x'.repeat(200) }))).status).toBe(200);
  });

  it('rejects someone who is not staff, manager or owner', async () => {
    state.profile = { id: 'c-1', role: 'customer' };
    expect((await POST(req('POST', good))).status).toBe(404);
    state.profile = null;
    expect((await POST(req('POST', good))).status).toBe(404);
  });

  it('503s with the SQL instruction when the table is missing', async () => {
    state.insertError = { code: 'PGRST205', message: 'Could not find the table' };
    const res = await POST(req('POST', good));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('Run supabase/2026-11-staff-advances.sql on Hioc India first.');
  });
});

describe('advances route — DELETE', () => {
  it('soft-removes an advance and records who', async () => {
    const res = await DELETE(req('DELETE', { id: 'adv-1' }));
    expect(res.status).toBe(200);
    expect(state.updated?.removed_by).toBe('owner-1');
    expect(typeof state.updated?.removed_at).toBe('string');
  });

  it('404s when the advance is missing or already removed', async () => {
    state.advance = null;
    expect((await DELETE(req('DELETE', { id: 'nope' }))).status).toBe(404);
    state.advance = { id: 'adv-1', user_id: 'staff-1', given_on: '2026-11-08', created_at: '2026-11-08T06:00:00Z', removed_at: '2026-11-09T00:00:00Z' };
    expect((await DELETE(req('DELETE', { id: 'adv-1' }))).status).toBe(404);
    expect(state.updated).toBeNull();
  });

  it('409s once a finalized month on or after its date has taken it off', async () => {
    state.finalizedRuns = [
      { id: 'run-1', user_id: 'staff-1', period_end: '2026-11-30', finalized_at: '2026-12-01T00:00:00Z' },
    ];
    const res = await DELETE(req('DELETE', { id: 'adv-1' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      'This advance was already counted in a finalized month. Reverse that month first.',
    );
    expect(state.updated).toBeNull();
    expect(state.lockFilter).toMatchObject({ user_id: 'staff-1', status: 'finalized', 'period_end>=': '2026-11-08' });
  });

  it('allows removing an advance added AFTER the month was finalized', async () => {
    state.advance = { id: 'adv-1', user_id: 'staff-1', given_on: '2026-11-28', created_at: '2026-12-02T06:00:00Z', removed_at: null };
    state.finalizedRuns = [
      { id: 'run-1', user_id: 'staff-1', period_end: '2026-11-30', finalized_at: '2026-12-01T00:00:00Z' },
    ];
    expect((await DELETE(req('DELETE', { id: 'adv-1' }))).status).toBe(200);
  });

  it('allows removing an advance dated after the finalized period', async () => {
    state.advance = { id: 'adv-1', user_id: 'staff-1', given_on: '2026-12-03', created_at: '2026-11-01T00:00:00Z', removed_at: null };
    state.finalizedRuns = [
      { id: 'run-1', user_id: 'staff-1', period_end: '2026-11-30', finalized_at: '2026-12-01T00:00:00Z' },
    ];
    expect((await DELETE(req('DELETE', { id: 'adv-1' }))).status).toBe(200);
  });

  it('503s when the table is missing', async () => {
    state.selectError = { code: '42P01', message: 'relation "staff_advances" does not exist' };
    expect((await DELETE(req('DELETE', { id: 'adv-1' }))).status).toBe(503);
  });

  it('400s without an id', async () => {
    expect((await DELETE(req('DELETE', {}))).status).toBe(400);
  });
});
