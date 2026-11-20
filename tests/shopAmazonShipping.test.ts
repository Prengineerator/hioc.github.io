import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  amazonErrorMessage,
  amazonMissingSettings,
  amazonNotConfiguredMessage,
  buildAmazonRatesRequest,
  cancelAmazonShipment,
  getAmazonRates,
  getAmazonTracking,
  isAmazonShippingConfigured,
  parseAmazonPurchase,
  parseAmazonRates,
  parseAmazonTracking,
  purchaseAmazonShipment,
  resetAmazonTokenCache,
  splitDeclaredValue,
  type AmazonShipFrom,
} from '@/lib/shop/amazonShipping';
import { canCancelAmazonLabel, canSendToShiprocket, canShipWithAmazon, orderCarrier, shopStatusFromAmazon, trackingUrl } from '@/lib/shop/status';
import { signAmazonQuote, verifyAmazonQuote } from '@/lib/shop/amazonQuote';
import { shopOrder } from './helpers/shopFixture';

// The Amazon Shipping client (lib/shop/amazonShipping.ts) with fetch stubbed:
// the rates request it builds (declared value = what the customer paid for the
// goods), the parsers, the token cache and its renewal on a 401. Not a live
// check of Amazon: the contract constants are marked "confirm" in the client.

const PKG = { weight_kg: 0.7, length_cm: 20, breadth_cm: 12, height_cm: 10 };
const FROM: AmazonShipFrom = {
  name: 'HIOC Cafe',
  phone: '9811111111',
  addressLine1: '5 Test Lane',
  addressLine2: '',
  city: 'Agra',
  stateOrRegion: 'Uttar Pradesh',
  postalCode: '282001',
  email: '',
};

// 798 + 699 = 1497 of goods; offer 100 + coupon 75 + 30 Beanies = 205 off; shipping 49.
const mixedLines = [
  { product_id: 'hazelnut', name: 'Nutty Hazelnut', sku: 'HIOC-IC-HAZELNUT-50G', unit_price_inr: 399, quantity: 2, line_total_inr: 798, line: 'instant' as const, pack_grams: 50, ship_weight_kg: 0.08 },
  {
    product_id: 'home-blend-500', name: 'Signature Home Blend', sku: 'HIOC-HB-500G-FLT', base_sku: 'HIOC-HB-500G', unit_price_inr: 699, quantity: 1,
    line_total_inr: 699, line: 'home_blend' as const, pack_grams: 500, grind: 'filter' as const, grind_label: 'Pour-over / Filter', ship_weight_kg: 0.52,
  },
];
const discounted = () =>
  shopOrder({
    jar_count: 3, lines: mixedLines, subtotal_inr: 1497, discount_inr: 205, offer_discount_inr: 100, coupon_code: 'WELCOME',
    coupon_discount_inr: 75, beanies_redeemed: 30, beanies_discount_inr: 30, shipping_inr: 49, total_inr: 1341, landmark: 'Opp. Metro Gate 2',
  });

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; raw: string };
let calls: Call[] = [];
let responder: (url: string, init: RequestInit, n: number) => Response;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const isToken = (url: string) => url.includes('/auth/o2/token');

const ENV = {
  AMAZON_SHIPPING_CLIENT_ID: 'cid',
  AMAZON_SHIPPING_CLIENT_SECRET: 'csecret',
  AMAZON_SHIPPING_REFRESH_TOKEN: 'rtoken',
  AMAZON_SHIPPING_FROM_NAME: 'HIOC Cafe',
  AMAZON_SHIPPING_FROM_PHONE: '+919811111111',
  AMAZON_SHIPPING_FROM_ADDRESS1: '5 Test Lane',
  AMAZON_SHIPPING_FROM_CITY: 'Agra',
  AMAZON_SHIPPING_FROM_STATE: 'Uttar Pradesh',
  AMAZON_SHIPPING_FROM_PINCODE: '282001',
};

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder-service-role-key';
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  delete process.env.AMAZON_SHIPPING_SANDBOX;
  resetAmazonTokenCache();
  calls = [];
  responder = (url) => (isToken(url) ? json({ access_token: 'acc1', expires_in: 3600 }) : json({ payload: {} }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      const raw = init.body ? String(init.body) : '';
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: raw && !isToken(url) ? JSON.parse(raw) : undefined,
        raw,
      });
      return Promise.resolve(responder(url, init, calls.length));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

