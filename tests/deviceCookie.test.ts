import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_COOKIE_MAX_AGE_S,
  clearedDeviceCookieOptions,
  deviceCookieDomain,
  deviceCookieOptions,
  hashDeviceToken,
  newDeviceToken,
} from '@/lib/api/deviceCookie';
import { surfaceForHost } from '@/lib/routing/surface';

// DEV-2 — the device secret. Everything here is a property of the credential
// itself, and every one of them fails silently in production if it is wrong: a
// host-scoped cookie makes an enrolled till look unenrolled to the surface that
// reads it, and a non-Secure cookie in production is a credential on the wire.

describe('deviceCookieDomain', () => {
  it('gives all three surfaces of one deployment the same device identity', () => {
    // The whole point. The owner enrolls from owner.hioc.in; the POS reads the
    // cookie on staff.hioc.in; both are the same physical machine. Host-scoped
    // (the correct choice for AUTH cookies, and the opposite one here) the
    // enrollment would simply be invisible where it is used.
    const hosts = ['hioc.in', 'staff.hioc.in', 'owner.hioc.in'];
    const domains = new Set(hosts.map((h) => deviceCookieDomain(h)));
    expect(domains).toEqual(new Set(['hioc.in']));
    // And those hosts really are the three surfaces, not three guesses.
    expect(hosts.map(surfaceForHost)).toEqual(['main', 'staff', 'owner']);
  });

  it('ignores the port and the case of the host', () => {
    expect(deviceCookieDomain('STAFF.HIOC.IN:443')).toBe('hioc.in');
  });

  it('only strips the two labels that are actually surfaces', () => {
    // surfaceForHost matches the leftmost label exactly, so this must too —
    // otherwise a cafe at staffcanteen.example.com would write its device
    // cookie to a domain it does not own.
    expect(deviceCookieDomain('mystaff.hioc.in')).toBe('mystaff.hioc.in');
    expect(surfaceForHost('mystaff.hioc.in')).toBe('main');
  });

  it('leaves the cookie host-only where a Domain attribute is invalid', () => {
    // Chrome rejects Domain=localhost outright; an IP literal cannot carry one
    // at all. Both are single-host situations anyway.
    expect(deviceCookieDomain('localhost:3001')).toBeUndefined();
    expect(deviceCookieDomain('staff.localhost:3001')).toBeUndefined();
    expect(deviceCookieDomain('127.0.0.1:3001')).toBeUndefined();
    expect(deviceCookieDomain('')).toBeUndefined();
    expect(deviceCookieDomain(null)).toBeUndefined();
  });

  it('scopes a preview deployment to itself', () => {
    expect(deviceCookieDomain('hioc-git-phase6-team.vercel.app')).toBe('hioc-git-phase6-team.vercel.app');
  });
});

describe('the device secret', () => {
  it('is 256 bits of randomness, and never the same twice', () => {
    const a = newDeviceToken();
    const b = newDeviceToken();
    expect(a).not.toBe(b);
    // 32 bytes, base64url: 43 chars, no padding, URL/cookie-safe alphabet.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes to stable hex that does not contain the secret', () => {
    const token = newDeviceToken();
    const hash = hashDeviceToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceToken(token)).toBe(hash); // the lookup depends on this
    expect(hash).not.toContain(token);
    expect(hashDeviceToken(newDeviceToken())).not.toBe(hash);
  });
});

describe('the cookie itself', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is httpOnly, Lax, site-wide, and lasts a year', () => {
    const opts = deviceCookieOptions('hioc.in');
    expect(opts.httpOnly).toBe(true);
    // Lax, not Strict: following a link into the POS must not land a staffer on
    // a machine that has silently forgotten what it is.
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge).toBe(DEVICE_COOKIE_MAX_AGE_S);
    expect(DEVICE_COOKIE_MAX_AGE_S).toBe(365 * 24 * 60 * 60);
  });

  it('is Secure in production and not on http localhost', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(deviceCookieOptions('hioc.in').secure).toBe(true);
    vi.stubEnv('NODE_ENV', 'development');
    // A Secure cookie on http://localhost is simply never stored, which would
    // make enrollment appear to succeed and then do nothing.
    expect(deviceCookieOptions('localhost:3001').secure).toBe(false);
  });

  it('clears with the same Domain and Path it was set with', () => {
    // A clear that differs in either attribute leaves the original cookie in
    // place, so a revoked device would keep presenting a dead secret.
    const set = deviceCookieOptions('staff.hioc.in');
    const cleared = clearedDeviceCookieOptions('staff.hioc.in');
    expect(cleared.domain).toBe(set.domain);
    expect(cleared.path).toBe(set.path);
    expect(cleared.maxAge).toBe(0);
  });
});
