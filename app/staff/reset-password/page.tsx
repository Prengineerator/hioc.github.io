'use client';

import { Suspense, useState, type FormEvent } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSurfaceHref } from '@/components/SurfaceLink';
import { passwordProblem } from '@/lib/staff/accounts';

// docs/PHASE-5-STAFF-ACCOUNTS.md, "Password emails". Reached from the link
// lib/staff/emails.ts sends to a staffer's PERSONAL email — never their
// <id>@hioc.in login ID. Deliberately does NOT verify token_hash on load: a
// mail client / security scanner that prefetches the link would otherwise burn
// the one-time recovery token before the staffer ever opens it. The token is
// only spent on submit, by POST /api/auth/staff/reset.
export default function StaffResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <StaffResetPasswordForm />
    </Suspense>
  );
}

function StaffResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const surfaceHref = useSurfaceHref();
  const tokenHash = searchParams.get('token_hash') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const hint = password.length > 0 ? passwordProblem(password) : null;
  const inputType = showPasswords ? 'text' : 'password';

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    if (!tokenHash) {
      setError('This link is missing information — use the link from your email.');
      return;
    }
    const problem = passwordProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/staff/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token_hash: tokenHash, password }),
      });

      if (res.ok) {
        setDone(true);
        // The response already set the session cookies (POST handler signs
        // the staffer in) — just navigate there, surface-aware so this reads
        // staff.hioc.in/ rather than staff.hioc.in/staff on the subdomain.
        router.push(surfaceHref('/staff'));
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({ error: 'Could not reset your password.' }));
      setError(data.error ?? 'Could not reset your password.');
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
          <Image
            src="/images/logo-black.png"
            alt="HIOC."
            width={480}
            height={291}
            className="mx-auto h-10 w-auto object-contain"
          />
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted">
            Reset your password
          </p>
        </div>

        {!tokenHash ? (
          <div role="alert" className="rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
            This link is missing information. Open it from the email you were sent, or ask the owner for a new one.
          </div>
        ) : (
          <>
            {error ? (
              <div
                role="alert"
                className="mb-4 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-sm text-charcoal"
              >
                {error}
              </div>
            ) : null}

            {done ? (
              <p className="text-sm text-charcoal">Password set — signing you in…</p>
            ) : (
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div>
                  <label htmlFor="password" className="mb-1 block text-sm font-bold text-charcoal">
                    New password
                  </label>
                  <input
                    id="password"
                    type={inputType}
                    required
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                  />
                  <p className="mt-1 text-xs text-muted">
                    {hint ?? 'At least 8 characters.'}
                  </p>
                </div>
                <div>
                  <label htmlFor="confirm" className="mb-1 block text-sm font-bold text-charcoal">
                    Confirm password
                  </label>
                  <input
                    id="confirm"
                    type={inputType}
                    required
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
                  />
                </div>

                <label className="flex items-center gap-2 text-sm text-charcoal">
                  <input
                    type="checkbox"
                    checked={showPasswords}
                    onChange={(e) => setShowPasswords(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Show passwords
                </label>

                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-2 w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Setting password…' : 'Set password'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
