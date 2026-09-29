import { beforeEach, describe, expect, it, vi } from 'vitest';

// BILL-1 — handler-level test for PATCH /api/orders/[id]/payment.
//
// The regression this locks down: the POS "Collect now" step settles through
// THIS route and never transitions status, so before BILL-1 a counter order got
// no bill at all until someone separately marked it completed. These tests
// assert the bill fires on a real settle, stays silent when the order isn't
// actually paid, and can never fail the payment write.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  existing: Record<string, unknown> | null;
  updated: Record<string, unknown> | null;
  full: Record<string, unknown> | null;
  orderPatch?: Record<string, unknown>;
  insertedParts: Record<string, unknown>[];
  deletedParts: boolean;
} = { actor: null, existing: null, updated: null, full: null, insertedParts: [], deletedParts: false };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders') state.orderPatch = p;
          return chain;
        },
        insert: (rows: Record<string, unknown>[]) => {
          if (table === 'order_payments') {
            state.insertedParts.push(...(Array.isArray(rows) ? rows : [rows]));
          }
          return Promise.resolve({ error: null });
        },
        delete: () => {
          if (table === 'order_payments') state.deletedParts = true;
          return chain;
        },
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            ctx.isUpdate ? { data: state.updated, error: null } : { data: state.existing, error: null },
          ),
        // The BILL-1 reload (with order_items) is the only .single() in the route.
        single: () => Promise.resolve({ data: state.full, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));

// Typed args (rather than a bare `vi.fn()`) so `mock.calls[0][0]` is a real
// tuple element — otherwise tsc infers a zero-length tuple and the assertion on
// the billed order below doesn't compile.
const { sendBillNotification } = vi.hoisted(() => ({
  sendBillNotification: vi.fn((_order: unknown, _opts?: { force?: boolean }) =>
    Promise.resolve({ email: false, whatsapp: false }),
  ),
}));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification }));

import { PATCH } from '@/app/api/orders/[id]/payment/route';

const ORDER_ID = '8f14e45f-ceea-4e0a-9f2b-3c1a7b2d5e60';

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/orders/x/payment', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const call = (body: Record<string, unknown>) => PATCH(request(body), { params: { id: ORDER_ID } });

beforeEach(() => {
  sendBillNotification.mockClear();
  state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
  state.insertedParts = [];
  state.deletedParts = false;
  state.orderPatch = undefined;
  state.existing = { payment_method: null, payment_status: 'unpaid', total_inr: 480, subtotal_inr: 450 };
  state.updated = { id: ORDER_ID, payment_method: 'cash', payment_status: 'paid' };
  state.full = {
    id: ORDER_ID,
    payment_method: 'cash',
    payment_status: 'paid',
    customer_phone: '+919876543210',
    order_items: [
      { id: 'i1', order_item_addons: [] },
      { id: 'i2', order_item_addons: [] },
    ],
  };
});

