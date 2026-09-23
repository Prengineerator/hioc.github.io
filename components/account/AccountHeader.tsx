'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { formatIndianMobileDisplay } from '@/lib/phone';

const LINKS = [
  { href: '/account', label: 'Overview' },
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/favorites', label: 'Favorites' },
  { href: '/rewards', label: 'Rewards' },
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
  // it into view (same pattern as components/owner/OwnerHeader.tsx).
  useEffect(() => {
    const active = navRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'center' });
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
    <header className="border-b border-[#e5e5e5] bg-cream">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <Link href="/" className="font-bold text-charcoal">
            HIOC · My Account
          </Link>
          {whoLabel ? <p className="truncate text-xs text-muted">{whoLabel}</p> : null}
        </div>
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          className="inline-flex min-h-[40px] shrink-0 items-center text-sm font-bold text-muted hover:text-tan disabled:opacity-60"
        >
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </div>
      {/* -mx-4/px-4 bleeds the scroll track to the viewport edge (so the
          last pill isn't clipped by the container's own padding) while
          keeping a 16px gutter before the first pill; [scrollbar-width:none]
          + the webkit selector hide the scrollbar itself without disabling
          scrolling. */}
      <nav
        ref={navRef}
        aria-label="Account navigation"
        className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {LINKS.map((l) => {
          const active = l.href === '/account' ? pathname === '/account' : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              data-active={active ? 'true' : undefined}
              className={
                'inline-flex min-h-[40px] shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-bold transition-colors ' +
                (active ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-[#f2efe9]')
              }
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
