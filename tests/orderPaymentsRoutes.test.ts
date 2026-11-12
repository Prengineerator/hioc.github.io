import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import { ORPHAN_CAPTURE_NOTE } from '@/lib/payments/paymentRowStateMachine';
import { STALE_VERSION_CODE } from '@/lib/orders/concurrency';

// The money routes against an in-memory database (tests/helpers/fakeAdmin.ts),
// so the REAL filter chains run and a compare-and-set that matches nothing
// really writes nothing. `world.beforeWrite` lets a test land a concurrent
// write between a route's read and its write.

type Tables = Record<string, Row[]>;
const world: {
  tables: Tables;
  actor: { user: { id: string }; role: string; via: 'session' } | null;
  /** Runs just before an update/insert on `table` executes — a concurrent writer. */
  beforeWrite: ((table: string, op: 'update' | 'insert', payload: Row) => void) | null;
  refundGateway: ReturnType<typeof vi.fn>;
  attempts: Record<string, { id: string; status: string; amount: number; method?: string }[] | null>;
  createIntent: ReturnType<typeof vi.fn>;
} = {
  tables: {},
  actor: null,
  beforeWrite: null,
  refundGateway: vi.fn(),
  attempts: {},
  createIntent: vi.fn(),
};

function makeAdmin() {
  const fake = makeFakeAdmin(world.tables, { startMs: Date.parse('2026-11-12T08:00:00.000Z') });
  return {
    from(table: string) {
      const chain = fake.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
      const update = chain.update;
      const insert = chain.insert;
      chain.update = (payload: unknown) => {
        world.beforeWrite?.(table, 'update', payload as Row);
        return update(payload);
      };
      chain.insert = (payload: unknown) => {
        world.beforeWrite?.(table, 'insert', payload as Row);
        // refunds.idempotency_key is UNIQUE (2026-08-refund-idempotency.sql).
        const key = (payload as Row).idempotency_key;
        if (table === 'refunds' && key && (world.tables.refunds ?? []).some((r) => r.idempotency_key === key)) {
          const err = { data: null, error: { code: '23505', message: 'duplicate key value' } };
          const failing: Record<string, unknown> = {};
          Object.assign(failing, {
            select: () => failing,
            single: () => Promise.resolve(err),
            maybeSingle: () => Promise.resolve(err),
            then: (r: (v: unknown) => void) => r(err),
          });
          return failing;
        }
        return insert(payload);
      };
      return chain;
    },
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => makeAdmin(),
  createServerSupabaseClient: () => ({}),
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(world.actor),
  actorRoleFor: (role: string) => (role === 'owner' || role === 'manager' ? 'owner' : 'staff'),
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/notifications/engine', () => ({
  sendBillNotification: vi.fn(() => Promise.resolve({})),
  sendOrderNotification: vi.fn(() => Promise.resolve({})),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
const ledger = vi.hoisted(() => ({ earnForOrder: vi.fn(() => Promise.resolve()), reverseForOrder: vi.fn(() => Promise.resolve()) }));
vi.mock('@/lib/loyalty/ledger', () => ledger);
vi.mock('@/lib/payments/gateway', () => ({
  requestGatewayRefund: (...args: unknown[]) => world.refundGateway(...args),
  fetchOrderPaymentAttempts: (id: string) => Promise.resolve(id in world.attempts ? world.attempts[id] : []),
  createPaymentIntent: (...args: unknown[]) => world.createIntent(...args),
  mapRazorpayMethod: (m?: string) => (m === 'upi' || m === 'card' ? m : 'online'),
}));
const passes = vi.hoisted(() => ({
  voidPassForRefund: vi.fn(() => Promise.resolve('not_found')),
  restorePassAfterFailedRefund: vi.fn(() => Promise.resolve('ok')),
}));
vi.mock('@/lib/passes/server', () => passes);
vi.mock('@/lib/inventory/server', () => ({ consumeStockForOrder: () => Promise.resolve() }));
vi.mock('@/lib/feedback/enqueue', () => ({ enqueueFeedbackRequest: () => Promise.resolve() }));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ default_prep_min: 15, staff_web_ordering: true, gst_percent: 5, packaging_charge_inr: 0 }),
}));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));

