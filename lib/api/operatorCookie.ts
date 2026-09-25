// PIN-3 — the operator cookie: how it is signed, how it is shaped, where it
// is sent.
//
// Deliberately free of any Supabase or next/headers import so all of it is
// unit-testable (tests/operatorCookie.test.ts). The database-and-cookies half
// (reading the request, resolving the operator, sliding the expiry) lives in
// lib/api/operator.ts — same split as deviceCookie.ts / device.ts.

import { createHmac, timingSafeEqual } from 'crypto';

/** Cookie name. Prefixed like hioc_device so devtools shows at a glance which
 * cookies are ours. */
export const OPERATOR_COOKIE = 'hioc_operator';

/** D6-7/PIN-3: 12 hours, sliding — refreshed on every request that resolves
 * it successfully (lib/api/operator.ts), so a shift that never idles out
 * never has to re-punch a PIN, but a forgotten-unlocked counter cannot stay
 * unlocked past 12h of total inactivity either way. */
export const OPERATOR_COOKIE_MAX_AGE_S = 12 * 60 * 60;

/** Below this length the secret is treated as absent: PIN-3's fail-safe
 * ("missing or short (<32 chars) => the whole PIN feature reports disabled;
 * nothing breaks"). A short secret is worse than none — it would fit inside
 * an HMAC brute-force budget an attacker could actually spend. */
const MIN_SECRET_LENGTH = 32;

/** True when OPERATOR_JWT_SECRET is configured and long enough to sign with.
 * Every operator-cookie code path (sign, verify, the API route, the device
 * context's operator list) gates on this FIRST — with it false, the PIN
 * feature must behave as if it doesn't exist. */
export function operatorSecretOk(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

export interface OperatorTokenPayload {
  /** The operator's profiles.id. */
  op: string;
  /** The pos_devices.id this unlock is scoped to — worthless off that
   * device, even with a stolen cookie, because lib/api/operator.ts also
   * requires the (separate, httpOnly) device cookie to resolve to THIS id. */
  dev: string;
  /** Issued-at, unix seconds. Re-stamped on every sliding refresh. */
  iat: number;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * Signs a compact JWT-shaped token (header.payload.signature, HS256,
 * base64url) for the operator cookie's value. Not a general-purpose JWT
 * library — just enough of the shape for one cookie, one algorithm, one
 * dedicated secret, built on Node's own `crypto` per PIN-3's "no new
 * dependency needed".
 */
export function signOperatorToken(payload: OperatorTokenPayload, secret: string): string {
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const signature = base64url(hmac(data, secret));
  return `${data}.${signature}`;
}

/**
 * Verifies the signature and the TTL (12h from `iat`, non-negotiable — a
 * sliding refresh re-signs a FRESH token with a fresh `iat` rather than
 * extending this one, so a stolen token's own window never grows past 12h
 * from whenever it was last actually used to refresh). Returns the payload
 * on success, else null — every failure (bad shape, bad signature, expired,
 * clock skew into the future) collapses to the same null, exactly like
 * getEnrolledDevice()'s "fail to unenrolled" posture.
 */
export function verifyOperatorToken(token: string, secret: string, nowMs: number = Date.now()): OperatorTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;

  const expected = base64url(hmac(`${header}.${body}`, secret));
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as Record<string, unknown>).op !== 'string' ||
    typeof (payload as Record<string, unknown>).dev !== 'string' ||
    typeof (payload as Record<string, unknown>).iat !== 'number'
  ) {
    return null;
  }
  const p = payload as OperatorTokenPayload;

  const expiresAtMs = (p.iat + OPERATOR_COOKIE_MAX_AGE_S) * 1000;
  if (nowMs >= expiresAtMs) return null;
  // A token stamped in the future (clock skew, or a forged iat) is refused
  // rather than trusted with a longer remaining life than 12h could ever
  // give it honestly.
  if (p.iat * 1000 > nowMs + 60_000) return null;

  return p;
}

export interface OperatorCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

/**
 * Deliberately host-only (no Domain attribute), unlike the device cookie.
 * The device cookie is set once from owner.hioc.in and read on staff.hioc.in,
 * so it needs the shared parent domain (see deviceCookieDomain's comment).
 * The operator cookie is set AND read only ever on the staff surface — the
 * lock screen and every migrated route live under /staff and its APIs — so
 * there is no cross-subdomain reason to widen it, and the narrower scope is
 * strictly safer for a token that (unlike the device secret) names a PERSON.
 */
export function operatorCookieOptions(isProd: boolean): OperatorCookieOptions {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: OPERATOR_COOKIE_MAX_AGE_S,
  };
}

/** Same options with a zero lifetime — clears the cookie (DELETE = lock). */
export function clearedOperatorCookieOptions(isProd: boolean): OperatorCookieOptions {
  return { ...operatorCookieOptions(isProd), maxAge: 0 };
}
