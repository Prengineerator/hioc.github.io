'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// Customers sign in with a one-time code only — WhatsApp or email (owner
// rule). Staff keep their password login at /staff/login.
type Mode = 'otp' | 'phone';
type OtpStep = 'email' | 'code';
type PhoneStep = 'phone' | 'code';

// Guest-order claim (ACC-4) — fired once, right after ANY successful login
// path below (email-OTP or phone-OTP), so a
// returning guest's past orders link onto their account regardless of how
// they signed in. Best-effort: a failure here must never block login.
async function claimGuestOrders() {
  try {
    await fetch('/api/account/claim', { method: 'POST' });
  } catch {
    // best-effort — the account page can't retroactively claim, but this
    // never blocks a successful login.
  }
}

// `initialNext` comes from app/login/page.tsx (a Server Component reading
// `searchParams` directly) rather than this component calling
// useSearchParams() itself — that removes the need for a Suspense boundary
// here entirely, and lets the server page decide the already-logged-in
// redirect with the exact same value this form uses post-login.
export function LoginForm({ initialNext }: { initialNext: string | null }) {
  const router = useRouter();
  // No explicit `?next=` means the visitor just navigated to /login
  // directly — send them to their orders (what customers come back for),
  // not "/". An explicit `next` (e.g. /account/orders from the account
  // gate, or /rewards from the rewards page) always wins.
  const next = initialNext ?? '/account/orders';

  // WhatsApp is the default (and first-offered) way in — it's the channel
  // guests already verify at checkout (VERIFY-2), so it's the one most
  // returning customers already have a code path for.
  const [mode, setMode] = useState<Mode>('phone');
  const [otpStep, setOtpStep] = useState<OtpStep>('email');
  const [phoneStep, setPhoneStep] = useState<PhoneStep>('phone');

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function resetMessages() {
    setError(null);
    setInfo(null);
  }

  function switchMode(m: Mode) {
    resetMessages();
    setMode(m);
    setOtpStep('email');
    setCode('');
    setPhoneStep('phone');
    setPhoneCode('');
  }

  async function handleOtpRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    resetMessages();
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/customer/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setOtpStep('code');
        setInfo(`We sent a 6-digit code to ${email}.`);
      } else {
        const data = await res.json().catch(() => ({ error: 'Could not send code' }));
        setError(data.error ?? 'Could not send code');
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOtpVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    resetMessages();
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/customer/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token: code }),
      });
      if (res.ok) {
        await claimGuestOrders();
        router.push(next);
        router.refresh();
        return;
      }
      setError('Invalid or expired code. Please try again.');
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePhoneRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    resetMessages();
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/customer/phone-otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      if (res.ok) {
        setPhoneStep('code');
        setInfo(`We sent a WhatsApp code to ${phone}.`);
      } else {
        const data = await res.json().catch(() => ({ error: 'Could not send code' }));
        setError(data.error ?? 'Could not send code');
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePhoneVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    resetMessages();
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/customer/phone-otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, token: phoneCode }),
      });
      if (res.ok) {
        await claimGuestOrders();
        router.push(next);
        router.refresh();
        return;
      }
      setError('Invalid or expired code. Please try again.');
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-[#faf7f4] px-4">
      <div className="mt-24 w-full max-w-sm rounded-md border border-[#e5e5e5] bg-cream p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-charcoal">Log In</h1>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted">HIOC.</p>
        </div>

        <div className="mb-6 flex flex-wrap gap-1 rounded-md border border-[#e5e5e5] p-1 text-sm sm:flex-nowrap">
          {/* WhatsApp first — the default tab (set above) and the one most
              customers already have a code path for, since it's the same
              channel guest checkout verifies (VERIFY-2). */}
          <button
            type="button"
            onClick={() => switchMode('phone')}
            className={`min-w-[6.5rem] flex-1 rounded px-3 py-1.5 font-semibold transition-colors ${
              mode === 'phone' ? 'bg-tan text-cream' : 'text-charcoal'
            }`}
          >
            WhatsApp
          </button>
          <button
            type="button"
            onClick={() => switchMode('otp')}
            className={`min-w-[6.5rem] flex-1 rounded px-3 py-1.5 font-semibold transition-colors ${
              mode === 'otp' ? 'bg-tan text-cream' : 'text-charcoal'
            }`}
          >
            Email
          </button>
        </div>

        {error ? (
          <div
            role="alert"
            className="mb-4 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-sm text-charcoal"
          >
            {error}
          </div>
        ) : null}
        {info ? (
          <div className="mb-4 rounded-md border border-[#e5e5e5] bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
            {info}
          </div>
        ) : null}

        {mode === 'otp' && otpStep === 'email' ? (
          <form onSubmit={handleOtpRequest} className="flex flex-col gap-4">
            <div>
              <label htmlFor="email" className="mb-1 block text-sm font-semibold text-charcoal">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Sending…' : 'Send Code'}
            </button>
          </form>
        ) : null}

        {mode === 'otp' && otpStep === 'code' ? (
          <form onSubmit={handleOtpVerify} className="flex flex-col gap-4">
            <div>
              <label htmlFor="code" className="mb-1 block text-sm font-semibold text-charcoal">
                6-digit code
              </label>
              <input
                id="code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Verifying…' : 'Verify & Log In'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOtpStep('email');
                resetMessages();
              }}
              className="text-sm text-tan hover:underline"
            >
              Use a different email
            </button>
          </form>
        ) : null}

        {mode === 'phone' && phoneStep === 'phone' ? (
          <form onSubmit={handlePhoneRequest} className="flex flex-col gap-4">
            <div>
              <label htmlFor="phone" className="mb-1 block text-sm font-semibold text-charcoal">
                WhatsApp number
              </label>
              <input
                id="phone"
                type="tel"
                inputMode="numeric"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="98765 43210"
                className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
              />
              <p className="mt-1 text-sm text-muted">
                We&apos;ll send a 6-digit code on WhatsApp to this number.
              </p>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Sending…' : 'Send WhatsApp Code'}
            </button>
          </form>
        ) : null}

        {mode === 'phone' && phoneStep === 'code' ? (
          <form onSubmit={handlePhoneVerify} className="flex flex-col gap-4">
            <div>
              <label htmlFor="phoneCode" className="mb-1 block text-sm font-semibold text-charcoal">
                WhatsApp code
              </label>
              <input
                id="phoneCode"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                required
                value={phoneCode}
                onChange={(e) => setPhoneCode(e.target.value)}
                placeholder="123456"
                className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Verifying…' : 'Verify & Log In'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPhoneStep('phone');
                resetMessages();
              }}
              className="text-sm text-tan hover:underline"
            >
              Use a different number
            </button>
          </form>
        ) : null}

        <p className="mt-6 text-center text-sm text-muted">
          <Link href="/" className="hover:text-tan hover:underline">
            Back to menu
          </Link>
        </p>
      </div>
    </div>
  );
}
