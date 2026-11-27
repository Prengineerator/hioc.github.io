import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from './helpers/fakeAdmin';
import { makeAdmin, type HarnessState } from './helpers/ownerShopHarness';

// Owner-entered orders after they exist: the Razorpay webhook (payment_link.paid /
// expired / cancelled), the expire-orders cron (30-minute rule skips link orders; a
// link past its 48 hours is read at Razorpay first), and the owner's cancel.

const ID = '7d0c3f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
const NOW = new Date('2026-11-21T10:00:00.000Z');

type Link = { id: string; shortUrl: string | null; status: string; amountPaidPaise: number; expireBy: number | null; payments: { id: string; method?: string; amountPaise?: number; status?: string }[] };
const state: HarnessState & {
  links: Record<string, Link | null>;
  byRef: Record<string, Link | null | 'down'>;
  cancelLinkOk: boolean;
  cancelledLinks: string[];
  refunds: { paymentId: string; amount: number }[];
  emails: string[];
  cafeCaptures: unknown[];
  reversed: string[];
} = {
  tables: {}, admin: null, rpcCalls: [], introEligible: true, coupons: {}, linkedUserId: null,
  links: {}, byRef: {}, cancelLinkOk: true, cancelledLinks: [], refunds: [], emails: [], cafeCaptures: [], reversed: [],
};

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => state.admin }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve({ id: 'owner-1' }) }));
vi.mock('@/lib/api/background', () => ({ runAfterResponse: (p: Promise<unknown>) => void p }));
vi.mock('@/lib/shop/emails', () => ({
  sendShopPaidEmails: (o: { id: string }) => {
    state.emails.push(o.id);
    return Promise.resolve();
  },
  sendShopCancelledEmail: () => Promise.resolve(),
}));
vi.mock('@/lib/payments/gateway', async () => {
  const actual = await vi.importActual<typeof import('@/lib/payments/gateway')>('@/lib/payments/gateway');
  return {
    verifyWebhookSignature: actual.verifyWebhookSignature,
    fetchOrderPaymentAttempts: () => Promise.resolve([]),
    findGatewayPaymentLinkByReference: (ref: string) => {
      const r = state.byRef[ref];
      return Promise.resolve(r === 'down' ? null : { link: r ?? null });
    },
    fetchGatewayPaymentLink: (id: string) => Promise.resolve(state.links[id] ?? null),
    cancelGatewayPaymentLink: (id: string) => {
      state.cancelledLinks.push(id);
      if (!state.cancelLinkOk) return Promise.resolve(null);
      const closed = { id, shortUrl: null, status: 'cancelled', amountPaidPaise: 0, expireBy: null, payments: [] };
      state.links[id] = closed;
      return Promise.resolve(closed);
    },
    createGatewayRefund: (paymentId: string, amount: number) => {
      state.refunds.push({ paymentId, amount });
      return Promise.resolve({ id: 'rfnd_1', status: 'processed' });
    },
  };
});
vi.mock('@/lib/payments/reconcile', () => ({
  captureGatewayPayment: (p: unknown) => {
    state.cafeCaptures.push(p);
    return Promise.resolve({ ok: true });
  },
  markGatewayPaymentFailed: () => Promise.resolve(),
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  earnForShopOrder: () => Promise.resolve(0),
  reverseForShopOrder: (id: string) => {
    state.reversed.push(id);
    return Promise.resolve(0);
  },
}));
vi.mock('@/lib/shop/shiprocket', () => ({
  cancelShiprocketOrder: () => Promise.resolve({ ok: true }),
  fetchShiprocketOrder: () => Promise.resolve({ ok: false, error: 'unused' }),
  isShiprocketConfigured: () => false,
}));

process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec';
const { POST: webhook } = await import('@/app/api/payments/webhook/route');
const { POST: cancel } = await import('@/app/api/owner/shop/orders/[id]/cancel/route');
const { expireStaleShopOrders, expireShopLinkOrders, expireUnlinkedShopLinkOrders } = await import('@/lib/shop/lifecycle');