describe('buildAmazonRatesRequest', () => {
  it('declares what the customer paid for the goods, never the pre-discount price', () => {
    const body = buildAmazonRatesRequest(discounted(), PKG, FROM) as any;
    const pkg = body.packages[0];
    // 1497 of goods - (100 offer + 75 coupon + 30 Beanies) = ₹1292. Shipping (₹49) is not goods.
    expect(pkg.insuredValue).toEqual({ value: 1292, unit: 'INR' });
    const items = pkg.items as { itemValue: { value: number } }[];
    expect(items.reduce((n, i) => n + i.itemValue.value, 0)).toBe(1292);
    expect(items.map((i) => i.itemValue.value)).toEqual([688, 604]); // floor(1292*798/1497), the rest
    expect(JSON.stringify(body)).not.toContain('1497');
  });

  it('builds the addresses, parcel, reference and items', () => {
    const body = buildAmazonRatesRequest(discounted(), PKG, FROM) as any;
    expect(body.shipTo).toEqual({
      name: 'Riya Sharma',
      addressLine1: '12, Rose Villa, MG Road',
      addressLine2: 'Near City Mall, Landmark: Opp. Metro Gate 2',
      city: 'Jaipur',
      stateOrRegion: 'Rajasthan',
      postalCode: '302001',
      countryCode: 'IN',
      phoneNumber: '9876543210',
      email: 'riya@example.com',
    });
    expect(body.shipFrom).toMatchObject({ name: 'HIOC Cafe', postalCode: '282001', countryCode: 'IN', phoneNumber: '9811111111' });
    expect(body.channelDetails).toEqual({ channelType: 'EXTERNAL' });
    expect(body.shipDate).toBeUndefined();
    const pkg = body.packages[0];
    expect(pkg.packageClientReferenceId).toBe('HIOC-S1001');
    expect(pkg.dimensions).toEqual({ length: 20, width: 12, height: 10, unit: 'CENTIMETER' });
    expect(pkg.weight).toEqual({ value: 0.7, unit: 'KILOGRAM' });
    expect(pkg.items[0]).toMatchObject({ itemIdentifier: 'HIOC-IC-HAZELNUT-50G', quantity: 2, weight: { value: 0.16, unit: 'KILOGRAM' } });
    expect(pkg.items[1].itemIdentifier).toBe('HIOC-HB-500G-FLT');
    expect(buildAmazonRatesRequest(shopOrder({ email: '' }), PKG, FROM, { shipDate: '2026-11-21T04:00:00Z' })).toMatchObject({ shipDate: '2026-11-21T04:00:00Z' });
  });

  it('declares the plain total when nothing is discounted', () => {
    const body = buildAmazonRatesRequest(shopOrder(), PKG, FROM) as any;
    expect(body.packages[0].insuredValue.value).toBe(798);
    expect('email' in body.shipFrom).toBe(false);
  });

  it('splits value to the exact rupee, with a remainder on the last line', () => {
    expect(splitDeclaredValue([{ line_total_inr: 100 }, { line_total_inr: 100 }, { line_total_inr: 100 }], 100)).toEqual([33, 33, 34]);
    expect(splitDeclaredValue([{ line_total_inr: 399 }], 0)).toEqual([0]);
    expect(splitDeclaredValue([], 10)).toEqual([]);
  });
});

