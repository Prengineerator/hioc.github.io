import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from './helpers/fakeAdmin';
import { fakeServerQuote, KEY, makeAdmin, ownerBody, type HarnessState } from './helpers/ownerShopHarness';

// POST /api/owner/shop/orders, POST /api/owner/shop/quote, GET /api/owner/shop/customer
// and the resend-link route: owner only, priced by the server, idempotent, link or offline.
// The database is an in-memory fake; Razorpay is mocked. Rupee figures from
// docs/SHOP-OWNER-ORDERS-SPEC.md.

const state: HarnessState & {
  owner: { id: string } | null;
  emails: string[];
  linkCalls: Record<string, unknown>[];
  linkResult: 'ok' | 'unknown' | 'refused' | 'no_url';
  byRef: { link: Record<string, unknown> | null } | null;
  cancelledLinks: string[];
  resent: { id: string; email: boolean }[];
  configured: boolean;
} = {
  tables: {},
  admin: null,
  rpcCalls: [],
  introEligible: true,
  coupons: {},
  linkedUserId: null,
  owner: { id: 'owner-1' },
  emails: [],
  linkCalls: [],
  linkResult: 'ok',
  byRef: { link: null },
  cancelledLinks: [],
  resent: [],
  configured: true,
};

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => state.admin }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(true), clientIp: () => '203.0.113.9' }));
vi.mock('@/lib/api/background', () => ({ runAfterResponse: (p: Promise<unknown>) => void p }));
vi.mock('@/lib/shop/emails', () => ({
  sendShopPaidEmails: (o: { id: string }) => {
    state.emails.push(o.id);
    return Promise.resolve();
  },
}));
vi.mock('@/lib/shop/context', () => ({ serverQuote: (a: unknown, r: never) => fakeServerQuote(state)(a, r) }));
vi.mock('@/lib/loyalty/customerLink', () => ({
  findVerifiedCustomerByPhone: () => Promise.resolve(state.linkedUserId ? { userId: state.linkedUserId, name: 'Linked Name' } : null),
}));
vi.mock('@/lib/payments/gateway', () => ({
  isGatewayConfigured: () => state.configured,
  createGatewayPaymentLink: (input: Record<string, unknown>) => {
    state.linkCalls.push(input);
    if (state.linkResult === 'unknown') return Promise.resolve({ ok: false, definite: false });
    if (state.linkResult === 'refused') return Promise.resolve({ ok: false, definite: true });
    return Promise.resolve({
      ok: true,
      link: {
        id: 'plink_1',
        shortUrl: state.linkResult === 'no_url' ? null : 'https://rzp.io/i/test1',
        status: 'created',
        amountPaidPaise: 0,
        expireBy: input.expireBy,
        payments: [],
      },
    });
  },
  findGatewayPaymentLinkByReference: () => Promise.resolve(state.byRef),
  fetchGatewayPaymentLink: () => Promise.resolve(null),
  cancelGatewayPaymentLink: (id: string) => {
    state.cancelledLinks.push(id);
    return Promise.resolve({ id, shortUrl: null, status: 'cancelled', amountPaidPaise: 0, expireBy: null, payments: [] });
  },
  resendGatewayPaymentLink: (id: string, email: boolean) => {
    state.resent.push({ id, email });
    return Promise.resolve(true);
  },
}));

const { POST: createOrder } = await import('@/app/api/owner/shop/orders/route');
const { POST: quoteRoute } = await import('@/app/api/owner/shop/quote/route');
const { GET: customerRoute } = await import('@/app/api/owner/shop/customer/route');
const { POST: linkRoute } = await import('@/app/api/owner/shop/orders/[id]/payment-link/route');

const post = (body: unknown) => new Request('http://localhost/api/owner/shop/orders', { method: 'POST', body: JSON.stringify(body) });
const orders = () => state.tables.shop_orders as Row[];

