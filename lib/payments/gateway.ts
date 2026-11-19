// Payment gateway integration (FND-1) — Razorpay, called via its REST API
// (Basic auth with key_id:key_secret) rather than an npm SDK, per the
// Phase-2 "no new deps" constraint. No card data ever passes through this
// server (PCI, XC-032) — we only ever handle gateway references.
//
// When RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are unset (or a gateway call
// fails), every function here degrades to returning null rather than
// throwing — callers (checkout, retry, refund) treat that as "gateway
// unavailable" and fall back to pay-at-counter (FND-1 edge case).

import 'server-only';
import { createHmac, timingSafeEqual } from 'crypto';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import type { PaymentMethod } from '@/lib/types';
import type { CreatedPaymentIntent } from './types';

export type { CreatedPaymentIntent } from './types';

const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';
const MIN_ORDER_AMOUNT_PAISE = 100; // Razorpay's minimum order amount (₹1)

function credentials(): { keyId: string; keySecret: string } | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

/**
 * True when the server holds both Razorpay keys, i.e. createPaymentIntent() can
 * possibly succeed. Lets a route that cannot fall back to pay-at-counter (a
 * HIOC Ritual purchase has no counter fallback) refuse BEFORE it creates an
 * order, and lets GET /api/passes/plans say whether to show "Buy" at all. It
 * asks the same credentials() the gateway calls use, so the answer can never
 * disagree with what a real payment attempt would do.
 */
export function isGatewayConfigured(): boolean {
  return credentials() !== null;
}

function authHeader(keyId: string, keySecret: string): string {
  return 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
}

