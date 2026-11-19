import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shopOrder } from './helpers/shopFixture';

// Small pieces of the owner-entered order work: the Razorpay Payment Links client, the
// emails (no owner alert, none without an email), the CSV columns and old-row reading.

const sent: { to: string; subject: string }[] = [];
vi.mock('@/lib/notifications/adapters', () => ({
  emailAdapter: { send: (m: { to: string; subject: string }) => { sent.push({ to: m.to, subject: m.subject }); return Promise.resolve({ ok: true }); } },
}));
vi.mock('@/lib/reports/ownerDigestServer', () => ({ ownerLoginEmails: () => Promise.resolve(['owner@example.com']) }));
vi.mock('@/lib/loyalty/ledger', () => ({ getLoyaltyConfig: () => Promise.resolve(null), computeEarnedPoints: () => 0, shopEarnBaseInr: () => 0 }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => ({}) }));

process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';

const { sendShopPaidEmails, sendShopCancelledEmail, sendShopShippedEmail } = await import('@/lib/shop/emails');
const gateway = await import('@/lib/payments/gateway');
const { shopOrdersCsvTable } = await import('@/lib/shop/owner');
const { toShopOrderRow } = await import('@/lib/shop/server');
const { shopOrderDiscountBreakdown } = await import('@/lib/shop/status');

beforeEach(() => {
  sent.length = 0;
  vi.restoreAllMocks();
});

describe('emails for owner-entered orders', () => {
  it('a website order still alerts the owner and thanks the customer', async () => {
    await sendShopPaidEmails(shopOrder());
    expect(sent.map((m) => m.to).sort()).toEqual(['owner@example.com', 'riya@example.com']);
  });

  it('an owner-entered order with an email: only the customer’s confirmation, no alert to the owner', async () => {
    await sendShopPaidEmails(shopOrder({ source: 'owner' }));
    expect(sent.map((m) => m.to)).toEqual(['riya@example.com']);
  });

  it('an owner-entered order with no email sends nothing, at paid, shipped or cancelled', async () => {
    const o = shopOrder({ source: 'owner', email: '' });
    await sendShopPaidEmails(o);
    await sendShopShippedEmail(o);
    await sendShopCancelledEmail(o);
    expect(sent).toHaveLength(0);
  });
});

