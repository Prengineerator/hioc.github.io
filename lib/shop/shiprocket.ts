// Shiprocket API client for the Instant Coffee shop (docs/INSTANT-COFFEE-SHOP.md).
// REST over fetch, no SDK, like lib/payments/gateway.ts.
//
// Setup (Shiprocket panel → Settings → API → Configure): create an API user.
// It must use a different email from the main Shiprocket login. Then set
//   SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD   that API user
//   SHIPROCKET_PICKUP_LOCATION              the nickname of the pickup address
//                                           saved in Shiprocket (default "Primary")
//
// What the owner's one click does: it creates the order in Shiprocket
// ("Create custom order"). No money moves at that point. The courier, label and
// pickup are then chosen in the Shiprocket panel as usual, and "Refresh" on
// /owner/shop reads back the AWB and status.
//
// Every function returns a result rather than throwing, and a missing
// configuration reads as a clear message, so the owner page can always say
// what went wrong.

import 'server-only';
import { shopOrderRef } from './status';
import type { ShopOrderRow, ShopPackage } from './types';

const API_BASE = 'https://apiv2.shiprocket.in/v1/external';
/** Tokens last 10 days; renew well before that. */
const TOKEN_TTL_MS = 8 * 24 * 60 * 60 * 1000;

interface ShiprocketConfig {
  email: string;
  password: string;
  pickupLocation: string;
}

function config(): ShiprocketConfig | null {
  const email = process.env.SHIPROCKET_EMAIL?.trim();
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) return null;
  return { email, password, pickupLocation: process.env.SHIPROCKET_PICKUP_LOCATION?.trim() || 'Primary' };
}

export function isShiprocketConfigured(): boolean {
  return config() !== null;
}

export const SHIPROCKET_NOT_CONFIGURED =
  'Shiprocket is not set up yet: add SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD (a Shiprocket API user) in Vercel.';

// One token per server instance, renewed after TOKEN_TTL_MS or on a 401.
let cachedToken: { token: string; expiresAt: number } | null = null;

/** Test hook: forget the cached token. */
export function resetShiprocketTokenCache(): void {
  cachedToken = null;
}

/** Pulls a readable message out of a Shiprocket error body. */
export function shiprocketErrorMessage(body: unknown, status: number): string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof b.message === 'string' && b.message.trim()) parts.push(b.message.trim());
  if (typeof b.errors === 'object' && b.errors !== null) {
    for (const v of Object.values(b.errors as Record<string, unknown>)) {
      if (Array.isArray(v)) parts.push(...v.filter((x): x is string => typeof x === 'string'));
      else if (typeof v === 'string') parts.push(v);
    }
  }
  const msg = [...new Set(parts)].join(' ');
  return msg ? `Shiprocket: ${msg}` : `Shiprocket answered HTTP ${status}`;
}

type CallResult = { ok: true; data: unknown } | { ok: false; status: number; error: string };

async function login(cfg: ShiprocketConfig): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: cfg.email, password: cfg.password }),
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token : '';
    if (!res.ok || !token) {
      return {
        ok: false,
        error:
          res.status === 400 || res.status === 401 || res.status === 403
            ? 'Shiprocket refused the login: check SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD (it must be the API user).'
            : shiprocketErrorMessage(body, res.status),
      };
    }
    cachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return { ok: true, token };
  } catch (err) {
    console.error('shiprocket login failed', err);
    return { ok: false, error: 'Could not reach Shiprocket just now — please try again.' };
  }
}

async function token(cfg: ShiprocketConfig, fresh: boolean) {
  if (!fresh && cachedToken && cachedToken.expiresAt > Date.now()) return { ok: true as const, token: cachedToken.token };
  return login(cfg);
}

