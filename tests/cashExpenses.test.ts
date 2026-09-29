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
  /** 'device' = an enrolled device's PIN operator: no Supabase session, so never getOwnerUser(). */
  via: 'session' | 'device';
  perms: Record<string, boolean>;
} = { user: null, role: 'staff', via: 'session', perms: {} };
const permissionCalls: unknown[][] = [];

let admin: SupabaseClient;
let tables: Record<string, Row[]>;

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => admin,
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () =>
    Promise.resolve(auth.user ? { user: auth.user, role: auth.role, via: auth.via } : null),
  getOwnerUser: () => Promise.resolve(auth.user && auth.role === 'owner' && auth.via === 'session' ? auth.user : null),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: (...args: unknown[]) => {
    permissionCalls.push(args);
    return Promise.resolve(auth.perms[args[1] as string] ?? false);
  },
}));

const { POST, GET } = await import('@/app/api/cash-expenses/route');
const { POST: UNDO } = await import('@/app/api/cash-expenses/[id]/undo/route');
const { POST: APPROVE } = await import('@/app/api/cash-expenses/approve/route');

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
  auth.via = 'session';
  auth.perms = { cash_expense: true };
  tables = {
    cash_days: [],
    cash_movements: [],
    cash_counts: [],
    profiles: [
      { id: 'staff-1', name: 'Priya' },
      { id: 'staff-2', name: 'Rohan' },
      { id: 'mgr-1', name: 'Meera' },
      { id: 'mgr-2', name: 'Manoj' },
      { id: 'owner-1', name: 'Olga' },
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

// ---------------------------------------------------------------------------
// 3. Approval + undo.
// ---------------------------------------------------------------------------
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const ID4 = '44444444-4444-4444-8444-444444444444';
const PUNCHED = '2026-09-29T10:00:00.000Z';

function expenseRow(over: Row = {}): Row {
  return {
    id: ID1,
    direction: 'out',
    amount_inr: 100,
    reason: 'Ice cubes',
    category: 'ice',
    recorded_by: 'staff-1',
    created_at: PUNCHED,
    approved_by: null,
    approved_at: null,
    voided_by: null,
    voided_at: null,
    ...over,
  };
}

const undoReq = () => new Request('http://t/api/cash-expenses/x/undo', { method: 'POST' });
const undo = (id = ID1) => UNDO(undoReq(), { params: { id } });
const approveReq = (body: unknown) =>
  new Request('http://t/api/cash-expenses/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/cash-expenses/[id]/undo', () => {
  it('401s with no actor and 404s a malformed id, a missing row and a plain cash out', async () => {
    auth.user = null;
    expect((await undo()).status).toBe(401);
    auth.user = { id: 'staff-1' };
    expect((await undo('not-a-uuid')).status).toBe(404);
    expect((await undo(ID2)).status).toBe(404);
    tables.cash_movements.push(expenseRow({ id: ID3, category: null }));
    expect((await undo(ID3)).status).toBe(404);
  });

  it('lets staff undo their OWN pending expense: voids the row, keeps it, returns the entry', async () => {
    tables.cash_movements.push(expenseRow());
    const res = await undo();
    expect(res.status).toBe(200);
    const row = tables.cash_movements[0];
    expect(tables.cash_movements).toHaveLength(1); // voided, never deleted
    expect(row.voided_at).toBe(NOW);
    expect(row.voided_by).toBe('staff-1');
    expect(row.approved_at).toBeNull();
    const { expense } = await res.json();
    expect(expense).toMatchObject({
      id: ID1,
      status: 'undone',
      undoneByName: 'Priya',
      undoneAt: NOW,
      canUndo: false,
      canApprove: false,
    });
  });

  it("403s staff undoing someone else's expense, and changes nothing", async () => {
    tables.cash_movements.push(expenseRow({ recorded_by: 'staff-2' }));
    const res = await undo();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/person who punched it or a manager/);
    expect(tables.cash_movements[0].voided_at).toBeNull();
  });

  it("lets a manager undo someone else's pending expense", async () => {
    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    tables.cash_movements.push(expenseRow({ recorded_by: 'staff-2' }));
    const res = await undo();
    expect(res.status).toBe(200);
    expect(tables.cash_movements[0]).toMatchObject({ voided_at: NOW, voided_by: 'mgr-1' });
    expect((await res.json()).expense.undoneByName).toBe('Meera');
  });

  it('409s an approved expense and an already undone one', async () => {
    tables.cash_movements.push(expenseRow({ approved_at: '2026-09-29T10:30:00.000Z', approved_by: 'mgr-1' }));
    const approved = await undo();
    expect(approved.status).toBe(409);
    expect((await approved.json()).error).toMatch(/already approved/);

    tables.cash_movements[0] = expenseRow({ voided_at: '2026-09-29T10:10:00.000Z', voided_by: 'staff-1' });
    const undone = await undo();
    expect(undone.status).toBe(409);
    expect((await undone.json()).error).toMatch(/already undone/);
  });

  it('409s once the drawer was counted after the punch (any cash_counts row), even for a manager', async () => {
    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    tables.cash_movements.push(expenseRow());
    tables.cash_counts.push({ id: 'cc-1', kind: 'clock_in', created_at: '2026-09-29T10:00:01.000Z' });
    const res = await undo();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/drawer has been counted/);
    expect(tables.cash_movements[0].voided_at).toBeNull();
  });

  it('a count made BEFORE the punch does not block the undo', async () => {
    tables.cash_movements.push(expenseRow());
    tables.cash_counts.push({ id: 'cc-1', kind: 'clock_in', created_at: '2026-09-29T09:59:59.000Z' });
    expect((await undo()).status).toBe(200);
  });

  it('409s once a cash day closed at or after the punch; an open day or an earlier close does not', async () => {
    tables.cash_movements.push(expenseRow());
    tables.cash_days.push({ id: 'cd-old', status: 'closed', closed_at: '2026-09-29T08:00:00.000Z' });
    tables.cash_days.push({ id: 'cd-open', status: 'open', closed_at: null });
    expect((await undo()).status).toBe(200);

    tables.cash_movements[0] = expenseRow();
    tables.cash_days.push({ id: 'cd-new', status: 'closed', closed_at: '2026-09-29T10:30:00.000Z' });
    const res = await undo();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/drawer has been counted/);
  });

  it('409s "changed — reload" when the row stops being pending between the read and the write (0 rows)', async () => {
    tables.cash_movements.push(expenseRow());
    const real = admin;
    admin = {
      from: (table: string) => {
        const chain = real.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (table !== 'cash_movements') return chain;
        return new Proxy(chain, {
          get(target, prop) {
            if (prop !== 'update') return target[prop as string];
            // A manager approves the expense just as the staffer taps Undo.
            return (payload: unknown) => {
              tables.cash_movements[0].approved_at = '2026-09-29T10:20:00.000Z';
              return target.update(payload);
            };
          },
        });
      },
    } as unknown as SupabaseClient;
    const res = await undo();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('This expense changed — reload');
    expect(tables.cash_movements[0].voided_at).toBeNull();
  });

  it('409s with the migration hint when the approval columns are missing', async () => {
    tables.cash_movements.push(expenseRow());
    admin = {
      from: () => {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: null, error: { code: '42703', message: 'column cash_movements.voided_at does not exist' } }),
        });
        return chain;
      },
    } as unknown as SupabaseClient;
    const res = await undo();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('supabase/2026-10-cash-expenses.sql');
  });
});

