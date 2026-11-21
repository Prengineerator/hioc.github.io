'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { safeNextPath } from '@/lib/url';

// Customers sign in with a one-time code only: WhatsApp or email (owner
// rule). Staff keep their password login at /staff/login.
type Mode = 'otp' | 'phone';
type OtpStep = 'email' | 'code';
type PhoneStep = 'phone' | 'code';

// How long "Resend code" stays disabled after a code is sent.
const RESEND_SECONDS = 30;

// Guest-order claim (ACC-4): fired once, right after ANY successful login
// path below (email-OTP or phone-OTP), so a
// returning guest's past orders link onto their account regardless of how
// they signed in. Best-effort: a failure here must never block login.
async function claimGuestOrders() {
  try {
    await fetch('/api/account/claim', { method: 'POST' });
  } catch {
    // best-effort: the account page can't retroactively claim, but this
    // never blocks a successful login.
  }
}

// The auth routes answer with developer-style messages (and, for send
// failures, whatever Supabase said). Show the customer a plain sentence:
// known messages are mapped, anything else gets a generic line, and the raw
// server text is never displayed.
function friendlyError(raw: unknown, status: number, fallback: string): string {
  const msg = typeof raw === 'string' ? raw : '';
  if (status === 429 || /too many|rate limit|only request this after|security purposes/i.test(msg)) {
    return 'Too many tries. Please wait a few minutes and try again.';
  }
  if (/valid 10-digit|phone is required/i.test(msg)) {
    return 'Enter a valid 10-digit mobile number.';
  }
  if (/email is required|invalid.*email|email.*invalid/i.test(msg)) {
    return 'Enter a valid email address.';
  }
  if (/invalid or expired|token has expired|invalid token/i.test(msg) || status === 401) {
    return 'That code is wrong or has expired. Check it, or ask for a new one.';
  }
  if (/already linked/i.test(msg)) {
    return 'This number is already linked to another account.';
  }
  return fallback;
}

const SEND_FALLBACK = "We couldn't send a code. Please try again in a moment.";
const VERIFY_FALLBACK = "We couldn't check that code. Please try again.";
const NETWORK_ERROR = 'No connection. Check your internet and try again.';