describe('Razorpay Payment Links client', () => {
  const fetchMock = (body: unknown, status = 200) => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('creates a link: paise, INR, no partial payment, 48h expiry, SMS always, email only when there is one', async () => {
    const f = fetchMock({ id: 'plink_9', short_url: 'https://rzp.io/i/abc', status: 'created', amount_paid: 0, expire_by: 1790000000 });
    const link = await gateway.createGatewayPaymentLink({
      amountInr: 1349, referenceId: 'HIOC-S1042', description: 'HIOC. order HIOC-S1042',
      customer: { name: 'Test Customer', contact: '+919876543210' }, expireBy: 1790000000,
      notes: { shop_order_id: 'abc' }, callbackUrl: 'https://example.test/shop/order/abc',
    });
    expect(link).toMatchObject({ ok: true, link: { id: 'plink_9', shortUrl: 'https://rzp.io/i/abc', status: 'created', expireBy: 1790000000 } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.razorpay.com/v1/payment_links');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      amount: 134900, currency: 'INR', accept_partial: false, expire_by: 1790000000, reference_id: 'HIOC-S1042',
      notify: { sms: true, email: false }, reminder_enable: true, notes: { shop_order_id: 'abc' },
      customer: { name: 'Test Customer', contact: '+919876543210' }, callback_url: 'https://example.test/shop/order/abc',
    });
    expect(JSON.parse(init.body as string).customer.email).toBeUndefined();

    await gateway.createGatewayPaymentLink({
      amountInr: 1349, referenceId: 'HIOC-S1042', description: 'd',
      customer: { name: 'Test Customer', contact: '+919876543210', email: 'a@example.com' }, expireBy: 1790000000, notes: {}, callbackUrl: '/shop/order/abc',
    });
    const second = JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(second.notify).toEqual({ sms: true, email: true });
    expect(second.callback_url).toBeUndefined(); // a bare path is not sent
  });

  it('never throws; says whether the failure is definite (a 4xx: no link exists) or unknown (5xx, network, odd answer)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = { amountInr: 500, referenceId: 'r', description: 'd', customer: { name: 'N', contact: '+919876543210' }, expireBy: 1, notes: {}, callbackUrl: '' };
    fetchMock({ error: { description: 'nope' } }, 400);
    expect(await gateway.createGatewayPaymentLink(input)).toEqual({ ok: false, definite: true });
    fetchMock({ error: {} }, 502);
    expect(await gateway.createGatewayPaymentLink(input)).toEqual({ ok: false, definite: false });
    fetchMock({ id: 5 }, 200); // an answer we can't read: the link may exist
    expect(await gateway.createGatewayPaymentLink(input)).toEqual({ ok: false, definite: false });
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('timeout'))));
    expect(await gateway.createGatewayPaymentLink(input)).toEqual({ ok: false, definite: false });
    // Nothing was sent for ₹0: definite.
    const f = fetchMock({});
    expect(await gateway.createGatewayPaymentLink({ ...input, amountInr: 0 })).toEqual({ ok: false, definite: true });
    expect(f).not.toHaveBeenCalled();
    // The error log never carries the answer body.
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls)).not.toContain('nope');
  });

  it('finds a link by the reference we sent: a paid one first; none is { link: null }; unreachable is null', async () => {
    const f = fetchMock({
      payment_links: [
        { id: 'plink_old', status: 'expired', reference_id: 'HIOC-S1042' },
        { id: 'plink_paid', status: 'paid', reference_id: 'HIOC-S1042', short_url: 'https://rzp.io/i/p', amount_paid: 134900, payments: [{ payment_id: 'pay_1', amount: 134900, status: 'captured' }] },
      ],
    });
    const hit = await gateway.findGatewayPaymentLinkByReference('HIOC-S1042');
    expect(hit?.link).toMatchObject({ id: 'plink_paid', status: 'paid' });
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://api.razorpay.com/v1/payment_links?reference_id=HIOC-S1042');
    fetchMock({ payment_links: [] });
    expect(await gateway.findGatewayPaymentLinkByReference('HIOC-S1042')).toEqual({ link: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock({}, 500);
    expect(await gateway.findGatewayPaymentLinkByReference('HIOC-S1042')).toBeNull();
    fetchMock({ unexpected: true });
    expect(await gateway.findGatewayPaymentLinkByReference('HIOC-S1042')).toBeNull();
  });

  describe('reference lookup does not trust Razorpay’s filter', () => {
    const ORDER = '7d0c3f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
    const mine = { id: 'plink_mine', status: 'created', reference_id: 'HIOC-S1042', notes: { shop_order_id: ORDER }, short_url: 'https://rzp.io/i/m' };

    it('an exact match (reference and note) works as before', async () => {
      fetchMock({ payment_links: [mine] });
      const hit = await gateway.findGatewayPaymentLinkByReference('HIOC-S1042', ORDER);
      expect(hit?.link).toMatchObject({ id: 'plink_mine', referenceId: 'HIOC-S1042' });
    });

    it('another order’s paid link of the same total in the answer: nothing is picked (retry later), ids logged', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const other = { id: 'plink_other', status: 'paid', amount_paid: 134900, reference_id: 'HIOC-S1042', notes: { shop_order_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd' } };
      fetchMock({ payment_links: [mine, other] });
      expect(await gateway.findGatewayPaymentLinkByReference('HIOC-S1042', ORDER)).toBeNull();
      expect(JSON.stringify(log.mock.calls)).toContain('plink_other');
    });

    it('a link with a different reference_id, or none, is not used', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      fetchMock({ payment_links: [{ id: 'plink_x', status: 'paid', reference_id: 'HIOC-S9999' }] });
      expect(await gateway.findGatewayPaymentLinkByReference('HIOC-S1042', ORDER)).toBeNull();
      fetchMock({ payment_links: [{ id: 'plink_y', status: 'paid' }] });
      expect(await gateway.findGatewayPaymentLinkByReference('HIOC-S1042', ORDER)).toBeNull();
    });
  });

  it('reads a paid link with its payments, cancels, and resends by SMS (and email)', async () => {
    fetchMock({ id: 'plink_9', status: 'paid', amount_paid: 134900, payments: [{ payment_id: 'pay_1', method: 'upi', amount: 134900, status: 'captured' }] });
    expect(await gateway.fetchGatewayPaymentLink('plink_9')).toMatchObject({
      status: 'paid', amountPaidPaise: 134900, payments: [{ id: 'pay_1', method: 'upi', amountPaise: 134900, status: 'captured' }],
    });
    const f = fetchMock({ success: true });
    expect(await gateway.resendGatewayPaymentLink('plink_9', true)).toBe(true);
    expect(f.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
      'https://api.razorpay.com/v1/payment_links/plink_9/notify_by/sms',
      'https://api.razorpay.com/v1/payment_links/plink_9/notify_by/email',
    ]);
    const c = fetchMock({ id: 'plink_9', status: 'cancelled' });
    expect(await gateway.cancelGatewayPaymentLink('plink_9')).toMatchObject({ status: 'cancelled' });
    expect((c.mock.calls[0] as unknown as [string])[0]).toBe('https://api.razorpay.com/v1/payment_links/plink_9/cancel');
  });

  it('no keys: every call answers null / false without calling Razorpay', async () => {
    const id = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;
    const f = fetchMock({});
    expect(await gateway.createGatewayPaymentLink({ amountInr: 500, referenceId: 'r', description: 'd', customer: { name: 'N', contact: '+919876543210' }, expireBy: 1, notes: {}, callbackUrl: '' })).toEqual({ ok: false, definite: true });
    expect(await gateway.findGatewayPaymentLinkByReference('HIOC-S1042')).toBeNull();
    expect(await gateway.fetchGatewayPaymentLink('plink_9')).toBeNull();
    expect(await gateway.cancelGatewayPaymentLink('plink_9')).toBeNull();
    expect(await gateway.resendGatewayPaymentLink('plink_9', false)).toBe(false);
    expect(f).not.toHaveBeenCalled();
    process.env.RAZORPAY_KEY_ID = id;
  });
});

