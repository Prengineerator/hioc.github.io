import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';

// lib/passes/server.ts (the database half of the coffee pass) and
// lib/passes/api.ts (the flag gate + missing-schema reading). The SQL itself is
// proven against a real Postgres (supabase/2026-10-coffee-pass.sql); here the
// mapping, the ordering and the pass-through of the SQL reason codes are
// pinned, and every failure is shown to degrade rather than throw.

const state = { flag: true };
vi.mock('@/lib/flags', () => ({
  flags: new Proxy({}, { get: (_t, key) => (key === 'coffeePass' ? state.flag : true) }),
}));

const {
  adjustPass,
  loadActivePlans,
  loadEligibleMenuIds,
  loadPassRedemptionHistory,
  loadPassSummaries,
  loadPlanById,
  loadUsablePasses,
  redeemPassDrinks,
  restorePassAfterFailedRefund,
  toCoffeePassPlan,
  voidPassForRefund,
} = await import('@/lib/passes/server');
const { coffeePassDisabled, isMissingPassSchema, PASS_MIGRATION_HINT, PASS_OFF_MESSAGE } = await import('@/lib/passes/api');

const NOW = new Date('2026-10-05T06:00:00Z');
const FUTURE = '2026-10-12T18:30:00.000Z';

function balance(over: Row = {}): Row {
  return {
    id: 'p1',
    user_id: 'u1',
    plan_id: 'plan-weekly',
    plan_name: 'Weekly Ritual',
    drinks_total: 7,
    drinks_used: 2,
    drinks_credited: 0,
    drinks_remaining: 5,
    drink_value_inr: 150,
    max_per_day: null,
    used_today: 0,
    price_inr: 750,
    starts_at: '2026-10-05T04:30:00.000Z',
    expires_at: FUTURE,
    status: 'active',
    state: 'active',
    order_id: 'order-1',
    created_at: '2026-10-05T04:30:00.000Z',
    ...over,
  };
}

function adminWith(tables: Record<string, Row[]>): SupabaseClient {
  return makeFakeAdmin(tables, { startMs: NOW.getTime() }) as unknown as SupabaseClient;
}

const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  state.flag = true;
  errorSpy.mockClear();
});
afterEach(() => {
  errorSpy.mockClear();
});

/** An admin whose every table read fails with `error`. */
function failingAdmin(error: { code?: string; message: string }): SupabaseClient {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = () => Promise.resolve({ data: null, error });
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error });
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error }) } as unknown as SupabaseClient;
}