describe('PATCH /api/orders/[id]/payment — bill at settle (BILL-1)', () => {
  it('sends the bill when the order settles as paid', async () => {
    const res = await call({ payment_method: 'cash' });

    expect(res.status).toBe(200);
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('bills from the reloaded order WITH its lines, so the item count is right', async () => {
    await call({ payment_method: 'cash' });

    const billed = sendBillNotification.mock.calls[0][0] as { id: string; items: unknown[] };
    // toOrderResponse shapes order_items → items; a bare select('*') row would
    // carry none and the template's {{4}} would render 0.
    expect(billed.id).toBe(ORDER_ID);
    expect(billed.items).toHaveLength(2);
  });

  it('does NOT bill an order that is not actually paid', async () => {
    state.updated = { id: ORDER_ID, payment_method: 'upi', payment_status: 'payment_pending' };

    const res = await call({ payment_method: 'upi', payment_status: 'payment_pending' });

    expect(res.status).toBe(200);
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('still records the payment when the bill send throws', async () => {
    sendBillNotification.mockRejectedValueOnce(new Error('meta is down'));

    const res = await call({ payment_method: 'card' });

    // A delivery failure must never fail settlement — the printed bill is the
    // guaranteed copy.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ order: { payment_status: 'paid' } });
  });

  // Issue-2/3: a web guest can no longer switch to pay at counter (issue-1),
  // but a LOGGED-IN customer still can (POST /api/payments/[orderId]/status,
  // 'switch_to_counter') — that leaves the order 'received'/unpaid with no
  // bill sent (issue-3). Its bill must arrive here, at staff settlement, same
  // as any other counter order.
  it('bills a web order that was switched to pay at counter, once staff settle it', async () => {
    state.existing = { payment_method: null, payment_status: 'unpaid', total_inr: 250, subtotal_inr: 230 };
    state.updated = { id: ORDER_ID, channel: 'customer_web', payment_method: 'cash', payment_status: 'paid' };
    state.full = {
      id: ORDER_ID,
      channel: 'customer_web',
      payment_method: 'cash',
      payment_status: 'paid',
      customer_phone: '+919876543210',
      order_items: [{ id: 'i1', order_item_addons: [] }],
    };

    const res = await call({ payment_method: 'cash' });

    expect(res.status).toBe(200);
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('does not bill when the settle is refused (online payment guard)', async () => {
    state.existing = { payment_method: 'online', payment_status: 'paid' };

    const res = await call({ payment_method: 'cash' });

    expect(res.status).toBe(409);
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller without billing', async () => {
    state.actor = null;

    const res = await call({ payment_method: 'cash' });

    expect(res.status).toBe(401);
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('PIN-3: an enrolled-device operator settles and is attributed on order_payments', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };

    const res = await PATCH(
      request({ parts: [{ method: 'cash', amount_inr: 480, tendered_inr: 500 }] }),
      { params: { id: ORDER_ID } },
    );

    expect(res.status).toBe(200);
    expect(state.insertedParts[0]).toMatchObject({ created_by: 'ravi' });
  });
});

describe('PATCH /api/orders/[id]/payment — split settlement (POS4-1)', () => {
  it('persists each part and stamps the dominant method on the order', async () => {
    const res = await call({
      parts: [
        { method: 'cash', amount_inr: 200, tendered_inr: 500 },
        { method: 'upi', amount_inr: 280 },
      ],
    });

    expect(res.status).toBe(200);
    expect(state.insertedParts).toHaveLength(2);
    expect(state.insertedParts[0]).toMatchObject({
      method: 'cash',
      amount_inr: 200,
      tendered_inr: 500,
      created_by: 'staff-1',
    });
    // UPI is the larger part, so that's what legacy reads see.
    expect(state.orderPatch).toMatchObject({ payment_method: 'upi', payment_status: 'paid' });
  });

  it('returns the change due so the counter does no arithmetic', async () => {
    const res = await call({
      parts: [
        { method: 'cash', amount_inr: 200, tendered_inr: 500 },
        { method: 'upi', amount_inr: 280 },
      ],
    });

    await expect(res.json()).resolves.toMatchObject({ change_due_inr: 300 });
  });

  it('validates against the SERVER total, not anything the client sends', async () => {
    // Order total is ₹480; these parts sum to ₹400.
    const res = await call({
      parts: [
        { method: 'cash', amount_inr: 200 },
        { method: 'upi', amount_inr: 200 },
      ],
      total_inr: 400, // a client-supplied total must be ignored
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('₹480'),
    });
    expect(state.insertedParts).toHaveLength(0);
  });

  it('clears prior parts so a re-settle cannot double-count cash', async () => {
    await call({ parts: [{ method: 'cash', amount_inr: 480, tendered_inr: 500 }] });
    expect(state.deletedParts).toBe(true);
  });

  it('bills once on a split settle, same as a single method', async () => {
    await call({
      parts: [
        { method: 'cash', amount_inr: 200 },
        { method: 'card', amount_inr: 280 },
      ],
    });

    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('writes no parts on the legacy single-method path', async () => {
    await call({ payment_method: 'cash' });

    expect(state.insertedParts).toHaveLength(0);
    expect(state.orderPatch).toMatchObject({ payment_method: 'cash' });
  });
});

describe('PATCH /api/orders/[id]/payment — changing how a bill was paid', () => {
  it('re-records a paid bill as a different method (cash → UPI)', async () => {
    state.existing = { payment_method: 'cash', payment_status: 'paid', total_inr: 480, subtotal_inr: 450 };
    state.updated = { id: ORDER_ID, payment_method: 'upi', payment_status: 'paid' };

    const res = await call({ parts: [{ method: 'upi', amount_inr: 480 }] });

    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ payment_method: 'upi', payment_status: 'paid' });
    // The old parts are replaced, so the drawer stops expecting the cash.
    expect(state.deletedParts).toBe(true);
    expect(state.insertedParts).toEqual([expect.objectContaining({ method: 'upi', amount_inr: 480 })]);
  });

  it('clears old split parts on a single-method change too', async () => {
    state.existing = { payment_method: 'cash', payment_status: 'paid', total_inr: 480, subtotal_inr: 450 };

    const res = await call({ payment_method: 'upi' });

    expect(res.status).toBe(200);
    expect(state.deletedParts).toBe(true);
    expect(state.insertedParts).toEqual([]);
  });

  it('refuses once the bill has a refund', async () => {
    state.existing = { payment_method: 'cash', payment_status: 'partially_refunded', total_inr: 480, subtotal_inr: 450 };

    const res = await call({ parts: [{ method: 'upi', amount_inr: 480 }] });

    expect(res.status).toBe(409);
    expect(state.orderPatch).toBeUndefined();
  });
});

// Settle short (settlement discount) or with extra (tip), always with a reason.
describe('PATCH /api/orders/[id]/payment — settle adjustments', () => {
  beforeEach(() => {
    state.existing = { payment_method: null, payment_status: 'unpaid', total_inr: 500, subtotal_inr: 476 };
  });

  it('records a shortfall within ₹50 as a settlement discount, for counter staff', async () => {
    const res = await call({
      parts: [{ method: 'cash', amount_inr: 480, tendered_inr: 500 }],
      adjustment: { short_inr: 20, reason: 'Rounded off' },
    });

    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({
      payment_status: 'paid',
      settle_discount_inr: 20,
      tip_inr: 0,
      settle_reason: 'Rounded off',
    });
    // The parts are what entered the till, so the drawer excludes the shortfall.
    expect(state.insertedParts).toEqual([expect.objectContaining({ method: 'cash', amount_inr: 480 })]);
    await expect(res.json()).resolves.toMatchObject({
      order: { settle_discount_inr: 20, tip_inr: 0, settle_reason: 'Rounded off' },
      change_due_inr: 20,
    });
  });

  it('accepts exactly ₹50 short from counter staff', async () => {
    const res = await call({
      parts: [{ method: 'upi', amount_inr: 450 }],
      adjustment: { short_inr: 50, reason: 'Regular customer' },
    });
    expect(res.status).toBe(200);
  });

  it('refuses a shortfall over ₹50 from counter staff with a 403 and writes nothing', async () => {
    const res = await call({
      parts: [{ method: 'cash', amount_inr: 440 }],
      adjustment: { short_inr: 60, reason: 'Customer short' },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('manager') });
    expect(state.orderPatch).toBeUndefined();
    expect(state.insertedParts).toHaveLength(0);
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it.each(['manager', 'owner'])('lets a %s approve a shortfall over ₹50', async (role) => {
    state.actor = { user: { id: 'boss-1' }, role, via: 'session' };

    const res = await call({
      parts: [{ method: 'cash', amount_inr: 440 }],
      adjustment: { short_inr: 60, reason: 'Customer short' },
    });

    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ settle_discount_inr: 60, settle_reason: 'Customer short' });
  });

  it('records extra as a tip: parts include it, the order total is untouched', async () => {
    const res = await call({
      parts: [{ method: 'cash', amount_inr: 520, tendered_inr: 520 }],
      adjustment: { tip_inr: 20, reason: 'Keep the change' },
    });

    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ settle_discount_inr: 0, tip_inr: 20, settle_reason: 'Keep the change' });
    expect(state.orderPatch).not.toHaveProperty('total_inr');
    expect(state.insertedParts[0]).toMatchObject({ amount_inr: 520 });
  });

  it('needs a reason whenever there is a difference (400)', async () => {
    const cases: { parts: number; adjustment: Record<string, unknown> }[] = [
      { parts: 480, adjustment: { short_inr: 20 } },
      { parts: 480, adjustment: { short_inr: 20, reason: 'no' } },
      { parts: 520, adjustment: { tip_inr: 20, reason: '  ' } },
    ];
    for (const c of cases) {
      const res = await call({ parts: [{ method: 'cash', amount_inr: c.parts }], adjustment: c.adjustment });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/reason/i) });
    }
    expect(state.orderPatch).toBeUndefined();
  });

  it('rejects parts that do not equal total - short (400)', async () => {
    const res = await call({
      parts: [{ method: 'cash', amount_inr: 500 }],
      adjustment: { short_inr: 20, reason: 'Rounded off' },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('₹480') });
    expect(state.insertedParts).toHaveLength(0);
  });

  it('rejects parts that do not equal total + tip (400)', async () => {
    const res = await call({
      parts: [{ method: 'cash', amount_inr: 500 }],
      adjustment: { tip_inr: 20, reason: 'Keep the change' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects short and tip together, and a shortfall bigger than the bill (400)', async () => {
    const both = await call({
      parts: [{ method: 'cash', amount_inr: 500 }],
      adjustment: { short_inr: 10, tip_inr: 10, reason: 'Other' },
    });
    expect(both.status).toBe(400);

    state.actor = { user: { id: 'boss-1' }, role: 'owner', via: 'session' };
    const tooBig = await call({
      parts: [{ method: 'cash', amount_inr: 1 }],
      adjustment: { short_inr: 501, reason: 'Other' },
    });
    expect(tooBig.status).toBe(400);
  });

  it('refuses an adjustment without parts on the single-method path (400)', async () => {
    const res = await call({ payment_method: 'cash', adjustment: { short_inr: 20, reason: 'Rounded off' } });
    expect(res.status).toBe(400);
  });

  it('ignores a client-supplied total when validating the adjusted sum', async () => {
    const res = await call({
      parts: [{ method: 'cash', amount_inr: 380 }],
      adjustment: { short_inr: 20, reason: 'Rounded off' },
      total_inr: 400,
    });
    expect(res.status).toBe(400);
  });

  it('resets an earlier adjustment when the bill is re-settled without one', async () => {
    state.existing = {
      payment_method: 'cash',
      payment_status: 'paid',
      total_inr: 500,
      subtotal_inr: 476,
      settle_discount_inr: 20,
      tip_inr: 0,
      settle_reason: 'Rounded off',
    };

    const res = await call({ parts: [{ method: 'upi', amount_inr: 500 }] });

    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ settle_discount_inr: 0, tip_inr: 0, settle_reason: '' });
  });

  it('does not touch the adjustment columns on a plain settle (works before the migration)', async () => {
    await call({ parts: [{ method: 'cash', amount_inr: 500 }] });
    expect(state.orderPatch).not.toHaveProperty('settle_discount_inr');
  });

  it('still bills once for an adjusted settle', async () => {
    await call({
      parts: [{ method: 'cash', amount_inr: 480 }],
      adjustment: { short_inr: 20, reason: 'Rounded off' },
    });
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });
});
