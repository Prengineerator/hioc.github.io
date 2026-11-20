// Amazon Shipping (India) client for the online shop (docs/AMAZON-SHIPPING-SPEC.md),
// next to Shiprocket (lib/shop/shiprocket.ts). The café's OWN Amazon Shipping
// account, direct integration: Amazon Shipping API v2. REST over fetch, no SDK.
//
// Setup (Vercel → Settings → Environment Variables, Production). Secrets: server
// only, never NEXT_PUBLIC_, never in the repository.
//   AMAZON_SHIPPING_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN   the app authorised
//                                          on the café's Amazon Shipping account
//   AMAZON_SHIPPING_FROM_NAME, _PHONE, _ADDRESS1, _CITY, _STATE, _PINCODE   ship-from
//   AMAZON_SHIPPING_FROM_ADDRESS2, _EMAIL                         ship-from, optional
//   AMAZON_SHIPPING_SANDBOX=1                                     use Amazon's sandbox host
//
// Flow: getRates (nothing is booked or charged) -> the owner picks a rate ->
// purchaseShipment (books it on the café's account, returns the tracking id and
// the label) -> getTracking on Refresh -> cancelShipment before pickup.
//
// Every function returns a result rather than throwing, and a missing setting
// reads as a clear message naming the Vercel variables. Neither the access
// token, the refresh token nor the label contents are ever logged.

import 'server-only';
import { lineShipWeightKg, shiprocketItemName } from './catalog';
import { canCancelAmazonLabel, shopOrderRef, shopStatusFromAmazon } from './status';
import type { ShopOrderRow, ShopPackage } from './types';

// Pure rules that the owner page (client) also needs live in ./status; they are
// re-exported here so the Amazon code has one import.
export { canCancelAmazonLabel, shopStatusFromAmazon };

// ===========================================================================
// THE AMAZON CONTRACT, in one place. The Amazon docs site could not be reached
// when this was written, so every value below is the best-known one and each is
// marked "confirm against Amazon's docs". Correct them here; nothing else in
// the file hard-codes a path, header or field name for the wire.
// ===========================================================================
export const AMAZON_API = {
  /** Login with Amazon token endpoint. Confirm against Amazon's docs. */
  tokenUrl: 'https://api.amazon.com/auth/o2/token',
  /** India sits in the EU region. Confirm against Amazon's docs. */
  host: 'https://sellingpartnerapi-eu.amazon.com',
  /** Sandbox host. Confirm against Amazon's docs. */
  sandboxHost: 'https://sandbox.sellingpartnerapi-eu.amazon.com',
  /** Header carrying the access token. Confirm against Amazon's docs. */
  accessTokenHeader: 'x-amz-access-token',
  /** Header and value selecting the India business (the API's default is UK). Confirm against Amazon's docs. */
  businessIdHeader: 'x-amzn-shipping-business-id',
  businessId: 'AmazonShipping_IN',
  /** POST. Confirm against Amazon's docs. */
  ratesPath: '/shipping/v2/shipments/rates',
  /** POST. Confirm against Amazon's docs. */
  purchasePath: '/shipping/v2/shipments',
  /** GET, query packageClientReferenceId and format. Confirm against Amazon's docs. */
  documentsPath: (shipmentId: string) => `/shipping/v2/shipments/${encodeURIComponent(shipmentId)}/documents`,
  /** GET, query trackingId and carrierId. Confirm against Amazon's docs. */
  trackingPath: '/shipping/v2/tracking',
  /** PUT. Confirm against Amazon's docs. */
  cancelPath: (shipmentId: string) => `/shipping/v2/shipments/${encodeURIComponent(shipmentId)}/cancel`,
  /** carrierId for tracking (the database keeps none). Confirm against Amazon's docs. */
  carrierId: 'AMZN_IN',
  /** channelDetails.channelType for a shipment not tied to a marketplace. Confirm against Amazon's docs. */
  channelType: 'EXTERNAL',
  /** The label asked for at purchase. Confirm against Amazon's docs. */
  documentSpecification: {
    format: 'PDF',
    size: { width: 4, length: 6, unit: 'INCH' },
    dpi: 300,
    pageLayout: 'DEFAULT',
    needFileJoining: false,
    requestedDocumentTypes: ['LABEL'],
  },
  /** Label format asked for when reprinting. Confirm against Amazon's docs. */
  reprintFormat: 'PDF',
  /**
   * true: items[].itemValue and items[].weight are the LINE's total (value and
   * weight of all `quantity` units). false: they are per unit. Confirm against Amazon's docs.
   */
  itemFieldsAreLineTotals: true,
} as const;

