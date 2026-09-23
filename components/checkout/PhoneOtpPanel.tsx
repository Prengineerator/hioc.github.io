'use client';

// VERIFY-2 — the code box and the verified badge, shared by both customer
// ordering surfaces (web checkout and the table-QR pad). The mechanics live in
// usePhoneOtp(); this is only what they look like.
//
// The phone INPUT itself is not here on purpose: the two surfaces lay it out
// differently (a labelled form row vs a compact panel), and forcing one layout
// on both would make the shared piece worse than the duplication it removes.

import type { PhoneOtp } from '@/lib/hooks/usePhoneOtp';

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
          ? 'w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60'
          : 'shrink-0 rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal hover:border-tan disabled:opacity-50'
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
  /** Overridable so a caller that auto-places the order right after
   *  verification (see CheckoutForm) can say so on the button itself. */
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
        <p className="mt-1 text-xs text-red-700">{otp.error}</p>
      ) : null}

      {otp.step === 'sent' && !otp.verified ? (
        <div className="mt-3 flex flex-col gap-3 rounded-md border border-tan bg-[#f6efe9] px-4 py-3">
          <p className="text-sm text-charcoal">
            Enter the 6-digit code sent to your WhatsApp on{' '}
            <span className="font-bold">{otp.phone}</span> to confirm your number.
          </p>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={otp.code}
            onChange={(e) => otp.setCode(e.target.value)}
            placeholder="6-digit code"
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
          {otp.error ? <p className="text-xs text-red-700">{otp.error}</p> : null}
          <button
            type="button"
            onClick={() => void otp.verifyOtp()}
            disabled={otp.busy}
            className="w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {otp.busy ? verifyingLabel : verifyLabel}
          </button>
          <div className="flex items-center justify-between text-xs">
            <button
              type="button"
              onClick={() => void otp.sendOtp()}
              disabled={otp.busy}
              className="font-bold text-tan underline disabled:opacity-50"
            >
              Resend code
            </button>
            <button type="button" onClick={otp.cancel} className="text-muted underline">
              Change number
            </button>
          </div>
        </div>
      ) : null}

      {otp.verified ? (
        <div
          role="status"
          className="mt-2 flex items-center gap-2 rounded-md border border-tan bg-[#f6efe9] px-3 py-2 text-sm text-charcoal"
        >
          <span aria-hidden className="text-base font-bold text-tan">
            ✓
          </span>
          <span>Number verified — you can place your order.</span>
        </div>
      ) : null}
    </>
  );
}
