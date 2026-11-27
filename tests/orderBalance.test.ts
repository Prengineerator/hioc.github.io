import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/orders/[id]/balance — settling the difference left on a PAID
// dine-in bill that was changed after it was paid (lib/orders/paidChange.ts).
//
// What these pin: a collect ADDS tenders for exactly the balance (never
// replaces the ones already taken) and honours the settle rules (split, cash
// change, round-off, the ₹50 manager rule); a give-back is a counter refund on
// a tender the bill was really paid with, needs the refund permission, and
// leaves the bill 'paid'; a write-off is a settlement discount with a reason;
// every action zeroes the balance under the version + paid + balance guard and
// takes its money record back out when it loses the race.

type Op = {
  table: string;
  op: 'select' | 'update' | 'insert' | 'delete';
  payload?: unknown;
  filters: [string, unknown][];
};

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  refundAllowed: boolean;
  order: Record<string, unknown> | null;
  guarded: Record<string, unknown> | null;
  parts: Record<string, unknown>[];
  priorRefunds: Record<string, unknown>[];
  ops: Op[];
} = { actor: null, refundAllowed: true, order: null, guarded: null, parts: [], priorRefunds: [], ops: [] };

const broadcast = vi.fn((..._args: unknown[]) => Promise.resolve());

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const op: Op = { table, op: 'select', filters: [] };
      state.ops.push(op);
      const result = (): { data: unknown; error: unknown } => {
        if (table === 'orders') return { data: op.op === 'update' ? state.guarded : state.order, error: null };
        if (table === 'order_payments' && op.op === 'select') return { data: state.parts, error: null };
        if (table === 'order_payments' && op.op === 'insert') {
          return { data: (op.payload as unknown[]).map((_, i) => ({ id: `part-${i + 1}` })), error: null };
        }
        if (table === 'refunds' && op.op === 'select') return { data: state.priorRefunds, error: null };
        if (table === 'refunds' && op.op === 'insert') return { data: { id: 'refund-1' }, error: null };
        return { data: null, error: null };
      };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: unknown) => ((op.op = 'update'), (op.payload = p), chain),
        insert: (p: unknown) => ((op.op = 'insert'), (op.payload = p), chain),
        delete: () => ((op.op = 'delete'), chain),
        eq: (c: string, v: unknown) => (op.filters.push([c, v]), chain),
        neq: (c: string, v: unknown) => (op.filters.push([`${c} !=`, v]), chain),
        in: (c: string, v: unknown) => (op.filters.push([`${c} in`, v]), chain),
        maybeSingle: () => Promise.resolve(result()),
        single: () =>
          Promise.resolve(
            table === 'orders' ? { data: { ...(state.order ?? {}), order_items: [] }, error: null } : result(),
          ),
        then: (resolve: (v: unknown) => void) => resolve(result()),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
const permissionCalls: unknown[][] = [];
vi.mock('@/lib/permissions', () => ({
  hasPermission: (...args: unknown[]) => {
    permissionCalls.push(args);
    return Promise.resolve(state.refundAllowed);
  },
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: (...a: unknown[]) => broadcast(...a) }));

const { POST } = await import('@/app/api/orders/[id]/balance/route');

