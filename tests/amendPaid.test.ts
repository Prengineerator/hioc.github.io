import { beforeEach, describe, expect, it, vi } from 'vitest';

// Changing a dine-in order AFTER it is paid — POST /api/orders/[id]/amend on a
// paid bill (lib/orders/paidChange.ts, supabase/2026-11-paid-order-changes.sql).
//
// The bill is recomputed exactly as for an unpaid one, and the change in its
// total lands in balance_due_inr to be settled later. What these tests pin:
//  * void / add / edit all work on a paid dine-in bill paid at the counter, and
//    every other paid order is still refused with its old message;
//  * the FIRST change writes the original single tender as an order_payments
//    row (same method, amount and moment) before anything else can see the new
//    total — and a later change doesn't write it again;
//  * the balance accumulates across changes, under the version guard AND only
//    while the bill is still 'paid';
//  * a lost race or a failed write puts back the lines and the tender row.

vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));

type Op = {
  table: string;
  op: 'select' | 'update' | 'insert' | 'delete';
  payload?: unknown;
  filters: [string, unknown][];
};

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  order: Record<string, unknown> | null;
  guarded: Record<string, unknown> | null; // null = lost version race
  tenderRows: Record<string, unknown>[]; // the bill's existing order_payments rows
  failTenderInsert: boolean;
  menuRows: Record<string, unknown>[];
  ops: Op[];
} = { actor: null, order: null, guarded: null, tenderRows: [], failTenderInsert: false, menuRows: [], ops: [] };

let seq = 0;

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const op: Op = { table, op: 'select', filters: [] };
      state.ops.push(op);
      const result = (): { data: unknown; error: unknown } => {
        if (table === 'orders') {
          if (op.op === 'update') return { data: state.guarded, error: null };
          return { data: state.order, error: null };
        }
        if (table === 'order_payments' && op.op === 'select') return { data: state.tenderRows, error: null };
        if (table === 'order_payments' && op.op === 'insert') {
          return state.failTenderInsert
            ? { data: null, error: { message: 'insert failed' } }
            : { data: { id: 'tender-1' }, error: null };
        }
        if (table === 'order_items' && op.op === 'insert') return { data: { id: `new-item-${++seq}` }, error: null };
        if (table === 'menu_items') return { data: state.menuRows, error: null };
        if (table === 'menu_offers' || table === 'spend_offers') return { data: [], error: null };
        return { data: null, error: null };
      };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: unknown) => {
          op.op = 'update';
          op.payload = p;
          return chain;
        },
        insert: (p: unknown) => {
          op.op = 'insert';
          op.payload = p;
          return chain;
        },
        delete: () => {
          op.op = 'delete';
          return chain;
        },
        eq: (col: string, val: unknown) => {
          op.filters.push([col, val]);
          return chain;
        },
        in: (col: string, val: unknown) => {
          op.filters.push([`${col} in`, val]);
          return chain;
        },
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result()),
        // The final reload (orders) or an insert's `.select('id').single()`.
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

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  actorRoleFor: (role: string) => (role === 'owner' ? 'owner' : 'staff'),
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 20 }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));

const { POST } = await import('@/app/api/orders/[id]/amend/route');

const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const LINE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // 2 × ₹100
const LINE_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'; // 1 × ₹100
const LATTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LATTE_REG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PAID_AT = '2026-11-07T08:30:00.123456+00:00';

