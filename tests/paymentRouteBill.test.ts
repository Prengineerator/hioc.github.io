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
} = { user: null, existing: null, updated: null, full: null };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: () => {
          ctx.isUpdate = true;
          return chain;
        },
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            ctx.isUpdate ? { data: state.updated, error: null } : { data: state.existing, error: null },
          ),
        // The BILL-1 reload (with order_items) is the only .single() in the route.
        single: () => Promise.resolve({ data: state.full, error: null }),
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
  state.existing = { payment_method: null, payment_status: 'unpaid' };
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
