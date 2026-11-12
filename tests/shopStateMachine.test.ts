import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import { shopOrder } from './helpers/shopFixture';
import {
  canCancel,
  canRefreshFromShiprocket,
  canSendToShiprocket,
  canShopTransition,
  checkShopAction,
  REFUND_CLAIM_MS,
  refundPendingMarker,
  SHIPROCKET_SEND_CLAIM_MS,
  SHOP_ORDER_STATUSES,
  SHOP_TERMINAL_STATUSES,
  SHOP_TRANSITIONS,
  shopFromStatuses,
  shopRefundState,
  type ShopAction,
} from '@/lib/shop/status';
import type { ShopOrderStatus } from '@/lib/shop/types';

// The shop order machine (lib/shop/status.ts) as a table, and the two races it
// closes on the owner's routes: Cancel & refund against Send to Shiprocket, and
// a refund claim left behind ("pending") that used to lock the order for good.

const NOW = Date.parse('2026-11-12T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('the transition table', () => {
  const allowed: [ShopAction, ShopOrderStatus, ShopOrderStatus][] = [
    ['capture', 'payment_pending', 'paid'],
    ['send', 'paid', 'sent_to_shiprocket'],
    ['send', 'paid', 'shipped'],
    ['mark_shipped', 'paid', 'shipped'],
    ['mark_shipped', 'sent_to_shiprocket', 'shipped'],
    ['refresh', 'sent_to_shiprocket', 'shipped'],
    ['refresh', 'sent_to_shiprocket', 'delivered'],
    ['refresh', 'shipped', 'delivered'],
    ['mark_delivered', 'shipped', 'delivered'],
    ['cancel', 'paid', 'cancelled'],
    ['cancel', 'sent_to_shiprocket', 'cancelled'],
    ['cancel', 'shipped', 'cancelled'],
    ['cancel', 'delivered', 'cancelled'],
  ];

  it('is exactly the moves the code makes', () => {
    expect(SHOP_TRANSITIONS.map((t) => [t.action, t.from, t.to])).toEqual(allowed);
    for (const [a, f, t] of allowed) expect(canShopTransition(a, f, t)).toEqual({ ok: true });
  });

  it('refuses every other pair, for every action', () => {
    const actions: ShopAction[] = ['capture', 'send', 'mark_shipped', 'refresh', 'mark_delivered', 'cancel'];
    for (const a of actions) {
      for (const f of SHOP_ORDER_STATUSES) {
        for (const t of SHOP_ORDER_STATUSES) {
          if (allowed.some(([x, y, z]) => x === a && y === f && z === t)) continue;
          expect(canShopTransition(a, f, t)).toMatchObject({ ok: false, code: 'not_allowed' });
        }
      }
    }
  });

  it('leaves cancelled terminal, and never cancels an unpaid checkout', () => {
    expect(SHOP_TERMINAL_STATUSES).toEqual(['cancelled']);
    expect(SHOP_TRANSITIONS.filter((t) => t.from === 'cancelled')).toEqual([]);
    expect(canShopTransition('cancel', 'payment_pending', 'cancelled').ok).toBe(false);
  });

  it('names who does each move', () => {
    expect(canShopTransition('capture', 'payment_pending', 'paid', { actor: 'gateway' }).ok).toBe(true);
    expect(canShopTransition('capture', 'payment_pending', 'paid', { actor: 'owner' })).toMatchObject({ ok: false, code: 'forbidden_actor' });
    expect(canShopTransition('cancel', 'paid', 'cancelled', { actor: 'gateway' })).toMatchObject({ ok: false, code: 'forbidden_actor' });
  });

  it('gives each write its compare-and-set statuses', () => {
    expect(shopFromStatuses('capture')).toEqual(['payment_pending']);
    expect(shopFromStatuses('send')).toEqual(['paid']);
    expect(shopFromStatuses('mark_shipped', 'shipped')).toEqual(['paid', 'sent_to_shiprocket']);
    expect(shopFromStatuses('mark_delivered')).toEqual(['shipped']);
    expect(shopFromStatuses('cancel')).toEqual(['paid', 'sent_to_shiprocket', 'shipped', 'delivered']);
  });
});

