'use client';

import { useReducer, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  INITIAL_LOGIN_FLOW,
  loginFlowReducer,
  loginLocked,
  type LoginMode,
  type LoginRequest,
} from './loginFlow';

// Customers sign in with a one-time code only — WhatsApp or email (owner
// rule). Staff keep their password login at /staff/login.

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
  // returning customers already have a code path for. The tabs, steps and the
  // request in flight are one reducer (./loginFlow.ts).
  const [flow, dispatchFlow] = useReducer(loginFlowReducer, INITIAL_LOGIN_FLOW);
  const { mode, emailStep: otpStep, phoneStep } = flow;

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneCode, setPhoneCode] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const submitting = loginLocked(flow);
  // One request at a time, even for a second Enter before the re-render.
  const inFlight = useRef(false);
  const requestId = useRef(0);

  function resetMessages() {
    setError(null);
    setInfo(null);
  }

  function switchMode(m: LoginMode) {
    if (inFlight.current) return;
    resetMessages();
    dispatchFlow({ type: 'switch_mode', mode: m });
    setCode('');
    setPhoneCode('');
  }

  function backToEntry() {
    if (inFlight.current) return;
    dispatchFlow({ type: 'back_to_entry' });
    resetMessages();
  }

  /**
   * Runs one request. `target` is the number or address it is for, captured
   * now: the code is later checked against where it was actually sent.
   */
  async function runRequest(
    request: LoginRequest,
    target: string,
    send: () => Promise<Response>,
    onOk: () => Promise<void> | void,
    failMessage: (res: Response) => Promise<string>,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = ++requestId.current;
    resetMessages();
    dispatchFlow({ type: 'request_started', id, request, target });
    let ok = false;
    try {
      const res = await send();
      if (res.ok) {
        ok = true;
        await onOk();
      } else {
        setError(await failMessage(res));
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      inFlight.current = false;
      dispatchFlow({ type: ok ? 'request_succeeded' : 'request_failed', id });
    }
  }

  const sendFailed = async (res: Response) => {
    const data = await res.json().catch(() => ({ error: 'Could not send code' }));
    return data.error ?? 'Could not send code';
  };
  const verifyFailed = async () => 'Invalid or expired code. Please try again.';
  const signedIn = async () => {
    await claimGuestOrders();
    router.push(next);
    router.refresh();
  };

  async function handleOtpRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const target = email;
    await runRequest(
      'email_request',
      target,
      () =>
        fetch('/api/auth/customer/otp/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: target }),
        }),
      () => setInfo(`We sent a 6-digit code to ${target}.`),
      sendFailed,
    );
  }

  async function handleOtpVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const target = flow.emailSentTo;
    await runRequest(
      'email_verify',
      target,
      () =>
        fetch('/api/auth/customer/otp/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: target, token: code }),
        }),
      signedIn,
      verifyFailed,
    );
  }

  async function handlePhoneRequest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const target = phone;
    await runRequest(
      'phone_request',
      target,
      () =>
        fetch('/api/auth/customer/phone-otp/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: target }),
        }),
      () => setInfo(`We sent a WhatsApp code to ${target}.`),
      sendFailed,
    );
  }

  async function handlePhoneVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const target = flow.phoneSentTo;
    await runRequest(
      'phone_verify',
      target,
      () =>
        fetch('/api/auth/customer/phone-otp/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: target, token: phoneCode }),
        }),
      signedIn,
      verifyFailed,
    );
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-[#faf7f4] px-4">
      <div className="mt-24 w-full max-w-sm rounded-md border border-line bg-cream p-8 shadow-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-charcoal">Log In</h1>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted">HIOC.</p>
        </div>

        <div className="mb-6 flex flex-wrap gap-1 rounded-md border border-line p-1 text-sm sm:flex-nowrap">
          {/* WhatsApp first — the default tab (set above) and the one most
              customers already have a code path for, since it's the same
              channel guest checkout verifies (VERIFY-2). */}
          <button
            type="button"
            onClick={() => switchMode('phone')}
            disabled={submitting}
            className={`min-w-[6.5rem] flex-1 rounded px-3 py-1.5 font-semibold transition-colors ${
              mode === 'phone' ? 'bg-tan-dark text-cream' : 'text-charcoal'
            }`}
          >
            WhatsApp
          </button>
          <button
            type="button"
            onClick={() => switchMode('otp')}
            disabled={submitting}
            className={`min-w-[6.5rem] flex-1 rounded px-3 py-1.5 font-semibold transition-colors ${
              mode === 'otp' ? 'bg-tan-dark text-cream' : 'text-charcoal'
            }`}
          >
            Email
          </button>
        </div>

        {error ? (
          <div
            role="alert"
            className="mb-4 rounded-md border border-tan bg-surface px-4 py-3 text-sm text-charcoal"
          >
            {error}
          </div>
        ) : null}
        {info ? (
          <div className="mb-4 rounded-md border border-line bg-surface px-4 py-3 text-sm text-charcoal">
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
                className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-md bg-tan-dark px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-60"
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
                className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-md bg-tan-dark px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Verifying…' : 'Verify & Log In'}
            </button>
            <button
              type="button"
              onClick={backToEntry}
              disabled={submitting}
              className="text-sm text-tan-dark hover:underline"
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
                className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
              />
              <p className="mt-1 text-sm text-muted">
                We&apos;ll send a 6-digit code on WhatsApp to this number.
              </p>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-md bg-tan-dark px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-60"
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
                className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full rounded-md bg-tan-dark px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Verifying…' : 'Verify & Log In'}
            </button>
            <button
              type="button"
              onClick={backToEntry}
              disabled={submitting}
              className="text-sm text-tan-dark hover:underline"
            >
              Use a different number
            </button>
          </form>
        ) : null}

        <p className="mt-6 text-center text-sm text-muted">
          <Link href="/" className="hover:text-tan-dark hover:underline">
            Back to menu
          </Link>
        </p>
      </div>
    </div>
  );
}
