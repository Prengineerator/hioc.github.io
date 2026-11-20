// A signed Amazon quote (docs/AMAZON-SHIPPING-SPEC.md). /amazon/rates gives each
// price a `quote`; /amazon/book takes only that quote back. The signature binds
// the order, Amazon's requestToken and rateId, the service name, the price the
// owner saw, the parcel and an expiry, so the browser cannot change which order
// a booking is for, nor the service name, charge or parcel that get saved.
//
// HMAC-SHA256. The key is derived from SUPABASE_SERVICE_ROLE_KEY with a fixed
// label (the repo has no other server secret fit for this), so it needs no new
// setting and fails closed: with the secret unset nothing signs and nothing verifies.

import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ShopPackage } from './types';

/** How long a quote may be booked after /rates gave it. */
export const AMAZON_QUOTE_TTL_MS = 15 * 60 * 1000;

export interface AmazonQuote {
  orderId: string;
  requestToken: string;
  rateId: string;
  serviceName: string;
  chargeInr: number;
  parcel: ShopPackage;
  /** ms since epoch */
  expiresAt: number;
}

function key(): Buffer | null {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  return createHmac('sha256', secret).update('hioc-amazon-quote-v1').digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signAmazonQuote(q: Omit<AmazonQuote, 'expiresAt'>, now = Date.now()): string | null {
  const k = key();
  if (!k) return null;
  const body = b64(JSON.stringify({ ...q, expiresAt: now + AMAZON_QUOTE_TTL_MS }));
  return `${body}.${b64(createHmac('sha256', k).update(body).digest())}`;
}

export type QuoteCheck = { ok: true; quote: AmazonQuote } | { ok: false; error: string };

export function verifyAmazonQuote(token: unknown, orderId: string, now = Date.now()): QuoteCheck {
  const stale = { ok: false as const, error: 'Get the Amazon prices again, then pick one.' };
  const k = key();
  if (!k || typeof token !== 'string' || token.length > 8000) return stale;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return stale;
  const want = createHmac('sha256', k).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return stale;
  let q: Partial<AmazonQuote>;
  try {
    q = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return stale;
  }
  const p = q.parcel;
  if (
    q.orderId !== orderId ||
    typeof q.requestToken !== 'string' || !q.requestToken ||
    typeof q.rateId !== 'string' || !q.rateId ||
    typeof q.serviceName !== 'string' || !q.serviceName ||
    typeof q.chargeInr !== 'number' || !Number.isFinite(q.chargeInr) || q.chargeInr < 0 ||
    !p || typeof p.weight_kg !== 'number' || typeof p.length_cm !== 'number' || typeof p.breadth_cm !== 'number' || typeof p.height_cm !== 'number' ||
    typeof q.expiresAt !== 'number'
  ) {
    return stale;
  }
  if (q.expiresAt < now) return { ok: false, error: 'These Amazon prices have expired. Get the prices again, then pick one.' };
  return { ok: true, quote: q as AmazonQuote };
}