/** Units sent to Amazon. Confirm against Amazon's docs. */
const UNITS = { length: 'CENTIMETER', weight: 'KILOGRAM', currency: 'INR' } as const;

/** What Amazon's tracking summary.status can say, kept for readers of this file. Confirm against Amazon's docs.
 *  PreTransit, InTransit, OutForDelivery, DeliveryAttempted, Delivered, Lost, Rejected, Undeliverable, PickupCancelled */

// ===========================================================================

export interface AmazonShipFrom {
  name: string;
  /** Without +91. */
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateOrRegion: string;
  postalCode: string;
  email: string;
}

interface AmazonCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const CREDENTIAL_VARS = ['AMAZON_SHIPPING_CLIENT_ID', 'AMAZON_SHIPPING_CLIENT_SECRET', 'AMAZON_SHIPPING_REFRESH_TOKEN'] as const;
const FROM_VARS = [
  'AMAZON_SHIPPING_FROM_NAME',
  'AMAZON_SHIPPING_FROM_PHONE',
  'AMAZON_SHIPPING_FROM_ADDRESS1',
  'AMAZON_SHIPPING_FROM_CITY',
  'AMAZON_SHIPPING_FROM_STATE',
  'AMAZON_SHIPPING_FROM_PINCODE',
] as const;

const env = (name: string): string => (process.env[name] ?? '').trim();

/** The Vercel settings still empty (names only, never values). */
export function amazonMissingSettings(): string[] {
  return [...CREDENTIAL_VARS, ...FROM_VARS].filter((n) => !env(n));
}

