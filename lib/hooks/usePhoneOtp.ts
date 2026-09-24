'use client';

// VERIFY-2 — the WhatsApp OTP state machine, owned in one place.
//
// There are two customer ordering surfaces: the web checkout and the table-QR
// pad. Until now only the first had any verification, and the second did not
// even ask for a phone number — it was an optional field labelled "for your
// bill on WhatsApp". Adding a second copy of this flow there would leave the
// rule with two implementations and one of them would eventually drift; the
// mechanics live here instead, and each surface renders its own markup around
// them (a full form on one, a compact panel on the other).
//
// What is deliberately IN here rather than left to the caller:
//   * re-locking on edit. Verifying one number and then typing another must
//     invalidate the verification — otherwise the whole check is decorative.
//   * the endpoints. /api/auth/customer/phone-otp/{request,verify} log the
//     guest in on success, which is what makes profiles.phone_verified true and
//     therefore what POST /api/orders will accept.
//
// Two modes. A guest verifies through the phone-otp endpoints, which sign
// them in as that number's account. A customer who is ALREADY signed in (e.g.
// by email) must not be switched to a different account — `linkToAccount`
// instead attaches the number to their current account via Supabase's
// updateUser({ phone }) + verifyOtp('phone_change'), then mirrors it into
// profiles.phone_verified through PATCH /api/account/me (the same flow the
// Profile page uses).
//
// Verifying is NOT placing. They stay separate actions so a validation failure
// at placement never drops someone back into re-entering a code that has since
// expired.

import { useCallback, useState } from 'react';
import { normalizeIndianMobile } from '@/lib/phone';
import { createClient } from '@/lib/supabase';

export type PhoneOtpStep = 'idle' | 'sent';

export interface PhoneOtp {
  phone: string;
  /** Sets the number and, if it changed after a verification, un-verifies it. */
  setPhone: (value: string) => void;
  verified: boolean;
  step: PhoneOtpStep;
  code: string;
  setCode: (value: string) => void;
  busy: boolean;
  error: string | null;
  /** Fills the number only when the field is still empty (profile prefill). */
  prefillPhone: (value: string) => void;
  /** True when the entered text is a well-formed Indian mobile number. */
  phoneIsValid: boolean;
  sendOtp: () => Promise<void>;
  verifyOtp: () => Promise<void>;
  /** "Change number" — closes the code box without discarding the number. */
  cancel: () => void;
}

export function usePhoneOtp(options?: {
  initialPhone?: string;
  /** Runs once, after a code checks out. The checkout uses it to claim the
   *  guest's past orders now that they are signed in. */
  onVerified?: () => void;
  /** Signed-in customer: add the number to THIS account instead of signing in. */
  linkToAccount?: boolean;
}): PhoneOtp {
  const [phone, setPhoneState] = useState(options?.initialPhone ?? '');
  const [verified, setVerified] = useState(false);
  const [step, setStep] = useState<PhoneOtpStep>('idle');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onVerified = options?.onVerified;
  const linkToAccount = Boolean(options?.linkToAccount);

  const setPhone = useCallback((value: string) => {
    // Editing the number resets the whole flow, unconditionally. Without this,
    // a guest could verify one number, swap in another, and place the order
    // against a number nobody confirmed. Unconditional rather than guarded on
    // "was it verified?" because React bails out of a re-render when a value is
    // already what it is being set to, and a guard here is one more branch that
    // can be wrong.
    setPhoneState(value);
    setVerified(false);
    setStep('idle');
    setCode('');
    setError(null);
  }, []);

  // Profile prefill. Fills ONLY an empty field, so a number someone has already
  // started typing is never overwritten when the account lookup lands. Stable
  // across renders (empty deps) so an effect can depend on it without re-running
  // on every keystroke — which is why it is here rather than a `setPhone` call
  // guarded at the call site.
  const prefillPhone = useCallback((value: string) => {
    setPhoneState((current) => current || value);
  }, []);

  const sendOtp = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (linkToAccount) {
        const normalized = normalizeIndianMobile(phone);
        if (!normalized) throw new Error('Enter a valid 10-digit mobile number.');
        const { error: linkError } = await createClient().auth.updateUser({ phone: `+91${normalized}` });
        if (linkError) {
          throw new Error(
            /already|registered|exists/i.test(linkError.message)
              ? 'This number already has its own login. Log out and log in with your mobile number instead.'
              : linkError.message,
          );
        }
      } else {
        const res = await fetch('/api/auth/customer/phone-otp/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? 'Could not send the verification code.');
      }
      setStep('sent');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the verification code.');
    } finally {
      setBusy(false);
    }
  }, [phone, linkToAccount]);

  const verifyOtp = useCallback(async () => {
    if (!code.trim()) {
      setError('Enter the code sent to your WhatsApp.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (linkToAccount) {
        const normalized = normalizeIndianMobile(phone);
        if (!normalized) throw new Error('Enter a valid 10-digit mobile number.');
        const e164 = `+91${normalized}`;
        const { error: otpError } = await createClient().auth.verifyOtp({
          phone: e164,
          token: code.trim(),
          type: 'phone_change',
        });
        if (otpError) throw new Error('Invalid or expired code.');
        // Supabase now holds the number on this account; mirror it into
        // profiles (what POST /api/orders checks).
        const res = await fetch('/api/account/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: e164 }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? 'Verified, but could not save the number to your account.');
      } else {
        const res = await fetch('/api/auth/customer/phone-otp/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, token: code.trim() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? 'Invalid or expired code.');
      }
      setVerified(true);
      setStep('idle');
      setCode('');
      onVerified?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid or expired code.');
    } finally {
      setBusy(false);
    }
  }, [phone, code, onVerified, linkToAccount]);

  const cancel = useCallback(() => {
    setStep('idle');
    setCode('');
    setError(null);
  }, []);

  return {
    phone,
    setPhone,
    prefillPhone,
    verified,
    step,
    code,
    setCode,
    busy,
    error,
    phoneIsValid: normalizeIndianMobile(phone) !== null,
    sendOtp,
    verifyOtp,
    cancel,
  };
}