async function razorpayRequest<T>(path: string, init: RequestInit): Promise<T | null> {
  const creds = credentials();
  if (!creds) return null;
  try {
    const res = await fetch(`${RAZORPAY_API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader(creds.keyId, creds.keySecret),
        ...(init.headers ?? {}),
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      // Payment-link answers can echo the customer's details: log the status only.
      const body = path.startsWith('/payment_links') ? '' : await res.text().catch(() => '');
      console.error(`Razorpay ${path.split('?')[0]} failed (${res.status})`, body);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`Razorpay ${path.split('?')[0]} request error`, err);
    return null;
  }
}

/**
 * Creates a gateway order for `amountInr` and records a `payments` row in
 * payment_pending. Returns the intent for the client SDK, or null on failure
 * (caller falls back to pay-at-counter). `orderId` must already exist (the
 * payments row FKs to it).
 */
export async function createPaymentIntent(
  orderId: string,
  amountInr: number,
): Promise<CreatedPaymentIntent | null> {
  const intent = await createGatewayOrder(amountInr, orderId, { hioc_order_id: orderId });
  if (!intent) return null;

  const admin = createAdminSupabaseClient();
  const { error } = await admin.from('payments').insert({
    order_id: orderId,
    gateway: 'razorpay',
    gateway_order_id: intent.gatewayOrderId,
    amount_inr: amountInr,
    status: 'payment_pending',
  });
  if (error) {
    // Idempotency unique (gateway, gateway_order_id) means a genuine retry of
    // the exact same gateway order id would land here too — but we always
    // mint a fresh Razorpay order above, so a conflict here means something
    // else is wrong; fail closed to pay-at-counter rather than hand back an
    // intent with no local record to reconcile against.
    console.error('createPaymentIntent: failed to record payments row', error);
    return null;
  }

  return intent;
}

/**
 * Creates a Razorpay order for `amountInr` (auto-capture) and returns the
 * intent for the client SDK, recording NOTHING locally. createPaymentIntent()
 * adds the café `payments` row on top; the Instant Coffee shop
 * (lib/shop/payments.ts) keeps the gateway order id on its own shop_orders row
 * instead, so a shipped jar never touches the café's orders or payments.
 * `receipt` is at most 40 characters (a uuid fits). Null on any failure or
 * when the gateway is not configured.
 */
export async function createGatewayOrder(
  amountInr: number,
  receipt: string,
  notes: Record<string, string>,
): Promise<CreatedPaymentIntent | null> {
  if (!Number.isFinite(amountInr) || amountInr <= 0) return null;
  const amountPaise = Math.round(amountInr) * 100;
  if (amountPaise < MIN_ORDER_AMOUNT_PAISE) return null; // Razorpay rejects < ₹1
  const creds = credentials();
  if (!creds) return null; // gateway not configured

  type RzpOrder = { id: string; amount: number; currency: string };
  const rzpOrder = await razorpayRequest<RzpOrder>('/orders', {
    method: 'POST',
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      receipt: receipt.slice(0, 40),
      payment_capture: 1, // auto-capture on success (M4) — never leave 'authorized'
      notes,
    }),
  });
  if (!rzpOrder) return null;

  const publicKeyId = process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || creds.keyId;
  return { gateway: 'razorpay', gatewayOrderId: rzpOrder.id, amountInr, keyId: publicKeyId };
}

/**
 * Verifies a gateway webhook signature against the RAW request body (must be
 * read as text before any JSON parsing — HMAC is over the exact bytes
 * Razorpay signed). Constant-time compare to avoid a timing side-channel.
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return signaturesMatch(expected, signature);
}

/**
 * Verifies the signature Checkout.js hands the browser on a successful
 * payment: HMAC-SHA256(`${razorpay_order_id}|${razorpay_payment_id}`) keyed
 * with RAZORPAY_KEY_SECRET (the API secret, not the webhook secret).
 */
export function verifyCheckoutSignature(
  gatewayOrderId: string,
  gatewayPaymentId: string,
  signature: string,
): boolean {
  const creds = credentials();
  if (!creds || !gatewayOrderId || !gatewayPaymentId || !signature) return false;
  const expected = createHmac('sha256', creds.keySecret)
    .update(`${gatewayOrderId}|${gatewayPaymentId}`)
    .digest('hex');
  return signaturesMatch(expected, signature);
}

// Constant-time compare to avoid a timing side-channel.
function signaturesMatch(expected: string, got: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(got, 'utf8');
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

export interface RazorpayPaymentAttempt {
  id: string;
  order_id: string;
  status: string; // created | authorized | captured | refunded | failed
  method?: string;
  amount: number;
}

/**
 * Lists payment attempts against a gateway order — used by the reconcile
 * poll (GET /api/payments/[orderId]/status) when the webhook hasn't landed
 * yet (FND-1 "webhook delayed" edge case). Returns null on any gateway/config
 * failure so the caller can just report "still pending" rather than erroring.
 */
export async function fetchOrderPaymentAttempts(
  gatewayOrderId: string,
): Promise<RazorpayPaymentAttempt[] | null> {
  const data = await razorpayRequest<{ items: RazorpayPaymentAttempt[] }>(
    `/orders/${gatewayOrderId}/payments`,
    { method: 'GET' },
  );
  return data?.items ?? null;
}

/** Fetches a single payment — used by the Checkout.js verify route. Null on failure. */
export async function fetchGatewayPayment(
  gatewayPaymentId: string,
): Promise<RazorpayPaymentAttempt | null> {
  return razorpayRequest<RazorpayPaymentAttempt>(
    `/payments/${encodeURIComponent(gatewayPaymentId)}`,
    { method: 'GET' },
  );
}

export interface RazorpayRefundResult {
  id: string;
  status: string;
}

/** Issues a full/partial refund against a captured gateway payment (FND-2/PAY-3). */
export async function createGatewayRefund(
  gatewayPaymentId: string,
  amountInr: number,
  notes: Record<string, string>,
): Promise<RazorpayRefundResult | null> {
  if (!Number.isFinite(amountInr) || amountInr <= 0) return null;
  return razorpayRequest<RazorpayRefundResult>(`/payments/${gatewayPaymentId}/refund`, {
    method: 'POST',
    body: JSON.stringify({ amount: Math.round(amountInr) * 100, notes }),
  });
}

/** Maps a Razorpay payment `method` string onto our narrower PaymentMethod enum. */
export function mapRazorpayMethod(method: string | undefined): PaymentMethod {
  if (method === 'upi') return 'upi';
  if (method === 'card') return 'card';
  return 'online'; // netbanking/wallet/emi/etc. — bucketed as generic "online"
}

// ---------------------------------------------------------------------------
// Razorpay Payment Links (owner-entered shop orders, docs/SHOP-OWNER-ORDERS-SPEC.md)
//
// NOT VERIFIED AGAINST A LIVE ACCOUNT. The request and answer shapes below follow
// Razorpay's public Payment Links documentation and are read loosely (every field
// optional, unknown fields ignored), the way lib/shop/shiprocket.ts reads
// Shiprocket. Same rules as every function above: no keys or any failure answers
// null, never a throw. Payment Links must be enabled on the Razorpay account.
// ---------------------------------------------------------------------------

/** A payment link as Razorpay describes it, reduced to what the shop uses. */
export interface GatewayPaymentLink {
  id: string;
  /** The link the customer opens (Razorpay's short_url). */
  shortUrl: string | null;
  /** created | partially_paid | expired | cancelled | paid (as Razorpay spells it). */
  status: string;
  /** Paise paid so far (0 when none). */
  amountPaidPaise: number;
  /** Unix seconds the link stops working, when known. */
  expireBy: number | null;
  /** The reference_id we sent (the order ref), when the answer carries it. */
  referenceId?: string | null;
  /** The notes we sent (shop_order_id), when the answer carries them. */
  notes?: Record<string, unknown>;
  /** Payments made through the link, when the answer lists them. */
  payments: { id: string; method?: string; amountPaise?: number; status?: string }[];
}

function parsePaymentLink(raw: unknown): GatewayPaymentLink | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const payments = Array.isArray(r.payments)
    ? (r.payments as unknown[]).flatMap((p) => {
        if (typeof p !== 'object' || p === null) return [];
        const o = p as Record<string, unknown>;
        const id = typeof o.payment_id === 'string' ? o.payment_id : typeof o.id === 'string' ? o.id : '';
        if (!id) return [];
        return [
          {
            id,
            ...(typeof o.method === 'string' ? { method: o.method } : {}),
            ...(n(o.amount) !== null ? { amountPaise: n(o.amount) as number } : {}),
            ...(typeof o.status === 'string' ? { status: o.status } : {}),
          },
        ];
      })
    : [];
  return {
    id: r.id,
    shortUrl: typeof r.short_url === 'string' && r.short_url ? r.short_url : null,
    status: typeof r.status === 'string' ? r.status : '',
    amountPaidPaise: n(r.amount_paid) ?? 0,
    expireBy: n(r.expire_by),
    referenceId: typeof r.reference_id === 'string' ? r.reference_id : null,
    notes: typeof r.notes === 'object' && r.notes !== null && !Array.isArray(r.notes) ? (r.notes as Record<string, unknown>) : {},
    payments,
  };
}

export interface CreatePaymentLinkInput {
  amountInr: number;
  /** Shown on Razorpay's page and echoed back (we send the order ref, e.g. HIOC-S1042). */
  referenceId: string;
  description: string;
  customer: { name: string; contact: string; email?: string };
  /** Unix seconds; Razorpay needs it at least 15 minutes ahead. */
  expireBy: number;
  notes: Record<string, string>;
  /** Where Razorpay sends the customer after paying. */
  callbackUrl: string;
}

export type CreatePaymentLinkResult =
  | { ok: true; link: GatewayPaymentLink }
  /**
   * `definite` is true ONLY when Razorpay answered with a 4xx validation refusal, so
   * no link can exist. A timeout, a 5xx, a network error or an unreadable answer is
   * not definite: the link may have been made, so the caller must keep its order.
   */
  | { ok: false; definite: boolean };

/**
 * Creates a payment link for the whole amount (no partial payments), texted to
 * the customer and emailed too when there is an email. See CreatePaymentLinkResult:
 * never throws. No keys or an amount under ₹1 is a definite failure (nothing was sent).
 */
export async function createGatewayPaymentLink(input: CreatePaymentLinkInput): Promise<CreatePaymentLinkResult> {
  if (!Number.isFinite(input.amountInr) || input.amountInr <= 0) return { ok: false, definite: true };
  const amountPaise = Math.round(input.amountInr) * 100;
  if (amountPaise < MIN_ORDER_AMOUNT_PAISE) return { ok: false, definite: true };
  const creds = credentials();
  if (!creds) return { ok: false, definite: true };
  const email = input.customer.email?.trim() || '';
  try {
    const res = await fetch(`${RAZORPAY_API_BASE}/payment_links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader(creds.keyId, creds.keySecret) },
      cache: 'no-store',
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        accept_partial: false,
        expire_by: Math.floor(input.expireBy),
        reference_id: input.referenceId.slice(0, 40),
        description: input.description.slice(0, 2000),
        customer: { name: input.customer.name, contact: input.customer.contact, ...(email ? { email } : {}) },
        notify: { sms: true, email: Boolean(email) },
        reminder_enable: true,
        notes: input.notes,
        // Only a real https address (no site URL configured in dev gives a bare path, which Razorpay refuses).
        ...(input.callbackUrl.startsWith('https://') ? { callback_url: input.callbackUrl, callback_method: 'get' } : {}),
      }),
    });
    if (!res.ok) {
      // Status only: the body can echo the customer's details.
      console.error(`Razorpay /payment_links failed (${res.status})`);
      return { ok: false, definite: res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 };
    }
    const link = parsePaymentLink(await res.json().catch(() => null));
    return link ? { ok: true, link } : { ok: false, definite: false };
  } catch {
    console.error('Razorpay /payment_links request error');
    return { ok: false, definite: false };
  }
}