describe('reading Amazon answers', () => {
  const rate = (rateId: string, value: number, end: string | null, extra: Record<string, unknown> = {}) => ({
    rateId, carrierId: 'AMZN_IN', carrierName: 'Amazon Shipping', serviceId: `svc-${rateId}`, serviceName: `Service ${rateId}`,
    totalCharge: { value, unit: 'INR' }, promise: { deliveryWindow: end ? { start: '2026-11-21T00:00:00Z', end } : undefined }, ...extra,
  });

  it('lists services cheapest first with ₹ price and delivery date, plus the request token', () => {
    const r = parseAmazonRates({ payload: { requestToken: 'tok-1', rates: [rate('B', 95, '2026-11-22T18:00:00Z'), rate('A', 62.5, '2026-11-24T18:00:00Z'), rate('C', '70.00' as unknown as number, null)] } });
    expect(r).toEqual({
      ok: true,
      requestToken: 'tok-1',
      rates: [
        { rateId: 'A', serviceName: 'Service A', carrierName: 'Amazon Shipping', chargeInr: 62.5, deliveryBy: '2026-11-24T18:00:00.000Z' },
        { rateId: 'C', serviceName: 'Service C', carrierName: 'Amazon Shipping', chargeInr: 70, deliveryBy: null },
        { rateId: 'B', serviceName: 'Service B', carrierName: 'Amazon Shipping', chargeInr: 95, deliveryBy: '2026-11-22T18:00:00.000Z' },
      ],
    });
  });

  it('says plainly when Amazon has no service, and skips prices not in rupees', () => {
    const none = { ok: false, error: 'Amazon has no service for this pincode — use Shiprocket.' };
    expect(parseAmazonRates({ payload: { requestToken: 't', rates: [], ineligibleRates: [{}] } })).toEqual(none);
    expect(parseAmazonRates({ payload: { requestToken: 't', rates: [{ rateId: 'X', totalCharge: { value: 5, unit: 'USD' } }] } })).toEqual(none);
    expect(parseAmazonRates({})).toEqual(none);
    expect(parseAmazonRates({ payload: { rates: [rate('A', 60, null)] } }).ok).toBe(false);
  });

  it('reads a purchase: shipment, tracking number, label, charge when present', () => {
    expect(
      parseAmazonPurchase({ payload: { shipmentId: 'SHP1', packageDocumentDetails: [{ packageClientReferenceId: 'HIOC-S1001', trackingId: 'TRK123', packageDocuments: [{ type: 'LABEL', format: 'PDF', contents: 'JVBERi0=' }] }], promise: { deliveryWindow: { end: '2026-11-24T18:00:00Z' } } } }),
    ).toEqual({ shipmentId: 'SHP1', trackingId: 'TRK123', chargeInr: null, packageClientReferenceId: 'HIOC-S1001', labelBase64: 'JVBERi0=', deliveryBy: '2026-11-24T18:00:00.000Z' });
    expect(parseAmazonPurchase({ payload: { shipmentId: 'SHP2', totalCharge: { value: 58, unit: 'INR' } } })).toMatchObject({ shipmentId: 'SHP2', trackingId: null, chargeInr: 58, labelBase64: null });
    expect(parseAmazonPurchase({ payload: {} })).toBeNull();
  });

  it('reads tracking: status and events', () => {
    expect(
      parseAmazonTracking({ payload: { trackingId: 'TRK123', promisedDeliveryDate: '2026-11-24T18:00:00Z', summary: { status: 'InTransit' }, eventHistory: [{ eventCode: 'PickedUp', eventTime: '2026-11-21T10:00:00Z', location: { city: 'Agra', stateOrRegion: 'UP' } }] } }),
    ).toEqual({
      trackingId: 'TRK123',
      status: 'InTransit',
      promisedDeliveryDate: '2026-11-24T18:00:00.000Z',
      events: [{ eventCode: 'PickedUp', eventTime: '2026-11-21T10:00:00.000Z', location: 'Agra, UP' }],
    });
    expect(parseAmazonTracking({ payload: {} })).toBeNull();
  });

  it('turns an error body into one readable line', () => {
    expect(amazonErrorMessage({ errors: [{ code: 'InvalidInput', message: 'Postal code is not serviceable', details: 'shipTo.postalCode' }] }, 400)).toBe(
      'Amazon Shipping: Postal code is not serviceable (shipTo.postalCode)',
    );
    expect(amazonErrorMessage({ errors: [{ code: 'Unauthorized' }] }, 403)).toBe('Amazon Shipping: Unauthorized');
    expect(amazonErrorMessage({}, 500)).toBe('Amazon Shipping answered HTTP 500');
  });
});

