import { describe, expect, it } from 'vitest';
import {
  evaluatePhoneVerification,
  type PhoneVerificationInput,
} from '@/lib/orders/phoneVerification';

// VERIFY-1 — who may place an order against which number. Pure, so the rule can
// be read in one place; the route test proves the route actually asks it.

const VERIFIED_GUEST: PhoneVerificationInput = {
  enabled: true,
  isStaff: false,
  sessionUserId: 'u1',
  profilePhone: '+919876543210',
  profilePhoneVerified: true,
  orderPhone: '+919876543210',
};

describe('evaluatePhoneVerification', () => {
  it('lets a verified customer order against their own number', () => {
    expect(evaluatePhoneVerification(VERIFIED_GUEST)).toEqual({
      ok: true,
      code: 'ok',
      message: '',
    });
  });

  it('refuses an anonymous guest and says what to do', () => {
    const v = evaluatePhoneVerification({ ...VERIFIED_GUEST, sessionUserId: null });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('no_session');
    expect(v.message).toMatch(/OTP/);
  });

  it('refuses an account that has never confirmed a number', () => {
    // Every customer who signed up by email before this rule existed lands
    // here, and is asked to verify once.
    const v = evaluatePhoneVerification({
      ...VERIFIED_GUEST,
      profilePhoneVerified: false,
    });
    expect(v.code).toBe('not_verified');
  });

  it('refuses a verified account whose stored number is somehow blank', () => {
    const v = evaluatePhoneVerification({ ...VERIFIED_GUEST, profilePhone: null });
    expect(v.code).toBe('not_verified');
  });

  it('refuses an order addressed to a DIFFERENT number than the verified one', () => {
    // The clause that closes most of the hole: without it, one verified account
    // could send the cafe's WhatsApp bill to any number in the country.
    const v = evaluatePhoneVerification({ ...VERIFIED_GUEST, orderPhone: '+919000000001' });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('phone_mismatch');
    expect(v.message).toMatch(/verified/i);
  });

  it('exempts a staff order at the counter', () => {
    // A walk-in has verified nothing and is standing at the till. Requiring an
    // OTP here would stop counter sales — a worse failure than the one the rule
    // prevents.
    const v = evaluatePhoneVerification({
      ...VERIFIED_GUEST,
      isStaff: true,
      sessionUserId: null,
      profilePhone: null,
      profilePhoneVerified: false,
    });
    expect(v).toEqual({ ok: true, code: 'not_required', message: '' });
  });

  it('is inert while the flag is off', () => {
    // The state production ships in until an OTP has been seen to arrive on a
    // real handset.
    const v = evaluatePhoneVerification({
      ...VERIFIED_GUEST,
      enabled: false,
      sessionUserId: null,
      profilePhoneVerified: false,
    });
    expect(v).toEqual({ ok: true, code: 'not_required', message: '' });
  });
});
