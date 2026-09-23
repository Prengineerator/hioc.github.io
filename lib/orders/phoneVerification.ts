// VERIFY-1 — may this order be placed against this number?
//
// Pure, because it is a rule about who may transact and it must have exactly
// one implementation. Today the answer lives only in CheckoutForm's disabled
// button, which is not enforcement at all: POST /api/orders never asked, so
// anything speaking HTTP could place an order against any number, and the
// table-QR checkout did not even have the button.
//
// That is not only an ordering-policy gap. The bill goes out over WhatsApp to
// whatever number the order carries, billed to the cafe, from the cafe's
// verified sender. An unverified `customer_phone` field is therefore a
// stranger-addressable WhatsApp send — the same shape as the unauthenticated
// sms-hook that was closed in dba55d4, reached through a different door.
//
// The verified fact comes from profiles.phone / profiles.phone_verified, which
// /api/auth/customer/phone-otp/verify writes only after Supabase has validated
// a code it sent to that number. Both it and POST /api/orders normalise to
// '+91XXXXXXXXXX', so the two are directly comparable.

export type PhoneVerificationCode =
  | 'ok'
  | 'not_required'
  | 'no_session'
  | 'not_verified'
  | 'phone_mismatch';

export interface PhoneVerificationVerdict {
  ok: boolean;
  code: PhoneVerificationCode;
  /** Shown to the customer verbatim. Says what to DO, not just what is wrong. */
  message: string;
}

export interface PhoneVerificationInput {
  /** flags.verifiedOrders — off until a real OTP has been seen to arrive. */
  enabled: boolean;
  /**
   * Staff taking an order at the counter are exempt, and must be. A walk-in
   * customer has not verified anything and is standing at the till; requiring
   * an OTP there would stop counter sales, which is a worse outcome than the
   * one this rule exists to prevent.
   */
  isStaff: boolean;
  /** The placing session, or null for an anonymous guest. */
  sessionUserId: string | null;
  /** profiles.phone for that session, '+91XXXXXXXXXX' or null. */
  profilePhone: string | null;
  profilePhoneVerified: boolean;
  /** The order's customer_phone, already normalised to '+91XXXXXXXXXX'. */
  orderPhone: string;
}

const VERIFY_PROMPT =
  'Verify your mobile number before placing the order — tap "Get OTP" and enter the code we send you on WhatsApp.';

export function evaluatePhoneVerification(
  input: PhoneVerificationInput,
): PhoneVerificationVerdict {
  if (!input.enabled || input.isStaff) {
    return { ok: true, code: 'not_required', message: '' };
  }

  if (!input.sessionUserId) {
    return { ok: false, code: 'no_session', message: VERIFY_PROMPT };
  }

  // An account that exists but has never confirmed a number — every customer
  // who signed up by email before this rule existed is in this state, and gets
  // asked to verify once.
  if (!input.profilePhoneVerified || !input.profilePhone) {
    return { ok: false, code: 'not_verified', message: VERIFY_PROMPT };
  }

  // Verified SOME number is not the same as verified THIS number. Without this
  // clause, one verified account could address a bill to any number at all,
  // which is most of the hole still open.
  if (input.profilePhone !== input.orderPhone) {
    return {
      ok: false,
      code: 'phone_mismatch',
      message:
        'This order has a different mobile number than the one you verified. Use your verified number, or verify the new one before ordering.',
    };
  }

  return { ok: true, code: 'ok', message: '' };
}