describe('POST /api/cash-expenses/approve', () => {
  it('401s with no actor and 403s plain staff, approving nothing', async () => {
    tables.cash_movements.push(expenseRow({ recorded_by: 'staff-2' }));
    auth.user = null;
    expect((await APPROVE(approveReq({ ids: [ID1] }))).status).toBe(401);
    auth.user = { id: 'staff-1' };
    const res = await APPROVE(approveReq({ ids: [ID1] }));
    expect(res.status).toBe(403);
    expect(tables.cash_movements[0].approved_at).toBeNull();
  });

  it('400s a bad body: not JSON, no ids, empty, too many, non-uuid', async () => {
    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    expect((await APPROVE(approveReq('not json'))).status).toBe(400);
    expect((await APPROVE(approveReq({}))).status).toBe(400);
    expect((await APPROVE(approveReq({ ids: [] }))).status).toBe(400);
    expect((await APPROVE(approveReq({ ids: 'abc' }))).status).toBe(400);
    expect((await APPROVE(approveReq({ ids: ['nope'] }))).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await APPROVE(approveReq({ ids: many }))).status).toBe(400);
    expect((await APPROVE(approveReq({ ids: many.slice(0, 100) }))).status).toBe(200);
  });

  it("a manager approves others' pending expenses but skips their own", async () => {
    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    tables.cash_movements.push(
      expenseRow({ id: ID1, recorded_by: 'staff-1' }),
      expenseRow({ id: ID2, recorded_by: 'mgr-1' }),
    );
    const res = await APPROVE(approveReq({ ids: [ID1, ID2] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approved).toEqual([ID1]);
    expect(body.skipped).toEqual([{ id: ID2, reason: 'Another manager or the owner must approve your own expense.' }]);
    expect(tables.cash_movements[0]).toMatchObject({ approved_at: NOW, approved_by: 'mgr-1' });
    expect(tables.cash_movements[1].approved_at).toBeNull();
  });

  it('an owner session approves anything, even an expense it punched itself (via getOwnerUser)', async () => {
    auth.user = { id: 'owner-1' };
    auth.role = 'owner';
    tables.cash_movements.push(
      expenseRow({ id: ID1, recorded_by: 'mgr-1' }),
      expenseRow({ id: ID2, recorded_by: 'owner-1' }),
    );
    const body = await (await APPROVE(approveReq({ ids: [ID1, ID2] }))).json();
    expect(body).toEqual({ approved: [ID1, ID2], skipped: [] });
    expect(tables.cash_movements.map((r) => r.approved_by)).toEqual(['owner-1', 'owner-1']);
  });

  it('an owner unlocked by a device PIN is capped at manager: cannot approve their own', async () => {
    auth.user = { id: 'owner-1' };
    auth.role = 'manager'; // getCounterActor caps a device operator at manager
    auth.via = 'device';
    tables.cash_movements.push(expenseRow({ id: ID1, recorded_by: 'owner-1' }));
    const body = await (await APPROVE(approveReq({ ids: [ID1] }))).json();
    expect(body.approved).toEqual([]);
    expect(body.skipped[0].id).toBe(ID1);
  });

  it('skips already approved, undone and unknown ids with a reason, and dedupes repeated ids', async () => {
    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    tables.cash_movements.push(
      expenseRow({ id: ID1 }),
      expenseRow({ id: ID2, approved_at: '2026-09-29T10:20:00.000Z', approved_by: 'mgr-2' }),
      expenseRow({ id: ID3, voided_at: '2026-09-29T10:10:00.000Z', voided_by: 'staff-1' }),
    );
    const body = await (await APPROVE(approveReq({ ids: [ID1, ID1, ID2, ID3, ID4] }))).json();
    expect(body.approved).toEqual([ID1]);
    expect(body.skipped).toEqual([
      { id: ID2, reason: 'This expense is already approved.' },
      { id: ID3, reason: 'This expense was undone.' },
      { id: ID4, reason: 'Expense not found.' },
    ]);
    expect(tables.cash_movements[1].approved_by).toBe('mgr-2'); // untouched
    expect(tables.cash_movements[2].approved_at).toBeNull();
  });

  it('does not approve a plain cash out (no category)', async () => {
    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    tables.cash_movements.push(expenseRow({ id: ID1, category: null }));
    const body = await (await APPROVE(approveReq({ ids: [ID1] }))).json();
    expect(body.approved).toEqual([]);
    expect(tables.cash_movements[0].approved_at).toBeNull();
  });
});

describe('POST /api/cash-expenses by the owner', () => {
  it('is approved on entry (approved_at / approved_by = the owner)', async () => {
    auth.user = { id: 'owner-1' };
    auth.role = 'owner';
    const res = await POST(postReq({ category: 'ice', amountInr: 120 }));
    expect(res.status).toBe(200);
    expect(tables.cash_movements[0]).toMatchObject({ approved_by: 'owner-1', approved_at: NOW });
    expect(tables.cash_movements[0].voided_at).toBeUndefined();
    const { expense } = await res.json();
    expect(expense).toMatchObject({ status: 'approved', approvedByName: 'Olga', canUndo: false, canApprove: false });
  });

  it('staff and manager punches stay pending; the entry says what the punching viewer may do', async () => {
    const staff = await (await POST(postReq({ category: 'ice', amountInr: 100 }))).json();
    expect(tables.cash_movements[0].approved_at).toBeUndefined();
    expect(staff.expense).toMatchObject({ status: 'pending', approvedByName: null, canUndo: true, canApprove: false });

    auth.user = { id: 'mgr-1' };
    auth.role = 'manager';
    const mgr = await (await POST(postReq({ category: 'water', amountInr: 50 }))).json();
    // A manager can undo their own pending punch but cannot approve it (four eyes).
    expect(mgr.expense).toMatchObject({ status: 'pending', canUndo: true, canApprove: false });
  });

  it('an owner unlocked by a device PIN (role manager) is not auto-approved', async () => {
    auth.user = { id: 'owner-1' };
    auth.role = 'manager';
    auth.via = 'device';
    await POST(postReq({ category: 'ice', amountInr: 100 }));
    expect(tables.cash_movements[0].approved_at).toBeUndefined();
  });
});

describe('GET /api/cash-expenses: approval state, per-viewer actions and totals', () => {
  const at = (h: number, m = 0) => `2026-09-29T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  function seed() {
    tables.cash_days.push({ id: 'cd-1', status: 'open', opened_at: OPENED });
    tables.cash_movements.push(
      expenseRow({ id: ID1, amount_inr: 100, recorded_by: 'staff-1', created_at: at(10) }), // pending, staff-1's
      expenseRow({ id: ID2, amount_inr: 200, category: 'water', recorded_by: 'staff-2', created_at: at(10, 30) }), // pending, staff-2's
      expenseRow({ id: ID3, amount_inr: 300, category: 'milk_dairy', recorded_by: 'staff-2', created_at: at(11), approved_at: at(11, 5), approved_by: 'mgr-2' }),
      expenseRow({ id: ID4, amount_inr: 400, recorded_by: 'staff-1', created_at: at(11, 30), voided_at: at(11, 35), voided_by: 'staff-1' }),
    );
  }
  type E = { id: string; status: string; canUndo: boolean; canApprove: boolean; approvedByName: string | null; undoneByName: string | null; recordedByName: string };
  const byId = (body: { expenses: E[] }, id: string) => body.expenses.find((e) => e.id === id) as E;

  it('for staff: undo only their own pending row, never approve; totals exclude the undone one', async () => {
    seed();
    const body = await (await GET()).json();
    expect(body.expenses.map((e: E) => e.id)).toEqual([ID4, ID3, ID2, ID1]);
    expect(byId(body, ID1)).toMatchObject({ status: 'pending', canUndo: true, canApprove: false, recordedByName: 'Priya' });
    expect(byId(body, ID2)).toMatchObject({ status: 'pending', canUndo: false, canApprove: false });
    expect(byId(body, ID3)).toMatchObject({ status: 'approved', approvedByName: 'Manoj', canUndo: false, canApprove: false });
    expect(byId(body, ID4)).toMatchObject({ status: 'undone', undoneByName: 'Priya', canUndo: false, canApprove: false });
    expect(body.totalInr).toBe(600); // 100 + 200 + 300, not the undone 400
    expect(body.byCategory).toEqual([
      { category: 'milk_dairy', label: 'Milk & dairy', amountInr: 300, count: 1 },
      { category: 'water', label: 'Water', amountInr: 200, count: 1 },
      { category: 'ice', label: 'Ice cubes', amountInr: 100, count: 1 },
    ]);
    expect(body.pendingCount).toBe(2);
    expect(body.pendingInr).toBe(300);
  });

  it('for a manager: undo any pending row, approve any pending row but their own', async () => {
    seed();
    auth.user = { id: 'staff-1' }; // punched ID1 …
    auth.role = 'manager'; // … and has since been promoted: own entry
    const body = await (await GET()).json();
    expect(byId(body, ID1)).toMatchObject({ canUndo: true, canApprove: false });
    expect(byId(body, ID2)).toMatchObject({ canUndo: true, canApprove: true });
    expect(byId(body, ID3)).toMatchObject({ canUndo: false, canApprove: false });
    expect(byId(body, ID4)).toMatchObject({ canUndo: false, canApprove: false });
  });

  it('for the owner: approve any pending row, including their own', async () => {
    seed();
    auth.user = { id: 'staff-1' };
    auth.role = 'owner';
    const body = await (await GET()).json();
    expect(byId(body, ID1)).toMatchObject({ canUndo: true, canApprove: true });
    expect(byId(body, ID2)).toMatchObject({ canUndo: true, canApprove: true });
  });

  it('canUndo turns off once the drawer was counted or a day closed after the punch', async () => {
    seed();
    tables.cash_counts.push({ id: 'cc-1', kind: 'clock_out', created_at: at(10, 45) });
    let body = await (await GET()).json();
    expect(byId(body, ID1).canUndo).toBe(false); // punched 10:00, counted 10:45
    // …but a later expense (11:00+) is still undoable by its own author.
    tables.cash_movements.push(expenseRow({ id: '55555555-5555-4555-8555-555555555555', recorded_by: 'staff-1', created_at: at(11, 50) }));
    body = await (await GET()).json();
    expect(byId(body, '55555555-5555-4555-8555-555555555555').canUndo).toBe(true);

    tables.cash_days.push({ id: 'cd-closed', status: 'closed', closed_at: at(11, 55) });
    body = await (await GET()).json();
    expect(byId(body, '55555555-5555-4555-8555-555555555555').canUndo).toBe(false);
  });

  it('an old database without the approval columns reads every expense as pending', async () => {
    tables.cash_days.push({ id: 'cd-1', status: 'open', opened_at: OPENED });
    tables.cash_movements.push(expenseRow({ id: ID1, recorded_by: 'staff-1', created_at: at(10) }));
    const real = admin;
    const selects: string[] = [];
    admin = {
      from: (table: string) => {
        const chain = real.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (table !== 'cash_movements') return chain;
        return new Proxy(chain, {
          get(target, prop) {
            if (prop !== 'select') return target[prop as string];
            return (cols: string) => {
              selects.push(cols);
              if (cols.includes('approved_at')) {
                const failing: Record<string, unknown> = {};
                Object.assign(failing, {
                  eq: () => failing,
                  gte: () => failing,
                  order: () => failing,
                  limit: () => failing,
                  then: (resolve: (v: unknown) => void) =>
                    resolve({ data: null, error: { code: '42703', message: 'column cash_movements.approved_at does not exist' } }),
                });
                return failing;
              }
              return target.select(cols);
            };
          },
        });
      },
    } as unknown as SupabaseClient;
    const body = await (await GET()).json();
    expect(selects).toHaveLength(2);
    expect(body.expenses).toHaveLength(1);
    expect(body.expenses[0]).toMatchObject({ status: 'pending', canUndo: true });
    expect(body).toMatchObject({ totalInr: 100, pendingCount: 1, pendingInr: 100 });
  });
});