describe('order status rules', () => {
  it('Delivered moves shipped to delivered; nothing moves backwards', () => {
    expect(shopStatusFromAmazon('shipped', 'Delivered')).toBe('delivered');
    expect(shopStatusFromAmazon('shipped', 'InTransit')).toBeNull();
    expect(shopStatusFromAmazon('shipped', 'OutForDelivery')).toBeNull();
    expect(shopStatusFromAmazon('delivered', 'InTransit')).toBeNull();
    expect(shopStatusFromAmazon('delivered', 'Delivered')).toBeNull();
    expect(shopStatusFromAmazon('paid', 'Delivered')).toBeNull();
    expect(shopStatusFromAmazon('cancelled', 'Delivered')).toBeNull();
  });

  it('Rejected, Undeliverable, Lost and attempts never read as delivered', () => {
    for (const s of ['Rejected', 'Undeliverable', 'Lost', 'DeliveryAttempted', 'PickupCancelled', 'PreTransit', null, '']) {
      expect(shopStatusFromAmazon('shipped', s)).toBeNull();
    }
  });

  it('the label can be cancelled only before pickup', () => {
    const amazon = (patch: object) => shopOrder({ status: 'shipped', carrier: 'amazon', amazon_shipment_id: 'SHP1', ...patch });
    expect(canCancelAmazonLabel(amazon({ amazon_status: null }))).toBe(true);
    expect(canCancelAmazonLabel(amazon({ amazon_status: 'PreTransit' }))).toBe(true);
    expect(canCancelAmazonLabel(amazon({ amazon_status: 'PickupCancelled' }))).toBe(true);
    expect(canCancelAmazonLabel(amazon({ amazon_status: 'InTransit' }))).toBe(false);
    expect(canCancelAmazonLabel(amazon({ amazon_status: 'Delivered' }))).toBe(false);
    expect(canCancelAmazonLabel(amazon({ status: 'delivered' }))).toBe(false);
    expect(canCancelAmazonLabel(amazon({ carrier: 'shiprocket' }))).toBe(false);
    expect(canCancelAmazonLabel(amazon({ amazon_shipment_id: null }))).toBe(false);
  });

  it('Amazon and Shiprocket refuse an order the other already has', () => {
    expect(canShipWithAmazon(shopOrder())).toBe(true);
    expect(canSendToShiprocket(shopOrder())).toBe(true);
    expect(canShipWithAmazon(shopOrder({ shiprocket_order_id: 'sr1' }))).toBe(false);
    expect(canSendToShiprocket(shopOrder({ amazon_shipment_id: 'SHP1' }))).toBe(false);
    expect(canShipWithAmazon(shopOrder({ amazon_shipment_id: 'SHP1' }))).toBe(false);
    expect(canShipWithAmazon(shopOrder({ status: 'shipped' }))).toBe(false);
  });

  it('reads an old order with no carrier but a Shiprocket id as Shiprocket', () => {
    expect(orderCarrier(shopOrder({ shiprocket_order_id: 'sr1' }))).toBe('shiprocket');
    expect(orderCarrier(shopOrder({ carrier: 'amazon', amazon_shipment_id: 'S' }))).toBe('amazon');
    expect(orderCarrier(shopOrder())).toBeNull();
  });

  it('links to the carrier’s own tracking page', () => {
    expect(trackingUrl('AWB1')).toBe('https://shiprocket.co/tracking/AWB1');
    expect(trackingUrl('AWB1', null)).toBe('https://shiprocket.co/tracking/AWB1');
    expect(trackingUrl('AWB1', 'shiprocket')).toBe('https://shiprocket.co/tracking/AWB1');
    expect(trackingUrl('TRK 1', 'amazon')).toBe('https://track.amazon.in/tracking/TRK%201');
    expect(trackingUrl('', 'amazon')).toBeNull();
  });
});

