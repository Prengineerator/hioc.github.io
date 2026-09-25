// The /feedback/[token] link's token: how it is made and matched.
//
// Same reasoning as lib/api/deviceCookie.ts's device token / pos_devices'
// token_hash / tables.qr_token: the plaintext exists for exactly one moment —
// here, the URL button's dynamic suffix at send time — and only its sha-256
// hash is ever stored. A column that can be read back is a secret that leaks
// through some future `select *`.
//
// Dependency-free (Node's `crypto` only) so it is unit-testable without a
// Supabase mock.

import { createHash, randomBytes } from 'crypto';

/** 32 random bytes, base64url. Short enough for a tidy WhatsApp button URL. */
export function newFeedbackToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * sha-256 hex. Plain hash, not bcrypt — this input is 256 bits of
 * machine-generated randomness (same call as hashDeviceToken), so there is no
 * dictionary to attack and no work factor worth paying on every page load.
 */
export function hashFeedbackToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A URL path segment is safe to hash as-is ONLY if it looks like a token we
 * could plausibly have issued — otherwise every stray bot request (favicon
 * probes, `../etc/passwd`, empty string) reaches the database. Base64url is
 * `[A-Za-z0-9_-]`; newFeedbackToken() always emits 43 chars for 32 bytes, but
 * this stays a *range* rather than an exact length so it isn't silently
 * broken by a future change to the byte count.
 */
export function looksLikeFeedbackToken(raw: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(raw);
}
