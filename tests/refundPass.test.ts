import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/orders/[id]/refund and the SALE of a HIOC Ritual pass
// (docs/COFFEE-PASS-SPEC.md CP-D15). Before any money moves the route voids the
// pass: 'used' refuses the refund, 'ok' means this call voided it (so a failed
// money step must give it back), 'already' and 'not_found' carry on, and 'error'
// refuses (503) rather than refund a pass that may have been drunk. Both the
// gateway path and the counter path.

const state: {
  order: Record<string, unknown> | null;
  payment: Record<string, unknown> | null; // a gateway payment row makes it the gateway path
  voidCode: string;
  restoreCode: string;
  gateway: { id: string } | null;
  refundInsertError: { code?: string; message: string } | null;
  events: string[];
  refundInserts: Record<string, unknown>[];
  orderSelect: string[];
} = {
  order: null,
  payment: null,
  voidCode: 'ok',
  restoreCode: 'ok',
  gateway: { id: 'rfnd_1' },
  refundInsertError: null,
  events: [],
  refundInserts: [],
  orderSelect: [],
};

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve({ user: { id: 'mgr-1' }, role: 'manager', via: 'session' }),
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/orders/idempotency', () => ({ readIdempotencyKey: () => null }));
vi.mock('@/lib/loyalty/ledger', () => ({ reverseForOrder: () => Promise.resolve() }));
vi.mock('@/lib/payments/gateway', () => ({
  createGatewayRefund: () => {
    state.events.push('gateway');
    return Promise.resolve(state.gateway);
  },
}));
const passServer = vi.hoisted(() => ({
  voidPassForRefund: vi.fn(),
  restorePassAfterFailedRefund: vi.fn(),
}));
vi.mock('@/lib/passes/server', () => passServer);

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { op: 'select' as 'select' | 'insert' | 'update' };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (cols?: string) => {
          if (table === 'orders' && ctx.op === 'select') state.orderSelect.push(cols ?? '');
          return chain;
        },
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        in: () => chain,
        insert: (row: Record<string, unknown>) => {
          ctx.op = 'insert';
          if (table === 'refunds') {
            state.refundInserts.push(row);
            if (row.status === 'processed') state.events.push('refund_insert');
          }
          return chain;
        },
        update: () => {
          ctx.op = 'update';
          return chain;
        },
        maybeSingle: () => {
          if (table === 'orders') return Promise.resolve({ data: state.order, error: null });
          if (table === 'payments') return Promise.resolve({ data: state.payment, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        single: () =>
          state.refundInsertError
            ? Promise.resolve({ data: null, error: state.refundInsertError })
            : Promise.resolve({ data: { ...state.refundInserts.at(-1), id: 'refund-1' }, error: null }),
        // Awaited lists: order_payments (the tenders), prior refunds.
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      });
      return chain;
    },
  }),
}));