beforeEach(() => {
  state.tables = { shop_orders: [] };
  state.admin = makeAdmin(state);
  state.rpcCalls = [];
  state.introEligible = true;
  state.coupons = {};
  state.linkedUserId = null;
  state.owner = { id: 'owner-1' };
  state.emails = [];
  state.linkCalls = [];
  state.linkResult = 'ok';
  state.byRef = { link: null };
  state.cancelledLinks = [];
  state.resent = [];
  state.configured = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('who may use the owner routes', () => {
  it('a non-owner gets 401 from every one, and nothing is written', async () => {
    state.owner = null;
    expect((await createOrder(post(ownerBody()))).status).toBe(401);
    expect((await quoteRoute(post({}))).status).toBe(401);
    expect((await customerRoute(new Request('http://localhost/api/owner/shop/customer?phone=9876543210'))).status).toBe(401);
    expect((await linkRoute(post({ action: 'resend' }), { params: { id: '7d0c3f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f' } })).status).toBe(401);
    expect(orders()).toHaveLength(0);
    expect(state.linkCalls).toHaveLength(0);
  });
});

describe('POST /api/owner/shop/quote', () => {
  const quoteReq = (patch: Record<string, unknown> = {}) =>
    post({ phone: '+91 98765 43210', items: ownerBody().items, ...patch });

  it('example 1: ₹1,449 goods, ₹100 owner discount, free shipping -> ₹1,349', async () => {
    const res = await quoteRoute(quoteReq({ owner_discount_inr: 100 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote).toMatchObject({
      subtotal_inr: 1449, offer_discount_inr: 0, owner_discount_inr: 100, shipping_inr: 0, total_inr: 1349, intro_offer_applied: false, coupon_code: null,
    });
    expect(body.quote.lines).toHaveLength(2);
    expect(Array.isArray(body.quote.notes)).toBe(true);
    expect(body.account_linked).toBe(false);
  });

  it('example 2: two jars for a first-time customer -> ₹648 with the intro offer', async () => {
    const res = await quoteRoute(quoteReq({ items: [{ product_id: 'hazelnut', quantity: 1 }, { product_id: 'vanilla', quantity: 1 }] }));
    expect((await res.json()).quote).toMatchObject({ subtotal_inr: 798, offer_discount_inr: 199, shipping_inr: 49, total_inr: 648, intro_offer_applied: true });
  });

  it('reports a linked account, and says so when a typed coupon does not apply', async () => {
    state.linkedUserId = 'user-9';
    const body = await (await quoteRoute(quoteReq({ coupon_code: 'NOPE' }))).json();
    expect(body.account_linked).toBe(true);
    expect(body.quote.notes).toContain('That code is not valid');
  });

  it('refuses a discount past 50% of the goods (₹725 of ₹1,449), a bad phone, and no items', async () => {
    const over = await quoteRoute(quoteReq({ owner_discount_inr: 725 }));
    expect(over.status).toBe(400);
    expect((await over.json()).error).toMatch(/at most ₹724/);
    expect((await quoteRoute(quoteReq({ phone: '12345' }))).status).toBe(400);
    expect((await quoteRoute(quoteReq({ items: [] }))).status).toBe(400);
  });
});

describe('GET /api/owner/shop/customer', () => {
  it('offers the saved addresses of the verified account, then the last order, without duplicates', async () => {
    state.linkedUserId = 'user-9';
    state.tables.customer_addresses = [
      { id: 'a1', user_id: 'user-9', label: 'Home', customer_name: 'Test Customer', phone: '+919876543210', address_line1: '12 Test Street, Sample Colony', address_line2: '', landmark: '', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
      { id: 'a2', user_id: 'someone-else', label: 'Work', customer_name: 'Other', phone: '+919876543210', address_line1: 'Not theirs', address_line2: '', landmark: '', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    ];
    state.tables.shop_orders = [
      { id: 's1', phone: '+919876543210', status: 'delivered', created_at: '2026-11-01T00:00:00Z', customer_name: 'Test Customer', email: 'test@example.com', address_line1: '12 Test Street, Sample Colony', address_line2: '', landmark: '', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
    ];
    const res = await customerRoute(new Request('http://localhost/api/owner/shop/customer?phone=%2B919876543210'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: 'Linked Name', email: 'test@example.com', account_linked: true });
    expect(body.user_id).toBeUndefined();
    expect(body.addresses).toHaveLength(1); // the last order's address is the saved one: shown once
    expect(body.addresses[0]).toMatchObject({ label: 'Home', source: 'saved', pincode: '302001' });
  });

  it('with no account, offers the last paid order’s address; a bad phone is 400', async () => {
    state.tables.shop_orders = [
      { id: 's1', phone: '+919876543210', status: 'paid', created_at: '2026-11-01T00:00:00Z', customer_name: 'Test Customer', email: '', address_line1: '12 Test Street, Sample Colony', address_line2: '', landmark: 'Near the park', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
      { id: 's2', phone: '+919876543210', status: 'payment_pending', created_at: '2026-11-05T00:00:00Z', customer_name: 'Unpaid', email: '', address_line1: 'Unpaid attempt address', address_line2: '', landmark: '', city: 'Jaipur', state: 'Rajasthan', pincode: '302001' },
    ];
    const body = await (await customerRoute(new Request('http://localhost/api/owner/shop/customer?phone=9876543210'))).json();
    expect(body.account_linked).toBe(false);
    expect(body.addresses).toEqual([expect.objectContaining({ source: 'last_order', landmark: 'Near the park', address_line1: '12 Test Street, Sample Colony' })]);
    expect((await customerRoute(new Request('http://localhost/api/owner/shop/customer?phone=123'))).status).toBe(400);
  });
});

describe('POST /api/owner/shop/orders — payment link', () => {
  it('prices on the server, saves the order unpaid, makes the link and stores it (example 1: ₹1,349)', async () => {
    state.linkedUserId = 'user-9';
    const res = await createOrder(post(ownerBody({ owner_discount_inr: 100, owner_discount_reason: 'launch week friend', expected_total_inr: 1349 })));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ order_number: 1042, status: 'payment_pending', total_inr: 1349, payment_link_url: 'https://rzp.io/i/test1' });
    expect(new Date(body.payment_link_expires_at).getTime() - Date.now()).toBeGreaterThan(47.9 * 3600_000);

    expect(orders()).toHaveLength(1);
    expect(orders()[0]).toMatchObject({
      status: 'payment_pending', source: 'owner', created_by: 'owner-1', user_id: 'user-9', payment_channel: 'payment_link',
      offline_method: null, payment_reference: null, owner_discount_inr: 100, owner_discount_reason: 'launch week friend',
      subtotal_inr: 1449, discount_inr: 100, shipping_inr: 0, total_inr: 1349, beanies_redeemed: 0, beanies_discount_inr: 0,
      razorpay_payment_link_id: 'plink_1', phone: '+919876543210', email: '',
    });
    // Nothing is claimed until it is paid.
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.emails).toHaveLength(0);

    // Razorpay: ₹1,349, SMS only (no email), reference is the order number.
    expect(state.linkCalls).toHaveLength(1);
    expect(state.linkCalls[0]).toMatchObject({
      amountInr: 1349, referenceId: 'HIOC-S1042', customer: { name: 'Test Customer', contact: '+919876543210' },
      notes: { shop_order_id: orders()[0].id },
    });
    expect((state.linkCalls[0].customer as Record<string, unknown>).email).toBeUndefined();
  });

  it('passes the email to Razorpay when there is one', async () => {
    const b = ownerBody();
    (b.address as Record<string, unknown>).email = 'Customer@Example.com';
    await createOrder(post(b));
    expect((state.linkCalls[0].customer as Record<string, unknown>).email).toBe('customer@example.com');
    expect(orders()[0].email).toBe('customer@example.com');
  });

  const KEPT_MESSAGE = "The order is saved under Awaiting payment, but the payment link isn't confirmed yet. Tap Retry link on the order.";
  const noDetailsLogged = () => {
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).not.toMatch(/details|hint|Failing row|Test Customer|9876543210|Test Street/);
  };

  it('Razorpay refusing outright (4xx) means no link can exist: the row is withdrawn, 502, and the same key can be retried', async () => {
    state.linkResult = 'refused';
    const res = await createOrder(post(ownerBody()));
    expect(res.status).toBe(502);
    expect(orders()).toHaveLength(0);
    state.linkResult = 'ok';
    expect((await createOrder(post(ownerBody()))).status).toBe(201);
    expect(orders()).toHaveLength(1);
  });

  it('an unknown outcome (timeout / 5xx) KEEPS the row, answers 202 link_pending, and never cancels or deletes', async () => {
    state.linkResult = 'unknown';
    const res = await createOrder(post(ownerBody()));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ order_number: 1042, status: 'payment_pending', link_pending: true, message: KEPT_MESSAGE });
    expect(orders()).toHaveLength(1);
    expect(orders()[0]).toMatchObject({ status: 'payment_pending', payment_channel: 'payment_link', source: 'owner' });
    expect(orders()[0].razorpay_payment_link_id ?? null).toBeNull();
    expect(state.cancelledLinks).toHaveLength(0);
    // The same attempt repeated finds the kept order: 202 again, no second order or link call.
    const again = await createOrder(post(ownerBody()));
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ order_id: body.order_id, link_pending: true, reused: true });
    expect(orders()).toHaveLength(1);
    expect(state.linkCalls).toHaveLength(1);
  });

  it('a link made without a usable URL keeps the row (202); nothing is cancelled on the assumption it worked', async () => {
    state.linkResult = 'no_url';
    expect((await createOrder(post(ownerBody()))).status).toBe(202);
    expect(orders()).toHaveLength(1);
    expect(orders()[0].razorpay_payment_link_id ?? null).toBeNull();
    expect(state.cancelledLinks).toHaveLength(0);
  });

  it('a link made but not saved keeps the row (202), and the logs carry no row details', async () => {
    const real = state.admin as ReturnType<typeof makeAdmin>;
    const failChain: Record<string, unknown> = {};
    Object.assign(failChain, {
      eq: () => failChain,
      is: () => failChain,
      select: () => failChain,
      maybeSingle: () =>
        Promise.resolve({
          data: null,
          error: { code: '23514', message: 'new row violates check constraint', details: 'Failing row contains (Test Customer, +919876543210, 12 Test Street)', hint: 'x' },
        }),
    });
    state.admin = {
      ...real,
      from: (t: string) => {
        const c = real.from(t) as unknown as Record<string, unknown>;
        const upd = c.update as (p: Record<string, unknown>) => unknown;
        c.update = (p: Record<string, unknown>) => ('razorpay_payment_link_id' in p ? failChain : upd(p));
        return c;
      },
    };
    const res = await createOrder(post(ownerBody()));
    expect(res.status).toBe(202);
    expect(orders()).toHaveLength(1);
    expect(state.cancelledLinks).toHaveLength(0);
    noDetailsLogged();
  });

  it('a failed insert logs only the code and message, never the failing row', async () => {
    const real = state.admin as ReturnType<typeof makeAdmin>;
    const insertChain: Record<string, unknown> = {};
    Object.assign(insertChain, {
      select: () => insertChain,
      single: () =>
        Promise.resolve({
          data: null,
          error: { code: '23514', message: 'check violated', details: 'Failing row contains (Test Customer, +919876543210)', hint: 'h' },
        }),
    });
    state.admin = { ...real, from: (t: string) => (t === 'shop_orders' ? { ...(real.from(t) as object), insert: () => insertChain } : real.from(t)) };
    const res = await createOrder(post(ownerBody()));
    expect(res.status).toBe(500);
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => JSON.stringify(c).includes('23514'))).toBe(true);
    noDetailsLogged();
  });

  it('with no Razorpay keys it answers 503 before saving anything', async () => {
    state.configured = false;
    expect((await createOrder(post(ownerBody()))).status).toBe(503);
    expect(orders()).toHaveLength(0);
  });

  it('a repeat of the same attempt gets the same order and link; nothing new is made', async () => {
    const first = await (await createOrder(post(ownerBody()))).json();
    const again = await createOrder(post(ownerBody()));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ order_id: first.order_id, payment_link_url: first.payment_link_url, reused: true });
    expect(orders()).toHaveLength(1);
    expect(state.linkCalls).toHaveLength(1);
  });

  it('the same key with a different order (another discount) is refused, not merged', async () => {
    await createOrder(post(ownerBody()));
    const res = await createOrder(post(ownerBody({ owner_discount_inr: 50, owner_discount_reason: 'regular customer', expected_total_inr: 1399 })));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('idempotency_mismatch');
    expect(orders()).toHaveLength(1);
  });
});

