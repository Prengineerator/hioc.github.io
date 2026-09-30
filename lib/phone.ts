// Indian mobile number validation — format only, no SMS verification.
// A valid mobile: exactly 10 digits, first digit 6-9.
// Shared between client components (checkout form) and server Route
// Handlers (order creation) so the two can never drift.

const INDIAN_MOBILE_REGEX = /^[6-9]\d{9}$/;

/**
 * Strips common formatting (+, spaces, hyphens) and an optional leading
 * trunk prefix ("0") and/or country code ("91"), then validates the
 * remaining 10 digits as an Indian mobile number.
 *
 * Prefixes are only stripped when there are MORE than 10 digits, so a bare
 * 10-digit input is always checked as-is — a real mobile number can itself
 * start with "91" or "0", and this guard prevents ever mis-truncating one.
 *
 * Returns the bare 10-digit number (e.g. "9876543210") on success, or null
 * if the input isn't a valid Indian mobile number in any recognizable form.
 */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/\D/g, '');

  if (digits.length > 10 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  if (digits.length > 10 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }

  return digits.length === 10 && INDIAN_MOBILE_REGEX.test(digits) ? digits : null;
}

/**
 * "9876543210" (or any recognizable Indian-mobile form — profiles.phone's
 * "+91XXXXXXXXXX", Supabase Auth's bare "91XXXXXXXXXX", raw digits, …) →
 * "+91 98765 43210" for display (AccountHeader/AccountNav "who's logged
 * in" line). Returns null when the input isn't a valid Indian mobile
 * number, same as normalizeIndianMobile.
 */
export function formatIndianMobileDisplay(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const normalized = normalizeIndianMobile(phone);
  if (!normalized) return null;
  return `+91 ${normalized.slice(0, 5)} ${normalized.slice(5)}`;
}

/**
 * normalizeIndianMobile for input that may already carry a country code. A leading
 * '+' says the caller SPECIFIED the country, so only '+91…' can be an Indian mobile:
 * '+6581234567' is a Singapore number, not the Indian 6581234567 that a blind
 * "strip everything but the digits" would turn it into. Without a '+' the input is
 * local entry and gets today's forgiving treatment ('9812345678', '09812345678',
 * '919812345678').
 *
 * Marketing consent is keyed by phone, so a foreign number read as Indian would opt in
 * (or out) an unrelated Indian customer. Use this — never normalizeIndianMobile —
 * wherever the input can be a stored/E.164 phone rather than something a customer
 * typed into an Indian-only field.
 *
 * Returns the bare 10 digits, or null (foreign '+' number, or not a valid mobile).
 */
export function normalizeIndianMobileHonouringPlus(input: string): string | null {
  const compact = input.trim().replace(/[\s\-().]/g, '');
  if (compact.startsWith('+') && !compact.startsWith('+91')) return null;
  return normalizeIndianMobile(compact);
}

/**
 * A typed phone → '+91XXXXXXXXXX', '+'-aware (see normalizeIndianMobileHonouringPlus), or null
 * for anything that is not text or not an Indian mobile.
 */
export function indianE164HonouringPlus(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const n = normalizeIndianMobileHonouringPlus(input);
  return n ? `+91${n}` : null;
}