describe('calls', () => {
  it('rates call books nothing: one token call and one rates call, with the India headers', async () => {
    responder = (url) => (isToken(url) ? json({ access_token: 'acc1', expires_in: 3600 }) : json({ payload: { requestToken: 'rt', rates: [{ rateId: 'R1', serviceName: 'Std', totalCharge: { value: 62, unit: 'INR' } }] } }));
    const r = await getAmazonRates(shopOrder(), PKG);
    expect(r.ok && r.rates[0]).toMatchObject({ rateId: 'R1', chargeInr: 62 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.amazon.com/auth/o2/token',
      'POST https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments/rates',
    ]);
    expect(calls[0].raw).toBe('grant_type=refresh_token&refresh_token=rtoken&client_id=cid&client_secret=csecret');
    expect(calls[1].headers).toMatchObject({ 'x-amz-access-token': 'acc1', 'x-amzn-shipping-business-id': 'AmazonShipping_IN', 'Content-Type': 'application/json' });
  });

  it('uses the sandbox host when AMAZON_SHIPPING_SANDBOX=1', async () => {
    process.env.AMAZON_SHIPPING_SANDBOX = '1';
    await getAmazonRates(shopOrder(), PKG);
    expect(calls[1].url).toBe('https://sandbox.sellingpartnerapi-eu.amazon.com/shipping/v2/shipments/rates');
  });

  it('purchase, tracking and cancel use their paths', async () => {
    responder = (url) =>
      isToken(url)
        ? json({ access_token: 'acc1', expires_in: 3600 })
        : url.endsWith('/shipments') ? json({ payload: { shipmentId: 'SHP1', packageDocumentDetails: [{ trackingId: 'TRK1' }] } })
        : url.includes('/tracking') ? json({ payload: { summary: { status: 'PreTransit' } } })
        : json({});
    const p = await purchaseAmazonShipment('rt', 'R1');
    expect(p.ok && p.purchase.trackingId).toBe('TRK1');
    expect(calls[1].body).toMatchObject({ requestToken: 'rt', rateId: 'R1', requestedDocumentSpecification: { format: 'PDF', requestedDocumentTypes: ['LABEL'] } });
    const t = await getAmazonTracking('TRK1');
    expect(t.ok && t.tracking.status).toBe('PreTransit');
    expect(calls[2].url).toBe('https://sellingpartnerapi-eu.amazon.com/shipping/v2/tracking?trackingId=TRK1&carrierId=AMZN_IN');
    expect(await cancelAmazonShipment('SHP1')).toEqual({ ok: true });
    expect(calls[3]).toMatchObject({ method: 'PUT', url: 'https://sellingpartnerapi-eu.amazon.com/shipping/v2/shipments/SHP1/cancel' });
  });

  it('reuses the token, and fetches a fresh one a minute before it expires', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await getAmazonTracking('T1');
    await getAmazonTracking('T2');
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(1);
    now.mockReturnValue(1_000_000 + 3539 * 1000); // inside the hour, outside the last minute
    await getAmazonTracking('T3');
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(1);
    now.mockReturnValue(1_000_000 + 3541 * 1000); // within a minute of expiry
    await getAmazonTracking('T4');
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(2);
  });

  it('renews the token once on a 401 and retries', async () => {
    let tokens = 0;
    responder = (url, init) => {
      if (isToken(url)) return json({ access_token: `acc${++tokens}`, expires_in: 3600 });
      const sent = (init.headers as Record<string, string>)['x-amz-access-token'];
      return sent === 'acc1' ? json({ errors: [{ code: 'Unauthorized', message: 'Access token expired' }] }, 401) : json({ payload: { summary: { status: 'InTransit' } } });
    };
    const r = await getAmazonTracking('TRK1');
    expect(r.ok && r.tracking.status).toBe('InTransit');
    expect(tokens).toBe(2);
    expect(calls.at(-1)?.headers['x-amz-access-token']).toBe('acc2');
  });

  it('gives up after one renewal', async () => {
    responder = (url) => (isToken(url) ? json({ access_token: 'acc', expires_in: 3600 }) : json({ errors: [{ message: 'Nope' }] }, 401));
    const r = await getAmazonTracking('TRK1');
    expect(r).toEqual({ ok: false, error: 'Amazon Shipping: Nope' });
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(2);
  });

  it('says so when the login is refused, and when Amazon cannot be reached', async () => {
    responder = () => json({ error: 'invalid_grant', error_description: 'bad' }, 400);
    const r = await getAmazonTracking('T');
    expect(!r.ok && r.error).toMatch(/refused the login: check AMAZON_SHIPPING_CLIENT_ID/);
    resetAmazonTokenCache();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNRESET'))));
    const n = await getAmazonTracking('T');
    expect(!n.ok && n.error).toMatch(/Could not reach Amazon Shipping/);
  });
});

