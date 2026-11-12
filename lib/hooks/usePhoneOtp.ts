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
//
// The state itself is a pure reducer (lib/hooks/phoneOtpMachine.ts): one
// request at a time, and an answer only lands for the number it was asked for.

import { useCallback, useReducer, useRef } from 'react';
import { normalizeIndianMobile } from '@/lib/phone';
import { createClient } from '@/lib/supabase';
import {
  initialPhoneOtpState,
  phoneOtpBusy,
  phoneOtpReducer,
  samePhoneNumber,
  type PhoneOtpStep,
} from '@/lib/hooks/phoneOtpMachine';

export type { PhoneOtpStep };

/** What a successful verification hands `onVerified`. */
export interface PhoneOtpVerified {
  /** The number that was verified, as entered. */
  phone: string;
  /** linkToAccount: the profile PATCH /api/account/me answered with; null otherwise. */
  profile: unknown;
}

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
  /** Runs once, after a code checks out for the number still on screen. The
   *  checkout uses it to claim the guest's past orders now that they are
   *  signed in; the Profile page to show the number it just saved. */
  onVerified?: (verified: PhoneOtpVerified) => void;
  /** Signed-in customer: add the number to THIS account instead of signing in. */
  linkToAccount?: boolean;
}): PhoneOtp {
  const [state, dispatch] = useReducer(phoneOtpReducer, options?.initialPhone ?? '', initialPhoneOtpState);

  const onVerified = options?.onVerified;
  const linkToAccount = Boolean(options?.linkToAccount);

  // What is on screen right now, for the async calls below: the number (an
  // answer is only for the number it was asked for) and whether a request is
  // out (one at a time, even for a second tap before the re-render).
  const phoneRef = useRef(state.phone);
  const inFlight = useRef(false);
  const requestId = useRef(0);

  const setPhone = useCallback((value: string) => {
    // Editing the number resets the whole flow, unconditionally (the reducer's
    // 'phone_changed'). Without this, a guest could verify one number, swap in
    // another, and place the order against a number nobody confirmed.
    phoneRef.current = value;
    dispatch({ type: 'phone_changed', value });
  }, []);

  // Profile prefill. Fills ONLY an empty field, so a number someone has already
  // started typing is never overwritten when the account lookup lands. Stable
  // across renders (empty deps) so an effect can depend on it without re-running
  // on every keystroke — which is why it is here rather than a `setPhone` call
  // guarded at the call site.
  const prefillPhone = useCallback((value: string) => {
    if (!phoneRef.current) phoneRef.current = value;
    dispatch({ type: 'prefill', value });
  }, []);

  const setCode = useCallback((value: string) => dispatch({ type: 'code_changed', value }), []);

  /** Runs one request for the number on screen now; false if another is still out. */
  const run = useCallback(
    async (kind: 'send' | 'verify', work: (phone: string) => Promise<unknown>, fallback: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const id = ++requestId.current;
      const asked = phoneRef.current;
      dispatch({ type: 'request_started', id, kind, phone: asked });
      try {
        const result = await work(asked);
        dispatch({ type: 'request_succeeded', id });
        if (kind === 'verify' && samePhoneNumber(asked, phoneRef.current)) {
          onVerified?.({ phone: asked, profile: result ?? null });
        }
      } catch (err) {
        dispatch({ type: 'request_failed', id, message: err instanceof Error ? err.message : fallback });
      } finally {
        inFlight.current = false;
      }
    },
    [onVerified],
  );

  const sendOtp = useCallback(
    () =>
      run(
        'send',
        async (phone) => {
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
            return null;
          }
          const res = await fetch('/api/auth/customer/phone-otp/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error ?? 'Could not send the verification code.');
          return null;
        },
        'Could not send the verification code.',
      ),
    [run, linkToAccount],
  );

  const code = state.code;
  const verifyOtp = useCallback(async () => {
    const token = code.trim();
    if (!token) {
      dispatch({ type: 'invalid', message: 'Enter the code sent to your WhatsApp.' });
      return;
    }
    await run(
      'verify',
      async (phone) => {
        if (linkToAccount) {
          const normalized = normalizeIndianMobile(phone);
          if (!normalized) throw new Error('Enter a valid 10-digit mobile number.');
          const e164 = `+91${normalized}`;
          const { error: otpError } = await createClient().auth.verifyOtp({
            phone: e164,
            token,
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
          return data;
        }
        const res = await fetch('/api/auth/customer/phone-otp/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? 'Invalid or expired code.');
        return null;
      },
      'Invalid or expired code.',
    );
  }, [run, code, linkToAccount]);

  const cancel = useCallback(() => dispatch({ type: 'cancel' }), []);

  return {
    phone: state.phone,
    setPhone,
    prefillPhone,
    verified: state.verified,
    step: state.step,
    code: state.code,
    setCode,
    busy: phoneOtpBusy(state),
    error: state.error,
    phoneIsValid: normalizeIndianMobile(state.phone) !== null,
    sendOtp,
    verifyOtp,
    cancel,
  };
}
