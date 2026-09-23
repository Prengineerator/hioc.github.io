'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { formatIndianMobileDisplay } from '@/lib/phone';

interface SessionUser {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
}

/**
 * Fetches the current session client-side on mount (via /api/auth/me)
 * rather than reading cookies() in the root layout — that would force
 * every page in the app into per-request dynamic rendering just to show a
 * login link, which isn't worth the cost for this MVP.
 *
 * Logged-in is `data.user != null` — NOT `!!data.user?.email`. A
 * WhatsApp/phone-OTP account (also what guest checkout's OTP creates) has
 * no email, and the old email-only check showed "Log In" to an already
 * signed-in phone customer (the owner's bug report). /api/auth/me always
 * includes `id` on a real session, so any field on `user` besides its
 * presence is just display data.
 *
 * Re-fetches on every pathname change, not just on mount: this component
 * lives in the root layout and is never remounted by client-side
 * navigation, and router.refresh() (used after login/logout) re-renders
 * Server Components but does not re-run an already-fired Client Component
 * effect — without the pathname dependency, the header would keep showing
 * "Log In" after a successful login until a manual hard reload.
 *
 * Also re-checks on window focus/visibility: a login completed in another
 * tab (or a hard redirect from /login, which can land before this tab's
 * pathname effect would re-fire) otherwise leaves this header stale until
 * something else causes a pathname change.
 */
export function AccountNav() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      const data = await res.json();
      if (mountedRef.current) setUser(data.user ?? null);
    } catch {
      // Leave the previous session state as-is on a network hiccup.
    } finally {
      if (mountedRef.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    function onFocus() {
      refresh();
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') refresh();
    }
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    router.refresh();
  }

  // Reserves roughly the width of "My Account" so the header doesn't jump
  // once the session check resolves.
  if (!loaded) {
    return <li className="min-h-[44px] w-24" aria-hidden="true" />;
  }

  if (!user) {
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

  const title = user.name || formatIndianMobileDisplay(user.phone) || user.email || undefined;

  return (
    <>
      <li>
        <Link
          href="/account"
          title={title}
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
