'use client';

// VERIFY-2 — the code box and the verified badge, shared by both customer
// ordering surfaces (web checkout and the table-QR pad). The mechanics live in
// usePhoneOtp(); this is only what they look like.
//
// The phone INPUT itself is not here on purpose: the two surfaces lay it out
// differently (a labelled form row vs a compact panel), and forcing one layout
// on both would make the shared piece worse than the duplication it removes.

import type { PhoneOtp } from '@/lib/hooks/usePhoneOtp';
import { Input } from '@/components/ui/Input';

export function GetOtpButton({
  otp,
  onBeforeSend,
  variant = 'inline',
  extraDisabled = false,
}: {
  otp: PhoneOtp;
  onBeforeSend?: () => boolean;
  /** 'primary' — full-width CTA styling for standalone placement (e.g. as the
   *  final step before placing an order), vs the default compact inline pill
   *  meant to sit next to the phone input. */
  variant?: 'inline' | 'primary';
  /** Extra disable condition beyond phone validity — e.g. other required
   *  fields on the surrounding form aren't filled in yet. Kept separate from
   *  `otp.phoneIsValid` so the caller can show its own reason for each. */
  extraDisabled?: boolean;
}) {
  if (otp.verified || otp.step !== 'idle') return null;
  return (
    <button
      type="button"
      onClick={() => {
        // The caller gets to run its own validation first (and show its own
        // message) — sending a code to a malformed number just wastes a
        // billable WhatsApp send and tells the customer nothing.
        if (onBeforeSend && !onBeforeSend()) return;
        void otp.sendOtp();
      }}
      disabled={otp.busy || !otp.phoneIsValid || extraDisabled}
      className={
        variant === 'primary'
          ? 'min-h-[48px] w-full rounded-md bg-tan-dark px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-60'
          : 'min-h-[44px] shrink-0 rounded-md border border-muted/80 px-4 py-2 text-sm font-semibold text-charcoal hover:border-tan disabled:opacity-50'
      }
    >
      {otp.busy ? 'Sending…' : 'Get OTP'}
    </button>
  );
}

export function PhoneOtpPanel({
  otp,
  verifyLabel = 'Verify number',
  verifyingLabel = 'Verifying…',
}: {
  otp: PhoneOtp;
  /** Overridable so a caller that does more than verify on this click can
   *  say so on the button itself. */
  verifyLabel?: string;
  verifyingLabel?: string;
}) {
  return (
    <>
      {/* A send failure (provider down, template misconfigured) surfaces here.
          It would otherwise only be shown inside the code box, which never
          opens if the send itself failed — leaving a button that appears to do
          nothing. */}
      {otp.step === 'idle' && !otp.verified && otp.error ? (
        <p role="alert" className="mt-1 text-sm text-red-700">{otp.error}</p>
      ) : null}

      {otp.step === 'sent' && !otp.verified ? (
        <div className="mt-3 flex flex-col gap-3 rounded-md border border-tan px-4 py-3">
          <p className="text-sm text-charcoal">
            Enter the 6-digit code sent to your WhatsApp on{' '}
            <span className="font-bold">{otp.phone}</span> to confirm your number.
          </p>
          <Input
            label="Verification code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={otp.code}
            onChange={(e) => otp.setCode(e.target.value)}
            placeholder="6-digit code"
            error={otp.error ?? undefined}
          />
          <button
            type="button"
            onClick={() => void otp.verifyOtp()}
            disabled={otp.busy}
            className="min-h-[48px] w-full rounded-md bg-tan-dark px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-60"
          >
            {otp.busy ? verifyingLabel : verifyLabel}
          </button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => void otp.sendOtp()}
              disabled={otp.busy}
              className="inline-flex min-h-[44px] items-center font-semibold text-tan-dark underline disabled:opacity-50"
            >
              Resend code
            </button>
            <button type="button" onClick={otp.cancel} className="inline-flex min-h-[44px] items-center text-muted underline">
              Change number
            </button>
          </div>
        </div>
      ) : null}

      {otp.verified ? (
        <div
          role="status"
          className="mt-2 flex items-center gap-2 text-sm text-charcoal"
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-green-700"
          >
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
          <span>Number verified. You can place your order.</span>
        </div>
      ) : null}
    </>
  );
}