const shopRow = (patch: Row = {}): Row => ({
  id: ID, order_number: 1042, status: 'payment_pending', source: 'owner', payment_channel: 'payment_link',
  razorpay_order_id: null, razorpay_payment_id: null, razorpay_payment_link_id: 'plink_1',
  payment_link_url: 'https://rzp.io/i/test1', payment_link_expires_at: '2026-11-21T08:00:00.000Z',
  total_inr: 1349, subtotal_inr: 1449, discount_inr: 100, owner_discount_inr: 100, shipping_inr: 0, jar_count: 3,
  lines: [], customer_name: 'Test Customer', phone: '+919876543210', email: '', intro_offer_applied: false, coupon_id: null,
  capture_effects_at: null, cancel_reason: '', refund_id: null, refunded_inr: null, created_at: '2026-11-19T08:00:00.000Z',
  ...patch,
});
const row = () => (state.tables.shop_orders as Row[])[0];

beforeEach(() => {
  state.tables = { shop_orders: [shopRow()] };
  state.admin = makeAdmin(state);
  state.rpcCalls = [];
  state.links = {};
  state.byRef = {};
  state.cancelLinkOk = true;
  state.cancelledLinks = [];
  state.refunds = [];
  state.emails = [];
  state.cafeCaptures = [];
  state.reversed = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function hook(event: string, payload: Record<string, unknown>, secret = 'whsec') {
  const raw = JSON.stringify({ event, payload });
  return webhook(
    new Request('http://localhost/api/payments/webhook', {
      method: 'POST',
      headers: { 'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex') },
      body: raw,
    }),
  );
}
const paid = (over: { amount?: number; linkId?: string; notes?: Record<string, unknown> } = {}) => ({
  payment_link: { entity: { id: over.linkId ?? 'plink_1', amount_paid: 134900, notes: over.notes ?? { shop_order_id: ID } } },
  payment: { entity: { id: 'pay_L1', method: 'upi', amount: over.amount ?? 134900, order_id: 'order_BEHIND_LINK' } },
});

describe('webhook payment_link.paid', () => {
  it('marks the order paid once (₹1,349 = 134900p), keeps the payment id and method, and runs the capture effects', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ intro_offer_applied: true });
    expect((await hook('payment_link.paid', paid())).status).toBe(200);
    expect(row()).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_L1', payment_method: 'upi' });
    expect(row().paid_at).toBeTruthy();
    expect(row().capture_effects_at).toBeTruthy();
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(['claim_shop_intro_offer']);
    // A second delivery (Razorpay retries) changes nothing and sends nothing more.
    await hook('payment_link.paid', paid());
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.emails).toHaveLength(1);
    expect(state.cafeCaptures).toHaveLength(0);
  });

  it('finds the order by the shop_order_id note when the link id is not on the row', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ razorpay_payment_link_id: null });
    await hook('payment_link.paid', paid());
    expect(row().status).toBe('paid');
  });

  it('does not use the note for another link’s order, or for an order that is not a link order', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ razorpay_payment_link_id: 'plink_OTHER' });
    await hook('payment_link.paid', paid());
    expect(row().status).toBe('payment_pending');
    (state.tables.shop_orders as Row[])[0] = shopRow({ razorpay_payment_link_id: null, payment_channel: 'checkout' });
    await hook('payment_link.paid', paid());
    expect(row().status).toBe('payment_pending');
  });

  it('a payment of the wrong amount is NOT captured; it is logged for the owner to reconcile', async () => {
    await hook('payment_link.paid', paid({ amount: 100000 }));
    expect(row().status).toBe('payment_pending');
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).includes('AMOUNT MISMATCH'))).toBe(true);
  });

  it('a paid link that matches no shop order logs loudly (link, payment, amount only) and changes nothing', async () => {
    await hook('payment_link.paid', paid({ linkId: 'plink_STRANGER', notes: { shop_order_id: '11111111-2222-4333-8444-555555555555' } }));
    expect(row().status).toBe('payment_pending');
    const lines = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    const loud = lines.find((l) => l.includes('UNMATCHED PAID LINK'));
    expect(loud).toContain('plink_STRANGER');
    expect(loud).toContain('pay_L1');
    expect(loud).toContain('134900p');
    expect(loud).not.toMatch(/Test Customer|9876543210/);
  });

  it('a KEPT order (no link fields yet) is found by the note and paid, with its link fields written in the same update', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ razorpay_payment_link_id: null, payment_link_url: null, payment_link_expires_at: null });
    const p = paid();
    (p.payment_link.entity as Record<string, unknown>).short_url = 'https://rzp.io/i/hook';
    (p.payment_link.entity as Record<string, unknown>).expire_by = 1790000000;
    await hook('payment_link.paid', p);
    expect(row()).toMatchObject({
      status: 'paid', razorpay_payment_link_id: 'plink_1', payment_link_url: 'https://rzp.io/i/hook',
      payment_link_expires_at: new Date(1790000000 * 1000).toISOString(),
    });
  });

  it('a signature that does not verify trusts nothing', async () => {
    const res = await hook('payment_link.paid', paid(), 'wrong-secret');
    expect(res.status).toBe(400);
    expect(row().status).toBe('payment_pending');
  });

  const errLines = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

  it('a payment on a CANCELLED order is not marked paid, and is logged loudly (ids and amount only)', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ status: 'cancelled' });
    await hook('payment_link.paid', paid());
    expect(row().status).toBe('cancelled');
    expect(state.emails).toHaveLength(0);
    const loud = errLines().find((l) => l.includes('PAID LINK ON CANCELLED ORDER'));
    expect(loud).toContain(ID);
    expect(loud).toContain('plink_1');
    expect(loud).toContain('pay_L1');
    expect(loud).toContain('134900p');
    expect(loud).toContain('refund by hand');
    expect(loud).not.toMatch(/Test Customer|9876543210/);
  });

  it('a payment on an EXPIRED order is honoured (the money was taken), as for website orders', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ status: 'expired' });
    await hook('payment_link.paid', paid());
    expect(row()).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_L1' });
    expect(errLines().some((l) => l.includes('PAID LINK ON'))).toBe(false);
  });

  it('a payment on an order already paid by a DIFFERENT payment is logged; the same payment again is quiet', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ status: 'paid', razorpay_payment_id: 'pay_OTHER' });
    await hook('payment_link.paid', paid());
    expect(errLines().some((l) => l.includes('PAID LINK ON PAID ORDER') && l.includes('pay_L1'))).toBe(true);
    expect(row().razorpay_payment_id).toBe('pay_OTHER');
    (console.error as unknown as { mockClear: () => void }).mockClear();
    (state.tables.shop_orders as Row[])[0] = shopRow({ status: 'paid', razorpay_payment_id: 'pay_L1', capture_effects_at: '2026-11-19T09:00:00.000Z' });
    await hook('payment_link.paid', paid());
    expect(errLines().some((l) => l.includes('PAID LINK ON'))).toBe(false);
  });
});

