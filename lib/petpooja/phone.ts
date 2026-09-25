// Petpooja phone number validation — stricter than lib/phone.ts's
// normalizeIndianMobile. The legacy export mixes real mobiles, landline
// numbers dialled into the POS ('Customer Phone' accepts free text), and a
// placeholder "no phone given" sentinel (9999999999), so every non-mobile
// shape has to be rejected explicitly rather than best-effort-parsed the
// way normalizeIndianMobile is for live checkout input. See lib/phone.ts
// for the live-input version this deliberately does not reuse.

const VALID_MOBILE = /^[6-9]\d{9}$/;
const ALL_SAME_DIGIT = /^(\d)\1+$/;

/**
 * Normalizes a raw Petpooja "Customer Phone" cell — an xlsx int, or a CSV
 * string with a leading apostrophe (`'9876500001`) — to `'+91XXXXXXXXXX'`,
 * or null when it isn't a usable Indian mobile number. Callers keep the
 * original raw value separately (customer_phone_raw) regardless of the
 * result.
 *
 * Rejected (returns null):
 * - 9999999999, and any other all-same-digit number (POS placeholders for
 *   "no phone given")
 * - any 11-digit number (0-prefixed landlines / aggregator support lines,
 *   e.g. '08069454407')
 * - anything else that isn't exactly 10 digits, or 12 digits starting '91'
 *
 * Accepted: a bare 10-digit mobile (first digit 6-9), or that same number
 * prefixed with the country code '91' (12 digits total) — matching
 * lib/phone.ts's rule that a prefix is only stripped when there are MORE
 * than 10 digits, so a bare 10-digit input is never mis-truncated.
 */
export function normalizeLegacyPhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  let s = typeof raw === 'number' ? String(Math.trunc(raw)) : String(raw);
  s = s.trim();
  if (s.startsWith("'")) s = s.slice(1);

  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 12 && digits.startsWith('91')) {
    const rest = digits.slice(2);
    return isValidMobile(rest) ? `+91${rest}` : null;
  }

  if (digits.length !== 10) return null; // 11-digit landlines, short junk, etc.
  return isValidMobile(digits) ? `+91${digits}` : null;
}

function isValidMobile(digits: string): boolean {
  return VALID_MOBILE.test(digits) && !ALL_SAME_DIGIT.test(digits);
}