const params = { params: { id: ORDER_ID } };
function req(body: unknown) {
  return new Request(`http://t/api/orders/${ORDER_ID}/amend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const voidB = { item_id: LINE_B, reason: 'Customer changed mind' };
const addTwoLattes = { op: 'add', items: [{ menu_item_id: LATTE, variant_id: LATTE_REG, quantity: 2 }] };
const editAToOne = { op: 'edit', changes: [{ item_id: LINE_A, quantity: 1 }], reason: 'Customer changed mind' };

const opsOn = (table: string, kind?: Op['op']) =>
  state.ops.filter((o) => o.table === table && (kind === undefined || o.op === kind));
const ordersUpdate = () => opsOn('orders', 'update')[0];
const auditPayload = () =>
  (opsOn('order_amendments', 'insert')[0]?.payload as { payload: Record<string, unknown> } | undefined)?.payload ??
  ((opsOn('order_amendments', 'insert')[0]?.payload as { payload: Record<string, unknown> }[] | undefined)?.[0]
    ?.payload as Record<string, unknown>);

beforeEach(() => {
  seq = 0;
  state.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'session' };
  state.guarded = { id: ORDER_ID };
  state.tenderRows = [];
  state.failTenderInsert = false;
  state.ops = [];
  // A table that paid ₹315 in cash up front: ₹300 of food + 5% GST (dine-in, no packaging).
  state.order = {
    id: ORDER_ID,
    status: 'preparing',
    version: 7,
    order_type: 'dine_in',
    payment_status: 'paid',
    payment_method: 'cash',
    subtotal_inr: 300,
    tax_inr: 15,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: 315,
    paid_at: PAID_AT,
    created_at: '2026-11-07T08:20:00Z',
    balance_due_inr: 0,
    paid_amended_at: null,
    order_items: [
      { id: LINE_A, voided: false, quantity: 2, price_inr_snapshot: 100, line_total_inr: 200 },
      { id: LINE_B, voided: false, quantity: 1, price_inr_snapshot: 100, line_total_inr: 100 },
    ],
  };
  state.menuRows = [
    {
      id: LATTE,
      name: 'Latte',
      category: 'coffee',
      is_veg: true,
      is_available: true,
      unavailable_until: null,
      menu_item_variants: [{ id: LATTE_REG, label: 'Regular', price_inr: 150, sort_order: 0 }],
      menu_item_addon_groups: [],
    },
  ];
});

describe('a paid dine-in bill can be changed — the difference becomes a balance', () => {
  it('void: the line comes off and the ₹105 it was worth (with GST) is owed back', async () => {
    const res = await POST(req(voidB), params);

    expect(res.status).toBe(200);
    const patch = ordersUpdate().payload as Record<string, unknown>;
    expect(patch).toMatchObject({ subtotal_inr: 200, tax_inr: 10, total_inr: 210, balance_due_inr: -105, version: 8 });
    expect(typeof patch.paid_amended_at).toBe('string');
    // Only while nobody else changed it, and only while it is still paid.
    expect(ordersUpdate().filters).toEqual([
      ['id', ORDER_ID],
      ['version', 7],
      ['payment_status', 'paid'],
    ]);
    expect(auditPayload()).toMatchObject({
      order_item_id: LINE_B,
      paid_bill: true,
      from_total_inr: 315,
      to_total_inr: 210,
      balance_due_inr: -105,
    });
  });

  it('add: the new items are made and what they cost (with GST) is to collect', async () => {
    const res = await POST(req(addTwoLattes), params);

    expect(res.status).toBe(200);
    // ₹300 + 2 × ₹150 = ₹600, +5% = ₹630: ₹315 more than was paid.
    expect(ordersUpdate().payload).toMatchObject({ total_inr: 630, balance_due_inr: 315 });
    expect(ordersUpdate().filters).toContainEqual(['payment_status', 'paid']);
    expect(auditPayload()).toMatchObject({ paid_bill: true, from_total_inr: 315, to_total_inr: 630, balance_due_inr: 315 });
    await expect(res.json()).resolves.toMatchObject({ added_item_ids: ['new-item-1'] });
  });

  it('edit: a quantity down on a paid bill is owed back', async () => {
    const res = await POST(req(editAToOne), params);

    expect(res.status).toBe(200);
    expect(opsOn('order_items', 'update')[0].payload).toEqual({ quantity: 1, line_total_inr: 100 });
    expect(ordersUpdate().payload).toMatchObject({ total_inr: 210, balance_due_inr: -105 });
    expect(ordersUpdate().filters).toContainEqual(['payment_status', 'paid']);
    expect(auditPayload()).toMatchObject({ paid_bill: true, balance_due_inr: -105 });
  });

  it('adds to whatever was still outstanding, and stamps the first change only once', async () => {
    state.order = { ...state.order!, balance_due_inr: 40, paid_amended_at: '2026-11-07T09:00:00Z' };

    const res = await POST(req(voidB), params);

    expect(res.status).toBe(200);
    const patch = ordersUpdate().payload as Record<string, unknown>;
    expect(patch.balance_due_inr).toBe(40 - 105);
    expect(patch).not.toHaveProperty('paid_amended_at');
  });
});

describe('the original payment is written as a tender row on the first change', () => {
  it('records the single cash tender — its amount and the moment it was paid — before the totals move', async () => {
    await POST(req(voidB), params);

    const inserts = opsOn('order_payments', 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toEqual({
      order_id: ORDER_ID,
      method: 'cash',
      amount_inr: 315,
      tendered_inr: null,
      created_by: null,
      created_at: PAID_AT,
    });
    // Written before the guarded totals update, so the drawer never sees the new total without it.
    expect(state.ops.indexOf(inserts[0])).toBeLessThan(state.ops.indexOf(ordersUpdate()));
  });

  it('writes nothing when the bill already has tender rows (a split, an app, a round-off)', async () => {
    state.tenderRows = [{ id: 'part-1' }];
    await POST(req(voidB), params);
    expect(opsOn('order_payments', 'insert')).toHaveLength(0);
  });

  it("doesn't even look on a second change — the first one wrote it", async () => {
    state.order = { ...state.order!, paid_amended_at: '2026-11-07T09:00:00Z' };
    await POST(req(addTwoLattes), params);
    expect(opsOn('order_payments')).toHaveLength(0);
  });

  it('a bill with nothing taken (₹0, no method) has no tender to write', async () => {
    state.order = { ...state.order!, payment_method: null };
    await POST(req(addTwoLattes), params);
    expect(opsOn('order_payments')).toHaveLength(0);
  });
});

describe('a lost race or a failed write puts everything back', () => {
  it('void: un-voids the line and removes the tender row it wrote', async () => {
    state.guarded = null;

    const res = await POST(req(voidB), params);

    expect(res.status).toBe(409);
    const itemWrites = opsOn('order_items', 'update').map((o) => o.payload);
    expect(itemWrites.at(-1)).toEqual({ voided: false, void_reason: '', voided_by: null, voided_at: null });
    expect(opsOn('order_payments', 'delete')[0].filters).toEqual([['id', 'tender-1']]);
    expect(opsOn('order_amendments')).toHaveLength(0);
  });

  it('add: removes the added lines and the tender row', async () => {
    state.guarded = null;

    const res = await POST(req(addTwoLattes), params);

    expect(res.status).toBe(409);
    expect(opsOn('order_items', 'delete')[0].filters).toEqual([['id in', ['new-item-1']]]);
    expect(opsOn('order_payments', 'delete')[0].filters).toEqual([['id', 'tender-1']]);
  });

  it('edit: restores the line and removes the tender row', async () => {
    state.guarded = null;

    const res = await POST(req(editAToOne), params);

    expect(res.status).toBe(409);
    expect(opsOn('order_items', 'update').at(-1)?.payload).toEqual({ quantity: 2, line_total_inr: 200 });
    expect(opsOn('order_payments', 'delete')[0].filters).toEqual([['id', 'tender-1']]);
  });

  it('a tender row that will not write stops the change before the totals move', async () => {
    state.failTenderInsert = true;

    const res = await POST(req(addTwoLattes), params);

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('nothing was changed') });
    expect(opsOn('order_items', 'delete')).toHaveLength(1);
    expect(ordersUpdate()).toBeUndefined();
  });
});

describe('every other paid order is still refused, writing nothing', () => {
  it.each([
    ['void', voidB, 'correct it through a refund'],
    ['add', addTwoLattes, 'start a new order'],
    ['edit', editAToOne, 'already paid'],
  ])('%s on a paid takeaway keeps its old answer', async (_op, body, message) => {
    state.order = { ...state.order!, order_type: 'takeaway' };

    const res = await POST(req(body), params);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining(message) });
    expect(opsOn('order_items').filter((o) => o.op !== 'select')).toHaveLength(0);
    expect(ordersUpdate()).toBeUndefined();
  });

  it('refuses a dine-in bill paid online (the gateway owns that payment)', async () => {
    state.order = { ...state.order!, payment_method: 'online' };
    const res = await POST(req(addTwoLattes), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('paid online') });
    expect(opsOn('order_items', 'insert')).toHaveLength(0);
  });

  it('names the migration on a database without the balance column', async () => {
    const { balance_due_inr: _b, paid_amended_at: _p, ...unmigrated } = state.order!;
    void _b;
    void _p;
    state.order = unmigrated;

    const res = await POST(req(voidB), params);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('2026-11-paid-order-changes.sql'),
    });
    expect(opsOn('order_items', 'update')).toHaveLength(0);
  });

  it('an unpaid bill writes no balance, and its change only lands while it is still unpaid', async () => {
    state.order = { ...state.order!, payment_status: 'unpaid', payment_method: null };

    const res = await POST(req(voidB), params);

    expect(res.status).toBe(200);
    expect(ordersUpdate().payload).not.toHaveProperty('balance_due_inr');
    expect(ordersUpdate().payload).not.toHaveProperty('paid_amended_at');
    expect(ordersUpdate().filters).toContainEqual(['payment_status', 'unpaid']);
    expect(opsOn('order_payments')).toHaveLength(0);
    expect(auditPayload()).not.toHaveProperty('paid_bill');
  });
});

describe('a paid dine-in bill marked Completed once served (same day)', () => {
  const today = () => new Date().toISOString();

  it('void: works on a completed bill from today, which stays completed', async () => {
    state.order = { ...state.order!, status: 'completed', created_at: today() };

    const res = await POST(req(voidB), params);

    expect(res.status).toBe(200);
    expect(ordersUpdate().payload).toMatchObject({ total_inr: 210, balance_due_inr: -105 });
    expect(ordersUpdate().payload).not.toHaveProperty('status');
  });

  it('add: reopens a completed bill from today to Preparing, with a status event', async () => {
    state.order = { ...state.order!, status: 'completed', created_at: today() };

    const res = await POST(req(addTwoLattes), params);

    expect(res.status).toBe(200);
    expect(ordersUpdate().payload).toMatchObject({ status: 'preparing', balance_due_inr: 315 });
    expect(opsOn('order_status_events', 'insert')[0].payload).toMatchObject({
      from_status: 'completed',
      to_status: 'preparing',
      reason: 'Items added',
    });
  });

  it('edit: works on a completed bill from today', async () => {
    state.order = { ...state.order!, status: 'completed', created_at: today() };
    const res = await POST(req(editAToOne), params);
    expect(res.status).toBe(200);
    expect(ordersUpdate().payload).toMatchObject({ balance_due_inr: -105 });
  });

  it.each([
    ['void', voidB],
    ['add', addTwoLattes],
    ['edit', editAToOne],
  ])('%s: refuses a completed bill from an earlier day, writing nothing', async (_op, body) => {
    state.order = { ...state.order!, status: 'completed', created_at: '2026-01-01T06:00:00Z' };

    const res = await POST(req(body), params);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('on the day it was placed') });
    expect(state.ops.filter((o) => o.op !== 'select')).toHaveLength(0);
  });

  it('a completed takeaway stays locked with the old answer', async () => {
    state.order = { ...state.order!, status: 'completed', order_type: 'takeaway', created_at: today() };
    const res = await POST(req(voidB), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('not open') });
  });
});

describe('removing the only item on a paid bill', () => {
  it('void says to add the replacement first', async () => {
    state.order = {
      ...state.order!,
      order_items: [{ id: LINE_B, voided: false, quantity: 1, price_inr_snapshot: 100, line_total_inr: 100 }],
    };
    const res = await POST(req(voidB), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('add the new item first') });
  });

  it('edit says the same', async () => {
    state.order = {
      ...state.order!,
      order_items: [{ id: LINE_B, voided: false, quantity: 1, price_inr_snapshot: 100, line_total_inr: 100 }],
    };
    const res = await POST(req({ op: 'edit', changes: [{ item_id: LINE_B, quantity: 0 }], reason: 'Swap' }), params);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('add the new item first') });
  });
});