describe('webhook payment_link.expired / payment_link.cancelled', () => {
  it('expired: an unpaid order becomes expired, nothing is refunded', async () => {
    await hook('payment_link.expired', { payment_link: { entity: { id: 'plink_1', notes: { shop_order_id: ID } } } });
    expect(row()).toMatchObject({ status: 'expired' });
    expect(state.refunds).toHaveLength(0);
  });

  it('cancelled: an unpaid order becomes cancelled', async () => {
    await hook('payment_link.cancelled', { payment_link: { entity: { id: 'plink_1', notes: {} } } });
    expect(row()).toMatchObject({ status: 'cancelled' });
    expect(row().cancelled_at).toBeTruthy();
  });

  it('a paid order is never moved by an expired / cancelled event', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ status: 'paid' });
    await hook('payment_link.expired', { payment_link: { entity: { id: 'plink_1' } } });
    await hook('payment_link.cancelled', { payment_link: { entity: { id: 'plink_1' } } });
    expect(row().status).toBe('paid');
  });

  it('café and website events still go the old way (a payment.captured for no shop order reaches the café)', async () => {
    await hook('payment.captured', { payment: { entity: { id: 'pay_C', order_id: 'order_CAFE', method: 'upi', amount: 20000 } } });
    expect(state.cafeCaptures).toEqual([expect.objectContaining({ gatewayOrderId: 'order_CAFE', gatewayPaymentId: 'pay_C' })]);
    expect(row().status).toBe('payment_pending');
  });
});

