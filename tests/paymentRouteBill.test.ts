import { beforeEach, describe, expect, it, vi } from 'vitest';

// BILL-1 — handler-level test for PATCH /api/orders/[id]/payment.
//
// The regression this locks down: the POS "Collect now" step settles through
// THIS route and never transitions status, so before BILL-1 a counter order got
// no bill at all until someone separately marked it completed. These tests
// assert the bill fires on a real settle, stays silent when the order isn't
// actually paid, and can never fail the payment write.

const state: {
  user: { id: string } | null;
  existing: Record<string, unknown> | null;
  updated: Record<string, unknown> | null;
  full: Record<string, unknown> | null;
  orderPatch?: Record<string, unknown>;
  insertedParts: Record<string, unknown>[];
  deletedParts: boolean;
} = { user: null, existing: null, updated: null, full: null, insertedParts: [], deletedParts: false };

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

vi.mock('@/lib/api/auth', () => ({ getStaffUser: () => Promise.resolve(state.user) }));

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
  state.user = { id: 'staff-1' };
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

  it('does not bill when the settle is refused (online payment guard)', async () => {
    state.existing = { payment_method: 'online', payment_status: 'paid' };

    const res = await call({ payment_method: 'cash' });

    expect(res.status).toBe(409);
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller without billing', async () => {
    state.user = null;

    const res = await call({ payment_method: 'cash' });

    expect(res.status).toBe(401);
    expect(sendBillNotification).not.toHaveBeenCalled();
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
