'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { normalizeLoginId, loginEmailFor } from '@/lib/staff/accounts';

const FORGOT_SENT_MESSAGE =
  'If that login ID has a personal email on file, a reset link is on its way. Otherwise ask the owner.';

/**
 * "ayush" → "ayush@hioc.in" (the Supabase auth email); a full address like
 * "ayush@hioc.in" or "someone@gmail.com" (an owner/manager profile predating
 * login IDs) passes through unchanged. Lets the field say "Login ID" and take
 * either form without the owner's existing address stopping working.
 */
function resolveLoginEmail(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('@')) return trimmed;
  const loginId = normalizeLoginId(trimmed);
  return loginId ? loginEmailFor(loginId) : trimmed;
}

export default function StaffLoginPage() {
  return (
    <Suspense fallback={null}>
      <StaffLoginForm />
    </Suspense>
  );
}

function StaffLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Initialized from ?error=not_staff, which middleware.ts sets when it
  // bounces a genuinely-authenticated-but-non-staff session back here —
  // without this, that case looked identical to a silent no-op click on
  // the login button, with the form just reappearing empty.
  const [error, setError] = useState<string | null>(() =>
    searchParams.get('error') === 'not_staff'
      ? "That account is signed in, but it doesn't have staff access. Contact the cafe owner if this is unexpected."
      : null,
  );
  const [submitting, setSubmitting] = useState(false);

  const [showForgot, setShowForgot] = useState(false);
  const [forgotLoginId, setForgotLoginId] = useState('');
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Declares which door this is; the server refuses a role that belongs
        // elsewhere and names the right entrance (lib/auth/audience.ts).
        body: JSON.stringify({ email: resolveLoginEmail(email), password, audience: 'staff' }),
      });

      if (res.ok) {
        const next = searchParams.get('next') ?? '/staff';
        router.push(next);
        router.refresh();
        return;
      }

      if (res.status === 401) {
        setError('Invalid login ID or password.');
      } else {
        const data = await res.json().catch(() => ({ error: 'Login failed' }));
        setError(data.error ?? 'Login failed');
      }
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // docs/PHASE-5-STAFF-ACCOUNTS.md, "Password emails": always the same
  // generic message, win or lose — no account enumeration, including on a
  // rate limit (429 still shows the same line rather than confirming an
  // account exists by naming a different failure).
  async function handleForgotSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setForgotSubmitting(true);
    setForgotMessage(null);
    try {
      await fetch('/api/auth/staff/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId: forgotLoginId }),
      });
    } catch {
      // Falls through to the same generic message below.
    } finally {
      setForgotMessage(FORGOT_SENT_MESSAGE);
      setForgotSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-[#faf7f4] px-4">
      <div className="mt-24 w-full max-w-sm rounded-md border border-[#e5e5e5] bg-cream p-8 shadow-sm">
        <div className="mb-6 text-center">
          <Image
            src="/images/logo-black.png"
            alt="HIOC."
            width={480}
            height={291}
            className="mx-auto h-10 w-auto object-contain"
          />
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted">
            Staff Portal
          </p>
        </div>

        {error ? (
          <div
            role="alert"
            className="mb-4 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-sm text-charcoal"
          >
            {error}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-bold text-charcoal">
              Login ID
            </label>
            <input
              id="email"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ayush or ayush@hioc.in"
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
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Logging in…' : 'Log In'}
          </button>
        </form>

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => {
              setShowForgot((v) => !v);
              setForgotMessage(null);
            }}
            className="text-sm font-bold text-tan underline decoration-tan/50 underline-offset-2 hover:text-tan-dark"
          >
            Forgot password?
          </button>
        </div>

        {showForgot ? (
          <form onSubmit={handleForgotSubmit} className="mt-4 flex flex-col gap-3 border-t border-[#e5e5e5] pt-4">
            {forgotMessage ? (
              <p role="status" className="text-sm text-charcoal">
                {forgotMessage}
              </p>
            ) : (
              <>
                <div>
                  <label htmlFor="forgotLoginId" className="mb-1 block text-sm font-bold text-charcoal">
                    Login ID
                  </label>
                  <input
                    id="forgotLoginId"
                    type="text"
                    autoCapitalize="none"
                    autoCorrect="off"
                    required
                    value={forgotLoginId}
                    onChange={(e) => setForgotLoginId(e.target.value)}
                    placeholder="ayush or ayush@hioc.in"
                    className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                  />
                </div>
                <button
                  type="submit"
                  disabled={forgotSubmitting}
                  className="w-full rounded-md border border-tan px-4 py-2 font-bold text-tan transition-colors hover:bg-[#f6efe9] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {forgotSubmitting ? 'Sending…' : 'Send reset link'}
                </button>
              </>
            )}
          </form>
        ) : null}
      </div>
    </div>
  );
}