describe('expire-orders: shop pass', () => {
  it('the 30-minute rule SKIPS a payment-link order (created two days ago, link still good)', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ payment_link_expires_at: '2026-11-22T08:00:00.000Z', created_at: '2026-11-20T08:00:00.000Z' });
    state.links.plink_1 = { id: 'plink_1', shortUrl: null, status: 'created', amountPaidPaise: 0, expireBy: null, payments: [] };
    const r = await expireStaleShopOrders(state.admin as never, NOW);
    expect(r).toEqual({ expired: 0, recovered: 0 });
    expect(row().status).toBe('payment_pending');
    expect(state.cancelledLinks).toHaveLength(0);
  });

  it('a website checkout older than 30 minutes still expires as before', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ payment_channel: 'checkout', razorpay_payment_link_id: null, razorpay_order_id: null, created_at: '2026-11-21T09:00:00.000Z', source: 'web' });
    const r = await expireStaleShopOrders(state.admin as never, NOW);
    expect(r.expired).toBe(1);
    expect(row().status).toBe('expired');
  });

  it('past its 48 hours the link is read first: expired at Razorpay -> the order expires, nothing charged', async () => {
    state.links.plink_1 = { id: 'plink_1', shortUrl: null, status: 'expired', amountPaidPaise: 0, expireBy: null, payments: [] };
    const r = await expireShopLinkOrders(state.admin as never, NOW);
    expect(r).toEqual({ expired: 1, recovered: 0 });
    expect(row().status).toBe('expired');
    expect(state.refunds).toHaveLength(0);
  });

  it('past its 48 hours but PAID at Razorpay: it is captured, not expired (₹1,349)', async () => {
    state.links.plink_1 = {
      id: 'plink_1', shortUrl: null, status: 'paid', amountPaidPaise: 134900, expireBy: null,
      payments: [{ id: 'pay_L2', method: 'card', amountPaise: 134900, status: 'captured' }],
    };
    const r = await expireStaleShopOrders(state.admin as never, NOW);
    expect(r.recovered).toBe(1);
    expect(row()).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_L2', payment_method: 'card' });
  });

  it('Razorpay unreachable: the order is left for the next run', async () => {
    state.links = {}; // fetch answers null
    const r = await expireShopLinkOrders(state.admin as never, NOW);
    expect(r).toEqual({ expired: 0, recovered: 0 });
    expect(row().status).toBe('payment_pending');
  });

  it('a link still open at Razorpay is cancelled there first; if that fails the order waits', async () => {
    state.links.plink_1 = { id: 'plink_1', shortUrl: null, status: 'created', amountPaidPaise: 0, expireBy: null, payments: [] };
    state.cancelLinkOk = false;
    expect((await expireShopLinkOrders(state.admin as never, NOW)).expired).toBe(0);
    expect(row().status).toBe('payment_pending');
    state.cancelLinkOk = true;
    expect((await expireShopLinkOrders(state.admin as never, NOW)).expired).toBe(1);
    expect(row().status).toBe('expired');
  });

  it('a link not yet past its expiry is left alone', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ payment_link_expires_at: '2026-11-22T08:00:00.000Z' });
    state.links.plink_1 = { id: 'plink_1', shortUrl: null, status: 'expired', amountPaidPaise: 0, expireBy: null, payments: [] };
    expect((await expireShopLinkOrders(state.admin as never, NOW)).expired).toBe(0);
    expect(row().status).toBe('payment_pending');
  });
});