/** Does this link belong to the order we asked about: same reference_id, and the same order id in its note when it has one. */
export function linkMatchesOrder(link: GatewayPaymentLink, referenceId: string, orderId?: string): boolean {
  if (link.referenceId !== referenceId) return false;
  const noted = link.notes?.shop_order_id;
  return noted === undefined || noted === null || (typeof noted === 'string' && (orderId === undefined || noted === orderId));
}

/**
 * Finds our payment link by the reference_id we sent (the order ref, e.g. HIOC-S1042):
 * how an order whose create call timed out is matched to a link Razorpay may have made.
 * `null` = Razorpay unreachable or unreadable (try again later); `{ link: null }` =
 * none exists. Razorpay's filter is not trusted: every link in the answer must carry
 * exactly this reference_id and, when it has a shop_order_id note, exactly `orderId`.
 * If ANY link does not, nothing is picked (null = retry later) and the ids are logged.
 * When several match, a paid one wins, then an open one, then the rest.
 * Answer shape (`payment_links` or `items`) is NOT VERIFIED against a live account.
 */
export async function findGatewayPaymentLinkByReference(referenceId: string, orderId?: string): Promise<{ link: GatewayPaymentLink | null } | null> {
  if (!referenceId) return null;
  const raw = await razorpayRequest<unknown>(`/payment_links?reference_id=${encodeURIComponent(referenceId)}`, { method: 'GET' });
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.payment_links) ? r.payment_links : Array.isArray(r.items) ? r.items : null;
  if (!list) return null;
  const links = list.map(parsePaymentLink).filter((l): l is GatewayPaymentLink => l !== null);
  const stranger = links.filter((l) => !linkMatchesOrder(l, referenceId, orderId));
  if (stranger.length > 0) {
    console.error(`Razorpay payment link lookup for ${referenceId} returned link(s) that are not this order's: ${stranger.map((l) => l.id).join(', ')}; not used`);
    return null;
  }
  const rank = (l: GatewayPaymentLink) => (l.status === 'paid' ? 0 : l.status === 'created' || l.status === 'partially_paid' ? 1 : 2);
  links.sort((a, b) => rank(a) - rank(b));
  return { link: links[0] ?? null };
}