describe('POST /api/owner/shop/orders — checks', () => {
  it('409 with the new quote when the total on the page is not the server’s (₹1,449 shown, ₹1,349 now)', async () => {
    const res = await createOrder(post(ownerBody({ owner_discount_inr: 100, owner_discount_reason: 'launch week friend', expected_total_inr: 1449 })));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('price_changed');
    expect(body.quote).toMatchObject({ total_inr: 1349, owner_discount_inr: 100, subtotal_inr: 1449 });
    expect(orders()).toHaveLength(0);
    expect(state.linkCalls).toHaveLength(0);
  });

  it('refuses a discount without a reason, an over-cap discount, a bad reference and a missing total', async () => {
    expect((await createOrder(post(ownerBody({ owner_discount_inr: 100, expected_total_inr: 1349 })))).status).toBe(400);
    const over = await createOrder(post(ownerBody({ owner_discount_inr: 800, owner_discount_reason: 'too generous', expected_total_inr: 649 })));
    expect(over.status).toBe(400);
    expect((await over.json()).error).toMatch(/at most/);
    expect((await createOrder(post(ownerBody({ payment: { kind: 'offline', method: 'cash', reference: 'ab' } })))).status).toBe(400);
    expect((await createOrder(post(ownerBody({ payment: { kind: 'offline', method: 'cheque', reference: 'abc123' } })))).status).toBe(400);
    const noTotal = ownerBody();
    delete noTotal.expected_total_inr;
    expect((await createOrder(post(noTotal))).status).toBe(400);
    expect((await createOrder(post(ownerBody({ idempotency_key: 'nope' })))).status).toBe(400);
    expect(orders()).toHaveLength(0);
  });

  it('an invalid typed email is refused, a blank one is fine', async () => {
    const b = ownerBody();
    (b.address as Record<string, unknown>).email = 'not-an-email';
    const res = await createOrder(post(b));
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('email');
  });
});

