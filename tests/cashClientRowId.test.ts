import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import { ID_TAKEN_MESSAGE, newClientRowId, parseClientRowId, sameEntry } from '@/lib/cash/clientRowId';

// Retry safety for cash-in / cash-out and expenses without a migration: the
// form names the cash_movements row (its uuid primary key), so a retry whose
// first attempt landed is answered with the row already there instead of the
// money being recorded twice. Pure helpers, then both routes against the
// in-memory fake Postgres — wrapped to enforce the primary key the way
// Postgres does (23505 on a duplicate id).

const ID = '0b7b8f9a-6c1e-4d2b-9f3a-1c2d3e4f5a6b';
const OTHER_ID = '1c8c9a0b-7d2f-4e3c-8a4b-2d3e4f5a6b7c';

describe('clientRowId helpers', () => {
  it('mints a v4 uuid the route accepts', () => {
    const id = newClientRowId();
    expect(id).not.toBeNull();
    expect(parseClientRowId(id)).toEqual({ ok: true, id });
    expect(newClientRowId()).not.toBe(id);
  });

  it('the id is optional; anything but a uuid is refused', () => {
    expect(parseClientRowId(undefined)).toEqual({ ok: true, id: null });
    expect(parseClientRowId(null)).toEqual({ ok: true, id: null });
    expect(parseClientRowId(ID.toUpperCase())).toEqual({ ok: true, id: ID });
    for (const bad of ['', 'abc', 42, {}, `${ID}x`]) expect(parseClientRowId(bad).ok).toBe(false);
  });

  it('a replay is the same actor’s same entry — nothing less', () => {
    const e = { recorded_by: 'm1', direction: 'out', amount_inr: 500, reason: 'Bank deposit', category: null };
    expect(sameEntry(e, { ...e })).toBe(true);
    expect(sameEntry({ ...e, category: undefined }, e)).toBe(true);
    expect(sameEntry(e, { ...e, recorded_by: 'm2' })).toBe(false);
    expect(sameEntry(e, { ...e, amount_inr: 501 })).toBe(false);
    expect(sameEntry(e, { ...e, direction: 'in' })).toBe(false);
    expect(sameEntry(e, { ...e, reason: 'Float top-up' })).toBe(false);
    expect(sameEntry(e, { ...e, category: 'ice' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------
const auth: { user: { id: string } | null; role: 'staff' | 'manager' | 'owner' } = { user: null, role: 'staff' };

let admin: SupabaseClient;
let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => admin,
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(auth.user ? { user: auth.user, role: auth.role, via: 'session' } : null),
  getCounterManager: () =>
    Promise.resolve(
      auth.user && (auth.role === 'manager' || auth.role === 'owner')
        ? { user: auth.user, role: auth.role, via: 'session' }
        : null,
    ),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: () => Promise.resolve(true),
}));

const movements = await import('@/app/api/cash-movements/route');
const expenses = await import('@/app/api/cash-expenses/route');

/** The fake admin, with cash_movements' primary key enforced as Postgres would. */
function withPrimaryKey(base: ReturnType<typeof makeFakeAdmin>) {
  return {
    from(table: string) {
      const chain = base.from(table) as unknown as Record<string, unknown>;
      const insert = chain.insert as (p: Row | Row[]) => unknown;
      chain.insert = (payload: Row | Row[]) => {
        const rows = Array.isArray(payload) ? payload : [payload];
        const clash = rows.some((r) => r.id !== undefined && (tables[table] ?? []).some((x) => x.id === r.id));
        if (!clash) return insert(payload);
        const error = { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` };
        const failing: Record<string, unknown> = {};
        Object.assign(failing, {
          select: () => failing,
          single: () => Promise.resolve({ data: null, error }),
          maybeSingle: () => Promise.resolve({ data: null, error }),
          then: (resolve: (v: unknown) => void) => resolve({ data: null, error }),
        });
        return failing;
      };
      return chain;
    },
  };
}

function post(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  auth.user = { id: 'mgr-1' };
  auth.role = 'manager';
  tables = {
    cash_movements: [],
    cash_counts: [],
    cash_days: [],
    profiles: [
      { id: 'mgr-1', name: 'Meera' },
      { id: 'mgr-2', name: 'Manoj' },
      { id: 'staff-1', name: 'Priya' },
    ],
  };
  admin = withPrimaryKey(makeFakeAdmin(tables, { startMs: Date.parse('2026-11-12T10:00:00.000Z') })) as unknown as SupabaseClient;
});

describe('POST /api/cash-movements with a client id', () => {
  const url = 'http://t/api/cash-movements';
  const entry = { direction: 'out', amountInr: 2000, reason: 'Bank deposit' };

  it('without an id: exactly as before (the database names the row)', async () => {
    const res = await movements.POST(post(url, entry));
    expect(res.status).toBe(200);
    expect(tables.cash_movements).toHaveLength(1);
    expect(tables.cash_movements[0].id).not.toBe(ID);
  });

  it('records the entry under the id the form sent', async () => {
    const res = await movements.POST(post(url, { ...entry, id: ID }));
    expect(res.status).toBe(200);
    expect(tables.cash_movements).toEqual([expect.objectContaining({ id: ID, amount_inr: 2000, recorded_by: 'mgr-1' })]);
    expect((await res.json()).movement.id).toBe(ID);
  });

  it('a retry of a request that went through is answered with the same row — not recorded twice', async () => {
    await movements.POST(post(url, { ...entry, id: ID }));
    const retry = await movements.POST(post(url, { ...entry, id: ID }));
    expect(retry.status).toBe(200);
    expect((await retry.json()).movement).toMatchObject({ id: ID, amount_inr: 2000, reason: 'Bank deposit' });
    expect(tables.cash_movements).toHaveLength(1);
  });

  it('another manager, or a different entry, under that id is refused (409), never overwritten', async () => {
    await movements.POST(post(url, { ...entry, id: ID }));
    auth.user = { id: 'mgr-2' };
    const otherActor = await movements.POST(post(url, { ...entry, id: ID }));
    expect(otherActor.status).toBe(409);
    expect((await otherActor.json()).error).toBe(ID_TAKEN_MESSAGE);
    auth.user = { id: 'mgr-1' };
    const otherAmount = await movements.POST(post(url, { ...entry, amountInr: 2500, id: ID }));
    expect(otherAmount.status).toBe(409);
    expect(tables.cash_movements).toHaveLength(1);
    expect(tables.cash_movements[0].amount_inr).toBe(2000);
  });

  it('a second entry gets its own id and is recorded', async () => {
    await movements.POST(post(url, { ...entry, id: ID }));
    expect((await movements.POST(post(url, { ...entry, id: OTHER_ID }))).status).toBe(200);
    expect(tables.cash_movements).toHaveLength(2);
  });

  it('a malformed id is a 400 and writes nothing', async () => {
    const res = await movements.POST(post(url, { ...entry, id: 'not-a-uuid' }));
    expect(res.status).toBe(400);
    expect(tables.cash_movements).toHaveLength(0);
  });
});

describe('POST /api/cash-expenses with a client id', () => {
  const url = 'http://t/api/cash-expenses';
  const expense = { category: 'ice', amountInr: 120, note: '3 bags' };

  beforeEach(() => {
    auth.user = { id: 'staff-1' };
    auth.role = 'staff';
  });

  it('without an id: exactly as before', async () => {
    const res = await expenses.POST(post(url, expense));
    expect(res.status).toBe(200);
    expect(tables.cash_movements).toHaveLength(1);
  });

  it('a retry of a request that went through returns the expense already recorded', async () => {
    const first = await expenses.POST(post(url, { ...expense, id: ID }));
    expect(first.status).toBe(200);
    expect(tables.cash_movements[0]).toMatchObject({ id: ID, category: 'ice', amount_inr: 120, recorded_by: 'staff-1' });
    const retry = await expenses.POST(post(url, { ...expense, id: ID }));
    expect(retry.status).toBe(200);
    expect((await retry.json()).expense).toMatchObject({ id: ID, category: 'ice', amountInr: 120, reason: '3 bags' });
    expect(tables.cash_movements).toHaveLength(1);
  });

  it('a different expense — or someone else — under that id is refused (409)', async () => {
    await expenses.POST(post(url, { ...expense, id: ID }));
    expect((await expenses.POST(post(url, { ...expense, amountInr: 150, id: ID }))).status).toBe(409);
    expect((await expenses.POST(post(url, { ...expense, category: 'water', id: ID }))).status).toBe(409);
    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    expect((await expenses.POST(post(url, { ...expense, id: ID }))).status).toBe(409);
    expect(tables.cash_movements).toHaveLength(1);
  });

  it('a malformed id is a 400 and writes nothing', async () => {
    expect((await expenses.POST(post(url, { ...expense, id: 7 }))).status).toBe(400);
    expect(tables.cash_movements).toHaveLength(0);
  });
});
