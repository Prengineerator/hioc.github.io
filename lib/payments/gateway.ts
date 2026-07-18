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

function credentials(): { keyId: string; keySecret: string } | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
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
      const body = await res.text().catch(() => '');
      console.error(`Razorpay ${path} failed (${res.status})`, body);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`Razorpay ${path} request error`, err);
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
  if (!Number.isFinite(amountInr) || amountInr <= 0) return null;
  const creds = credentials();
  if (!creds) return null; // gateway not configured — caller falls back to counter

  type RzpOrder = { id: string; amount: number; currency: string };
  const rzpOrder = await razorpayRequest<RzpOrder>('/orders', {
    method: 'POST',
    body: JSON.stringify({
      amount: Math.round(amountInr) * 100, // paise
      currency: 'INR',
      receipt: orderId,
      notes: { hioc_order_id: orderId },
    }),
  });
  if (!rzpOrder) return null;

  const admin = createAdminSupabaseClient();
  const { error } = await admin.from('payments').insert({
    order_id: orderId,
    gateway: 'razorpay',
    gateway_order_id: rzpOrder.id,
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
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(signature, 'utf8');
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