describe('POST /api/owner/shop/orders — already paid (offline)', () => {
  const offline = (patch: Record<string, unknown> = {}) =>
    ownerBody({ payment: { kind: 'offline', method: 'upi_direct', reference: 'UPI 4321' }, ...patch });

  it('example 3: a repeat customer pays ₹1,750 by UPI: straight to paid, nothing sent to Razorpay', async () => {
    state.introEligible = false;
    const res = await createOrder(
      post(offline({ items: [{ product_id: 'hb-1000', quantity: 1, grind: 'espresso' }], expected_total_inr: 1750 })),
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'paid', total_inr: 1750, payment_link_url: null, payment_link_expires_at: null });
    expect(orders()[0]).toMatchObject({
      status: 'paid', source: 'owner', payment_channel: 'offline', offline_method: 'upi_direct', payment_method: 'upi_direct',
      payment_reference: 'UPI 4321', total_inr: 1750, razorpay_payment_id: null,
    });
    expect(orders()[0].razorpay_payment_link_id ?? null).toBeNull();
    expect(orders()[0].paid_at).toBeTruthy();
    expect(orders()[0].capture_effects_at).toBeTruthy();
    expect(state.linkCalls).toHaveLength(0);
  });

  it('claims the intro offer and records the coupon through the same capture step (₹648 for two jars)', async () => {
    state.coupons = {};
    const res = await createOrder(
      post(offline({ items: [{ product_id: 'hazelnut', quantity: 1 }, { product_id: 'vanilla', quantity: 1 }], expected_total_inr: 648 })),
    );
    expect(res.status).toBe(201);
    expect(orders()[0]).toMatchObject({ status: 'paid', intro_offer_applied: true, offer_discount_inr: 199, total_inr: 648 });
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(['claim_shop_intro_offer']);
    expect(state.rpcCalls[0].args).toEqual({ p_shop_order_id: orders()[0].id });
  });

  it('records a coupon redemption when a coupon was used (₹1,050 goods, 10% off = ₹105)', async () => {
    state.coupons = {
      TEN: { id: 'c1', code: 'TEN', discount_type: 'percent', discount_value: 10, min_order_inr: 0, max_discount_inr: 0, shop_product_ids: [], is_auto: false },
    };
    state.introEligible = false;
    const res = await createOrder(
      post(offline({ items: [{ product_id: 'hb-250', quantity: 2, grind: 'filter' }], coupon_code: 'ten', expected_total_inr: 945 })),
    );
    expect(res.status).toBe(201);
    expect(orders()[0]).toMatchObject({ coupon_code: 'TEN', coupon_discount_inr: 105, total_inr: 945, status: 'paid' });
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(['record_shop_coupon_redemption']);
  });

  it('a repeat tap does not capture again: one order, one claim, one email pass', async () => {
    const items = [{ product_id: 'hazelnut', quantity: 1 }, { product_id: 'vanilla', quantity: 1 }];
    const first = await createOrder(post(offline({ items, expected_total_inr: 648 })));
    const again = await createOrder(post(offline({ items, expected_total_inr: 648 })));
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ reused: true, status: 'paid' });
    expect(orders()).toHaveLength(1);
    expect(state.rpcCalls.filter((c) => c.fn === 'claim_shop_intro_offer')).toHaveLength(1);
    expect(state.emails).toHaveLength(1);
  });

  it('finishes an offline order a crash left unpaid, when the same attempt is retried', async () => {
    const first = await createOrder(post(offline()));
    expect(first.status).toBe(201);
    // Simulate the crash: the row exists, still waiting.
    Object.assign(orders()[0], { status: 'payment_pending', paid_at: null, capture_effects_at: null });
    const again = await createOrder(post(offline()));
    expect(again.status).toBe(200);
    expect(orders()[0].status).toBe('paid');
  });
});