/** Reads a payment link (its status, and the payments made through it). Null on failure. */
export async function fetchGatewayPaymentLink(linkId: string): Promise<GatewayPaymentLink | null> {
  if (!linkId) return null;
  const raw = await razorpayRequest<unknown>(`/payment_links/${encodeURIComponent(linkId)}`, { method: 'GET' });
  return parsePaymentLink(raw);
}

/** Cancels an unpaid payment link. Null when Razorpay refuses (already paid, expired or cancelled) or is unreachable. */
export async function cancelGatewayPaymentLink(linkId: string): Promise<GatewayPaymentLink | null> {
  if (!linkId) return null;
  const raw = await razorpayRequest<unknown>(`/payment_links/${encodeURIComponent(linkId)}/cancel`, { method: 'POST', body: '{}' });
  return parsePaymentLink(raw);
}

/** Sends the link again by text (and by email when `email` is true). True only when every send went through. */
export async function resendGatewayPaymentLink(linkId: string, email: boolean): Promise<boolean> {
  if (!linkId) return false;
  const channels = email ? ['sms', 'email'] : ['sms'];
  let ok = true;
  for (const channel of channels) {
    const res = await razorpayRequest<unknown>(`/payment_links/${encodeURIComponent(linkId)}/notify_by/${channel}`, {
      method: 'POST',
      body: '{}',
    });
    if (res === null) ok = false;
  }
  return ok;
}