describe('rows and the sheet', () => {
  it('a row from before the migration reads as a website order paid at checkout', () => {
    const { source: _s, payment_channel: _p, owner_discount_inr: _o, ...old } = shopOrder() as unknown as Record<string, unknown>;
    void _s; void _p; void _o;
    expect(toShopOrderRow(old)).toMatchObject({
      source: 'web', created_by: null, payment_channel: 'checkout', offline_method: null, payment_reference: null,
      owner_discount_inr: 0, owner_discount_reason: null, razorpay_payment_link_id: null, payment_link_url: null, payment_link_expires_at: null,
    });
  });

  it('the CSV gains source, payment channel and method, reference, owner discount and reason', () => {
    const web = shopOrder();
    const owner = shopOrder({
      source: 'owner', payment_channel: 'offline', offline_method: 'upi_direct', payment_method: 'upi_direct', payment_reference: 'UPI 4321',
      owner_discount_inr: 100, owner_discount_reason: 'launch week friend', discount_inr: 100, total_inr: 1349,
    });
    const t = shopOrdersCsvTable([web, owner]);
    const col = (name: string) => t.columns.indexOf(name);
    expect(t.columns.slice(-6)).toEqual(['Source', 'Payment channel', 'Offline method', 'Payment reference', 'Owner discount (₹)', 'Owner discount reason']);
    expect(t.rows[0].slice(col('Source'))).toEqual(['website', 'Razorpay checkout', '', '', 0, '']);
    expect(t.rows[1].slice(col('Source'))).toEqual(['owner', 'Offline', 'UPI to café', 'UPI 4321', 100, 'launch week friend']);
    for (const r of t.rows) expect(r).toHaveLength(t.columns.length);
  });

  it('the receipt shows the owner discount as its own line, so the lines add up to discount_inr', () => {
    const o = shopOrder({ offer_discount_inr: 0, owner_discount_inr: 100, discount_inr: 100 });
    expect(shopOrderDiscountBreakdown(o)).toEqual([{ kind: 'owner', label: 'Special discount', amount_inr: 100 }]);
  });
});
