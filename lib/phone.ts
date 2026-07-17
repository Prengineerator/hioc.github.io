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
