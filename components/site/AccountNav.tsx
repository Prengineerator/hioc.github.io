'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

/**
 * Fetches the current session client-side on mount (via /api/auth/me)
 * rather than reading cookies() in the root layout — that would force
 * every page in the app into per-request dynamic rendering just to show a
 * login link, which isn't worth the cost for this MVP.
 *
 * Re-fetches on every pathname change, not just on mount: this component
 * lives in the root layout and is never remounted by client-side
 * navigation, and router.refresh() (used after login/logout) re-renders
 * Server Components but does not re-run an already-fired Client Component
 * effect — without the pathname dependency, the header would keep showing
 * "Log In" after a successful login until a manual hard reload.
 */
export function AccountNav() {
  const router = useRouter();
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setEmail(data.user?.email ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setEmail(null);
    router.refresh();
  }

  // Reserves roughly the width of "My Account" so the header doesn't jump
  // once the session check resolves.
  if (!loaded) {
    return <li className="min-h-[44px] w-24" aria-hidden="true" />;
  }

  if (!email) {
    return (
      <li>
        <Link
          href="/login"
          className="inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-bold text-charcoal transition-colors hover:bg-surface hover:text-tan"
        >
          Log In
        </Link>
      </li>
    );
  }

  return (
    <>
      <li>
        <Link
          href="/account"
          title={email}
          className="inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-bold text-charcoal transition-colors hover:bg-surface hover:text-tan"
        >
          My Account
        </Link>
      </li>
      <li>
        <button
          type="button"
          onClick={handleLogout}
          className="inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-bold text-charcoal transition-colors hover:bg-surface hover:text-tan"
        >
          Log Out
        </button>
      </li>
    </>
  );
}