/** An admin whose rpc records its calls and answers `answer`. */
function rpcAdmin(answer: { data?: unknown; error?: { code?: string; message: string } | null; throws?: boolean }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (answer.throws) throw new Error('network down');
      return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

describe('loadPassSummaries', () => {
  const rows = () => [
    balance({ id: 'later', expires_at: '2026-10-30T18:30:00.000Z' }),
    balance({ id: 'sooner', expires_at: '2026-10-08T18:30:00.000Z' }),
    balance({ id: 'used', state: 'used_up', drinks_remaining: 0, drinks_used: 7, created_at: '2026-09-20T00:00:00.000Z' }),
    balance({ id: 'expired', state: 'expired', created_at: '2026-09-28T00:00:00.000Z' }),
    balance({ id: 'refunded', state: 'refunded', status: 'refunded', created_at: '2026-09-01T00:00:00.000Z' }),
    balance({ id: 'someone-elses', user_id: 'u2' }),
  ];

  it('returns only the active passes by default, soonest-expiring first', async () => {
    const list = await loadPassSummaries(adminWith({ v_coffee_pass_balances: rows() }), 'u1');
    expect(list.map((p) => p.id)).toEqual(['sooner', 'later']);
  });

  it('with includeInactive: active first (by expiry), then the rest newest first', async () => {
    const list = await loadPassSummaries(adminWith({ v_coffee_pass_balances: rows() }), 'u1', { includeInactive: true });
    expect(list.map((p) => p.id)).toEqual(['sooner', 'later', 'expired', 'used', 'refunded']);
  });

  it("never returns another customer's pass", async () => {
    const list = await loadPassSummaries(adminWith({ v_coffee_pass_balances: rows() }), 'u1', { includeInactive: true });
    expect(list.map((p) => p.id)).not.toContain('someone-elses');
  });

  it('limit caps the whole list; inactiveLimit caps the non-active part', async () => {
    const admin = adminWith({ v_coffee_pass_balances: rows() });
    expect((await loadPassSummaries(admin, 'u1', { includeInactive: true, limit: 3 })).map((p) => p.id)).toEqual(['sooner', 'later', 'expired']);
    expect((await loadPassSummaries(admin, 'u1', { includeInactive: true, limit: 1 })).map((p) => p.id)).toEqual(['sooner']);
    expect((await loadPassSummaries(admin, 'u1', { includeInactive: true, inactiveLimit: 1 })).map((p) => p.id)).toEqual(['sooner', 'later', 'expired']);
    expect((await loadPassSummaries(admin, 'u1', { includeInactive: true, inactiveLimit: 0 })).map((p) => p.id)).toEqual(['sooner', 'later']);
  });

  it('maps a row to a PassSummary, coercing numbers and defaulting an unknown state to expired', async () => {
    const admin = adminWith({
      v_coffee_pass_balances: [
        balance({ id: 'p1', drinks_remaining: '5', max_per_day: '1', used_today: '1', price_inr: '750' }),
        balance({ id: 'weird', state: 'sideways', expires_at: '2026-10-09T00:00:00.000Z' }),
      ],
    });
    const list = await loadPassSummaries(admin, 'u1', { includeInactive: true });
    expect(list.find((p) => p.id === 'p1')).toEqual({
      id: 'p1',
      plan_id: 'plan-weekly',
      plan_name: 'Weekly Ritual',
      drinks_total: 7,
      drinks_used: 2,
      drinks_credited: 0,
      drinks_remaining: 5,
      drink_value_inr: 150,
      max_per_day: 1,
      used_today: 1,
      price_inr: 750,
      starts_at: '2026-10-05T04:30:00.000Z',
      expires_at: FUTURE,
      status: 'active',
      state: 'active',
      order_id: 'order-1',
    });
    expect(list.find((p) => p.id === 'weird')?.state).toBe('expired');
  });

  it('a read failure logs and returns [] (never throws)', async () => {
    const list = await loadPassSummaries(failingAdmin({ code: '42P01', message: 'relation does not exist' }), 'u1');
    expect(list).toEqual([]);
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(String(errorSpy.mock.calls[0][0])).toContain(PASS_MIGRATION_HINT);
  });
});

describe('loadUsablePasses', () => {
  it('returns active passes with cups left, soonest-expiring first, in the shape the allocator takes', async () => {
    const admin = adminWith({
      v_coffee_pass_balances: [
        balance({ id: 'later', expires_at: '2026-10-30T18:30:00.000Z', max_per_day: 1, used_today: 1 }),
        balance({ id: 'sooner', expires_at: '2026-10-08T18:30:00.000Z' }),
        balance({ id: 'used-up', state: 'used_up', drinks_remaining: 0 }),
        balance({ id: 'expired', state: 'expired' }),
        balance({ id: 'refunded', state: 'refunded', status: 'refunded' }),
        balance({ id: 'not-mine', user_id: 'u2' }),
      ],
    });
    expect(await loadUsablePasses(admin, 'u1', NOW)).toEqual([
      { id: 'sooner', drinks_remaining: 5, drink_value_inr: 150, expires_at: '2026-10-08T18:30:00.000Z', max_per_day: null, used_today: 0 },
      { id: 'later', drinks_remaining: 5, drink_value_inr: 150, expires_at: '2026-10-30T18:30:00.000Z', max_per_day: 1, used_today: 1 },
    ]);
  });

  it('drops a pass that expired since the view was read, and one with nothing left', async () => {
    const admin = adminWith({
      v_coffee_pass_balances: [
        balance({ id: 'just-gone', expires_at: '2026-10-05T05:59:59.000Z' }),
        balance({ id: 'exactly-now', expires_at: NOW.toISOString() }),
        balance({ id: 'empty', drinks_remaining: 0 }),
        balance({ id: 'fine' }),
      ],
    });
    expect((await loadUsablePasses(admin, 'u1', NOW)).map((p) => p.id)).toEqual(['fine']);
  });

  it('a read failure returns []', async () => {
    expect(await loadUsablePasses(failingAdmin({ message: 'boom' }), 'u1', NOW)).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('loadEligibleMenuIds', () => {
  const menu = () => [
    { id: 'latte', pass_eligible: true },
    { id: 'cappuccino', pass_eligible: true },
    { id: 'sandwich', pass_eligible: false },
  ];

  it('returns every eligible item', async () => {
    expect(await loadEligibleMenuIds(adminWith({ menu_items: menu() }))).toEqual(new Set(['latte', 'cappuccino']));
  });

  it('narrows to the ids asked about', async () => {
    const ids = await loadEligibleMenuIds(adminWith({ menu_items: menu() }), ['latte', 'sandwich', 'unknown']);
    expect(ids).toEqual(new Set(['latte']));
  });

  it('an empty list of ids is an empty set without asking the database', async () => {
    const admin = { from: vi.fn() } as unknown as SupabaseClient;
    expect(await loadEligibleMenuIds(admin, [])).toEqual(new Set());
    expect(admin.from).not.toHaveBeenCalled();
  });

  it('fails closed: a read failure means nothing is eligible', async () => {
    expect(await loadEligibleMenuIds(failingAdmin({ code: '42703', message: 'column pass_eligible does not exist' }))).toEqual(new Set());
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('loadActivePlans / loadPlanById', () => {
  const plans = () => [
    { id: 'monthly', name: 'Monthly Ritual', description: 'Pay for 6, get 7', drinks_total: 7, drinks_paid: 6, validity_days: 30, drink_value_inr: 150, price_inr: 900, max_per_day: null, gst_exempt: false, is_active: true, sort_order: 20 },
    { id: 'weekly', name: 'Weekly Ritual', description: '7 cups for 5', drinks_total: 7, drinks_paid: 5, validity_days: 7, drink_value_inr: 150, price_inr: 750, max_per_day: 1, gst_exempt: false, is_active: true, sort_order: 10 },
    { id: 'tie-b', name: 'B plan', description: '', drinks_total: 1, drinks_paid: 1, validity_days: 1, drink_value_inr: 1, price_inr: 1, max_per_day: null, gst_exempt: true, is_active: true, sort_order: 30 },
    { id: 'tie-a', name: 'A plan', description: '', drinks_total: 1, drinks_paid: 1, validity_days: 1, drink_value_inr: 1, price_inr: 1, max_per_day: null, gst_exempt: true, is_active: true, sort_order: 30 },
    { id: 'off', name: 'Retired', description: '', drinks_total: 1, drinks_paid: 1, validity_days: 1, drink_value_inr: 1, price_inr: 1, max_per_day: null, gst_exempt: false, is_active: false, sort_order: 0 },
  ];

  it('returns only active plans, by sort_order then name', async () => {
    const list = await loadActivePlans(adminWith({ coffee_pass_plans: plans() }));
    expect(list.map((p) => p.id)).toEqual(['weekly', 'monthly', 'tie-a', 'tie-b']);
    expect(list[0]).toEqual({
      id: 'weekly',
      name: 'Weekly Ritual',
      description: '7 cups for 5',
      drinks_total: 7,
      drinks_paid: 5,
      validity_days: 7,
      drink_value_inr: 150,
      price_inr: 750,
      max_per_day: 1,
      gst_exempt: false,
      is_active: true,
      sort_order: 10,
    });
  });

  it('nothing on sale is an empty list', async () => {
    expect(await loadActivePlans(adminWith({ coffee_pass_plans: [plans()[4]] }))).toEqual([]);
  });

  it('loads one plan by id, active or not', async () => {
    const admin = adminWith({ coffee_pass_plans: plans() });
    expect((await loadPlanById(admin, 'off'))?.is_active).toBe(false);
    expect((await loadPlanById(admin, 'weekly'))?.name).toBe('Weekly Ritual');
    expect(await loadPlanById(admin, 'nope')).toBeNull();
  });

  it('read failures return [] / null', async () => {
    expect(await loadActivePlans(failingAdmin({ message: 'boom' }))).toEqual([]);
    expect(await loadPlanById(failingAdmin({ message: 'boom' }), 'x')).toBeNull();
  });

  it('toCoffeePassPlan tolerates a sparse row', () => {
    expect(toCoffeePassPlan({ id: 'x' })).toMatchObject({ id: 'x', name: '', max_per_day: null, gst_exempt: false, is_active: false });
  });
});

describe('the SQL functions', () => {
  it('redeemPassDrinks sends the allocations as they are and passes every code through', async () => {
    const allocations = [{ pass_id: 'p1', order_item_id: 'i1', drinks: 2, covered_inr: 240 }];
    for (const code of ['ok', 'not_owner', 'inactive', 'expired', 'insufficient', 'daily_limit', 'bad_input'] as const) {
      const { admin, calls } = rpcAdmin({ data: code });
      expect(await redeemPassDrinks(admin, { userId: 'u1', orderId: 'o1', allocations })).toBe(code);
      expect(calls).toEqual([{ fn: 'coffee_pass_redeem', args: { p_user_id: 'u1', p_order_id: 'o1', p_allocations: allocations } }]);
    }
  });

  it('voidPassForRefund passes every code through', async () => {
    for (const code of ['ok', 'used', 'not_found', 'already'] as const) {
      const { admin, calls } = rpcAdmin({ data: code });
      expect(await voidPassForRefund(admin, 'o1')).toBe(code);
      expect(calls).toEqual([{ fn: 'coffee_pass_void_for_refund', args: { p_order_id: 'o1' } }]);
    }
  });

  it('restorePassAfterFailedRefund passes every code through', async () => {
    for (const code of ['ok', 'not_found', 'not_voided', 'order_refunded'] as const) {
      const { admin, calls } = rpcAdmin({ data: code });
      expect(await restorePassAfterFailedRefund(admin, 'o1')).toBe(code);
      expect(calls).toEqual([{ fn: 'coffee_pass_restore_after_failed_refund', args: { p_order_id: 'o1' } }]);
    }
  });

  it('adjustPass maps its arguments to the function and passes every code through', async () => {
    for (const code of ['ok', 'bad_input', 'not_found', 'inactive'] as const) {
      const { admin, calls } = rpcAdmin({ data: code });
      expect(await adjustPass(admin, { passId: 'p1', kind: 'extend', days: 3, reason: 'goodwill', actorId: 'mgr' })).toBe(code);
      expect(calls).toEqual([
        { fn: 'coffee_pass_adjust', args: { p_pass_id: 'p1', p_kind: 'extend', p_days: 3, p_drinks: null, p_reason: 'goodwill', p_actor: 'mgr' } },
      ]);
    }
    const { admin, calls } = rpcAdmin({ data: 'ok' });
    await adjustPass(admin, { passId: 'p1', kind: 'credit', drinks: 2, reason: 'spilt', actorId: null });
    expect(calls[0].args).toEqual({ p_pass_id: 'p1', p_kind: 'credit', p_days: null, p_drinks: 2, p_reason: 'spilt', p_actor: null });
  });

  it("an rpc error is 'error', logged, with the migration hint when the function is missing", async () => {
    const { admin } = rpcAdmin({ error: { code: 'PGRST202', message: 'Could not find the function public.coffee_pass_redeem' } });
    expect(await redeemPassDrinks(admin, { userId: 'u', orderId: 'o', allocations: [] })).toBe('error');
    expect(String(errorSpy.mock.calls[0][0])).toContain(PASS_MIGRATION_HINT);
  });

  it("an unexpected result is 'error' (never trusted as success)", async () => {
    for (const data of [null, true, 1, 'maybe', { ok: true }]) {
      const { admin } = rpcAdmin({ data });
      expect(await voidPassForRefund(admin, 'o1')).toBe('error');
    }
    // a code that belongs to a different function is not accepted either
    expect(await voidPassForRefund(rpcAdmin({ data: 'insufficient' }).admin, 'o1')).toBe('error');
  });

  it("a thrown exception is 'error', not a throw", async () => {
    const { admin } = rpcAdmin({ throws: true });
    await expect(redeemPassDrinks(admin, { userId: 'u', orderId: 'o', allocations: [] })).resolves.toBe('error');
    await expect(adjustPass(admin, { passId: 'p', kind: 'credit', drinks: 1, reason: 'r', actorId: null })).resolves.toBe('error');
    await expect(restorePassAfterFailedRefund(admin, 'o')).resolves.toBe('error');
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('loadPassRedemptionHistory', () => {
  const redemption = (over: Row) => ({
    pass_id: 'p1',
    order_id: 'o1',
    drinks: 1,
    covered_inr: 120,
    created_at: '2026-10-05T05:00:00.000Z',
    reversed_at: null,
    orders: { order_number: 1042 },
    ...over,
  });

  it('groups by pass, newest first, with the order number and the reversed flag', async () => {
    const admin = adminWith({
      coffee_pass_redemptions: [
        redemption({ order_id: 'o1', created_at: '2026-10-05T05:00:00.000Z', orders: { order_number: 1042 } }),
        redemption({ order_id: 'o2', created_at: '2026-10-06T05:00:00.000Z', drinks: 2, covered_inr: 240, reversed_at: '2026-10-06T06:00:00.000Z', orders: { order_number: 1050 } }),
        redemption({ pass_id: 'p2', order_id: 'o3', created_at: '2026-10-07T05:00:00.000Z', orders: { order_number: 1060 } }),
        redemption({ pass_id: 'not-asked', order_id: 'o9' }),
      ],
    });
    expect(await loadPassRedemptionHistory(admin, ['p1', 'p2', 'p3'])).toEqual({
      p1: [
        { order_id: 'o2', order_number: 1050, drinks: 2, covered_inr: 240, created_at: '2026-10-06T05:00:00.000Z', reversed: true },
        { order_id: 'o1', order_number: 1042, drinks: 1, covered_inr: 120, created_at: '2026-10-05T05:00:00.000Z', reversed: false },
      ],
      p2: [{ order_id: 'o3', order_number: 1060, drinks: 1, covered_inr: 120, created_at: '2026-10-07T05:00:00.000Z', reversed: false }],
      p3: [],
    });
  });

  it('reads the embedded order as an object, an array, or absent', async () => {
    const admin = adminWith({
      coffee_pass_redemptions: [
        redemption({ order_id: 'a', created_at: '2026-10-05T01:00:00.000Z', orders: [{ order_number: 7 }] }),
        redemption({ order_id: 'b', created_at: '2026-10-05T02:00:00.000Z', orders: null }),
        redemption({ order_id: 'c', created_at: '2026-10-05T03:00:00.000Z', orders: { order_number: 9 } }),
      ],
    });
    const list = (await loadPassRedemptionHistory(admin, ['p1'])).p1;
    expect(list.map((e) => [e.order_id, e.order_number])).toEqual([['c', 9], ['b', null], ['a', 7]]);
  });

  it('perPass caps each list', async () => {
    const admin = adminWith({
      coffee_pass_redemptions: [1, 2, 3, 4].map((i) => redemption({ order_id: `o${i}`, created_at: `2026-10-0${i}T00:00:00.000Z` })),
    });
    expect((await loadPassRedemptionHistory(admin, ['p1'], { perPass: 2 })).p1.map((e) => e.order_id)).toEqual(['o4', 'o3']);
  });

  it('no ids is {} without asking the database; a read failure leaves empty lists', async () => {
    const admin = { from: vi.fn() } as unknown as SupabaseClient;
    expect(await loadPassRedemptionHistory(admin, [])).toEqual({});
    expect(admin.from).not.toHaveBeenCalled();
    expect(await loadPassRedemptionHistory(failingAdmin({ message: 'boom' }), ['p1'])).toEqual({ p1: [] });
  });
});

describe('coffeePassDisabled', () => {
  it('is a 404 with the error shape while the flag is off', async () => {
    state.flag = false;
    const res = coffeePassDisabled();
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({ error: PASS_OFF_MESSAGE });
  });

  it('is null (go on) while the flag is on', () => {
    state.flag = true;
    expect(coffeePassDisabled()).toBeNull();
  });
});

describe('isMissingPassSchema', () => {
  it.each([
    [{ code: '42P01', message: 'relation "coffee_passes" does not exist' }, true],
    [{ code: '42703', message: 'column orders.order_kind does not exist' }, true],
    [{ code: 'PGRST204', message: "Could not find the 'order_kind' column of 'orders' in the schema cache" }, true],
    [{ code: 'PGRST205', message: "Could not find the table 'public.coffee_passes' in the schema cache" }, true],
    [{ code: 'PGRST202', message: 'Could not find the function public.coffee_pass_redeem' }, true],
    [{ code: '42883', message: 'function public.coffee_pass_redeem(uuid) does not exist' }, true],
    [{ message: 'relation "v_coffee_pass_balances" does not exist' }, true],
    [{ message: 'Could not find the table in the schema cache' }, true],
    [{ code: '23505', message: 'duplicate key value violates unique constraint' }, false],
    [{ code: '23514', message: 'violates check constraint' }, false],
    [{ code: 'PGRST301', message: 'JWT expired' }, false],
    [{ message: 'fetch failed' }, false],
    [null, false],
    [undefined, false],
  ])('%j is %s', (error, want) => {
    expect(isMissingPassSchema(error)).toBe(want);
  });
});
