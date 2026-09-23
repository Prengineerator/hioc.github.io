// DEV-2 — the device secret: how it is made, how it is stored, where it is sent.
//
// Deliberately free of any Supabase or next/headers import so all of it is
// unit-testable (tests/deviceCookie.test.ts). The database half lives in
// lib/api/device.ts.

import { createHash, randomBytes } from 'crypto';

/**
 * Cookie name. Prefixed like the rest of this app's own cookies so it is
 * obvious in devtools which cookies are ours and which are Supabase's.
 */
export const DEVICE_COOKIE = 'hioc_device';

/** One year. A till is enrolled once and then forgotten about. */
export const DEVICE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/**
 * 32 random bytes, base64url. Returned to the browser exactly once, in the
 * Set-Cookie header of the enrollment response, and never persisted anywhere
 * on our side — only its hash is.
 */
export function newDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * sha-256 hex. Plain hash, not bcrypt, and that is the right call HERE: this
 * input is 256 bits of machine-generated randomness, so there is no dictionary
 * to attack and no work factor worth paying on every request. (staff_pins in
 * PIN-1 is the opposite case — four human-chosen digits — and uses bcrypt.)
 */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Which domain the device cookie is scoped to.
 *
 * This is the one part that has to know about the three-surface split. Auth
 * cookies are host-scoped on purpose — each subdomain carries its own session,
 * which is what keeps /staff and /owner separate doors. A DEVICE cookie is the
 * opposite kind of thing: it identifies the machine, it grants nothing, and the
 * owner enrolls it from owner.hioc.in while the POS reads it on staff.hioc.in.
 * Host-scoped, the enrollment would be invisible to the surface that needs it.
 *
 * So it is scoped to the parent domain, which also means the customer site at
 * hioc.in receives it. That is not a leak worth avoiding: it is httpOnly, it
 * carries no authority, and hioc.in/staff IS the POS on the main domain — the
 * only domain that exists until the subdomain DNS is added.
 *
 * Returns undefined for hosts where a Domain attribute is wrong or rejected
 * (localhost, bare hostnames, IP literals), which makes the cookie host-only —
 * correct for local development, where there is one host anyway.
 */
export function deviceCookieDomain(host: string | null | undefined): string | undefined {
  const h = (host ?? '').toLowerCase().trim().split(':')[0];
  if (!h) return undefined;
  // IP literals cannot carry a Domain attribute.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes('[')) return undefined;

  const labels = h.split('.');
  // staff.hioc.in and owner.hioc.in must both write the cookie the OTHER can
  // read, so climb to the shared parent. Only these two labels: a cafe domain
  // could legitimately be `staffcanteen.example.com`, and surfaceForHost()
  // matches the same two exact labels.
  const parent = labels[0] === 'staff' || labels[0] === 'owner' ? labels.slice(1) : labels;
  // 'localhost', 'staff.localhost' → 'localhost', and any single-label host:
  // host-only. Chrome rejects Domain=localhost outright.
  if (parent.length < 2) return undefined;
  return parent.join('.');
}

export interface DeviceCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
  domain?: string;
}

/**
 * SameSite=Lax, not Strict: a staffer following a link into the POS (an order
 * link from a WhatsApp desktop client, say) must still arrive on an enrolled
 * device rather than a machine that has silently forgotten what it is.
 *
 * `secure` is off outside production only because localhost is http — a
 * Secure cookie there is simply never stored, which would make enrollment
 * appear to succeed and then do nothing.
 */
export function deviceCookieOptions(host: string | null | undefined): DeviceCookieOptions {
  const domain = deviceCookieDomain(host);
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: DEVICE_COOKIE_MAX_AGE_S,
    ...(domain ? { domain } : {}),
  };
}

/**
 * The same options with a zero lifetime — used to clear a cookie whose device
 * has been revoked or deleted. The Domain and Path must match the ones the
 * cookie was set with or the browser keeps the original.
 */
export function clearedDeviceCookieOptions(host: string | null | undefined): DeviceCookieOptions {
  return { ...deviceCookieOptions(host), maxAge: 0 };
}
