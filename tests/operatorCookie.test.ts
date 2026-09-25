import { describe, expect, it } from 'vitest';
import {
  OPERATOR_COOKIE_MAX_AGE_S,
  clearedOperatorCookieOptions,
  operatorCookieOptions,
  operatorSecretOk,
  signOperatorToken,
  verifyOperatorToken,
} from '@/lib/api/operatorCookie';

// PIN-3 — the operator cookie's crypto and shape. No database, no
// next/headers: everything here is a property of the token itself.

const SECRET = 'a'.repeat(40);
const SHORT_SECRET = 'a'.repeat(31);

describe('operatorSecretOk', () => {
  it('accepts a secret >= 32 chars', () => {
    expect(operatorSecretOk(SECRET)).toBe(true);
    expect(operatorSecretOk('a'.repeat(32))).toBe(true);
  });

  it('rejects missing or short secrets — PIN-3 fail-safe', () => {
    expect(operatorSecretOk(undefined)).toBe(false);
    expect(operatorSecretOk('')).toBe(false);
    expect(operatorSecretOk(SHORT_SECRET)).toBe(false);
  });
});

describe('sign/verify round trip', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');

  it('round-trips a freshly signed token', () => {
    const token = signOperatorToken({ op: 'user-1', dev: 'device-1', iat: Math.floor(now / 1000) }, SECRET);
    const payload = verifyOperatorToken(token, SECRET, now);
    expect(payload).toEqual({ op: 'user-1', dev: 'device-1', iat: Math.floor(now / 1000) });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signOperatorToken({ op: 'user-1', dev: 'device-1', iat: Math.floor(now / 1000) }, SECRET);
    expect(verifyOperatorToken(token, 'b'.repeat(40), now)).toBeNull();
  });

  it('rejects a tampered payload (op swapped for a different user)', () => {
    const token = signOperatorToken({ op: 'user-1', dev: 'device-1', iat: Math.floor(now / 1000) }, SECRET);
    const [header, , signature] = token.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ op: 'user-2', dev: 'device-1', iat: Math.floor(now / 1000) })).toString(
      'base64url',
    );
    const forged = `${header}.${forgedBody}.${signature}`;
    expect(verifyOperatorToken(forged, SECRET, now)).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(verifyOperatorToken('not-a-token', SECRET, now)).toBeNull();
    expect(verifyOperatorToken('a.b', SECRET, now)).toBeNull();
    expect(verifyOperatorToken('', SECRET, now)).toBeNull();
  });

  it('accepts right up to the 12h boundary and rejects just past it', () => {
    const iat = Math.floor(now / 1000);
    const token = signOperatorToken({ op: 'user-1', dev: 'device-1', iat }, SECRET);
    const justBefore = now + OPERATOR_COOKIE_MAX_AGE_S * 1000 - 1000;
    const justAfter = now + OPERATOR_COOKIE_MAX_AGE_S * 1000 + 1000;
    expect(verifyOperatorToken(token, SECRET, justBefore)).not.toBeNull();
    expect(verifyOperatorToken(token, SECRET, justAfter)).toBeNull();
  });

  it('rejects a token stamped implausibly far in the future', () => {
    const token = signOperatorToken({ op: 'user-1', dev: 'device-1', iat: Math.floor(now / 1000) + 3600 }, SECRET);
    expect(verifyOperatorToken(token, SECRET, now)).toBeNull();
  });
});

describe('cookie options', () => {
  it('is httpOnly, SameSite=Lax, path=/, and 12h', () => {
    const opts = operatorCookieOptions(true);
    expect(opts).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: OPERATOR_COOKIE_MAX_AGE_S });
  });

  it('is not Secure outside production (parity with the device cookie)', () => {
    expect(operatorCookieOptions(false).secure).toBe(false);
  });

  it('carries no Domain attribute — host-only, unlike the device cookie', () => {
    expect(operatorCookieOptions(true)).not.toHaveProperty('domain');
  });

  it('clears with a zero maxAge, same shape otherwise', () => {
    expect(clearedOperatorCookieOptions(true)).toEqual({ ...operatorCookieOptions(true), maxAge: 0 });
  });
});
