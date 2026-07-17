'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

type Mode = 'otp' | 'password';
type OtpStep = 'email' | 'code';
type PasswordAction = 'login' | 'signup';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/';

  const [mode, setMode] = useState<Mode>('otp');
  const [passwordAction, setPasswordAction] = useState<PasswordAction>('login');
  const [otpStep, setOtpStep] = useState<OtpStep>('email');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

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

  async function handlePasswordLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    resetMessages();
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        router.push(next);
        router.refresh();
        return;
      }
      setError(res.status === 401 ? 'Invalid email or password.' : 'Login failed.');
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    resetMessages();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/customer/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        if (data.needsEmailConfirmation) {
          setInfo('Account created — check your email to confirm it, then log in below.');
          setPasswordAction('login');
          setPassword('');
        } else {
          router.push(next);
          router.refresh();
        }
        return;
      }
      setError(data.error ?? 'Could not create account.');
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

        <div className="mb-6 flex rounded-md border border-[#e5e5e5] p-1 text-sm">
          <button
            type="button"
            onClick={() => switchMode('otp')}
            className={`flex-1 rounded px-3 py-1.5 font-bold transition-colors ${
              mode === 'otp' ? 'bg-tan text-cream' : 'text-charcoal'
            }`}
          >
            Email Code
          </button>
          <button
            type="button"
            onClick={() => switchMode('password')}
            className={`flex-1 rounded px-3 py-1.5 font-bold transition-colors ${
              mode === 'password' ? 'bg-tan text-cream' : 'text-charcoal'
            }`}
          >
            Password
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
              <label htmlFor="email" className="mb-1 block text-sm font-bold text-charcoal">
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
              className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? 'Sending…' : 'Send Code'}
            </button>
          </form>
        ) : null}

        {mode === 'otp' && otpStep === 'code' ? (
          <form onSubmit={handleOtpVerify} className="flex flex-col gap-4">
            <div>
              <label htmlFor="code" className="mb-1 block text-sm font-bold text-charcoal">
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
              className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
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

        {mode === 'password' ? (
          <>
            <div className="mb-4 flex justify-center gap-4 text-sm">
              <button
                type="button"
                onClick={() => {
                  setPasswordAction('login');
                  resetMessages();
                }}
                className={passwordAction === 'login' ? 'font-bold text-tan' : 'text-charcoal'}
              >
                Log In
              </button>
              <button
                type="button"
                onClick={() => {
                  setPasswordAction('signup');
                  resetMessages();
                }}
                className={passwordAction === 'signup' ? 'font-bold text-tan' : 'text-charcoal'}
              >
                Create Account
              </button>
            </div>
            <form
              onSubmit={passwordAction === 'login' ? handlePasswordLogin : handleSignup}
              className="flex flex-col gap-4"
            >
              <div>
                <label htmlFor="pw-email" className="mb-1 block text-sm font-bold text-charcoal">
                  Email
                </label>
                <input
                  id="pw-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                />
              </div>
              <div>
                <label htmlFor="password" className="mb-1 block text-sm font-bold text-charcoal">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  minLength={passwordAction === 'signup' ? 8 : undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                />
                {passwordAction === 'signup' ? (
                  <p className="mt-1 text-xs text-muted">At least 8 characters.</p>
                ) : null}
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Please wait…' : passwordAction === 'login' ? 'Log In' : 'Create Account'}
              </button>
            </form>
          </>
        ) : null}

        <p className="mt-6 text-center text-xs text-muted">
          <Link href="/" className="hover:text-tan hover:underline">
            Back to menu
          </Link>
        </p>
      </div>
    </div>
  );
}
