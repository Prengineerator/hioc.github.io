'use client';

// The owner's own entrance.
//
// /staff/login used to establish owner sessions too, which meant the counter
// tablet's bookmark could open payroll. The dashboard reaches salary, drawer
// history and finalized pay runs — it deserves a door that only the owner can
// walk through, and one that looks different enough that signing in on the
// wrong device feels wrong.
//
// The role check itself is SERVER-side (app/api/auth/login/route.ts). Nothing
// here is a security boundary; this page only decides what to render.

import { Suspense, useState, type FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

export default function OwnerLoginPage() {
  return (
    <Suspense fallback={null}>
      <OwnerLoginForm />
    </Suspense>
  );
}

function OwnerLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(() =>
    searchParams.get('error') === 'not_owner'
      ? "That account is signed in, but it isn't the owner account. The dashboard is owner-only."
      : null,
  );
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Declares which door this is. The server resolves the account's role
        // and refuses a mismatch — a staff member signing in here gets sent to
        // the staff portal rather than a blank failure.
        body: JSON.stringify({ email, password, audience: 'owner' }),
      });

      if (res.ok) {
        const next = searchParams.get('next') ?? '/owner';
        router.push(next);
        router.refresh();
        return;
      }

      const data = await res.json().catch(() => ({ error: 'Login failed' }));
      setError(res.status === 401 ? 'Invalid email or password.' : (data.error ?? 'Login failed'));
    } catch {
      setError('Network error — please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-charcoal px-4">
      <div className="mt-24 w-full max-w-sm rounded-md border border-[#3a3a3a] bg-[#1f1f1f] p-8 shadow-lg">
        <div className="mb-6 text-center">
          <Image
            src="/images/logo-black.png"
            alt="HIOC."
            width={480}
            height={291}
            className="mx-auto h-10 w-auto object-contain invert"
          />
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-[#c9a227]">Owner Dashboard</p>
        </div>

        {error ? (
          <p className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm">
            <span className="text-[#ddd]">Email</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#444] bg-[#2a2a2a] px-3 py-2 text-cream"
            />
          </label>
          <label className="block text-sm">
            <span className="text-[#ddd]">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-[#444] bg-[#2a2a2a] px-3 py-2 text-cream"
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-[#c9a227] px-4 py-3 text-sm font-bold text-charcoal disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-[#888]">
          Staff sign in at{' '}
          <Link href="/staff/login" className="text-[#c9a227] underline">
            the staff portal
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