function credentials(): AmazonCredentials | null {
  const clientId = env('AMAZON_SHIPPING_CLIENT_ID');
  const clientSecret = env('AMAZON_SHIPPING_CLIENT_SECRET');
  const refreshToken = env('AMAZON_SHIPPING_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

function shipFrom(): AmazonShipFrom | null {
  if (FROM_VARS.some((n) => !env(n))) return null;
  return {
    name: env('AMAZON_SHIPPING_FROM_NAME'),
    phone: env('AMAZON_SHIPPING_FROM_PHONE').replace(/^\+91/, ''),
    addressLine1: env('AMAZON_SHIPPING_FROM_ADDRESS1'),
    addressLine2: env('AMAZON_SHIPPING_FROM_ADDRESS2'),
    city: env('AMAZON_SHIPPING_FROM_CITY'),
    stateOrRegion: env('AMAZON_SHIPPING_FROM_STATE'),
    postalCode: env('AMAZON_SHIPPING_FROM_PINCODE'),
    email: env('AMAZON_SHIPPING_FROM_EMAIL'),
  };
}

/** Everything needed to get prices and book: the three credentials and the ship-from address. */
export function isAmazonShippingConfigured(): boolean {
  return credentials() !== null && shipFrom() !== null;
}

/** Enough to read tracking, reprint a label or cancel (no ship-from needed): used by Refresh and the nightly sweep. */
export function hasAmazonCredentials(): boolean {
  return credentials() !== null;
}

/** The plain message for a missing setting, naming exactly what is missing. */
export function amazonNotConfiguredMessage(): string {
  const missing = amazonMissingSettings();
  return `Amazon Shipping is not set up yet: add ${missing.length ? missing.join(', ') : 'the AMAZON_SHIPPING_* settings'} in Vercel.`;
}

const NO_SERVICE_MESSAGE = 'Amazon has no service for this pincode — use Shiprocket.';
const UNREACHABLE = 'Could not reach Amazon Shipping just now — please try again.';

// One access token per server instance, renewed a minute before it expires or on a 401.
let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_EARLY_MS = 60 * 1000;
const DEFAULT_TOKEN_TTL_S = 3600;

/** Test hook: forget the cached token. */
export function resetAmazonTokenCache(): void {
  cachedToken = null;
}

const asObject = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

/** Amazon's { errors: [{ code, message, details }] } as one readable "Amazon Shipping: …" line. */
export function amazonErrorMessage(body: unknown, status: number): string {
  const b = asObject(body);
  const parts: string[] = [];
  if (Array.isArray(b.errors)) {
    for (const e of b.errors) {
      const o = asObject(e);
      const text = str(o.message) ?? str(o.code);
      const details = str(o.details);
      if (text) parts.push(details && !text.includes(details) ? `${text} (${details})` : text);
    }
  }
  const authText = str(b.error_description) ?? str(b.error) ?? str(b.message);
  if (parts.length === 0 && authText) parts.push(authText);
  const msg = [...new Set(parts)].join('; ');
  return msg ? `Amazon Shipping: ${msg}` : `Amazon Shipping answered HTTP ${status}`;
}

/**
 * ambiguous: true when the request may have reached Amazon and done its work
 * (network error or timeout after sending, a 5xx, a 4xx with no errors body).
 * false when it was definitely refused or never sent (not configured, login
 * failed, 401 twice, a 4xx that came with an errors body). Only the purchase
 * cares: it spends money.
 */
type CallResult = { ok: true; data: unknown } | { ok: false; status: number; error: string; ambiguous: boolean };

/** Time limits on every Amazon request (the purchase gets longer, still well under the claim and the route's maxDuration). */
const TOKEN_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 15_000;
export const PURCHASE_TIMEOUT_MS = 25_000;
/** A purchase renews the token first when it has less than this left. */
const PURCHASE_MIN_TOKEN_LIFE_MS = 5 * 60 * 1000;

/** Only the codes of an Amazon error body: never its message or details. */
function errorCodes(body: unknown): string[] {
  const errors = asObject(body).errors;
  return (Array.isArray(errors) ? errors : []).map((e) => str(asObject(e).code) ?? '?').slice(0, 5);
}
const hasErrorsBody = (body: unknown): boolean => Array.isArray(asObject(body).errors) && (asObject(body).errors as unknown[]).length > 0;

async function login(creds: AmazonCredentials): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(AMAZON_API.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    const body = asObject(await res.json().catch(() => ({})));
    const token = typeof body.access_token === 'string' ? body.access_token : '';
    if (!res.ok || !token) {
      console.error(`amazon shipping login failed (${res.status})`);
      return {
        ok: false,
        error:
          res.status === 400 || res.status === 401 || res.status === 403
            ? 'Amazon Shipping refused the login: check AMAZON_SHIPPING_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN in Vercel.'
            : amazonErrorMessage(body, res.status),
      };
    }
    const seconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : DEFAULT_TOKEN_TTL_S;
    cachedToken = { token, expiresAt: Date.now() + seconds * 1000 - TOKEN_EARLY_MS };
    return { ok: true, token };
  } catch {
    console.error('amazon shipping login: could not reach Amazon');
    return { ok: false, error: UNREACHABLE };
  }
}

async function token(creds: AmazonCredentials, fresh: boolean) {
  if (!fresh && cachedToken && cachedToken.expiresAt > Date.now()) return { ok: true as const, token: cachedToken.token };
  return login(creds);
}

/** An authenticated call; a 401 renews the token and tries once more. */
async function call(
  path: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown; query?: Record<string, string>; timeoutMs?: number; purchase?: boolean },
): Promise<CallResult> {
  const creds = credentials();
  if (!creds) return { ok: false, status: 0, error: amazonNotConfiguredMessage(), ambiguous: false };
  const host = process.env.AMAZON_SHIPPING_SANDBOX?.trim() === '1' ? AMAZON_API.sandboxHost : AMAZON_API.host;
  const qs = init.query ? `?${new URLSearchParams(init.query).toString()}` : '';
  // A purchase spends money, so it makes ONE attempt: no 401 retry (that would double the
  // worst case: token 10 s + purchase 25 s must stay under the route's 60 s). Instead the
  // token is renewed up front when it has under 5 minutes left, and a 401 is a refusal.
  const renewFirst = init.purchase === true && (!cachedToken || cachedToken.expiresAt - Date.now() < PURCHASE_MIN_TOKEN_LIFE_MS);
  for (const fresh of init.purchase ? [renewFirst] : [false, true]) {
    const t = await token(creds, fresh);
    if (!t.ok) return { ok: false, status: 0, error: t.error, ambiguous: false }; // never sent
    let res: Response;
    try {
      res = await fetch(`${host}${path}${qs}`, {
        method: init.method,
        headers: {
          'Content-Type': 'application/json',
          [AMAZON_API.accessTokenHeader]: t.token,
          [AMAZON_API.businessIdHeader]: AMAZON_API.businessId,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS),
      });
    } catch {
      console.error(`amazon shipping ${init.method} ${path} request failed`);
      return { ok: false, status: 0, error: UNREACHABLE, ambiguous: true }; // sent, outcome unknown
    }
    if (res.status === 401 && init.purchase) {
      cachedToken = null;
      return { ok: false, status: 401, error: 'Amazon refused the login — try again.', ambiguous: false }; // refused before booking
    }
    if (res.status === 401 && !fresh) {
      cachedToken = null;
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Only the status and the error codes are logged: never a message or details (they can carry customer data).
      console.error(`amazon shipping ${init.method} ${path} failed (${res.status})`, errorCodes(data));
      return {
        ok: false,
        status: res.status,
        error: amazonErrorMessage(data, res.status),
        ambiguous: !(res.status === 401 || (res.status >= 400 && res.status < 500 && hasErrorsBody(data))),
      };
    }
    return { ok: true, data };
  }
  return { ok: false, status: 401, error: 'Amazon Shipping refused the login.', ambiguous: false };
}