describe('not configured', () => {
  it('names the missing Vercel settings and calls no one', async () => {
    delete process.env.AMAZON_SHIPPING_REFRESH_TOKEN;
    delete process.env.AMAZON_SHIPPING_FROM_PINCODE;
    expect(isAmazonShippingConfigured()).toBe(false);
    expect(amazonMissingSettings()).toEqual(['AMAZON_SHIPPING_REFRESH_TOKEN', 'AMAZON_SHIPPING_FROM_PINCODE']);
    expect(amazonNotConfiguredMessage()).toBe('Amazon Shipping is not set up yet: add AMAZON_SHIPPING_REFRESH_TOKEN, AMAZON_SHIPPING_FROM_PINCODE in Vercel.');
    expect(await getAmazonRates(shopOrder(), PKG)).toEqual({ ok: false, error: amazonNotConfiguredMessage() });
    expect(await purchaseAmazonShipment('rt', 'R1')).toEqual({ ok: false, error: amazonNotConfiguredMessage(), ambiguous: false });
    expect(calls).toHaveLength(0);
  });

  it('is configured with everything set', () => {
    expect(isAmazonShippingConfigured()).toBe(true);
    expect(amazonMissingSettings()).toEqual([]);
  });
});

describe('purchase: definite refusal or unclear', () => {
  const answer = (fn: (url: string) => Response | never) => {
    responder = (url) => (isToken(url) ? json({ access_token: 'acc1', expires_in: 3600 }) : fn(url));
  };

  it.each([
    ['a 4xx with an errors body', () => json({ errors: [{ code: 'RateExpired', message: 'expired' }] }, 400)],
    ['a 401 with an errors body, twice', () => json({ errors: [{ code: 'Unauthorized' }] }, 401)],
  ])('%s is a definite refusal', async (_n, fn) => {
    answer(fn);
    const r = await purchaseAmazonShipment('rt', 'R1');
    expect(r).toMatchObject({ ok: false, ambiguous: false });
  });

  it('a refused login never reached the purchase: definite', async () => {
    responder = () => json({ error: 'invalid_grant' }, 400);
    expect(await purchaseAmazonShipment('rt', 'R1')).toMatchObject({ ok: false, ambiguous: false });
    expect(calls.every((c) => isToken(c.url))).toBe(true);
  });

  it.each([
    ['a 5xx', () => json({}, 502)],
    ['a 4xx with no errors body', () => json({ message: 'x' }, 400)],
    ['a 200 with no shipment id', () => json({ payload: {} })],
    ['a 200 with an unreadable body', () => new Response('<html>', { status: 200 })],
  ])('%s is unclear', async (_n, fn) => {
    answer(fn);
    expect(await purchaseAmazonShipment('rt', 'R1')).toMatchObject({ ok: false, ambiguous: true });
  });

  it('a network error or timeout after sending is unclear', async () => {
    resetAmazonTokenCache();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => (isToken(url) ? Promise.resolve(json({ access_token: 'a', expires_in: 3600 })) : (n++, Promise.reject(new DOMException('timed out', 'TimeoutError'))))));
    expect(await purchaseAmazonShipment('rt', 'R1')).toMatchObject({ ok: false, ambiguous: true });
    expect(n).toBe(1);
  });

  it('every Amazon fetch has a timeout and refuses redirects, the token call included', async () => {
    await getAmazonTracking('T1');
    const inits = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.map((c) => c[1]);
    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('logs only the status and error codes, never an Amazon message or details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    answer(() => json({ errors: [{ code: 'InvalidInput', message: 'Riya Sharma, 12 Rose Villa is not serviceable', details: '9876543210' }] }, 400));
    await getAmazonTracking('T1');
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('InvalidInput');
    expect(logged).toContain('400');
    expect(logged).not.toContain('Riya');
    expect(logged).not.toContain('9876543210');
  });
});