// `initialNext` comes from app/login/page.tsx (a Server Component reading
// `searchParams` directly) rather than this component calling
// useSearchParams() itself: that removes the need for a Suspense boundary
// here entirely, and lets the server page decide the already-logged-in
// redirect with the exact same value this form uses post-login. It has
// already been through safeNextPath (a single leading "/" only).
export function LoginForm({ initialNext }: { initialNext: string | null }) {
  const router = useRouter();
  // No explicit `?next=` means the visitor just navigated to /login
  // directly: send them to their orders (what customers come back for),
  // not "/". An explicit `next` (e.g. /account/orders from the account
  // gate, or /account/rewards from the rewards page) always wins.
  const next = initialNext ?? '/account/orders';
  // "Back to menu" goes back to where they were headed (e.g. /checkout) when
  // that's a safe internal path, otherwise to the menu, not the home page.
  const backHref = safeNextPath(initialNext) ?? '/menu';

  // WhatsApp is the default (and first-offered) way in: it's the channel
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
  // Seconds until "Resend code" is available again (0 = available).
  const [cooldown, setCooldown] = useState(0);

  const codeRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Record<Mode, HTMLButtonElement | null>>({ phone: null, otp: null });

  // Focus the code field as soon as the code step appears.
  const onCodeStep = (mode === 'otp' && otpStep === 'code') || (mode === 'phone' && phoneStep === 'code');
  useEffect(() => {
    if (onCodeStep) codeRef.current?.focus();
  }, [onCodeStep]);

  // Tick the resend countdown down once a second; the effect re-arms itself
  // after each tick and cleans up on unmount.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

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
    setCooldown(0);
  }

  // Left/right arrows move between the two tabs (WAI-ARIA tabs pattern).
  function handleTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const target: Mode = mode === 'phone' ? 'otp' : 'phone';
    switchMode(target);
    tabRefs.current[target]?.focus();
  }

  // One request helper per channel, used by both the first send and Resend so
  // "Resend code" always calls exactly what the first send called.
  async function sendEmailCode() {
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
        setCode('');
        setCooldown(RESEND_SECONDS);
        setInfo(`We sent a 6-digit code to ${email}.`);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(friendlyError(data.error, res.status, SEND_FALLBACK));
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  async function sendPhoneCode() {
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
        setPhoneCode('');
        setCooldown(RESEND_SECONDS);
        setInfo(`We sent a 6-digit code on WhatsApp to +91 ${phone}.`);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(friendlyError(data.error, res.status, SEND_FALLBACK));
      }
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  function handleOtpRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void sendEmailCode();
  }

  function handlePhoneRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void sendPhoneCode();
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
      const data = await res.json().catch(() => ({}));
      setError(friendlyError(data.error, res.status, VERIFY_FALLBACK));
    } catch {
      setError(NETWORK_ERROR);
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
      const data = await res.json().catch(() => ({}));
      setError(friendlyError(data.error, res.status, VERIFY_FALLBACK));
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSubmitting(false);
    }
  }

  // Digits only, max 6: a pasted "123 456" or "123-456" still works.
  const digitsOnly = (v: string) => v.replace(/\D/g, '').slice(0, 6);

  const resendButton = (
    <Button
      type="button"
      variant="ghost"
      onClick={() => (mode === 'phone' ? sendPhoneCode() : sendEmailCode())}
      disabled={submitting || cooldown > 0}
    >
      {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
    </Button>
  );

  const tabClass = (active: boolean) =>
    `flex min-h-[44px] flex-1 items-center justify-center rounded px-3 text-sm font-semibold transition-colors ${
      active ? 'bg-tan-dark text-cream' : 'text-charcoal hover:bg-surface'
    }`;

  return (
    <div className="flex min-h-screen items-start justify-center bg-surface/40 px-4">
      <div className="mt-12 w-full max-w-sm rounded-md border border-line bg-cream p-6 shadow-sm sm:mt-24 sm:p-8">
        <div className="mb-5 text-center">
          <h1 className="text-xl font-bold text-charcoal">Log in</h1>
        </div>

        {/* What signing in unlocks. Kept to what the app really does; the
            last line follows the privacy policy (contact details are for
            orders, order updates and the account). */}
        <div className="mb-6 rounded-md bg-surface px-4 py-3 text-sm text-charcoal">
          <p className="font-semibold">With an account you can:</p>
          <ul className="mt-1 list-disc pl-5">
            <li>Pay at the counter instead of online</li>
            <li>Earn Beanies on your orders</li>
            <li>Reorder a past order in one tap</li>
          </ul>
          <p className="mt-2 text-muted">
            We use your number or email to send your sign-in code and order updates, and to keep your orders in one
            place. See our{' '}
            <Link href="/privacy" className="font-semibold text-tan-dark underline">
              privacy policy
            </Link>
            .
          </p>
        </div>

        {/* WhatsApp first: the default tab (set above) and the one most
            customers already have a code path for, since it's the same
            channel guest checkout verifies (VERIFY-2). */}
        <div role="tablist" aria-label="How to get your code" className="mb-6 flex gap-1 rounded-md border border-muted/80 p-1">
          <button
            type="button"
            role="tab"
            id="login-tab-phone"
            aria-selected={mode === 'phone'}
            aria-controls="login-panel"
            tabIndex={mode === 'phone' ? 0 : -1}
            ref={(el) => {
              tabRefs.current.phone = el;
            }}
            onClick={() => switchMode('phone')}
            onKeyDown={handleTabKey}
            className={tabClass(mode === 'phone')}
          >
            WhatsApp
          </button>
          <button
            type="button"
            role="tab"
            id="login-tab-email"
            aria-selected={mode === 'otp'}
            aria-controls="login-panel"
            tabIndex={mode === 'otp' ? 0 : -1}
            ref={(el) => {
              tabRefs.current.otp = el;
            }}
            onClick={() => switchMode('otp')}
            onKeyDown={handleTabKey}
            className={tabClass(mode === 'otp')}
          >
            Email
          </button>
        </div>

        <div
          role="tabpanel"
          id="login-panel"
          aria-labelledby={mode === 'phone' ? 'login-tab-phone' : 'login-tab-email'}
        >
          {error ? (
            <div
              role="alert"
              className="mb-4 rounded-md border border-red-700 bg-surface px-4 py-3 text-sm font-semibold text-red-700"
            >
              {error}
            </div>
          ) : null}
          {info ? (
            <div role="status" className="mb-4 rounded-md border border-line bg-surface px-4 py-3 text-sm text-charcoal">
              {info}
            </div>
          ) : null}

          {mode === 'otp' && otpStep === 'email' ? (
            <form onSubmit={handleOtpRequest} className="flex flex-col gap-4">
              <Input
                id="email"
                label="Email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="!border-muted/80 text-base"
              />
              <Button type="submit" size="lg" fullWidth loading={submitting}>
                {submitting ? 'Sending' : 'Send code'}
              </Button>
            </form>
          ) : null}

          {mode === 'otp' && otpStep === 'code' ? (
            <form onSubmit={handleOtpVerify} className="flex flex-col gap-4">
              <Input
                ref={codeRef}
                id="code"
                label="6-digit code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(digitsOnly(e.target.value))}
                placeholder="123456"
                className="!border-muted/80 text-base"
              />
              <Button type="submit" size="lg" fullWidth loading={submitting}>
                {submitting ? 'Checking' : 'Verify and log in'}
              </Button>
              {resendButton}
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOtpStep('email');
                  setCooldown(0);
                  resetMessages();
                }}
              >
                Use a different email
              </Button>
            </form>
          ) : null}

          {mode === 'phone' && phoneStep === 'phone' ? (
            <form onSubmit={handlePhoneRequest} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <label htmlFor="phone" className="text-sm font-semibold text-charcoal">
                  WhatsApp number
                </label>
                {/* Visible +91 prefix: customers type the 10 digits only. */}
                <div className="flex min-h-[44px] w-full items-stretch rounded-md border border-muted/80 bg-cream focus-within:border-tan">
                  <span className="flex items-center border-r border-line px-3 text-base text-charcoal" aria-hidden="true">
                    +91
                  </span>
                  <input
                    id="phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    required
                    aria-describedby="phone-hint"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="98765 43210"
                    className="min-w-0 flex-1 rounded-r-md bg-transparent px-3 py-2 text-base text-charcoal outline-none placeholder:text-muted"
                  />
                </div>
                <p id="phone-hint" className="text-sm text-muted">
                  We&apos;ll send a 6-digit code on WhatsApp to this number (India, +91).
                </p>
              </div>
              <Button type="submit" size="lg" fullWidth loading={submitting}>
                {submitting ? 'Sending' : 'Send WhatsApp code'}
              </Button>
            </form>
          ) : null}

          {mode === 'phone' && phoneStep === 'code' ? (
            <form onSubmit={handlePhoneVerify} className="flex flex-col gap-4">
              <Input
                ref={codeRef}
                id="phoneCode"
                label="WhatsApp code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={phoneCode}
                onChange={(e) => setPhoneCode(digitsOnly(e.target.value))}
                placeholder="123456"
                className="!border-muted/80 text-base"
              />
              <Button type="submit" size="lg" fullWidth loading={submitting}>
                {submitting ? 'Checking' : 'Verify and log in'}
              </Button>
              {resendButton}
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setPhoneStep('phone');
                  setCooldown(0);
                  resetMessages();
                }}
              >
                Use a different number
              </Button>
            </form>
          ) : null}
        </div>

        <p className="mt-6 text-center text-sm">
          <Link href={backHref} className="inline-flex min-h-[44px] items-center text-muted hover:text-tan-dark hover:underline">
            {backHref === '/menu' ? 'Back to menu' : 'Back'}
          </Link>
        </p>
      </div>
    </div>
  );
}