describe('POST /api/owner/shop/orders/[id]/payment-link', () => {
  const ID = '7d0c3f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
  const resend = () => linkRoute(post({ action: 'resend' }), { params: { id: ID } });
  const seed = (patch: Row = {}) => {
    state.tables.shop_orders = [
      { id: ID, status: 'payment_pending', payment_channel: 'payment_link', razorpay_payment_link_id: 'plink_1', payment_link_url: 'https://rzp.io/i/test1', email: '', ...patch },
    ];
  };

  it('sends the link again by text only when there is no email, and by email too when there is', async () => {
    seed();
    const res = await resend();
    expect(await res.json()).toEqual({ ok: true, payment_link_url: 'https://rzp.io/i/test1' });
    seed({ email: 'customer@example.com' });
    await resend();
    expect(state.resent).toEqual([{ id: 'plink_1', email: false }, { id: 'plink_1', email: true }]);
  });

  it('refuses an order that is not waiting on its link', async () => {
    seed({ status: 'paid' });
    expect((await resend()).status).toBe(409);
    seed({ payment_channel: 'checkout' });
    expect((await resend()).status).toBe(409);
    expect(state.resent).toHaveLength(0);
  });
});

describe('POST /api/owner/shop/orders/[id]/payment-link — retry', () => {
  const ID = '7d0c3f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
  const retry = () => linkRoute(post({ action: 'retry' }), { params: { id: ID } });
  const seed = (patch: Row = {}) => {
    state.tables.shop_orders = [
      {
        id: ID, order_number: 1042, status: 'payment_pending', payment_channel: 'payment_link', source: 'owner', razorpay_payment_link_id: null,
        payment_link_url: null, payment_link_expires_at: null, total_inr: 1349, customer_name: 'Test Customer', phone: '+919876543210', email: '',
        created_at: '2026-11-19T08:00:00.000Z', capture_effects_at: null, intro_offer_applied: false, coupon_id: null, ...patch,
      },
    ];
  };
  const link = (over: Record<string, unknown> = {}) => ({
    id: 'plink_R', shortUrl: 'https://rzp.io/i/found', status: 'created', amountPaidPaise: 0, expireBy: 1790000000, payments: [], ...over,
  });

  it('resend answers 409 while no link is stored', async () => {
    seed();
    expect((await linkRoute(post({ action: 'resend' }), { params: { id: ID } })).status).toBe(409);
  });

  it('a link already made at Razorpay (found by reference HIOC-S1042) is stored on the order, no new one is made', async () => {
    seed();
    state.byRef = { link: link() };
    const res = await retry();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, payment_link_url: 'https://rzp.io/i/found' });
    expect(body.payment_link_expires_at).toBe(new Date(1790000000 * 1000).toISOString());
    expect(orders()[0]).toMatchObject({ razorpay_payment_link_id: 'plink_R', payment_link_url: 'https://rzp.io/i/found', status: 'payment_pending' });
    expect(state.linkCalls).toHaveLength(0);
  });

  it('a link found already PAID by reference is captured (₹1,349), with its link fields stored in the same update', async () => {
    seed();
    state.byRef = { link: link({ status: 'paid', amountPaidPaise: 134900, payments: [{ id: 'pay_R', method: 'upi', amountPaise: 134900, status: 'captured' }] }) };
    const res = await retry();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('paid');
    expect(orders()[0]).toMatchObject({
      status: 'paid', razorpay_payment_id: 'pay_R', razorpay_payment_link_id: 'plink_R', payment_link_url: 'https://rzp.io/i/found',
    });
    expect(orders()[0].payment_link_expires_at).toBeTruthy();
    expect(state.linkCalls).toHaveLength(0);
  });

  it('none found: a new link is made and stored', async () => {
    seed();
    state.byRef = { link: null };
    const res = await retry();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, payment_link_url: 'https://rzp.io/i/test1' });
    expect(state.linkCalls).toHaveLength(1);
    expect(orders()[0].razorpay_payment_link_id).toBe('plink_1');
  });

  it('Razorpay unreachable, or the new link unconfirmed: 502 and nothing changed', async () => {
    seed();
    state.byRef = null;
    expect((await retry()).status).toBe(502);
    expect(state.linkCalls).toHaveLength(0);
    state.byRef = { link: null };
    state.linkResult = 'unknown';
    expect((await retry()).status).toBe(502);
    expect(orders()[0].razorpay_payment_link_id ?? null).toBeNull();
    expect(orders()[0].status).toBe('payment_pending');
  });

  it('an order that already has its link just answers with it; a paid or website order is 409', async () => {
    seed({ razorpay_payment_link_id: 'plink_1', payment_link_url: 'https://rzp.io/i/test1', payment_link_expires_at: '2026-11-21T08:00:00.000Z' });
    expect((await (await retry()).json()).payment_link_url).toBe('https://rzp.io/i/test1');
    expect(state.linkCalls).toHaveLength(0);
    seed({ status: 'paid' });
    expect((await retry()).status).toBe(409);
    seed({ payment_channel: 'checkout' });
    expect((await retry()).status).toBe(409);
  });
});