const ORDER_ID = '55555555-5555-4555-8555-555555555555';
const params = { params: { id: ORDER_ID } };
const req = (body: unknown) =>
  new Request(`http://t/api/orders/${ORDER_ID}/balance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const opsOn = (table: string, kind?: Op['op']) =>
  state.ops.filter((o) => o.table === table && (kind === undefined || o.op === kind));
const ordersUpdate = () => opsOn('orders', 'update')[0];
const auditRow = () => opsOn('order_amendments', 'insert')[0]?.payload as Record<string, unknown> | undefined;

/** A ₹500 cash bill with a ₹150 coffee added after it was paid: ₹630 now, ₹130 to collect. */
const owing = (extra: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  status: 'preparing',
  version: 9,
  order_type: 'dine_in',
  payment_status: 'paid',
  payment_method: 'cash',
  subtotal_inr: 600,
  total_inr: 630,
  balance_due_inr: 130,
  paid_amended_at: '2026-11-07T09:00:00Z',
  settle_discount_inr: 0,
  tip_inr: 0,
  settle_reason: '',
  ...extra,
});

beforeEach(() => {
  state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
  state.refundAllowed = true;
  state.order = owing();
  state.guarded = { id: ORDER_ID };
  state.parts = [{ method: 'cash', amount_inr: 500 }];
  state.priorRefunds = [];
  state.ops = [];
  permissionCalls.length = 0;
  broadcast.mockClear();
});

describe('preconditions', () => {
  it('401s without a counter actor', async () => {
    state.actor = null;
    expect((await POST(req({ action: 'collect' }), params)).status).toBe(401);
  });

  it.each([
    ['an unpaid bill', { payment_status: 'unpaid' }, 'Only a paid bill'],
    ['a cancelled order', { status: 'cancelled' }, 'no longer live'],
    ['a bill settled up', { balance_due_inr: 0 }, 'Nothing to settle'],
  ])('409s %s, writing nothing', async (_n, patch, message) => {
    state.order = owing(patch);
    const res = await POST(req({ action: 'collect', parts: [{ method: 'cash', amount_inr: 130 }] }), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining(message) });
    expect(state.ops.filter((o) => o.op !== 'select')).toHaveLength(0);
  });

  it('names the migration on a database without the balance column', async () => {
    const { balance_due_inr: _b, ...unmigrated } = owing();
    void _b;
    state.order = unmigrated;
    const res = await POST(req({ action: 'collect' }), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('2026-11-paid-order-changes.sql') });
  });

  it('400s an action that goes the wrong way for the balance', async () => {
    expect((await POST(req({ action: 'give_back', amount_inr: 130 }), params)).status).toBe(400);
    state.order = owing({ balance_due_inr: -40 });
    expect((await POST(req({ action: 'collect', parts: [{ method: 'cash', amount_inr: 40 }] }), params)).status).toBe(400);
    expect((await POST(req({ action: 'nope' }), params)).status).toBe(400);
  });
});

describe('collect — the customer pays what they owe', () => {
  it('adds the new tenders beside the original and zeroes the balance under the guard', async () => {
    const res = await POST(
      req({ action: 'collect', parts: [{ method: 'cash', amount_inr: 130, tendered_inr: 200 }] }),
      params,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ change_due_inr: 70 });
    // Added, never replacing: no delete of the bill's existing tenders.
    expect(opsOn('order_payments', 'delete')).toHaveLength(0);
    expect(opsOn('order_payments', 'insert')[0].payload).toEqual([
      { order_id: ORDER_ID, method: 'cash', amount_inr: 130, tendered_inr: 200, created_by: 'staff-1' },
    ]);
    expect(ordersUpdate().payload).toEqual({ balance_due_inr: 0, version: 10 });
    expect(ordersUpdate().filters).toEqual([
      ['id', ORDER_ID],
      ['version', 9],
      ['payment_status', 'paid'],
      ['balance_due_inr', 130],
    ]);
    // The tenders land before the balance is zeroed.
    expect(state.ops.indexOf(opsOn('order_payments', 'insert')[0])).toBeLessThan(state.ops.indexOf(ordersUpdate()));
    expect(auditRow()).toMatchObject({
      order_id: ORDER_ID,
      staff_id: 'staff-1',
      kind: 'settle_balance',
      payload: { action: 'collect', amount_inr: 130, parts: [{ method: 'cash', amount_inr: 130 }] },
    });
    expect(broadcast).toHaveBeenCalledWith(ORDER_ID, 'preparing');
  });

  it('takes a split across tenders', async () => {
    const res = await POST(
      req({ action: 'collect', parts: [{ method: 'cash', amount_inr: 30 }, { method: 'upi', amount_inr: 100 }] }),
      params,
    );
    expect(res.status).toBe(200);
    expect((opsOn('order_payments', 'insert')[0].payload as unknown[]).length).toBe(2);
  });

  it('refuses tenders that do not add up to the balance, writing nothing', async () => {
    const res = await POST(req({ action: 'collect', parts: [{ method: 'cash', amount_inr: 630 }] }), params);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('₹130') });
    expect(opsOn('order_payments', 'insert')).toHaveLength(0);
    expect(ordersUpdate()).toBeUndefined();
  });

  it('a round-off adds to the bill’s settlement discount and keeps both reasons', async () => {
    state.order = owing({ settle_discount_inr: 2, settle_reason: 'No change' });
    const res = await POST(
      req({
        action: 'collect',
        parts: [{ method: 'cash', amount_inr: 127 }],
        adjustment: { short_inr: 3, reason: 'Rounded off' },
      }),
      params,
    );
    expect(res.status).toBe(200);
    expect(ordersUpdate().payload).toEqual({
      balance_due_inr: 0,
      settle_discount_inr: 5,
      tip_inr: 0,
      settle_reason: 'No change; Balance: Rounded off',
      version: 10,
    });
  });

  it('holds a shortfall above ₹50 for a manager', async () => {
    state.order = owing({ balance_due_inr: 300 });
    const res = await POST(
      req({ action: 'collect', parts: [{ method: 'cash', amount_inr: 200 }], adjustment: { short_inr: 100, reason: 'Left early' } }),
      params,
    );
    expect(res.status).toBe(403);
    expect(opsOn('order_payments', 'insert')).toHaveLength(0);
  });

  it('takes the tenders back out when it loses the race', async () => {
    state.guarded = null;
    const res = await POST(req({ action: 'collect', parts: [{ method: 'upi', amount_inr: 130 }] }), params);
    expect(res.status).toBe(409);
    expect(opsOn('order_payments', 'delete')[0].filters).toEqual([['id in', ['part-1']]]);
    expect(auditRow()).toBeUndefined();
  });
});

describe('give back — the café returns what it owes', () => {
  beforeEach(() => {
    // The brownie came off the ₹500 bill: ₹395 now, ₹105 to give back.
    state.order = owing({ total_inr: 395, subtotal_inr: 376, balance_due_inr: -105 });
    state.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'session' };
  });

  it('records a counter refund on the tender, leaves the bill paid, and zeroes the balance', async () => {
    const res = await POST(req({ action: 'give_back', amount_inr: 105, reason: 'Brownie off' }), params);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ given_back: { method: 'cash', amount_inr: 105 } });
    expect(permissionCalls[0]).toEqual([{ id: 'mgr-1' }, 'refund', 'manager']);
    expect(opsOn('refunds', 'insert')[0].payload).toMatchObject({
      payment_id: null,
      order_id: ORDER_ID,
      amount_inr: 105,
      method: 'cash',
      reason: 'Bill lowered after payment — Brownie off',
      status: 'processed',
      created_by: 'mgr-1',
    });
    // The bill comes down; it is not a refund OF the bill — payment_status is untouched.
    expect(ordersUpdate().payload).toEqual({ balance_due_inr: 0, version: 10 });
    expect(ordersUpdate().filters).toContainEqual(['balance_due_inr', -105]);
    expect(auditRow()).toMatchObject({ kind: 'settle_balance', payload: { action: 'give_back', amount_inr: 105, method: 'cash' } });
  });

  it('needs the refund permission', async () => {
    state.refundAllowed = false;
    const res = await POST(req({ action: 'give_back', amount_inr: 105 }), params);
    expect(res.status).toBe(403);
    expect(opsOn('refunds', 'insert')).toHaveLength(0);
  });

  it('refuses an amount that is no longer the balance', async () => {
    const res = await POST(req({ action: 'give_back', amount_inr: 100 }), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('₹105 to give back') });
    expect(opsOn('refunds', 'insert')).toHaveLength(0);
  });

  it('asks which tender on a split, and never more than that tender took', async () => {
    state.parts = [
      { method: 'cash', amount_inr: 60 },
      { method: 'upi', amount_inr: 440 },
    ];
    expect((await POST(req({ action: 'give_back', amount_inr: 105 }), params)).status).toBe(400);
    const tooMuchCash = await POST(req({ action: 'give_back', amount_inr: 105, method: 'cash' }), params);
    expect(tooMuchCash.status).toBe(400);
    await expect(tooMuchCash.json()).resolves.toMatchObject({ error: expect.stringContaining('₹60') });
    expect((await POST(req({ action: 'give_back', amount_inr: 105, method: 'upi' }), params)).status).toBe(200);
  });

  it('takes the refund back out when it loses the race', async () => {
    state.guarded = null;
    const res = await POST(req({ action: 'give_back', amount_inr: 105 }), params);
    expect(res.status).toBe(409);
    expect(opsOn('refunds', 'delete')[0].filters).toEqual([['id', 'refund-1']]);
    expect(auditRow()).toBeUndefined();
  });
});

describe('write off — the café lets an owed balance go', () => {
  it('turns it into a settlement discount with the reason', async () => {
    state.order = owing({ balance_due_inr: 40 });
    const res = await POST(req({ action: 'write_off', amount_inr: 40, reason: 'Customer left' }), params);

    expect(res.status).toBe(200);
    expect(ordersUpdate().payload).toEqual({
      balance_due_inr: 0,
      settle_discount_inr: 40,
      settle_reason: 'Balance: Customer left',
      version: 10,
    });
    expect(auditRow()).toMatchObject({ payload: { action: 'write_off', amount_inr: 40, reason: 'Customer left' } });
  });

  it('needs a reason and the balance the staffer saw', async () => {
    state.order = owing({ balance_due_inr: 40 });
    expect((await POST(req({ action: 'write_off', amount_inr: 40, reason: '' }), params)).status).toBe(400);
    expect((await POST(req({ action: 'write_off', amount_inr: 30, reason: 'Customer left' }), params)).status).toBe(409);
    expect(ordersUpdate()).toBeUndefined();
  });

  it('holds more than ₹50 for a manager', async () => {
    const res = await POST(req({ action: 'write_off', amount_inr: 130, reason: 'Customer left' }), params);
    expect(res.status).toBe(403);
    state.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'session' };
    expect((await POST(req({ action: 'write_off', amount_inr: 130, reason: 'Customer left' }), params)).status).toBe(200);
  });
});
