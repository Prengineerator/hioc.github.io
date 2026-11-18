'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { formatIndianMobileDisplay } from '@/lib/phone';

interface SessionUser {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
}

// The header avatar menu (docs/SHOP-V2-SPEC.md E4): every account destination is
// one tap from here. Beanies goes to /rewards.
const ACCOUNT_LINKS = [
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/addresses', label: 'Addresses' },
  { href: '/rewards', label: 'Beanies' },
  { href: '/account/profile', label: 'Profile' },
] as const;

const ITEM_CLASS =
  'flex min-h-[44px] items-center rounded-md px-3 text-sm font-semibold text-charcoal transition-colors hover:bg-surface hover:text-tan-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan';

/** One letter for the avatar: the name, else the email; a phone-only account gets a generic mark. */
function initial(user: { name: string | null; email: string | null }): string {
  return ((user.name || user.email || '').trim()[0] ?? '·').toUpperCase();
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
 * Signed in, the desktop header shows an avatar button that opens a small
 * disclosure menu: Orders, Addresses, Beanies, Profile and Log Out. It is a
 * plain button (aria-expanded / aria-controls) over a list of links, so Tab and
 * screen readers work natively; Escape closes it and returns focus to the
 * button, and so does a tap outside or a navigation.
 *
 * `hideLogout` (the mobile site menu) shows the same four links inline instead
 * and drops the Log Out button: the account pages carry their own, and a
 * one-tap logout in a nav list is easy to hit by mistake.
 *
 * Also re-checks on window focus/visibility: a login completed in another
 * tab (or a hard redirect from /login, which can land before this tab's
 * pathname effect would re-fire) otherwise leaves this header stale until
 * something else causes a pathname change.
 */
export function AccountNav({ hideLogout = false }: { hideLogout?: boolean } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLLIElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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

  // Close on navigation, on Escape (focus back to the button) and on a tap outside.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  async function handleLogout() {
    setOpen(false);
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
          className="inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-semibold text-charcoal transition-colors hover:bg-surface hover:text-tan-dark"
        >
          Log In
        </Link>
      </li>
    );
  }

  const title = user.name || formatIndianMobileDisplay(user.phone) || user.email || undefined;

  // The mobile site menu is already an open list: show the four destinations
  // inline, one tap each, under the "My Account" link.
  if (hideLogout) {
    return (
      <>
        <li>
          <Link href="/account" title={title} className={ITEM_CLASS}>
            My Account
          </Link>
        </li>
        {ACCOUNT_LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className={ITEM_CLASS + ' pl-6 font-normal'}>
              {l.label}
            </Link>
          </li>
        ))}
      </>
    );
  }

  return (
    <li ref={menuRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 text-sm font-semibold text-charcoal transition-colors hover:bg-surface hover:text-tan-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-tan-dark text-sm font-bold uppercase text-cream"
        >
          {initial(user)}
        </span>
        My Account
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className={'h-4 w-4 transition-transform ' + (open ? 'rotate-180' : '')}>
          <path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <ul
          id={menuId}
          aria-label="Account"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-line bg-cream p-1 shadow-elevated"
        >
          {/* The button only opens this menu, so the account home needs its own first entry. */}
          <li>
            <Link href="/account" className={ITEM_CLASS + ' w-full'}>
              My account
            </Link>
          </li>
          {ACCOUNT_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className={ITEM_CLASS + ' w-full'}>
                {l.label}
              </Link>
            </li>
          ))}
          <li className="mt-1 border-t border-line pt-1">
            <button type="button" onClick={handleLogout} className={ITEM_CLASS + ' w-full'}>
              Log Out
            </button>
          </li>
        </ul>
      ) : null}
    </li>
  );
}