const { PATCH: settleRoute } = await import('@/app/api/orders/[id]/payment/route');
const { POST: refundRoute } = await import('@/app/api/orders/[id]/refund/route');
const { PATCH: statusRoute } = await import('@/app/api/orders/[id]/status/route');
const { POST: cancelRoute } = await import('@/app/api/orders/[id]/cancel/route');
const { POST: paymentActionRoute } = await import('@/app/api/payments/[orderId]/status/route');
const { POST: amendRoute } = await import('@/app/api/orders/[id]/amend/route');
const { POST: balanceRoute } = await import('@/app/api/orders/[id]/balance/route');
const { captureGatewayPayment } = await import('@/lib/payments/reconcile');

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const LINE_A = '22222222-2222-4222-8222-222222222222';
const LINE_B = '33333333-3333-4333-8333-333333333333';

function order(over: Row = {}): Row {
  return {
    id: ORDER_ID,
    order_number: 1042,
    status: 'ready',
    version: 3,
    order_type: 'dine_in',
    channel: 'staff_pos',
    user_id: null,
    payment_status: 'unpaid',
    payment_method: null,
    total_inr: 500,
    subtotal_inr: 476,
    discount_inr: 0,
    customer_phone: '',
    created_at: '2026-11-12T07:00:00.000Z',
    ...over,
  };
}