describe('GET /api/owner/shop/products', () => {
  it('401 for a non-owner; the owner gets only listed, in-stock products with the client fields', async () => {
    const { GET } = await import('@/app/api/owner/shop/products/route');
    state.owner = null;
    expect((await GET(new Request('http://localhost/api/owner/shop/products'))).status).toBe(401);
    state.owner = { id: 'owner-1' };
    state.tables.shop_products = [
      { id: 'classic', name: 'Signature Classic', sku: 'S1', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1, line: 'instant', display_name: 'Signature Classic', pack_grams: 50, ship_weight_kg: 0.3, listed: true, requires_grind: false, description: '' },
      { id: 'soldout', name: 'Sold Out', sku: 'S2', price_inr: 399, net_qty: '50 g', in_stock: false, sort_order: 2, line: 'instant', listed: true },
      { id: 'hidden', name: 'Hidden', sku: 'S3', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 3, line: 'instant', listed: false },
    ];
    const res = await GET(new Request('http://localhost/api/owner/shop/products'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const { products } = await res.json();
    expect(products).toEqual([
      { id: 'classic', name: 'Signature Classic', display_name: 'Signature Classic', line: 'instant', pack_grams: 50, price_inr: 399, in_stock: true, requires_grind: false, sort_order: 1, net_qty: '50 g' },
    ]);
  });
});