/** An authenticated call; a 401 renews the token and tries once more. */
async function call(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<CallResult> {
  const cfg = config();
  if (!cfg) return { ok: false, status: 0, error: SHIPROCKET_NOT_CONFIGURED };
  for (const fresh of [false, true]) {
    const t = await token(cfg, fresh);
    if (!t.ok) return { ok: false, status: 0, error: t.error };
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: init.method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.token}` },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: 'no-store',
      });
    } catch (err) {
      console.error(`shiprocket ${path} request failed`, err);
      return { ok: false, status: 0, error: 'Could not reach Shiprocket just now — please try again.' };
    }
    if (res.status === 401 && !fresh) {
      cachedToken = null;
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`shiprocket ${path} failed (${res.status})`, data);
      return { ok: false, status: res.status, error: shiprocketErrorMessage(data, res.status) };
    }
    return { ok: true, data };
  }
  return { ok: false, status: 401, error: 'Shiprocket refused the login.' };
}

/** "2026-11-12 14:05" in India time, the order_date format Shiprocket takes. */
export function shiprocketDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 330 * 60 * 1000); // IST = UTC+5:30
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** "Riya Sharma Gupta" → first "Riya", last "Sharma Gupta". */
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] ?? full, last: parts.slice(1).join(' ') };
}

/**
 * The "Create custom order" body for a paid shop order. Pure (tested).
 * Prepaid only. Shipping is billed to the customer as shipping_charges;
 * sub_total is the jars. The billing address is the delivery address.
 */
export function buildShiprocketOrder(
  order: ShopOrderRow,
  pkg: ShopPackage,
  pickupLocation: string,
): Record<string, unknown> {
  const { first, last } = splitName(order.customer_name);
  return {
    order_id: shopOrderRef(order.order_number),
    order_date: shiprocketDate(order.paid_at ?? order.created_at),
    pickup_location: pickupLocation,
    comment: 'HIOC. Premium Instant Coffee — online order (prepaid)',
    billing_customer_name: first,
    billing_last_name: last,
    billing_address: order.address_line1,
    billing_address_2: order.address_line2,
    billing_city: order.city,
    billing_pincode: order.pincode,
    billing_state: order.state,
    billing_country: 'India',
    billing_email: order.email,
    billing_phone: order.phone.replace(/^\+91/, ''),
    shipping_is_billing: true,
    order_items: order.lines.map((l) => ({
      name: `HIOC. Premium Instant Coffee — ${l.name} (50 g)`,
      sku: l.sku,
      units: l.quantity,
      selling_price: l.unit_price_inr,
      discount: 0,
      tax: 0,
    })),
    payment_method: 'Prepaid',
    shipping_charges: order.shipping_inr,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    sub_total: order.subtotal_inr,
    length: pkg.length_cm,
    breadth: pkg.breadth_cm,
    height: pkg.height_cm,
    weight: pkg.weight_kg,
  };
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) && v !== 0 ? String(v) : null;

export interface ShiprocketCreated {
  shiprocketOrderId: string;
  shipmentId: string | null;
  status: string | null;
  awb: string | null;
  courier: string | null;
}

/** Reads the create response loosely: ids may come back as numbers or strings. */
export function parseCreatedOrder(data: unknown): ShiprocketCreated | null {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const shiprocketOrderId = str(d.order_id);
  if (!shiprocketOrderId) return null;
  return {
    shiprocketOrderId,
    shipmentId: str(d.shipment_id),
    status: str(d.status),
    awb: str(d.awb_code),
    courier: str(d.courier_name),
  };
}

export async function createShiprocketOrder(
  order: ShopOrderRow,
  pkg: ShopPackage,
): Promise<{ ok: true; created: ShiprocketCreated } | { ok: false; error: string }> {
  const cfg = config();
  if (!cfg) return { ok: false, error: SHIPROCKET_NOT_CONFIGURED };
  const result = await call('/orders/create/adhoc', { method: 'POST', body: buildShiprocketOrder(order, pkg, cfg.pickupLocation) });
  if (!result.ok) return { ok: false, error: result.error };
  const created = parseCreatedOrder(result.data);
  if (!created) {
    console.error('shiprocket create: no order id in the answer', result.data);
    return { ok: false, error: shiprocketErrorMessage(result.data, 200) };
  }
  return { ok: true, created };
}

export interface ShiprocketOrderState {
  status: string | null;
  awb: string | null;
  courier: string | null;
  shipmentId: string | null;
}

/**
 * Reads the "order details" answer loosely. The order sits under `data`; the
 * AWB and courier are on its shipment (an object, or a list of one) or on
 * `awb_data`, depending on the account's API version.
 */
export function parseOrderDetails(body: unknown): ShiprocketOrderState | null {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const d = (typeof b.data === 'object' && b.data !== null ? b.data : b) as Record<string, unknown>;
  if (!('id' in d) && !('status' in d) && !('shipments' in d)) return null;
  const rawShip = Array.isArray(d.shipments) ? d.shipments[0] : d.shipments;
  const ship = (typeof rawShip === 'object' && rawShip !== null ? rawShip : {}) as Record<string, unknown>;
  const awbData = (typeof d.awb_data === 'object' && d.awb_data !== null ? d.awb_data : {}) as Record<string, unknown>;
  return {
    status: str(d.status),
    awb: str(ship.awb) ?? str(ship.awb_code) ?? str(awbData.awb) ?? str(d.awb_code),
    courier: str(ship.courier) ?? str(ship.courier_name) ?? str(d.courier_name),
    shipmentId: str(ship.id) ?? str(d.shipment_id),
  };
}

export async function fetchShiprocketOrder(
  shiprocketOrderId: string,
): Promise<{ ok: true; state: ShiprocketOrderState } | { ok: false; error: string }> {
  const result = await call(`/orders/show/${encodeURIComponent(shiprocketOrderId)}`, { method: 'GET' });
  if (!result.ok) return { ok: false, error: result.error };
  const state = parseOrderDetails(result.data);
  if (!state) return { ok: false, error: 'Shiprocket sent back an order this page could not read.' };
  return { ok: true, state };
}

/** Calls off a Shiprocket order that hasn't been handed to a courier. */
export async function cancelShiprocketOrder(shiprocketOrderId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = Number(shiprocketOrderId);
  const result = await call('/orders/cancel', {
    method: 'POST',
    body: { ids: [Number.isFinite(id) ? id : shiprocketOrderId] },
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