describe('expire-orders: link orders with no stored link id', () => {
  const kept = (patch: Row = {}) => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ razorpay_payment_link_id: null, payment_link_url: null, payment_link_expires_at: null, created_at: '2026-11-21T09:00:00.000Z', ...patch });
  };
  const open = { id: 'plink_R', shortUrl: 'https://rzp.io/i/found', status: 'created', amountPaidPaise: 0, expireBy: 1790000000, payments: [] };

  it('younger than 10 minutes: not looked up at all', async () => {
    kept({ created_at: '2026-11-21T09:55:00.000Z' });
    state.byRef = { 'HIOC-S1042': open };
    await expireUnlinkedShopLinkOrders(state.admin as never, NOW);
    expect(row().razorpay_payment_link_id ?? null).toBeNull();
  });

  it('a link found by reference is stored on the order, which stays unpaid', async () => {
    kept();
    state.byRef = { 'HIOC-S1042': open };
    const r = await expireStaleShopOrders(state.admin as never, NOW);
    expect(r).toEqual({ expired: 0, recovered: 0 });
    expect(row()).toMatchObject({ status: 'payment_pending', razorpay_payment_link_id: 'plink_R', payment_link_url: 'https://rzp.io/i/found' });
  });

  it('a link found already paid is captured (₹1,349)', async () => {
    kept();
    state.byRef = {
      'HIOC-S1042': { ...open, status: 'paid', amountPaidPaise: 134900, payments: [{ id: 'pay_R', method: 'upi', amountPaise: 134900, status: 'captured' }] },
    };
    const r = await expireStaleShopOrders(state.admin as never, NOW);
    expect(r.recovered).toBe(1);
    expect(row()).toMatchObject({ status: 'paid', razorpay_payment_id: 'pay_R', razorpay_payment_link_id: 'plink_R' });
  });

  it('another order\'s paid link with the same total is NOT captured or stored; retry later', async () => {
    kept();
    state.byRef = {
      'HIOC-S1042': {
        ...open, status: 'paid', amountPaidPaise: 134900, referenceId: 'HIOC-S1042', notes: { shop_order_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd' },
        payments: [{ id: 'pay_X', method: 'upi', amountPaise: 134900, status: 'captured' }],
      } as never,
    };
    const r = await expireStaleShopOrders(state.admin as never, NOW);
    expect(r).toEqual({ expired: 0, recovered: 0 });
    expect(row().status).toBe('payment_pending');
    expect(row().razorpay_payment_link_id ?? null).toBeNull();
  });

  it('none found: kept while under 48 hours, expired after', async () => {
    kept();
    state.byRef = { 'HIOC-S1042': null };
    expect((await expireUnlinkedShopLinkOrders(state.admin as never, NOW)).expired).toBe(0);
    expect(row().status).toBe('payment_pending');
    kept({ created_at: '2026-11-19T08:00:00.000Z' });
    expect((await expireUnlinkedShopLinkOrders(state.admin as never, NOW)).expired).toBe(1);
    expect(row().status).toBe('expired');
  });

  it('Razorpay unreachable: even a 3-day-old order is left for the next run', async () => {
    kept({ created_at: '2026-11-18T08:00:00.000Z' });
    state.byRef = { 'HIOC-S1042': 'down' };
    expect((await expireUnlinkedShopLinkOrders(state.admin as never, NOW)).expired).toBe(0);
    expect(row().status).toBe('payment_pending');
  });
});