describe('signed quote', () => {
  const base = { orderId: 'o1', requestToken: 'rt', rateId: 'R1', serviceName: 'Standard', chargeInr: 62, parcel: PKG };

  it('round-trips for its order and refuses another order, tampering, expiry and a missing secret', () => {
    const q = signAmazonQuote(base, 1_000)!;
    expect(verifyAmazonQuote(q, 'o1', 2_000)).toMatchObject({ ok: true, quote: { rateId: 'R1', chargeInr: 62, serviceName: 'Standard', parcel: PKG } });
    expect(verifyAmazonQuote(q, 'o2', 2_000).ok).toBe(false);
    expect(verifyAmazonQuote(q.replace(/\.(.)/, (_m, c) => `.${c === 'A' ? 'B' : 'A'}`), 'o1', 2_000).ok).toBe(false);
    expect(verifyAmazonQuote(q, 'o1', 1_000 + 15 * 60 * 1000 + 1)).toMatchObject({ ok: false, error: expect.stringContaining('expired') });
    expect(verifyAmazonQuote(undefined, 'o1').ok).toBe(false);
    const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(signAmazonQuote(base)).toBeNull();
    expect(verifyAmazonQuote(q, 'o1', 2_000).ok).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  });
});

describe('purchase timing and the token', () => {
  it('renews the token first when it has under 5 minutes left, and uses a cached one with more', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await getAmazonTracking('T1'); // caches a token (expires ~59 min on)
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(1);
    responder = (url) => (isToken(url) ? json({ access_token: 'acc2', expires_in: 3600 }) : json({ payload: { shipmentId: 'S1' } }));
    await purchaseAmazonShipment('rt', 'R1');
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(1); // plenty of life left: reused
    now.mockReturnValue(1_000_000 + 55 * 60 * 1000); // ~4 minutes left (a minute is already held back)
    await purchaseAmazonShipment('rt', 'R1');
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(2);
    expect(calls.at(-1)?.headers['x-amz-access-token']).toBe('acc2');
  });

  it('a 401 on purchase is one attempt, no retry, no new login: a definite refusal', async () => {
    responder = (url) => (isToken(url) ? json({ access_token: 'acc1', expires_in: 3600 }) : json({ message: 'bad token' }, 401));
    const r = await purchaseAmazonShipment('rt', 'R1');
    expect(r).toEqual({ ok: false, error: 'Amazon refused the login — try again.', ambiguous: false });
    expect(calls.filter((c) => !isToken(c.url))).toHaveLength(1);
    expect(calls.filter((c) => isToken(c.url))).toHaveLength(1);
  });

  it('keeps the worst case under the route’s 60 s: token 10 s + purchase 25 s', async () => {
    const { PURCHASE_TIMEOUT_MS } = await import('@/lib/shop/amazonShipping');
    expect(10_000 + PURCHASE_TIMEOUT_MS).toBeLessThan(60_000);
  });
});
