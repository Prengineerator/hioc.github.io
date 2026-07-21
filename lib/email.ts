// Lightweight email-format check for the optional e-bill address. Deliberately
// not RFC-5322 exhaustive — just enough to reject obviously invalid input
// before we store it or hand it to the email provider. Shared between the
// checkout client and the orders Route Handler so the two can't drift.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Trims + lowercases an email and validates its shape. Returns the normalized
 * address on success, or null if it isn't a plausibly-valid email.
 */
export function normalizeEmail(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  return trimmed.length <= 254 && EMAIL_REGEX.test(trimmed) ? trimmed : null;
}
