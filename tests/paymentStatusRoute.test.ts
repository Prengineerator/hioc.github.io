import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for POST /api/payments/[orderId]/status (PAY-2).
//
// Issue-1 regression lock: a web GUEST (no session) or a table-QR order must
// pay online — there is no pay-at-counter fallback for either (see
// POST /api/orders' isWebGuest / QR-1 comments) — so 'switch_to_counter' must
// be refused for them, and left available for a logged-in web customer and a
// staff_pos order.

const UUID = '5f9d3b2a-1e4c-4a7b-9c3d-2b1a4e6f7c8d';

const state: {
  order: Record<string, unknown> | null;
  updatedPatch?: Record<string, unknown>;
  eventRow?: Record<string, unknown>;
} = { order: null };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (patch: Record<string, unknown>) => {
          ctx.isUpdate = true;
          state.updatedPatch = patch;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'order_status_events') state.eventRow = row;
          return Promise.resolve({ error: null });
        },
        maybeSingle: () => {
          if (table === 'payments') return Promise.resolve({ data: null, error: null });
          if (ctx.isUpdate && table === 'orders' && state.order) {
            const updated = { ...state.order, ...state.updatedPatch };
            return Promise.resolve({ data: updated, error: null });
          }
          return Promise.resolve({ data: state.order, error: null });
        },
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
vi.mock('@/lib/payments/gateway', () => ({
  createPaymentIntent: () => Promise.resolve(null),
  fetchOrderPaymentAttempts: () => Promise.resolve([]),
}));
vi.mock('@/lib/payments/reconcile', () => ({
  captureGatewayPayment: () => Promise.resolve({ ok: true, order: null }),
}));

const { POST } = await import('@/app/api/payments/[orderId]/status/route');

function req(body: unknown) {
  return new Request(`http://t/api/payments/${UUID}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const call = (body: unknown) => POST(req(body), { params: { orderId: UUID } });

beforeEach(() => {
  state.order = null;
  state.updatedPatch = undefined;
  state.eventRow = undefined;
});

describe('POST /api/payments/[orderId]/status — switch_to_counter guest gate (issue-1)', () => {
  it('rejects a web GUEST order (customer_web, no user_id)', async () => {
    state.order = {
      id: UUID, status: 'placed', version: 0, payment_status: 'payment_pending',
      total_inr: 250, channel: 'customer_web', user_id: null,
    };
    const res = await call({ action: 'switch_to_counter' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/must be paid online/i);
    expect(state.updatedPatch).toBeUndefined();
    expect(state.eventRow).toBeUndefined();
  });

  it('rejects a table-QR order (always pays online first)', async () => {
    state.order = {
      id: UUID, status: 'placed', version: 0, payment_status: 'payment_pending',
      total_inr: 250, channel: 'table_qr', user_id: null,
    };
    const res = await call({ action: 'switch_to_counter' });
    expect(res.status).toBe(403);
    expect(state.updatedPatch).toBeUndefined();
  });

  it('allows a logged-in web customer to switch to pay at counter', async () => {
    state.order = {
      id: UUID, status: 'placed', version: 0, payment_status: 'payment_pending',
      total_inr: 250, channel: 'customer_web', user_id: 'cust-1',
    };
    const res = await call({ action: 'switch_to_counter' });
    expect(res.status).toBe(200);
    expect(state.updatedPatch).toMatchObject({ status: 'received', payment_status: 'unpaid' });
    expect(state.eventRow?.to_status).toBe('received');
  });

  it('a table-QR order with a logged-in user_id is still refused (channel always pays online)', async () => {
    state.order = {
      id: UUID, status: 'placed', version: 0, payment_status: 'payment_pending',
      total_inr: 250, channel: 'table_qr', user_id: 'cust-1',
    };
    const res = await call({ action: 'switch_to_counter' });
    expect(res.status).toBe(403);
  });

  it('does not reject retry for a guest order — only switch_to_counter is gated', async () => {
    state.order = {
      id: UUID, status: 'placed', version: 0, payment_status: 'payment_pending',
      total_inr: 250, channel: 'customer_web', user_id: null,
    };
    const res = await call({ action: 'retry' });
    // createPaymentIntent mocked to null → gateway-unavailable 502, not a
    // guest-rule rejection (403) — proves the guard is scoped to switch only.
    expect(res.status).toBe(502);
  });
});
