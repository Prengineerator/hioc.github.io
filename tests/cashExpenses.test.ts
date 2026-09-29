import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import {
  EXPENSE_CATEGORIES,
  MAX_EXPENSE_INR,
  expenseCategoryLabel,
  totalsByCategory,
  validateExpense,
} from '@/lib/cash/expenses';

// Expenses paid from the cash drawer. Two layers, house style:
//  1. The pure rules in lib/cash/expenses.ts (validateExpense, totalsByCategory)
//     — no mocks; the staff form and the route share these exact functions.
//  2. Handler-level tests for POST/GET /api/cash-expenses against the in-memory
//     fake Postgres, with auth + the permission matrix mocked.

// ---------------------------------------------------------------------------
// 1. Pure rules.
// ---------------------------------------------------------------------------
describe('validateExpense', () => {
  it('accepts a preset category with just an amount; the reason falls back to the label', () => {
    expect(validateExpense({ category: 'ice', amountInr: 120 })).toEqual({
      ok: true,
      expense: { category: 'ice', amountInr: 120, note: '', reason: 'Ice cubes' },
    });
  });

  it('keeps a trimmed note as the reason', () => {
    const r = validateExpense({ category: 'water', amountInr: 60, note: '  20L can  ' });
    expect(r).toMatchObject({ ok: true, expense: { note: '20L can', reason: '20L can' } });
  });

  it('rejects a non-object body, an unknown category and a missing category', () => {
    expect(validateExpense(null)).toMatchObject({ ok: false });
    expect(validateExpense('ice')).toMatchObject({ ok: false });
    expect(validateExpense({ category: 'yacht', amountInr: 10 })).toMatchObject({ ok: false });
    expect(validateExpense({ amountInr: 10 })).toMatchObject({ ok: false });
  });

  it('rejects zero, negative, fractional and non-numeric amounts', () => {
    for (const amountInr of [0, -5, 12.5, '50', null, undefined, Number.NaN]) {
      expect(validateExpense({ category: 'ice', amountInr })).toMatchObject({ ok: false });
    }
  });

  it('caps petty cash at MAX_EXPENSE_INR (inclusive)', () => {
    expect(validateExpense({ category: 'groceries', amountInr: MAX_EXPENSE_INR }).ok).toBe(true);
    const over = validateExpense({ category: 'groceries', amountInr: MAX_EXPENSE_INR + 1 });
    expect(over).toMatchObject({ ok: false });
    expect(over.ok === false && over.error).toContain("manager's cash out");
  });

  it("'other' needs a real note (5+ characters after trimming); a preset does not", () => {
    expect(validateExpense({ category: 'other', amountInr: 50 })).toMatchObject({ ok: false });
    expect(validateExpense({ category: 'other', amountInr: 50, note: '  abc  ' })).toMatchObject({ ok: false });
    expect(validateExpense({ category: 'other', amountInr: 50, note: 'Key copy' }).ok).toBe(true);
    expect(validateExpense({ category: 'ice', amountInr: 50, note: '' }).ok).toBe(true);
  });

  it('rejects a non-text note and an over-long one', () => {
    expect(validateExpense({ category: 'ice', amountInr: 50, note: 7 })).toMatchObject({ ok: false });
    expect(validateExpense({ category: 'ice', amountInr: 50, note: 'x'.repeat(301) })).toMatchObject({ ok: false });
    expect(validateExpense({ category: 'ice', amountInr: 50, note: 'x'.repeat(300) }).ok).toBe(true);
  });
});

describe('expense categories', () => {
  it('has unique keys and ends with other', () => {
    const keys = EXPENSE_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[keys.length - 1]).toBe('other');
  });

  it('labels a known key, shows an unknown key as-is, and is empty for none', () => {
    expect(expenseCategoryLabel('milk_dairy')).toBe('Milk & dairy');
    expect(expenseCategoryLabel('legacy_thing')).toBe('legacy_thing');
    expect(expenseCategoryLabel(null)).toBe('');
  });
});

