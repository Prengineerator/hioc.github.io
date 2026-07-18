'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AccountNav } from '@/components/site/AccountNav';

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/menu', label: 'Menu' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

function CartIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="h-5 w-5">
      <path
        d="M3 4h2l2.4 12.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21 8H6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="21" r="1.4" fill="currentColor" />
      <circle cx="18" cy="21" r="1.4" fill="currentColor" />
    </svg>
  );
}

/**
 * The public site's header (logo, nav, cart affordance, AccountNav). Hidden
 * on /staff/** and /owner/**, which have their own separate chrome — those
 * are a distinct "backstage" surface and must not show the customer nav or
 * account widget. Gated client-side via usePathname() rather than reading
 * headers()/cookies() in the root layout, so `/`, `/about`, `/contact` etc.
 * stay statically rendered. usePathname() resolves correctly during SSR of
 * the initial request too, so there's no header flash on a hard navigation
 * to a backstage page.
 *
 * Sticky on all breakpoints (translucent + blur) so the "Menu" link and cart
 * affordance stay reachable while scrolling a long page — most useful on
 * mobile and the counter tablet, where reaching a footer link is a real cost.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile panel on every route change, so it never stays open
  // across a navigation triggered some other way (e.g. browser back).
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (pathname.startsWith('/staff') || pathname.startsWith('/owner')) {
    return null;
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-cream/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex shrink-0 items-center" aria-label="HIOC. home">
          <Image
            src="/images/logo-black.png"
            alt="HIOC."
            width={480}
            height={291}
            className="h-8 w-auto object-contain md:h-9"
            priority
          />
        </Link>

        <nav className="hidden md:block" aria-label="Primary">
          <ul className="flex items-center gap-1">
            {NAV_LINKS.map((link) => {
              const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={
                      'inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-bold transition-colors ' +
                      (active ? 'text-tan' : 'text-charcoal hover:text-tan')
                    }
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
            <li>
              <Link
                href="/menu"
                aria-label="View menu and cart"
                title="View menu and cart"
                className="ml-1 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-charcoal transition-colors hover:text-tan"
              >
                <CartIcon />
              </Link>
            </li>
            <AccountNav />
          </ul>
        </nav>

        <button
          type="button"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-charcoal transition-colors hover:text-tan md:hidden"
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          aria-controls="mobile-nav"
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="h-6 w-6">
              <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="h-6 w-6">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      {mobileOpen ? (
        <nav id="mobile-nav" aria-label="Primary" className="border-t border-line md:hidden">
          <ul className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
            {NAV_LINKS.map((link) => {
              const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={
                      'flex min-h-[44px] items-center rounded-md px-3 text-base font-bold transition-colors ' +
                      (active ? 'bg-surface text-tan' : 'text-charcoal hover:bg-surface hover:text-tan')
                    }
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
            <li>
              <Link
                href="/menu"
                className="flex min-h-[44px] items-center gap-2 rounded-md px-3 text-base font-bold text-charcoal transition-colors hover:bg-surface hover:text-tan"
              >
                <CartIcon />
                Your Order
              </Link>
            </li>
            <AccountNav />
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