/** Amazon wraps answers in { payload }; read either. */
const payloadOf = (body: unknown): Record<string, unknown> => {
  const b = asObject(body);
  return 'payload' in b ? asObject(b.payload) : b;
};

// ---------------------------------------------------------------------------
// Rates request (pure)
// ---------------------------------------------------------------------------

/** Address line 2 is short on Amazon's side as on Shiprocket's. */
const ADDRESS_2_MAX = 200;
const DESCRIPTION_MAX = 100;

/** The whole-rupee money value of the goods the customer paid for: after offer, coupon and Beanies. */
export function declaredValueInr(order: Pick<ShopOrderRow, 'subtotal_inr' | 'discount_inr'>): number {
  return Math.max(0, Math.round(order.subtotal_inr - order.discount_inr));
}

/**
 * The declared value split across the lines in whole rupees, in proportion to
 * each line's price; the last line takes the rounding remainder, so the parts
 * add up to exactly the total. Never the pre-discount price (HIOC-S1004 lesson,
 * lib/shop/shiprocket.ts).
 */
export function splitDeclaredValue(lines: readonly { line_total_inr: number }[], total: number): number[] {
  const gross = lines.reduce((n, l) => n + l.line_total_inr, 0);
  if (lines.length === 0) return [];
  const parts = lines.map((l) => (gross > 0 ? Math.floor((total * l.line_total_inr) / gross) : 0));
  parts[parts.length - 1] += total - parts.reduce((n, p) => n + p, 0);
  return parts;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The "get rates" body for a paid shop order (pure, tested). One package, the
 * parcel the owner confirmed. The declared value (package insuredValue, and the
 * itemValue of the lines, which add up to it) is what the customer paid for the
 * goods: subtotal minus every discount (offer, coupon, Beanies), never the
 * pre-discount price, and without shipping. Phone without +91; the landmark is
 * appended to address line 2 as for Shiprocket; packageClientReferenceId is the
 * order's HIOC-S number.
 */
export function buildAmazonRatesRequest(
  order: ShopOrderRow,
  pkg: ShopPackage,
  from: AmazonShipFrom,
  opts: { shipDate?: string } = {},
): Record<string, unknown> {
  const declared = declaredValueInr(order);
  const values = splitDeclaredValue(order.lines, declared);
  const landmark = order.landmark?.trim();
  const address2 = [order.address_line2?.trim(), landmark ? `Landmark: ${landmark}` : null]
    .filter(Boolean)
    .join(', ')
    .slice(0, ADDRESS_2_MAX);
  const lineTotals = AMAZON_API.itemFieldsAreLineTotals;
  const shipTo: Record<string, unknown> = {
    name: order.customer_name,
    addressLine1: order.address_line1,
    addressLine2: address2,
    city: order.city,
    stateOrRegion: order.state,
    postalCode: order.pincode,
    countryCode: 'IN',
    phoneNumber: order.phone.replace(/^\+91/, ''),
  };
  if (order.email) shipTo.email = order.email;
  const shipFromBody: Record<string, unknown> = {
    name: from.name,
    addressLine1: from.addressLine1,
    addressLine2: from.addressLine2,
    city: from.city,
    stateOrRegion: from.stateOrRegion,
    postalCode: from.postalCode,
    countryCode: 'IN',
    phoneNumber: from.phone.replace(/^\+91/, ''),
  };
  if (from.email) shipFromBody.email = from.email;
  const body: Record<string, unknown> = {
    shipFrom: shipFromBody,
    shipTo,
    packages: [
      {
        dimensions: { length: pkg.length_cm, width: pkg.breadth_cm, height: pkg.height_cm, unit: UNITS.length },
        weight: { value: pkg.weight_kg, unit: UNITS.weight },
        insuredValue: { value: declared, unit: UNITS.currency },
        packageClientReferenceId: shopOrderRef(order.order_number),
        items: order.lines.map((l, i) => {
          const qty = Math.max(1, l.quantity);
          return {
            itemValue: { value: lineTotals ? values[i] : round2(values[i] / qty), unit: UNITS.currency },
            description: shiprocketItemName(l).slice(0, DESCRIPTION_MAX),
            itemIdentifier: l.sku,
            quantity: l.quantity,
            weight: { value: round3(lineTotals ? lineShipWeightKg(l) * l.quantity : lineShipWeightKg(l)), unit: UNITS.weight },
          };
        }),
      },
    ],
    channelDetails: { channelType: AMAZON_API.channelType },
  };
  if (opts.shipDate) body.shipDate = opts.shipDate;
  return body;
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

export interface AmazonRate {
  rateId: string;
  serviceName: string;
  carrierName: string;
  /** Rupees (paise allowed). */
  chargeInr: number;
  /** ISO time of the promised delivery (the end of its window), or null. */
  deliveryBy: string | null;
}

export type AmazonRatesResult = { ok: true; requestToken: string; rates: AmazonRate[] } | { ok: false; error: string };

function amount(v: unknown): number | null {
  const o = asObject(v);
  const unit = str(o.unit);
  if (unit && unit.toUpperCase() !== 'INR') return null;
  const n = typeof o.value === 'string' && o.value.trim() ? Number(o.value) : o.value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The rates answer → the services, cheapest first, plus the requestToken the purchase needs. */
export function parseAmazonRates(body: unknown): AmazonRatesResult {
  const p = payloadOf(body);
  const requestToken = str(p.requestToken);
  const rates: AmazonRate[] = [];
  for (const raw of Array.isArray(p.rates) ? p.rates : []) {
    const r = asObject(raw);
    const rateId = str(r.rateId);
    const chargeInr = amount(r.totalCharge);
    if (!rateId || chargeInr === null) continue;
    const window = asObject(asObject(r.promise).deliveryWindow);
    rates.push({
      rateId,
      serviceName: str(r.serviceName) ?? str(r.serviceId) ?? 'Amazon Shipping',
      carrierName: str(r.carrierName) ?? 'Amazon Shipping',
      chargeInr,
      deliveryBy: isoOrNull(window.end) ?? isoOrNull(window.start),
    });
  }
  if (rates.length === 0) return { ok: false, error: NO_SERVICE_MESSAGE };
  if (!requestToken) return { ok: false, error: 'Amazon Shipping sent prices this page could not read — please try again.' };
  rates.sort((a, b) => a.chargeInr - b.chargeInr || (a.deliveryBy ?? '9').localeCompare(b.deliveryBy ?? '9'));
  return { ok: true, requestToken, rates };
}

export interface AmazonPurchase {
  shipmentId: string;
  /** The tracking number (stored as awb_code). Null if the answer carried none. */
  trackingId: string | null;
  /** What Amazon says the label costs, when the answer carries it. */
  chargeInr: number | null;
  /** The package reference Amazon echoed (should be the order's HIOC-S number), or null if it echoed none. */
  packageClientReferenceId: string | null;
  /** The label PDF, base64, when the answer carries it. Never logged. */
  labelBase64: string | null;
  deliveryBy: string | null;
}

function labelFrom(details: unknown): string | null {
  for (const d of Array.isArray(details) ? details : []) {
    for (const doc of Array.isArray(asObject(d).packageDocuments) ? (asObject(d).packageDocuments as unknown[]) : []) {
      const o = asObject(doc);
      const contents = str(o.contents);
      if (contents && (!str(o.type) || str(o.type)?.toUpperCase() === 'LABEL')) return contents;
    }
  }
  return null;
}

/** The purchase answer. Null when there is no shipment id (nothing was booked as far as we can tell). */
export function parseAmazonPurchase(body: unknown): AmazonPurchase | null {
  const p = payloadOf(body);
  const shipmentId = str(p.shipmentId);
  if (!shipmentId) return null;
  const first = asObject(Array.isArray(p.packageDocumentDetails) ? p.packageDocumentDetails[0] : null);
  const window = asObject(asObject(p.promise).deliveryWindow);
  return {
    shipmentId,
    trackingId: str(first.trackingId),
    chargeInr: amount(p.totalCharge),
    packageClientReferenceId: str(first.packageClientReferenceId),
    labelBase64: labelFrom(p.packageDocumentDetails),
    deliveryBy: isoOrNull(window.end) ?? isoOrNull(window.start),
  };
}

export interface AmazonTracking {
  trackingId: string | null;
  /** Amazon's own status text (summary.status), e.g. InTransit, Delivered. */
  status: string | null;
  promisedDeliveryDate: string | null;
  events: { eventCode: string; eventTime: string | null; location: string | null }[];
}

/** The tracking answer. Null when it holds neither a status nor any events. */
export function parseAmazonTracking(body: unknown): AmazonTracking | null {
  const p = payloadOf(body);
  const status = str(asObject(p.summary).status);
  const events = (Array.isArray(p.eventHistory) ? p.eventHistory : []).flatMap((e) => {
    const o = asObject(e);
    const eventCode = str(o.eventCode);
    if (!eventCode) return [];
    const loc = asObject(o.location);
    const location = str(o.location) ?? ([str(loc.city), str(loc.stateOrRegion)].filter(Boolean).join(', ') || null);
    return [{ eventCode, eventTime: isoOrNull(o.eventTime), location }];
  });
  if (!status && events.length === 0) return null;
  return { trackingId: str(p.trackingId), status, promisedDeliveryDate: isoOrNull(p.promisedDeliveryDate), events };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** Prices for a parcel. Books and charges nothing. */
export async function getAmazonRates(order: ShopOrderRow, pkg: ShopPackage): Promise<AmazonRatesResult> {
  const from = shipFrom();
  if (!credentials() || !from) return { ok: false, error: amazonNotConfiguredMessage() };
  const result = await call(AMAZON_API.ratesPath, { method: 'POST', body: buildAmazonRatesRequest(order, pkg, from) });
  if (!result.ok) return { ok: false, error: result.error };
  return parseAmazonRates(result.data);
}

/**
 * Books the chosen rate on the café's Amazon Shipping account: this one spends money.
 * A failure carries `ambiguous`: false means Amazon definitely did not book it
 * (never sent, or refused with an errors body), so the caller may let the owner
 * try again; true means it MAY have booked (network error or timeout after
 * sending, a 5xx, a 2xx with no shipment id or an unreadable body), so the
 * caller must keep the order held and send the owner to check Amazon.
 */
export async function purchaseAmazonShipment(
  requestToken: string,
  rateId: string,
): Promise<{ ok: true; purchase: AmazonPurchase } | { ok: false; error: string; ambiguous: boolean }> {
  if (!credentials()) return { ok: false, error: amazonNotConfiguredMessage(), ambiguous: false };
  const result = await call(AMAZON_API.purchasePath, {
    method: 'POST',
    body: { requestToken, rateId, requestedDocumentSpecification: AMAZON_API.documentSpecification },
    timeoutMs: PURCHASE_TIMEOUT_MS,
    purchase: true,
  });
  if (!result.ok) return { ok: false, error: result.error, ambiguous: result.ambiguous };
  const purchase = parseAmazonPurchase(result.data);
  if (!purchase) return { ok: false, error: 'Amazon Shipping did not confirm the booking (no shipment id came back).', ambiguous: true };
  return { ok: true, purchase };
}

/** The label PDF (base64) of a booked shipment, for reprinting. */
export async function getAmazonLabel(
  shipmentId: string,
  packageClientReferenceId: string,
): Promise<{ ok: true; labelBase64: string } | { ok: false; error: string }> {
  const result = await call(AMAZON_API.documentsPath(shipmentId), {
    method: 'GET',
    query: { packageClientReferenceId, format: AMAZON_API.reprintFormat },
  });
  if (!result.ok) return { ok: false, error: result.error };
  const labelBase64 = labelFrom(payloadOf(result.data).packageDocumentDetails ?? [{ packageDocuments: payloadOf(result.data).packageDocuments }]);
  if (!labelBase64) return { ok: false, error: 'Amazon Shipping sent no label for this shipment.' };
  return { ok: true, labelBase64 };
}

/** Amazon's latest tracking for a tracking number. */
export async function getAmazonTracking(trackingId: string): Promise<{ ok: true; tracking: AmazonTracking } | { ok: false; error: string }> {
  const result = await call(AMAZON_API.trackingPath, { method: 'GET', query: { trackingId, carrierId: AMAZON_API.carrierId } });
  if (!result.ok) return { ok: false, error: result.error };
  const tracking = parseAmazonTracking(result.data);
  if (!tracking) return { ok: false, error: 'Amazon Shipping sent back tracking this page could not read.' };
  return { ok: true, tracking };
}

/** Calls off a booked shipment that has not been collected. */
export async function cancelAmazonShipment(shipmentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await call(AMAZON_API.cancelPath(shipmentId), { method: 'PUT' });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