const { POST } = await import('@/app/api/orders/[id]/refund/route');

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const req = (body: unknown) =>
  new Request(`https://hioc.in/api/orders/${ORDER_ID}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const call = (body: unknown = { reason: 'Customer asked' }) => POST(req(body), { params: { id: ORDER_ID } });

const passSale = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  payment_status: 'paid',
  payment_method: 'cash',
  total_inr: 788,
  subtotal_inr: 750,
  order_kind: 'coffee_pass',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.order = passSale();
  state.payment = null; // the counter path
  state.voidCode = 'ok';
  state.restoreCode = 'ok';
  state.gateway = { id: 'rfnd_1' };
  state.refundInsertError = null;
  state.events = [];
  state.refundInserts = [];
  state.orderSelect = [];
  passServer.voidPassForRefund.mockImplementation(() => {
    state.events.push('void');
    return Promise.resolve(state.voidCode);
  });
  passServer.restorePassAfterFailedRefund.mockImplementation(() => {
    state.events.push('restore');
    return Promise.resolve(state.restoreCode);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('refund of a HIOC Ritual sale — the counter path', () => {
  it("voids the pass BEFORE the refund is recorded, and keeps it void when the refund succeeds", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(passServer.voidPassForRefund).toHaveBeenCalledWith(expect.anything(), ORDER_ID);
    expect(state.events).toEqual(['void', 'refund_insert']);
    expect(passServer.restorePassAfterFailedRefund).not.toHaveBeenCalled();
  });

  it("'used' refuses with a 409 and nothing is recorded", async () => {
    state.voidCode = 'used';
    const res = await call();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "This HIOC Ritual has already been used — it can't be refunded.",
    );
    expect(state.refundInserts).toHaveLength(0);
    expect(passServer.restorePassAfterFailedRefund).not.toHaveBeenCalled();
  });

  it("'already' (an earlier refund voided it) carries on, and a later failure does NOT restore it", async () => {
    state.voidCode = 'already';
    expect((await call()).status).toBe(200);
    expect(state.events).toEqual(['void', 'refund_insert']);

    state.events = [];
    state.refundInserts = [];
    state.refundInsertError = { message: 'boom' };
    expect((await call()).status).toBe(500);
    // Not this call's void, so not this call's to undo.
    expect(passServer.restorePassAfterFailedRefund).not.toHaveBeenCalled();
  });

  it("'not_found' (no pass was ever issued for this sale) carries on", async () => {
    state.voidCode = 'not_found';
    const res = await call();
    expect(res.status).toBe(200);
    expect(state.refundInserts).toHaveLength(1);
  });

  it("'error' refuses with a 503 and nothing moves", async () => {
    state.voidCode = 'error';
    const res = await call();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/HIOC Ritual is temporarily unavailable/);
    expect(state.refundInserts).toHaveLength(0);
  });

  it('gives the pass back when THIS call voided it and recording the refund then fails', async () => {
    state.voidCode = 'ok';
    state.refundInsertError = { message: 'is supabase/2026-08-counter-refunds.sql applied?' };
    const res = await call();
    expect(res.status).toBe(500);
    expect(passServer.restorePassAfterFailedRefund).toHaveBeenCalledWith(expect.anything(), ORDER_ID);
    expect(state.events).toEqual(['void', 'refund_insert', 'restore']); // the insert was tried, then undone
  });

  it('does not void the pass for a request that would be refused anyway (a bad tender)', async () => {
    const res = await call({ reason: 'x', method: 'crypto' });
    expect(res.status).toBe(400);
    expect(passServer.voidPassForRefund).not.toHaveBeenCalled();
  });

  it('a partial refund also cancels the pass (CP-D15: any refund on a pass sale does)', async () => {
    const res = await call({ reason: 'Just the GST', amount_inr: 38 });
    expect(res.status).toBe(200);
    expect(passServer.voidPassForRefund).toHaveBeenCalledTimes(1);
  });
});

describe('refund of a HIOC Ritual sale — the gateway path', () => {
  beforeEach(() => {
    state.order = passSale({ payment_method: 'online' });
    state.payment = { id: 'pay-row-1', gateway_payment_id: 'pay_1', amount_inr: 788 };
  });

  it('voids the pass before the gateway is asked to move money', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(state.events).toEqual(['void', 'gateway', 'refund_insert']);
    expect(passServer.restorePassAfterFailedRefund).not.toHaveBeenCalled();
  });

  it("'used' refuses with a 409 before the gateway is called", async () => {
    state.voidCode = 'used';
    const res = await call();
    expect(res.status).toBe(409);
    expect(state.events).toEqual(['void']);
  });

  it("'error' refuses with a 503 before the gateway is called", async () => {
    state.voidCode = 'error';
    const res = await call();
    expect(res.status).toBe(503);
    expect(state.events).toEqual(['void']);
  });

  it('gives the pass back when THIS call voided it and the gateway then fails (the failed attempt is still logged)', async () => {
    state.gateway = null;
    const res = await call();
    expect(res.status).toBe(502);
    expect(state.events).toEqual(['void', 'gateway', 'restore']);
    expect(state.refundInserts[0]).toMatchObject({ status: 'failed', amount_inr: 788 });
  });

  it("does not restore a pass an earlier refund voided ('already') when the gateway fails", async () => {
    state.voidCode = 'already';
    state.gateway = null;
    expect((await call()).status).toBe(502);
    expect(passServer.restorePassAfterFailedRefund).not.toHaveBeenCalled();
  });

  it('does not void the pass for an amount over what is refundable', async () => {
    const res = await call({ reason: 'x', amount_inr: 5000 });
    expect(res.status).toBe(400);
    expect(passServer.voidPassForRefund).not.toHaveBeenCalled();
  });
});

describe('refund of an ordinary order', () => {
  it.each([
    ['a menu order', { order_kind: 'menu' }],
    ['an order from a database before the migration (no order_kind)', { order_kind: undefined }],
  ])('never touches the pass functions for %s', async (_label, over) => {
    state.order = passSale(over);
    const res = await call();
    expect(res.status).toBe(200);
    expect(passServer.voidPassForRefund).not.toHaveBeenCalled();
    expect(passServer.restorePassAfterFailedRefund).not.toHaveBeenCalled();
  });

  it('reads the order with `*`, so the route keeps working on a database without order_kind', async () => {
    await call();
    expect(state.orderSelect[0]).toBe('*');
  });
});
