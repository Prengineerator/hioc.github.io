import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settle → Edit order — POST /api/orders/[id]/amend with { op: 'edit' }.
//
// The cashier lowers a quantity or takes a line off an UNPAID bill from the
// Settle screen, with a reason. These tests cover what makes that acceptable:
// the `settle_edit_order` gate, the order-state preconditions, the line writes
// and the server-side recompute under the optimistic version guard, one audit
// row per change — and, the important one, that a LOST RACE (or a failed write)
// puts every line back exactly as it was instead of leaving the bill half-edited.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  permitted: boolean;
  order: Record<string, unknown> | null;
  guarded: Record<string, unknown> | null; // null = lost version race
  fullOrder: Record<string, unknown> | null; // the reload feeding toOrderResponse
  orderPatch?: Record<string, unknown>;
  orderEqs: [string, unknown][]; // the filters on the guarded orders update
  itemUpdates: { id: unknown; payload: Record<string, unknown> }[]; // every order_items write, rollbacks included
  amendmentRows?: Record<string, unknown>[];
  auditError: { message: string } | null;
  ordersUpdateError: { message: string } | null;
  failItemWhen?: (update: { id: unknown; payload: Record<string, unknown> }) => boolean;
} = {
  actor: null,
  permitted: true,
  order: null,
  guarded: null,
  fullOrder: null,
  orderEqs: [],
  itemUpdates: [],
  auditError: null,
  ordersUpdateError: null,
};

const broadcast = vi.fn((..._args: unknown[]) => Promise.resolve());

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: { isUpdate: boolean; payload: Record<string, unknown>; itemId: unknown } = {
        isUpdate: false,
        payload: {},
        itemId: undefined,
      };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          ctx.payload = p;
          if (table === 'orders') state.orderPatch = p; // guarded totals write
          return chain;
        },
        insert: (rows: Record<string, unknown>[]) => {
          if (table === 'order_amendments') {
            state.amendmentRows = rows;
            return Promise.resolve({ error: state.auditError });
          }
          return Promise.resolve({ error: null });
        },
        eq: (col: string, val: unknown) => {
          if (ctx.isUpdate && table === 'orders') state.orderEqs.push([col, val]);
          if (ctx.isUpdate && table === 'order_items' && col === 'id') ctx.itemId = val;
          return chain;
        },
        neq: (col: string, val: unknown) => {
          if (ctx.isUpdate && table === 'orders') state.orderEqs.push([`${col} !=`, val]);
          return chain;
        },
        // Order load (isUpdate=false) → order; guarded totals write → guarded.
        maybeSingle: () =>
          Promise.resolve(
            ctx.isUpdate
              ? { data: state.guarded, error: state.ordersUpdateError }
              : { data: state.order, error: null },
          ),
        // The reload (select → eq → single) that feeds toOrderResponse.
        single: () =>
          Promise.resolve({
            data: state.fullOrder,
            error: state.fullOrder ? null : { message: 'reload failed' },
          }),
        // Makes a bare `.update().eq()` (an order_items write or rollback) awaitable.
        then: (resolve: (v: unknown) => void) => {
          if (table !== 'order_items' || !ctx.isUpdate) return resolve({ data: null, error: null });
          const update = { id: ctx.itemId, payload: ctx.payload };
          state.itemUpdates.push(update);
          return resolve({ data: null, error: state.failItemWhen?.(update) ? { message: 'write failed' } : null });
        },
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  actorRoleFor: (role: string) => (role === 'owner' ? 'owner' : 'staff'),
}));
const hasPermissionCalls: unknown[][] = [];
vi.mock('@/lib/permissions', () => ({
  hasPermission: (...args: unknown[]) => {
    hasPermissionCalls.push(args);
    return Promise.resolve(state.permitted);
  },
}));
// Real recompute (money is under test) fed by a deterministic settings row.
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () =>
    Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 20 }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: (...args: unknown[]) => broadcast(...args) }));

const { POST } = await import('@/app/api/orders/[id]/amend/route');

