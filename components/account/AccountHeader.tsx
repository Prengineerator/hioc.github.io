'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { formatIndianMobileDisplay } from '@/lib/phone';
import { flags } from '@/lib/flags';
import { PASS_SHORT_NAME } from '@/lib/passes/brand';

const LINKS = [
  { href: '/account', label: 'Overview' },
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/favorites', label: 'Favourites' },
  { href: '/rewards', label: 'Rewards' },
  // HIOC Ritual: only while the feature is on.
  ...(flags.coffeePass ? [{ href: '/ritual', label: PASS_SHORT_NAME }] : []),
  { href: '/account/profile', label: 'Profile' },
];

interface SessionUser {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
}

export function AccountHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [user, setUser] = useState<SessionUser | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setUser(data.user ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The nav below is a horizontally scrolling pill row on narrow screens
  // (360px has no room for 5 labels side by side) — on first paint and on
  // every navigation, the active pill may be scrolled off-screen, so bring
  // it into view.
  useEffect(() => {
    const active = navRef.current?.querySelector('[data-active="true"]');
    // Scroll only the pill row (not the page): scrollIntoView can nudge the
    // whole page sideways, so set the row's own scrollLeft instead.
    const nav = navRef.current;
    if (nav && active instanceof HTMLElement) {
      nav.scrollLeft = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    }
  }, [pathname]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/');
      router.refresh();
    }
  }

  // Who's signed in: name, else their phone formatted for reading
  // ("+91 98765 43210"), else their email — a phone-only account has
  // neither a name nor an email, so this is often the only identifying
  // line on the page for that customer.
  const whoLabel = user?.name || formatIndianMobileDisplay(user?.phone) || user?.email || null;

  return (
    <header className="border-b border-line bg-cream">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <Link href="/" className="font-bold text-charcoal">
            HIOC. My account
          </Link>
          {whoLabel ? <p className="truncate text-sm text-muted">{whoLabel}</p> : null}
        </div>
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          className="inline-flex min-h-[44px] shrink-0 items-center px-1 text-sm font-semibold text-muted hover:text-tan-dark disabled:opacity-60"
        >
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </div>
      {/* The pill row lives inside the same max-w-3xl px-4 box as the title
          row, so the page is never wider than the viewport (a -mx-4 bleed
          used to push every account page to ~406px at 390). It scrolls
          horizontally within that box; [scrollbar-width:none] + the webkit
          selector hide the scrollbar itself without disabling scrolling. */}
      <div className="mx-auto max-w-3xl px-4 pb-3">
      <nav
        ref={navRef}
        aria-label="Account navigation"
        className="relative flex gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {LINKS.map((l) => {
          const active = l.href === '/account' ? pathname === '/account' : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              data-active={active ? 'true' : undefined}
              className={
                'inline-flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-semibold transition-colors ' +
                (active ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-surface')
              }
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      </div>
    </header>
  );
}