describe('POST /api/owner/shop/orders/[id]/cancel', () => {
  const req = (body: unknown = {}) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) });
  const params = { params: { id: ID } };

  it('an unpaid link order: the link is cancelled at Razorpay, the order is cancelled, no refund', async () => {
    const res = await cancel(req({ reason: 'customer changed mind' }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).order.status).toBe('cancelled');
    expect(state.cancelledLinks).toEqual(['plink_1']);
    expect(state.refunds).toHaveLength(0);
    expect(row()).toMatchObject({ status: 'cancelled', cancel_reason: 'customer changed mind' });
  });

  it('if Razorpay will not cancel the link, the order is left as it was (502)', async () => {
    state.cancelLinkOk = false;
    state.links.plink_1 = { id: 'plink_1', shortUrl: null, status: 'created', amountPaidPaise: 0, expireBy: null, payments: [] };
    const res = await cancel(req(), params);
    expect(res.status).toBe(502);
    expect(row().status).toBe('payment_pending');
  });

  it('if the link was paid a moment ago, the order is captured instead and the cancel answers 409', async () => {
    state.cancelLinkOk = false;
    state.links.plink_1 = {
      id: 'plink_1', shortUrl: null, status: 'paid', amountPaidPaise: 134900, expireBy: null,
      payments: [{ id: 'pay_L3', method: 'upi', amountPaise: 134900, status: 'captured' }],
    };
    const res = await cancel(req(), params);
    expect(res.status).toBe(409);
    expect(row().status).toBe('paid');
  });

  it('a paid OFFLINE order: cancelled, refunded_inr = total, no Razorpay refund, "refund by hand"', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({
      status: 'paid', payment_channel: 'offline', offline_method: 'cash', razorpay_payment_link_id: null, payment_link_url: null,
      total_inr: 1750, capture_effects_at: '2026-11-19T09:00:00.000Z',
    });
    const res = await cancel(req({ reason: 'customer returned it' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refund_by_hand).toBe(true);
    expect(body.order).toMatchObject({ status: 'cancelled', refunded_inr: 1750, refund_id: null });
    expect(row().cancel_reason).toBe('customer returned it (refund by hand)');
    expect(state.refunds).toHaveLength(0);
    expect(state.reversed).toEqual([ID]); // Beanies reversed as today (and the intro claim released)
    // A second click finds it cancelled.
    expect((await cancel(req(), params)).status).toBe(409);
  });

  it('a payment-link order paid through Razorpay is refunded through Razorpay (₹1,349)', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ status: 'paid', razorpay_payment_id: 'pay_L1' });
    const res = await cancel(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.refund_by_hand).toBeUndefined();
    expect(body.order).toMatchObject({ status: 'cancelled', refund_id: 'rfnd_1', refunded_inr: 1349 });
    expect(state.refunds).toEqual([{ paymentId: 'pay_L1', amount: 1349 }]);
  });

  it('an unpaid link order with NO stored link id: the link is found by reference and cancelled (result checked) before the order', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ razorpay_payment_link_id: null, payment_link_url: null, payment_link_expires_at: null });
    state.byRef = { 'HIOC-S1042': { id: 'plink_R', shortUrl: 'https://rzp.io/i/found', status: 'created', amountPaidPaise: 0, expireBy: 1790000000, payments: [] } };
    const res = await cancel(req(), params);
    expect(res.status).toBe(200);
    expect(state.cancelledLinks).toEqual(['plink_R']);
    expect(row().status).toBe('cancelled');
  });

  it('no stored link id and the cancel is refused: 502, the order is untouched', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ razorpay_payment_link_id: null, payment_link_url: null, payment_link_expires_at: null });
    state.byRef = { 'HIOC-S1042': { id: 'plink_R', shortUrl: 'https://rzp.io/i/found', status: 'created', amountPaidPaise: 0, expireBy: 1790000000, payments: [] } };
    state.cancelLinkOk = false;
    expect((await cancel(req(), params)).status).toBe(502);
    expect(row().status).toBe('payment_pending');
  });

  it('no stored link id and Razorpay unreachable: 502, nothing changed; none found: the order is cancelled', async () => {
    (state.tables.shop_orders as Row[])[0] = shopRow({ razorpay_payment_link_id: null, payment_link_url: null, payment_link_expires_at: null });
    state.byRef = { 'HIOC-S1042': 'down' };
    expect((await cancel(req(), params)).status).toBe(502);
    expect(row().status).toBe('payment_pending');
    state.byRef = { 'HIOC-S1042': null };
    expect((await cancel(req(), params)).status).toBe(200);
    expect(row().status).toBe('cancelled');
    expect(state.cancelledLinks).toHaveLength(0);
  });
});