const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const LATTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // 3 × ₹160
const BROWNIE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'; // 1 × ₹120
const MISSING = '99999999-9999-4999-8999-999999999999';

const params = { params: { id: ORDER_ID } };
function req(body: unknown) {
  return new Request(`http://t/api/orders/${ORDER_ID}/amend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const editBody = (changes: unknown, reason: unknown = 'Customer changed mind') => ({ op: 'edit', changes, reason });

// What an un-void / restore looks like when a write is put back.
const UNVOIDED = { voided: false, void_reason: '', voided_by: null, voided_at: null };

beforeEach(() => {
  state.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'session' };
  state.permitted = true;
  state.orderPatch = undefined;
  state.orderEqs = [];
  state.itemUpdates = [];
  state.amendmentRows = undefined;
  state.auditError = null;
  state.ordersUpdateError = null;
  state.failItemWhen = undefined;
  hasPermissionCalls.length = 0;
  broadcast.mockClear();
  state.order = {
    id: ORDER_ID,
    status: 'preparing',
    version: 3,
    order_type: 'dine_in',
    payment_status: 'unpaid',
    discount_inr: 0,
    // ₹600 on the bill: three lattes at ₹160 and a ₹120 brownie.
    order_items: [
      { id: LATTE, voided: false, quantity: 3, price_inr_snapshot: 160, line_total_inr: 480 },
      { id: BROWNIE, voided: false, quantity: 1, price_inr_snapshot: 120, line_total_inr: 120 },
    ],
  };
  state.guarded = { id: ORDER_ID };
  state.fullOrder = { id: ORDER_ID, status: 'preparing', order_items: [] };
});

describe('POST /api/orders/[id]/amend { op: edit } — gate + validation', () => {
  it('401s without a staff session or operator', async () => {
    state.actor = null;
    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);
    expect(res.status).toBe(401);
  });

  it('403s without the settle_edit_order permission, and writes nothing', async () => {
    state.permitted = false;

    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);

    expect(res.status).toBe(403);
    // Its own key — not void_line, not pos_order_entry — with the operator's role as the hint.
    expect(hasPermissionCalls).toEqual([[{ id: 'mgr-1' }, 'settle_edit_order', 'manager']]);
    expect(state.itemUpdates).toEqual([]);
    expect(state.orderPatch).toBeUndefined();
    expect(state.amendmentRows).toBeUndefined();
  });

  it('PIN-3: a device operator is asked about with their own role, and the edit is attributed to them', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };

    const res = await POST(req(editBody([{ item_id: BROWNIE, quantity: 0 }])), params);

    expect(res.status).toBe(200);
    expect(hasPermissionCalls[0]).toEqual([{ id: 'ravi' }, 'settle_edit_order', 'staff']);
    expect(state.itemUpdates[0].payload.voided_by).toBe('ravi');
    expect(state.amendmentRows?.[0].staff_id).toBe('ravi');
  });

  it.each([
    ['missing', { op: 'edit', changes: [{ item_id: LATTE, quantity: 2 }] }],
    ['blank', editBody([{ item_id: LATTE, quantity: 2 }], '   ')],
    ['not a string', editBody([{ item_id: LATTE, quantity: 2 }], 42)],
  ])('400s a reason that is %s', async (_name, body) => {
    const res = await POST(req(body), params);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('reason is required') });
    expect(state.itemUpdates).toEqual([]);
  });

  it('400s a reason over 200 characters but takes exactly 200', async () => {
    const tooLong = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }], 'x'.repeat(201))), params);
    expect(tooLong.status).toBe(400);
    expect(state.itemUpdates).toEqual([]);

    const longest = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }], 'x'.repeat(200))), params);
    expect(longest.status).toBe(200);
  });

  it('trims the reason before storing it', async () => {
    await POST(req(editBody([{ item_id: BROWNIE, quantity: 0 }], '  Wrong item  ')), params);
    expect(state.itemUpdates[0].payload.void_reason).toBe('Wrong item');
    expect((state.amendmentRows?.[0].payload as { reason: string }).reason).toBe('Wrong item');
  });

  it('404s a missing order', async () => {
    state.order = null;
    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);
    expect(res.status).toBe(404);
  });

  it('passes the plan’s errors through with their own status', async () => {
    const cases: [unknown, number][] = [
      [[], 400], // nothing asked
      [[{ item_id: 'nope', quantity: 1 }], 400], // not a uuid
      [[{ item_id: LATTE, quantity: 3 }], 400], // nothing changes
      [[{ item_id: MISSING, quantity: 0 }], 404], // not a line on this order
      [[{ item_id: LATTE, quantity: 4 }], 409], // more goes through Add items
      [[{ item_id: LATTE, quantity: 0 }, { item_id: BROWNIE, quantity: 0 }], 409], // would empty the order
    ];
    for (const [changes, status] of cases) {
      const res = await POST(req(editBody(changes)), params);
      expect(res.status).toBe(status);
    }
    expect(state.itemUpdates).toEqual([]);
    expect(state.orderPatch).toBeUndefined();
  });

  it('409s lowering a line a Ritual cup paid for, and a line already removed', async () => {
    state.order = {
      ...state.order,
      order_items: [
        { id: LATTE, voided: false, quantity: 3, price_inr_snapshot: 160, line_total_inr: 480, pass_drinks: 1, pass_covered_inr: 160 },
        { id: BROWNIE, voided: true, quantity: 1, price_inr_snapshot: 120, line_total_inr: 120 },
      ],
    };

    expect((await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params)).status).toBe(409);
    expect((await POST(req(editBody([{ item_id: BROWNIE, quantity: 0 }])), params)).status).toBe(409);
    expect(state.itemUpdates).toEqual([]);
  });

  it.each([
    ['a paid bill', { payment_status: 'paid' }, 'already paid'],
    ['a received (not yet accepted) order', { status: 'received' }, 'Accept this order'],
    ['a completed order', { status: 'completed' }, 'stock'],
    ['a cancelled order', { status: 'cancelled' }, 'no longer be changed'],
    ['a HIOC Ritual sale', { order_kind: 'coffee_pass' }, 'HIOC Ritual'],
  ])('409s %s, writing nothing', async (_name, patch, message) => {
    state.order = { ...state.order, ...patch };

    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining(message) });
    expect(state.itemUpdates).toEqual([]);
    expect(state.orderPatch).toBeUndefined();
    expect(state.amendmentRows).toBeUndefined();
  });
});

describe('POST /api/orders/[id]/amend { op: edit } — happy paths', () => {
  it('lowers a quantity, recomputes the whole bill under the version guard, and audits it', async () => {
    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }], 'Customer changed mind')), params);

    expect(res.status).toBe(200);
    // Only the quantity and the line total move: the unit price snapshot stays.
    expect(state.itemUpdates).toEqual([{ id: LATTE, payload: { quantity: 2, line_total_inr: 320 } }]);

    // 2 × ₹160 + ₹120 = ₹440, +5% GST = ₹462. Dine-in drops packaging (D5)
    // even though the store charges ₹20.
    expect(state.orderPatch).toEqual({
      subtotal_inr: 440,
      tax_inr: 22,
      packaging_inr: 0,
      discount_inr: 0,
      total_inr: 462,
      version: 4, // optimistic bump
    });
    // The write only lands if nobody changed the order since it was read, and
    // never on a bill settled in the meantime (settling doesn't bump version).
    expect(state.orderEqs).toEqual([
      ['id', ORDER_ID],
      ['version', 3],
      ['payment_status !=', 'paid'],
    ]);

    expect(state.amendmentRows).toEqual([
      {
        order_id: ORDER_ID,
        staff_id: 'mgr-1',
        kind: 'change_qty',
        payload: {
          order_item_id: LATTE,
          reason: 'Customer changed mind',
          from_quantity: 3,
          to_quantity: 2,
          from_line_total_inr: 480,
          to_line_total_inr: 320,
        },
      },
    ]);
  });

  it('removes a line by voiding it — never deleting — and recomputes from what is left', async () => {
    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 0 }], 'Wrong item')), params);

    expect(res.status).toBe(200);
    expect(state.itemUpdates).toHaveLength(1);
    expect(state.itemUpdates[0].id).toBe(LATTE);
    expect(state.itemUpdates[0].payload).toEqual({
      voided: true,
      void_reason: 'Wrong item',
      voided_by: 'mgr-1',
      voided_at: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(state.itemUpdates[0].payload.voided_at as string))).toBe(false);

    // Only the ₹120 brownie is left: +5% GST = ₹126.
    expect(state.orderPatch).toMatchObject({
      subtotal_inr: 120,
      tax_inr: 6,
      packaging_inr: 0,
      total_inr: 126,
      version: 4,
    });

    expect(state.amendmentRows).toEqual([
      {
        order_id: ORDER_ID,
        staff_id: 'mgr-1',
        kind: 'void_item',
        payload: { order_item_id: LATTE, reason: 'Wrong item', line_total_inr: 480, via: 'settle_edit' },
      },
    ]);
  });

  it('applies a reduction and a removal together, with one audit row each', async () => {
    const res = await POST(
      req(
        editBody([
          { item_id: LATTE, quantity: 1 },
          { item_id: BROWNIE, quantity: 0 },
        ]),
      ),
      params,
    );

    expect(res.status).toBe(200);
    expect(state.itemUpdates.map((u) => u.id)).toEqual([LATTE, BROWNIE]);
    // One latte at ₹160 is all that is left: +5% GST = ₹168.
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 160, tax_inr: 8, total_inr: 168 });
    expect(state.amendmentRows?.map((r) => [r.kind, (r.payload as { order_item_id: string }).order_item_id])).toEqual([
      ['change_qty', LATTE],
      ['void_item', BROWNIE],
    ]);
  });

  it('keeps takeaway packaging on the lowered bill', async () => {
    state.order = { ...state.order, order_type: 'takeaway' };

    await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);

    // ₹440 + ₹20 packaging, GST 5% of ₹460 = ₹23 → ₹483.
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 440, packaging_inr: 20, tax_inr: 23, total_inr: 483 });
  });

  it('clamps the stored discount to the lowered subtotal', async () => {
    state.order = { ...state.order, discount_inr: 500 };

    await POST(req(editBody([{ item_id: LATTE, quantity: 0 }])), params);

    // ₹120 left on the bill: a ₹500 discount can only take it to nothing.
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 120, discount_inr: 120, total_inr: 0 });
  });

  it('leaves the order’s status alone and tells the live board', async () => {
    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);

    expect(state.orderPatch).not.toHaveProperty('status');
    expect(broadcast).toHaveBeenCalledWith(ORDER_ID, 'preparing');
    // Nothing new to make, so a Ready order stays Ready.
    state.order = { ...state.order, status: 'ready' };
    await POST(req(editBody([{ item_id: LATTE, quantity: 1 }])), params);
    expect(state.orderPatch).not.toHaveProperty('status');
    expect(broadcast).toHaveBeenLastCalledWith(ORDER_ID, 'ready');
    expect(res.status).toBe(200);
  });

  it('returns the reloaded order', async () => {
    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);
    const data = (await res.json()) as { order: { id: string; items: unknown[] } };
    expect(data.order.id).toBe(ORDER_ID);
    expect(data.order.items).toEqual([]);
  });

  it('writes pass_discount_inr back only when removing a line a cup paid for changed it', async () => {
    // Plain order: the column is never sent.
    await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);
    expect(state.orderPatch).not.toHaveProperty('pass_discount_inr');

    // A Ritual cup paid for the latte; removing it takes its cover with it.
    state.order = {
      ...state.order,
      pass_discount_inr: 160,
      order_items: [
        { id: LATTE, voided: false, quantity: 1, price_inr_snapshot: 160, line_total_inr: 160, pass_drinks: 1, pass_covered_inr: 160 },
        { id: BROWNIE, voided: false, quantity: 1, price_inr_snapshot: 120, line_total_inr: 120 },
      ],
    };
    await POST(req(editBody([{ item_id: LATTE, quantity: 0 }])), params);
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 120, pass_discount_inr: 0, total_inr: 126 });
  });

  it('keeps a pass cup’s cover when lowering a different line', async () => {
    state.order = {
      ...state.order,
      pass_discount_inr: 160,
      order_items: [
        { id: LATTE, voided: false, quantity: 1, price_inr_snapshot: 160, line_total_inr: 160, pass_drinks: 1, pass_covered_inr: 160 },
        { id: BROWNIE, voided: false, quantity: 2, price_inr_snapshot: 120, line_total_inr: 240 },
      ],
    };

    await POST(req(editBody([{ item_id: BROWNIE, quantity: 1 }])), params);

    // ₹160 + ₹120 = ₹280, the cup still covers ₹160, GST on the ₹120 paid for.
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 280, tax_inr: 6, total_inr: 126 });
    expect(state.orderPatch).not.toHaveProperty('pass_discount_inr');
  });
});

describe('POST /api/orders/[id]/amend { op: edit } — never half-applied', () => {
  it('puts every line back on a lost version race, with no audit and no broadcast', async () => {
    state.guarded = null; // guarded update matched zero rows

    const res = await POST(
      req(
        editBody([
          { item_id: LATTE, quantity: 1 },
          { item_id: BROWNIE, quantity: 0 },
        ]),
      ),
      params,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('updated by someone else') });
    // The two writes, then each restored to what it was when the order was read.
    expect(state.itemUpdates).toEqual([
      { id: LATTE, payload: { quantity: 1, line_total_inr: 160 } },
      { id: BROWNIE, payload: expect.objectContaining({ voided: true }) },
      { id: LATTE, payload: { quantity: 3, line_total_inr: 480 } },
      { id: BROWNIE, payload: UNVOIDED },
    ]);
    expect(state.amendmentRows).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('puts the lines back and 500s when the totals write errors', async () => {
    state.ordersUpdateError = { message: 'boom' };

    const res = await POST(req(editBody([{ item_id: BROWNIE, quantity: 0 }])), params);

    expect(res.status).toBe(500);
    expect(state.itemUpdates[state.itemUpdates.length - 1]).toEqual({ id: BROWNIE, payload: UNVOIDED });
    expect(state.amendmentRows).toBeUndefined();
  });

  it('rolls back the writes that landed when a later line fails, and never touches the totals', async () => {
    state.failItemWhen = (u) => u.id === BROWNIE && u.payload.voided === true;

    const res = await POST(
      req(
        editBody([
          { item_id: LATTE, quantity: 1 },
          { item_id: BROWNIE, quantity: 0 },
        ]),
      ),
      params,
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'Failed to change the order' });
    // The latte landed, so it is restored; the brownie never did, so it is not "restored".
    expect(state.itemUpdates).toEqual([
      { id: LATTE, payload: { quantity: 1, line_total_inr: 160 } },
      { id: BROWNIE, payload: expect.objectContaining({ voided: true }) },
      { id: LATTE, payload: { quantity: 3, line_total_inr: 480 } },
    ]);
    expect(state.orderPatch).toBeUndefined();
    expect(state.amendmentRows).toBeUndefined();
  });

  it('does not fail the edit when only the audit write fails — it names the migration instead', async () => {
    state.auditError = { message: 'violates check constraint "order_amendments_kind_check"' };
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);

      expect(res.status).toBe(200);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('supabase/2026-10-settle-edit-order.sql'),
        state.auditError,
      );
      // The lines and totals stayed committed.
      expect(state.orderPatch).toMatchObject({ version: 4 });
      expect(state.itemUpdates).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });

  it('500s when the edited order cannot be reloaded', async () => {
    state.fullOrder = null;
    const res = await POST(req(editBody([{ item_id: LATTE, quantity: 2 }])), params);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'Changed the order but failed to reload it' });
  });
});
