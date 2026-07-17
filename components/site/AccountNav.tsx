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

  if (!loaded) {
    return <li className="w-16" aria-hidden="true" />;
  }

  if (!email) {
    return (
      <li>
        <Link href="/login" className="text-charcoal transition-colors hover:text-tan">
          Log In
        </Link>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3">
      <span className="max-w-[10rem] truncate text-charcoal" title={email}>
        {email}
      </span>
      <button
        type="button"
        onClick={handleLogout}
        className="text-charcoal transition-colors hover:text-tan"
      >
        Log Out
      </button>
    </li>
  );
}