describe('totalsByCategory', () => {
  it('sums by category, biggest first, skipping rows with no category', () => {
    const totals = totalsByCategory([
      { category: 'ice', amountInr: 100 },
      { category: 'water', amountInr: 300 },
      { category: 'ice', amountInr: 250 },
      { category: null, amountInr: 9999 }, // a plain manager cash out
      { category: undefined, amountInr: 1 },
    ]);
    expect(totals).toEqual([
      { category: 'ice', label: 'Ice cubes', amountInr: 350, count: 2 },
      { category: 'water', label: 'Water', amountInr: 300, count: 1 },
    ]);
  });

  it('breaks a tie by label and is empty for no rows', () => {
    const totals = totalsByCategory([
      { category: 'water', amountInr: 100 },
      { category: 'ice', amountInr: 100 },
    ]);
    expect(totals.map((t) => t.category)).toEqual(['ice', 'water']); // 'Ice cubes' < 'Water'
    expect(totalsByCategory([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Handlers.
// ---------------------------------------------------------------------------
const auth: {
  user: { id: string } | null;
  role: 'staff' | 'manager' | 'owner';
  perms: Record<string, boolean>;
} = { user: null, role: 'staff', perms: {} };
const permissionCalls: unknown[][] = [];

let admin: SupabaseClient;
let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => admin,
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () =>
    Promise.resolve(auth.user ? { user: auth.user, role: auth.role, via: 'session' } : null),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: (...args: unknown[]) => {
    permissionCalls.push(args);
    return Promise.resolve(auth.perms[args[1] as string] ?? false);
  },
}));

const { POST, GET } = await import('@/app/api/cash-expenses/route');

const NOW = '2026-09-29T12:00:00.000Z';
const OPENED = '2026-09-29T09:30:00.000Z';

function postReq(body: unknown) {
  return new Request('http://t/api/cash-expenses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  permissionCalls.length = 0;
  auth.user = { id: 'staff-1' };
  auth.role = 'staff';
  auth.perms = { cash_expense: true };
  tables = {
    cash_days: [],
    cash_movements: [],
    profiles: [
      { id: 'staff-1', name: 'Priya' },
      { id: 'staff-2', name: 'Rohan' },
    ],
  };
  admin = makeFakeAdmin(tables, { startMs: Date.parse('2026-09-29T10:00:00.000Z') }) as unknown as SupabaseClient;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/cash-expenses', () => {
  it('401s with no actor, and writes nothing', async () => {
    auth.user = null;
    expect((await POST(postReq({ category: 'ice', amountInr: 100 }))).status).toBe(401);
    expect(tables.cash_movements).toHaveLength(0);
  });

  it('403s without the cash_expense permission, checking it against the actor role', async () => {
    auth.perms = {};
    auth.role = 'staff';
    const res = await POST(postReq({ category: 'ice', amountInr: 100 }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("You don't have permission to record expenses.");
    expect(permissionCalls[0]).toEqual([auth.user, 'cash_expense', 'staff']);
    expect(tables.cash_movements).toHaveLength(0);
  });

  it('400s a malformed body and every validation failure, with the validator message', async () => {
    expect((await POST(postReq('not json'))).status).toBe(400);
    expect((await POST(postReq([]))).status).toBe(400);

    const badCategory = await POST(postReq({ category: 'yacht', amountInr: 100 }));
    expect(badCategory.status).toBe(400);
    expect((await badCategory.json()).error).toBe('Pick what the expense was for.');

    expect((await POST(postReq({ category: 'ice', amountInr: 0 }))).status).toBe(400);
    expect((await POST(postReq({ category: 'ice', amountInr: MAX_EXPENSE_INR + 1 }))).status).toBe(400);
    expect((await POST(postReq({ category: 'other', amountInr: 50 }))).status).toBe(400);
    expect(tables.cash_movements).toHaveLength(0);
  });

  it("inserts a cash-out with the category, the actor as recorder, and returns the entry", async () => {
    const res = await POST(postReq({ category: 'ice', amountInr: 120, note: ' 3 bags ' }));
    expect(res.status).toBe(200);
    expect(tables.cash_movements).toHaveLength(1);
    expect(tables.cash_movements[0]).toMatchObject({
      direction: 'out',
      amount_inr: 120,
      reason: '3 bags',
      category: 'ice',
      recorded_by: 'staff-1',
    });
    const { expense } = await res.json();
    expect(expense).toMatchObject({
      id: tables.cash_movements[0].id,
      category: 'ice',
      categoryLabel: 'Ice cubes',
      amountInr: 120,
      reason: '3 bags',
      recordedByName: 'Priya',
    });
    expect(typeof expense.createdAt).toBe('string');
  });

  it('uses the category label as the reason when there is no note', async () => {
    const res = await POST(postReq({ category: 'milk_dairy', amountInr: 80 }));
    expect(res.status).toBe(200);
    expect(tables.cash_movements[0].reason).toBe('Milk & dairy');
  });

  it('a device PIN operator (role manager) is checked the same way', async () => {
    auth.role = 'manager';
    expect((await POST(postReq({ category: 'water', amountInr: 40 }))).status).toBe(200);
    expect(permissionCalls[0]?.[2]).toBe('manager');
  });

  it('names the migration when the category column is missing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          insert: () => chain,
          select: () => chain,
          single: () => Promise.resolve({ data: null, error: { code: 'PGRST204', message: "Could not find the 'category' column" } }),
        });
        return chain;
      },
    };
    admin = failing as unknown as SupabaseClient;
    const res = await POST(postReq({ category: 'ice', amountInr: 100 }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('supabase/2026-10-cash-expenses.sql');
    spy.mockRestore();
  });
});

describe('GET /api/cash-expenses', () => {
  const day = (over: Row = {}): Row => ({ id: 'cd-1', status: 'open', opened_at: OPENED, ...over });
  const move = (over: Row): Row => ({
    direction: 'out',
    reason: 'x',
    category: null,
    recorded_by: 'staff-1',
    ...over,
  });

  it('401s with no actor', async () => {
    auth.user = null;
    expect((await GET()).status).toBe(401);
  });

  it('with a day open: expenses since it opened, newest first, names + totals, plain cash outs excluded', async () => {
    tables.cash_days.push(day());
    tables.cash_movements.push(
      move({ id: 'm-before', amount_inr: 999, category: 'ice', created_at: '2026-09-29T08:00:00.000Z' }), // before opened_at
      move({ id: 'm1', amount_inr: 100, reason: 'Ice cubes', category: 'ice', created_at: '2026-09-29T10:00:00.000Z' }),
      move({ id: 'm2', amount_inr: 500, reason: 'Bank deposit', created_at: '2026-09-29T10:30:00.000Z' }), // manager cash out
      move({ id: 'm3', amount_inr: 300, reason: '20L cans', category: 'water', recorded_by: 'staff-2', created_at: '2026-09-29T11:00:00.000Z' }),
      move({ id: 'm4', amount_inr: 50, reason: 'Ice cubes', category: 'ice', created_at: '2026-09-29T11:30:00.000Z' }),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dayOpen).toBe(true);
    expect(body.since).toBe(OPENED);
    expect(body.expenses.map((e: { id: string }) => e.id)).toEqual(['m4', 'm3', 'm1']);
    expect(body.expenses[1]).toMatchObject({
      category: 'water',
      categoryLabel: 'Water',
      amountInr: 300,
      reason: '20L cans',
      recordedByName: 'Rohan',
    });
    expect(body.totalInr).toBe(450);
    expect(body.byCategory).toEqual([
      { category: 'water', label: 'Water', amountInr: 300, count: 1 },
      { category: 'ice', label: 'Ice cubes', amountInr: 150, count: 2 },
    ]);
  });

  it('with no day open: the last 24 hours only', async () => {
    tables.cash_days.push(day({ status: 'closed' }));
    tables.cash_movements.push(
      move({ id: 'old', amount_inr: 70, category: 'ice', created_at: '2026-09-28T11:00:00.000Z' }), // 25h ago
      move({ id: 'recent', amount_inr: 30, category: 'ice', created_at: '2026-09-28T13:00:00.000Z' }),
    );
    const body = await (await GET()).json();
    expect(body.dayOpen).toBe(false);
    expect(body.since).toBe('2026-09-28T12:00:00.000Z');
    expect(body.expenses.map((e: { id: string }) => e.id)).toEqual(['recent']);
    expect(body.totalInr).toBe(30);
  });

  it('returns an empty list rather than failing when the category column does not exist yet', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tables.cash_days.push(day());
    const real = admin;
    admin = {
      from: (table: string) => {
        if (table !== 'cash_movements') return real.from(table);
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: () => chain,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: { code: '42703', message: 'column cash_movements.category does not exist' } }),
        });
        return chain;
      },
    } as unknown as SupabaseClient;
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dayOpen: true, expenses: [], totalInr: 0, byCategory: [] });
    spy.mockRestore();
  });
});