describe('the in-flight markers', () => {
  it('reads the refund marker', () => {
    expect(shopRefundState({ refund_id: null }, NOW)).toBe('none');
    expect(shopRefundState({ refund_id: 'rfnd_123' }, NOW)).toBe('done');
    expect(shopRefundState({ refund_id: refundPendingMarker(NOW - 1000) }, NOW)).toBe('in_flight');
    expect(shopRefundState({ refund_id: refundPendingMarker(NOW - REFUND_CLAIM_MS) }, NOW)).toBe('unconfirmed');
    // Written before the marker carried its time: never "in flight" forever.
    expect(shopRefundState({ refund_id: 'pending' }, NOW)).toBe('unconfirmed');
    expect(shopRefundState({ refund_id: 'pending:garbage' }, NOW)).toBe('unconfirmed');
  });

  it('never sends an order whose refund has started', () => {
    expect(canSendToShiprocket(shopOrder())).toBe(true);
    expect(canSendToShiprocket(shopOrder({ refund_id: refundPendingMarker(NOW) }))).toBe(false);
    expect(canSendToShiprocket(shopOrder({ refund_id: 'pending' }))).toBe(false);
    expect(checkShopAction('send', shopOrder({ refund_id: 'pending' }))).toMatchObject({ ok: false, code: 'refund_started' });
  });

  it('never cancels under a send in flight; a stale send claim does not block', () => {
    expect(canCancel(shopOrder({ shiprocket_sending_at: ago(10_000) }), NOW)).toBe(false);
    expect(checkShopAction('cancel', shopOrder({ shiprocket_sending_at: ago(10_000) }), NOW)).toMatchObject({ code: 'sending' });
    expect(canCancel(shopOrder({ shiprocket_sending_at: ago(SHIPROCKET_SEND_CLAIM_MS + 1) }), NOW)).toBe(true);
  });

  it('lets an unconfirmed refund be finished, not one in flight or done', () => {
    expect(canCancel(shopOrder({ refund_id: refundPendingMarker(NOW - 1000) }), NOW)).toBe(false);
    expect(canCancel(shopOrder({ refund_id: 'pending' }), NOW)).toBe(true);
    expect(canCancel(shopOrder({ refund_id: 'rfnd_1' }), NOW)).toBe(false);
  });

  it('offers Refresh only for an order Shiprocket has, on its way', () => {
    expect(canRefreshFromShiprocket(shopOrder({ status: 'sent_to_shiprocket', shiprocket_order_id: '9' }))).toBe(true);
    expect(canRefreshFromShiprocket(shopOrder({ status: 'shipped', shiprocket_order_id: '9' }))).toBe(true);
    expect(canRefreshFromShiprocket(shopOrder({ status: 'shipped' }))).toBe(false);
    expect(canRefreshFromShiprocket(shopOrder({ status: 'delivered', shiprocket_order_id: '9' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The routes, on an in-memory database
// ---------------------------------------------------------------------------

const state: {
  tables: Record<string, Row[]>;
  fake: ReturnType<typeof makeFakeAdmin>;
  /** Runs before the n-th shop_orders query (1-based): lets a test move the row between a route's read and its write. */
  beforeQuery: Record<number, () => void>;
  queries: number;
  payment: { status: string } | null;
  paymentAfter: { status: string } | null | undefined;
  refund: { id: string; status: string } | null;
  refundCalls: number;
  srCancels: string[];
  srCreates: number;
} = {
  tables: {},
  fake: makeFakeAdmin({}, { startMs: 0 }),
  beforeQuery: {},
  queries: 0,
  payment: null,
  paymentAfter: undefined,
  refund: null,
  refundCalls: 0,
  srCancels: [],
  srCreates: 0,
};

const admin = {
  from(table: string) {
    if (table === 'shop_orders') {
      state.queries++;
      state.beforeQuery[state.queries]?.();
    }
    return state.fake.from(table);
  },
};

let paymentReads = 0;
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => admin }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve({ id: 'owner-1' }) }));
vi.mock('@/lib/api/background', () => ({ runAfterResponse: (p: Promise<unknown>) => void p }));
vi.mock('@/lib/shop/emails', () => ({
  sendShopCancelledEmail: () => Promise.resolve(),
  sendShopShippedEmail: () => Promise.resolve(),
}));
vi.mock('@/lib/payments/gateway', () => ({
  fetchGatewayPayment: () => {
    paymentReads++;
    return Promise.resolve(paymentReads > 1 && state.paymentAfter !== undefined ? state.paymentAfter : state.payment);
  },
  createGatewayRefund: () => {
    state.refundCalls++;
    return Promise.resolve(state.refund);
  },
}));
vi.mock('@/lib/shop/shiprocket', () => ({
  isShiprocketConfigured: () => true,
  SHIPROCKET_NOT_CONFIGURED: 'not configured',
  cancelShiprocketOrder: (id: string) => {
    state.srCancels.push(id);
    return Promise.resolve({ ok: true });
  },
  createShiprocketOrder: () => {
    state.srCreates++;
    return Promise.resolve({ ok: true, created: { shiprocketOrderId: 'SR1', shipmentId: 'SH1', status: 'NEW', awb: null, courier: null } });
  },
}));

const cancel = (await import('@/app/api/owner/shop/orders/[id]/cancel/route')).POST;
const send = (await import('@/app/api/owner/shop/orders/[id]/shiprocket/route')).POST;

const ID = shopOrder().id;
const ctx = { params: { id: ID } };
const post = (body: unknown) =>
  new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const row = () => state.tables.shop_orders[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.tables = { shop_orders: [shopOrder() as unknown as Row] };
  state.fake = makeFakeAdmin(state.tables, { startMs: NOW });
  state.beforeQuery = {};
  state.queries = 0;
  state.payment = { status: 'captured' };
  state.paymentAfter = undefined;
  state.refund = { id: 'rfnd_OK', status: 'processed' };
  state.refundCalls = 0;
  state.srCancels = [];
  state.srCreates = 0;
  paymentReads = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Cancel & refund', () => {
  it('refunds once and cancels', async () => {
    const res = await cancel(post({ reason: 'Out of stock' }), ctx);
    expect(res.status).toBe(200);
    expect(state.refundCalls).toBe(1);
    expect(row()).toMatchObject({ status: 'cancelled', refund_id: 'rfnd_OK', refunded_inr: 847 });
  });

  it('refuses while a Send to Shiprocket is in flight, before any money moves', async () => {
    Object.assign(row(), { shiprocket_sending_at: ago(5_000) });
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(409);
    expect(state.refundCalls).toBe(0);
    expect(row()).toMatchObject({ status: 'paid', refund_id: null });
  });

  it('refuses when a send starts between its read and its claim', async () => {
    // Query 1 is the read; before query 2 (the claim) a send takes its own claim.
    state.beforeQuery[2] = () => Object.assign(row(), { shiprocket_sending_at: new Date(NOW).toISOString() });
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(409);
    expect(state.refundCalls).toBe(0);
    expect(row().refund_id).toBeNull();
  });

  it('calls the shipment off when a send FINISHED between its read and its claim (the stale read)', async () => {
    // The send's final write clears its marker, so the claim still lands — but
    // the order is now in Shiprocket and its shipment must be cancelled.
    state.beforeQuery[2] = () =>
      Object.assign(row(), { status: 'sent_to_shiprocket', shiprocket_order_id: 'SR77', shiprocket_sending_at: null });
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(200);
    expect(state.srCancels).toEqual(['SR77']);
    expect(row()).toMatchObject({ status: 'cancelled', refund_id: 'rfnd_OK' });
  });

  it('refuses a second cancel while the first is asking Razorpay', async () => {
    Object.assign(row(), { refund_id: refundPendingMarker(NOW - 1000) });
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(409);
    expect(state.refundCalls).toBe(0);
  });

  it('finishes a refund left "pending" without refunding twice', async () => {
    // The old sentinel, from a run that refunded and then could not save.
    Object.assign(row(), { refund_id: 'pending' });
    state.payment = { status: 'refunded' };
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(200);
    expect(state.refundCalls).toBe(0);
    expect(row()).toMatchObject({ status: 'cancelled', refunded_inr: 847, refund_id: null });
    expect((await res.json()).warning).toMatch(/already refunded/);
  });

  it('finishes a stale claim whose refund never went: refunds it now', async () => {
    Object.assign(row(), { refund_id: refundPendingMarker(NOW - REFUND_CLAIM_MS - 1) });
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(200);
    expect(state.refundCalls).toBe(1);
    expect(row()).toMatchObject({ status: 'cancelled', refund_id: 'rfnd_OK' });
  });

  it('a save that fails after the refund leaves a claim the next try finishes', async () => {
    // Before the final write (query 4: read, claim, fresh read, save) the order is cancelled elsewhere.
    state.beforeQuery[4] = () => Object.assign(row(), { refund_id: 'someone-else' });
    const first = await cancel(post({}), ctx);
    expect(first.status).toBe(500);
    expect(state.refundCalls).toBe(1);

    // Put back the claim this run left (the interference above stands in for "the save failed").
    Object.assign(row(), { refund_id: refundPendingMarker(NOW) });
    vi.setSystemTime(NOW + REFUND_CLAIM_MS + 1);
    state.payment = { status: 'refunded' };
    state.beforeQuery = {};
    state.queries = 0;
    paymentReads = 0;
    const retry = await cancel(post({}), ctx);
    expect(retry.status).toBe(200);
    expect(state.refundCalls).toBe(1); // not refunded twice
    expect(row().status).toBe('cancelled');
  });

  it('a refused refund changes nothing and releases the claim', async () => {
    state.refund = null;
    state.paymentAfter = { status: 'captured' };
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(502);
    expect(row()).toMatchObject({ status: 'paid', refund_id: null });
  });

  it('a refund with no answer keeps the claim, so the order cannot ship meanwhile', async () => {
    state.refund = null;
    state.paymentAfter = null; // Razorpay unreachable: did the money move?
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(502);
    expect(shopRefundState(row() as never, NOW)).toBe('in_flight');

    const sent = await send(post({ weight_kg: 0.5, length_cm: 10, breadth_cm: 10, height_cm: 10 }), ctx);
    expect(sent.status).toBe(409);
    expect(state.srCreates).toBe(0);
  });

  it('a refund Razorpay made but did not confirm in time is recorded, not retried', async () => {
    state.refund = null;
    state.paymentAfter = { status: 'refunded' };
    const res = await cancel(post({}), ctx);
    expect(res.status).toBe(200);
    expect(state.refundCalls).toBe(1);
    expect(row()).toMatchObject({ status: 'cancelled', refunded_inr: 847 });
  });
});

describe('Send to Shiprocket', () => {
  it('sends a paid order', async () => {
    const res = await send(post({ weight_kg: 0.5, length_cm: 10, breadth_cm: 10, height_cm: 10 }), ctx);
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ status: 'sent_to_shiprocket', shiprocket_order_id: 'SR1', shiprocket_sending_at: null });
  });

  it('refuses an order whose refund has started', async () => {
    Object.assign(row(), { refund_id: 'pending' });
    const res = await send(post({ weight_kg: 0.5, length_cm: 10, breadth_cm: 10, height_cm: 10 }), ctx);
    expect(res.status).toBe(409);
    expect(state.srCreates).toBe(0);
  });

  it('refuses when a refund is claimed between its read and its claim', async () => {
    state.beforeQuery[2] = () => Object.assign(row(), { refund_id: refundPendingMarker(NOW) });
    const res = await send(post({ weight_kg: 0.5, length_cm: 10, breadth_cm: 10, height_cm: 10 }), ctx);
    expect(res.status).toBe(409);
    expect(state.srCreates).toBe(0);
  });
});