function gatewayRow(over: Row = {}): Row {
  return {
    id: 'pay-row-1',
    order_id: ORDER_ID,
    gateway: 'razorpay',
    gateway_order_id: 'order_rzp_1',
    gateway_payment_id: 'pay_1',
    amount_inr: 500,
    status: 'paid',
    error: '',
    created_at: '2026-11-12T07:01:00.000Z',
    ...over,
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const params = { params: { id: ORDER_ID } };
const theOrder = () => world.tables.orders.find((o) => o.id === ORDER_ID)!;
/**
 * Another writer changes the order. The row is REPLACED, not mutated: the fake
 * hands the route its stored objects, and a real read is a copy the route keeps.
 */
const concurrently = (changes: Row) => {
  const i = world.tables.orders.findIndex((o) => o.id === ORDER_ID);
  world.tables.orders[i] = { ...world.tables.orders[i], ...changes };
};

beforeEach(() => {
  vi.clearAllMocks();
  world.tables = { orders: [], payments: [], refunds: [], order_payments: [], order_amendments: [], order_status_events: [], order_items: [] };
  world.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'session' };
  world.beforeWrite = null;
  world.attempts = {};
  world.refundGateway.mockReset();
  world.refundGateway.mockResolvedValue({ kind: 'processed', refundId: 'rfnd_1' });
  world.createIntent.mockReset();
  world.createIntent.mockResolvedValue({ gateway: 'razorpay', gatewayOrderId: 'order_rzp_new', amountInr: 500 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
describe('PATCH /api/orders/[id]/payment — the counter settle', () => {
  const settle = (body: Row) =>
    settleRoute(new Request('http://t/api/orders/x/payment', { ...json(body), method: 'PATCH' }), params);

  it('refuses to re-record a UPI bill the GATEWAY took (its payments row is paid), writing nothing', async () => {
    world.tables.orders.push(order({ payment_status: 'paid', payment_method: 'upi', channel: 'table_qr' }));
    world.tables.payments.push(gatewayRow());
    const res = await settle({ payment_method: 'cash' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/paid online/);
    expect(theOrder()).toMatchObject({ payment_method: 'upi', version: 3 });
  });

  it('still re-records a UPI bill the COUNTER took', async () => {
    world.tables.orders.push(order({ payment_status: 'paid', payment_method: 'upi' }));
    expect((await settle({ payment_method: 'cash' })).status).toBe(200);
    expect(theOrder()).toMatchObject({ payment_method: 'cash', payment_status: 'paid', version: 4 });
  });

  it('refuses a cancelled order — the Settle screen never offered it', async () => {
    world.tables.orders.push(order({ status: 'cancelled' }));
    const res = await settle({ payment_method: 'cash' });
    expect(res.status).toBe(409);
    expect(theOrder().payment_status).toBe('unpaid');
  });

  it('refuses an order waiting on an open Razorpay order; settles it once none is open', async () => {
    world.tables.orders.push(order({ status: 'received', payment_status: 'payment_pending', payment_method: 'online' }));
    world.tables.payments.push(gatewayRow({ status: 'payment_pending', gateway_payment_id: '' }));
    const res = await settle({ payment_method: 'cash' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/waiting on an online payment/);

    world.tables.payments[0].status = 'unpaid'; // abandoned
    expect((await settle({ payment_method: 'cash' })).status).toBe(200);
    expect(theOrder().payment_status).toBe('paid');
  });

  it('is a compare-and-set: a refund landing mid-request is not overwritten', async () => {
    world.tables.orders.push(order({ payment_status: 'paid', payment_method: 'cash' }));
    world.beforeWrite = (table, op) => {
      if (table === 'orders' && op === 'update') concurrently({ payment_status: 'partially_refunded' });
    };
    const res = await settle({ payment_method: 'upi' });
    expect(res.status).toBe(409);
    expect(theOrder()).toMatchObject({ payment_status: 'partially_refunded', payment_method: 'cash' });
  });

  it('loses cleanly to a change of the bill (version) instead of settling the old total', async () => {
    world.tables.orders.push(order());
    world.beforeWrite = (table, op) => {
      if (table === 'orders' && op === 'update') concurrently({ total_inr: 650, version: 4 });
    };
    const res = await settle({ parts: [{ method: 'cash', amount_inr: 500 }] });
    expect(res.status).toBe(409);
    expect(theOrder().payment_status).toBe('unpaid');
    expect(world.tables.order_payments).toHaveLength(0);
  });

  it('never takes a completed order back to unpaid', async () => {
    world.tables.orders.push(order({ status: 'completed', payment_status: 'paid', payment_method: 'cash' }));
    expect((await settle({ payment_method: 'cash', payment_status: 'unpaid' })).status).toBe(409);
    expect(theOrder().payment_status).toBe('paid');
  });
});

// ---------------------------------------------------------------------------
describe('captureGatewayPayment — a capture that lands late', () => {
  const capture = () =>
    captureGatewayPayment({ gatewayOrderId: 'order_rzp_1', gatewayPaymentId: 'pay_9', method: 'upi', signatureOk: true });

  it('on a CANCELLED order: records the money as an orphan and does not mark the order paid', async () => {
    world.tables.orders.push(order({ status: 'cancelled', payment_status: 'unpaid', payment_method: null, channel: 'customer_web' }));
    world.tables.payments.push(gatewayRow({ status: 'unpaid', gateway_payment_id: '' })); // abandoned on cancel
    const result = await capture();
    expect(result).toMatchObject({ ok: true, orphan: true });
    expect(theOrder()).toMatchObject({ status: 'cancelled', payment_status: 'unpaid', payment_method: null });
    expect(world.tables.payments[0].status).toBe('paid');
    expect(String(world.tables.payments[0].error)).toMatch(new RegExp(`^${ORPHAN_CAPTURE_NOTE}`));
  });

  it('after the counter took CASH (switched to counter): leaves the cash alone — no upi overwrite', async () => {
    world.tables.orders.push(order({ status: 'accepted', payment_status: 'paid', payment_method: 'cash' }));
    world.tables.payments.push(gatewayRow({ status: 'unpaid', gateway_payment_id: '' }));
    const result = await capture();
    expect(result.orphan).toBe(true);
    expect(theOrder()).toMatchObject({ payment_status: 'paid', payment_method: 'cash' });
  });

  it('after switching to the counter but before it collected: the online payment settles the bill', async () => {
    world.tables.orders.push(order({ status: 'accepted', payment_status: 'unpaid', payment_method: null }));
    world.tables.payments.push(gatewayRow({ status: 'unpaid', gateway_payment_id: '' }));
    const result = await capture();
    expect(result.orphan).toBeUndefined();
    expect(theOrder()).toMatchObject({ payment_status: 'paid', payment_method: 'upi', status: 'accepted' });
  });

  it('a cancel racing the capture wins, and the capture is marked an orphan', async () => {
    world.tables.orders.push(order({ status: 'placed', payment_status: 'payment_pending', payment_method: 'online', version: 0 }));
    world.tables.payments.push(gatewayRow({ status: 'payment_pending', gateway_payment_id: '' }));
    world.beforeWrite = (table, op) => {
      if (table === 'orders' && op === 'update') {
        world.beforeWrite = null;
        concurrently({ status: 'cancelled', payment_status: 'unpaid', version: 1 });
      }
    };
    const result = await capture();
    expect(result.orphan).toBe(true);
    expect(theOrder()).toMatchObject({ status: 'cancelled', payment_status: 'unpaid' });
    expect(String(world.tables.payments[0].error)).toMatch(new RegExp(`^${ORPHAN_CAPTURE_NOTE}`));
  });

  it('a normal capture advances placed → received exactly once', async () => {
    world.tables.orders.push(order({ status: 'placed', payment_status: 'payment_pending', payment_method: 'online', version: 0 }));
    world.tables.payments.push(gatewayRow({ status: 'payment_pending', gateway_payment_id: '' }));
    expect((await capture()).order).toMatchObject({ status: 'received', payment_status: 'paid' });
    expect((await capture()).alreadyProcessed).toBe(true);
    expect(world.tables.order_status_events).toHaveLength(1);
  });

  it('finishes an order a crashed capture left waiting on a recorded payment (once the claim is old)', async () => {
    world.tables.orders.push(order({ status: 'placed', payment_status: 'payment_pending', payment_method: 'online', version: 0 }));
    world.tables.payments.push(gatewayRow({ status: 'paid', updated_at: '2026-11-12T07:02:00.000Z' }));
    expect((await capture()).order).toMatchObject({ status: 'received', payment_status: 'paid' });
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/orders/[id]/refund — the refund lifecycle', () => {
  const refund = (body: Row = { reason: 'Customer asked' }, key?: string) =>
    refundRoute(new Request('http://t/api/orders/x/refund', json(body, key ? { 'idempotency-key': key } : {})), params);

  beforeEach(() => {
    world.tables.orders.push(order({ status: 'completed', payment_status: 'paid', payment_method: 'upi', channel: 'table_qr' }));
    world.tables.payments.push(gatewayRow());
  });

  it('claims the refund (pending, with its key) BEFORE the gateway moves money, then marks it processed', async () => {
    world.refundGateway.mockImplementation(async () => {
      expect(world.tables.refunds).toHaveLength(1);
      expect(world.tables.refunds[0]).toMatchObject({ status: 'pending', idempotency_key: 'key-0001', amount_inr: 200 });
      return { kind: 'processed', refundId: 'rfnd_1' };
    });
    const res = await refund({ reason: 'Cold coffee', amount_inr: 200 }, 'key-0001');
    expect(res.status).toBe(200);
    expect(world.tables.refunds[0]).toMatchObject({ status: 'processed', gateway_ref: 'rfnd_1' });
    expect(theOrder().payment_status).toBe('partially_refunded');
    expect(world.tables.payments[0].status).toBe('partially_refunded');
  });

  it('a second tap with the same key while the first is still out never reaches the gateway', async () => {
    world.tables.refunds.push({ id: 'r-1', payment_id: 'pay-row-1', order_id: ORDER_ID, amount_inr: 500, status: 'pending', idempotency_key: 'key-0001' });
    const res = await refund({ reason: 'x' }, 'key-0001');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('refund_pending');
    expect(world.refundGateway).not.toHaveBeenCalled();
  });

  it('two taps racing past the key lookup: the unique index stops the second before the gateway', async () => {
    world.beforeWrite = (table, op, payload) => {
      if (table === 'refunds' && op === 'insert' && payload.status === 'pending') {
        world.beforeWrite = null;
        world.tables.refunds.push({ id: 'r-other', payment_id: 'pay-row-1', order_id: ORDER_ID, amount_inr: 500, status: 'pending', idempotency_key: 'key-0002' });
      }
    };
    const res = await refund({ reason: 'x' }, 'key-0002');
    expect(res.status).toBe(409);
    expect(world.refundGateway).not.toHaveBeenCalled();
  });

  it('an UNKNOWN gateway answer leaves the refund pending: not failed, nothing restored, order unchanged', async () => {
    world.refundGateway.mockResolvedValue({ kind: 'unknown' });
    const res = await refund({ reason: 'x' }, 'key-0003');
    expect(res.status).toBe(504);
    expect((await res.json()).code).toBe('refund_unconfirmed');
    expect(world.tables.refunds[0]).toMatchObject({ status: 'pending', idempotency_key: 'key-0003' });
    expect(theOrder().payment_status).toBe('paid');
    expect(passes.restorePassAfterFailedRefund).not.toHaveBeenCalled();
    // ...and no other gateway refund starts on that payment until someone looks.
    const again = await refund({ reason: 'x', amount_inr: 100 }, 'key-0004');
    expect(again.status).toBe(409);
    expect(world.refundGateway).toHaveBeenCalledTimes(1);
  });

  it('a DEFINITE refusal is failed, releases the key, and the same key may try again', async () => {
    world.refundGateway.mockResolvedValueOnce({ kind: 'rejected', httpStatus: 400 });
    expect((await refund({ reason: 'x' }, 'key-0005')).status).toBe(502);
    expect(world.tables.refunds[0]).toMatchObject({ status: 'failed', idempotency_key: null });
    expect((await refund({ reason: 'x' }, 'key-0005')).status).toBe(200);
    expect(theOrder().payment_status).toBe('refunded');
    expect(ledger.reverseForOrder).toHaveBeenCalledTimes(1);
  });

  it('writes the payment status from a FRESH read of what has gone back', async () => {
    // Another ₹300 refund on the payment is recorded while ours is out.
    world.refundGateway.mockImplementation(async () => {
      world.tables.refunds.push({ id: 'r-x', payment_id: 'pay-row-1', order_id: ORDER_ID, amount_inr: 300, status: 'processed' });
      return { kind: 'processed', refundId: 'rfnd_2' };
    });
    expect((await refund({ reason: 'x', amount_inr: 200 })).status).toBe(200);
    expect(theOrder().payment_status).toBe('refunded'); // 300 + 200 = all of it
    expect(world.tables.payments[0].status).toBe('refunded');
  });

  it('refunds an ORPHAN capture on a cancelled order through the gateway, leaving the order as it was', async () => {
    world.tables.orders[0] = order({ status: 'cancelled', payment_status: 'unpaid', payment_method: null });
    world.tables.payments[0] = gatewayRow({ error: `${ORPHAN_CAPTURE_NOTE} captured after the order was cancelled` });
    const res = await refund({ reason: 'Order was cancelled' });
    expect(res.status).toBe(200);
    expect(world.refundGateway).toHaveBeenCalledWith('pay_1', 500, expect.anything());
    expect(theOrder()).toMatchObject({ status: 'cancelled', payment_status: 'unpaid' });
    expect(world.tables.payments[0].status).toBe('refunded');
    expect(ledger.reverseForOrder).not.toHaveBeenCalled();
  });

  it('refuses a refund while a changed paid bill still has a balance open (it would get stuck)', async () => {
    world.tables.orders[0] = order({ status: 'ready', payment_status: 'paid', payment_method: 'cash', balance_due_inr: 150 });
    world.tables.payments = [];
    const res = await refund({ reason: 'x', method: 'cash', amount_inr: 100 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/₹150 to collect/);
    expect(world.tables.refunds).toHaveLength(0);
  });

  it('counter refunds: the status comes from a fresh sum, so two part-refunds end fully refunded', async () => {
    world.tables.orders[0] = order({ status: 'completed', payment_status: 'paid', payment_method: 'cash' });
    world.tables.payments = [];
    expect((await refund({ reason: 'a', method: 'cash', amount_inr: 200 })).status).toBe(200);
    expect(theOrder().payment_status).toBe('partially_refunded');
    expect((await refund({ reason: 'b', method: 'cash', amount_inr: 300 })).status).toBe(200);
    expect(theOrder().payment_status).toBe('refunded');
  });
});

// ---------------------------------------------------------------------------
describe('PATCH /api/orders/[id]/status — comp and cancel', () => {
  const transition = (body: Row) =>
    statusRoute(new Request('http://t/api/orders/x/status', { ...json(body), method: 'PATCH' }), params);

  it('a comp that loses the version race writes nothing — no comp row, still unpaid', async () => {
    world.tables.orders.push(order());
    world.beforeWrite = (table, op) => {
      if (table === 'orders' && op === 'update') concurrently({ version: 4 });
    };
    const res = await transition({ status: 'completed', comp: { reason: 'On the house' } });
    expect(res.status).toBe(409);
    expect(theOrder()).toMatchObject({ status: 'ready', payment_status: 'unpaid' });
    expect(world.tables.order_amendments).toHaveLength(0);
  });

  it('a comp completes and pays in one write, then audits', async () => {
    world.tables.orders.push(order());
    expect((await transition({ status: 'completed', comp: { reason: 'On the house' } })).status).toBe(200);
    expect(theOrder()).toMatchObject({ status: 'completed', payment_status: 'paid' });
    expect(world.tables.order_amendments[0]).toMatchObject({ kind: 'comp' });
  });

  it('never comps over a refund: a part-refunded Ready order completes as it is', async () => {
    world.tables.orders.push(order({ payment_status: 'partially_refunded', payment_method: 'cash' }));
    expect((await transition({ status: 'completed', comp: { reason: 'On the house' } })).status).toBe(200);
    expect(theOrder()).toMatchObject({ status: 'completed', payment_status: 'partially_refunded' });
    expect(world.tables.order_amendments).toHaveLength(0);
  });

  it('a manager cancelling a placed order takes it off the gateway and abandons its Razorpay order', async () => {
    world.tables.orders.push(order({ status: 'placed', payment_status: 'payment_pending', payment_method: 'online' }));
    world.tables.payments.push(gatewayRow({ status: 'payment_pending', gateway_payment_id: '' }));
    world.actor = { user: { id: 'own-1' }, role: 'owner', via: 'session' };
    expect((await transition({ status: 'cancelled', reason: 'Duplicate' })).status).toBe(200);
    expect(theOrder()).toMatchObject({ status: 'cancelled', payment_status: 'unpaid' });
    expect(world.tables.payments[0].status).toBe('unpaid');
  });
});

// ---------------------------------------------------------------------------
describe('customer cancel, retry and switch to the counter', () => {
  const cancel = () => cancelRoute(new Request('http://t/api/orders/x/cancel', json({})), params);
  const action = (body: Row) => paymentActionRoute(new Request('http://t/api/payments/x/status', json(body)), { params: { orderId: ORDER_ID } });

  beforeEach(() => {
    world.tables.orders.push(
      order({ status: 'placed', version: 0, payment_status: 'payment_pending', payment_method: 'online', channel: 'customer_web', user_id: 'cust-1' }),
    );
    world.tables.payments.push(gatewayRow({ status: 'payment_pending', gateway_payment_id: '' }));
  });

  it('a cancelled placed order reads unpaid and its Razorpay order is abandoned', async () => {
    expect((await cancel()).status).toBe(200);
    expect(theOrder()).toMatchObject({ status: 'cancelled', payment_status: 'unpaid' });
    expect(world.tables.payments[0].status).toBe('unpaid');
  });

  it('asks the gateway first: a payment that went through is recorded and the cancel refused', async () => {
    world.attempts.order_rzp_1 = [{ id: 'pay_9', status: 'captured', amount: 50000, method: 'upi' }];
    expect((await cancel()).status).toBe(409);
    expect(theOrder()).toMatchObject({ status: 'received', payment_status: 'paid' });
  });

  it('retry is refused for a cancelled order — no Razorpay order is handed out for it', async () => {
    Object.assign(theOrder(), { status: 'cancelled', payment_status: 'payment_pending' });
    const res = await action({ action: 'retry' });
    expect(res.status).toBe(409);
    expect(world.createIntent).not.toHaveBeenCalled();
  });

  it('retry reuses the open Razorpay order only for the same amount', async () => {
    const same = await action({ action: 'retry' });
    expect((await same.json()).payment.gatewayOrderId).toBe('order_rzp_1');
    expect(world.createIntent).not.toHaveBeenCalled();

    theOrder().total_inr = 650;
    await action({ action: 'retry' });
    expect(world.createIntent).toHaveBeenCalledWith(ORDER_ID, 650);
    expect(world.tables.payments[0].status).toBe('unpaid'); // the old amount is never paid
  });

  it('switch to the counter: the customer moves it, and its Razorpay order is abandoned', async () => {
    expect((await action({ action: 'switch_to_counter' })).status).toBe(200);
    expect(theOrder()).toMatchObject({ status: 'received', payment_status: 'unpaid', payment_method: null });
    expect(world.tables.payments[0].status).toBe('unpaid');
    expect(world.tables.order_status_events[0]).toMatchObject({ actor_role: 'customer', to_status: 'received' });
    // ...so a retry now mints a fresh one rather than handing the abandoned one out.
    await action({ action: 'retry' });
    expect(world.createIntent).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('amend and balance — safe to retry, and not on a gateway or refunded bill', () => {
  const amend = (body: Row) => amendRoute(new Request('http://t/api/orders/x/amend', json(body)), params);
  const balance = (body: Row) => balanceRoute(new Request('http://t/api/orders/x/balance', json(body)), params);
  const lines = () => [
    { id: LINE_A, voided: false, quantity: 1, price_inr_snapshot: 250, line_total_inr: 250, menu_item_id: 'm1', name_snapshot: 'Latte' },
    { id: LINE_B, voided: false, quantity: 1, price_inr_snapshot: 250, line_total_inr: 250, menu_item_id: 'm2', name_snapshot: 'Mocha' },
  ];

  it('a void carrying a stale expected_version is refused before anything is written', async () => {
    world.tables.orders.push(order({ order_items: lines() }));
    const res = await amend({ item_id: LINE_A, reason: 'Wrong item', expected_version: 2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: STALE_VERSION_CODE, version: 3 });
    expect((theOrder().order_items as Row[])[0].voided).toBe(false);
  });

  it('a non-integer expected_version is a 400', async () => {
    world.tables.orders.push(order({ order_items: lines() }));
    expect((await amend({ item_id: LINE_A, reason: 'x', expected_version: 'three' })).status).toBe(400);
  });

  it('a part-refunded bill is not changed as if it were unpaid', async () => {
    world.tables.orders.push(order({ payment_status: 'partially_refunded', payment_method: 'cash', order_items: lines() }));
    const res = await amend({ item_id: LINE_A, reason: 'Wrong item' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/refunded/);
  });

  it('a dine-in bill a UPI capture paid can’t be changed (payment_method alone said it could)', async () => {
    world.tables.orders.push(order({ payment_status: 'paid', payment_method: 'upi', balance_due_inr: 0, order_items: lines() }));
    world.tables.payments.push(gatewayRow());
    const res = await amend({ item_id: LINE_A, reason: 'Wrong item' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/paid online/);
  });

  it('a balance settlement carrying a stale expected_version is refused before any money record', async () => {
    world.tables.orders.push(order({ payment_status: 'paid', payment_method: 'cash', balance_due_inr: 150, settle_discount_inr: 0 }));
    const res = await balance({ action: 'collect', parts: [{ method: 'cash', amount_inr: 150 }], expected_version: 2 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(STALE_VERSION_CODE);
    expect(world.tables.order_payments).toHaveLength(0);
    // The matching version goes through, and bumps it — so a retry of it is stale.
    expect((await balance({ action: 'collect', parts: [{ method: 'cash', amount_inr: 150 }], expected_version: 3 })).status).toBe(200);
    expect(theOrder()).toMatchObject({ balance_due_inr: 0, version: 4 });
  });

  it('never gives money back from the drawer against a bill the gateway took', async () => {
    world.tables.orders.push(order({ payment_status: 'paid', payment_method: 'upi', balance_due_inr: -120, paid_amended_at: '2026-11-12T07:30:00.000Z' }));
    world.tables.payments.push(gatewayRow());
    const res = await balance({ action: 'give_back', amount_inr: 120 });
    expect(res.status).toBe(409);
    expect(world.tables.refunds).toHaveLength(0);
  });
});
