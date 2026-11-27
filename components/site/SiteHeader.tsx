'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSurface } from '@/components/SurfaceLink';
import { usePathname } from 'next/navigation';
import { AccountNav } from '@/components/site/AccountNav';
import { CART_CHANGED_EVENT } from '@/lib/cart/CartContext';
import { flags } from '@/lib/flags';

const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/menu', label: 'Menu' },
  // Instant Coffee jars shipped across India (docs/INSTANT-COFFEE-SHOP.md).
  ...(flags.shop ? [{ href: '/shop', label: 'Shop' }] : []),
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

// Same key lib/cart/CartContext.tsx persists to. The header lives in the root
// layout, outside the per-page <CartProvider>s (see the note on CartProvider),
// so it can't call useCart(); it reads the saved cart's quantities instead.
const CART_STORAGE_KEY = 'hioc.cart.v2';

function readCartCount(): number {
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed?.items)) return 0;
    return parsed.items.reduce((n: number, i: { qty?: number }) => n + (Number(i?.qty) || 0), 0);
  } catch {
    return 0;
  }
}

/**
 * Item count of the saved cart. Starts at 0 so the server and first client
 * render agree, then reads storage after mount. A cart changed on this page is
 * written by a different provider instance in the same tab (no `storage`
 * event fires there), so it listens for the provider's CART_CHANGED_EVENT,
 * plus `storage` for other tabs and a re-read on navigation and focus.
 */
function useCartCount(pathname: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const sync = () => setCount(readCartCount());
    sync();
    window.addEventListener(CART_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener(CART_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
    };
  }, [pathname]);
  return count;
}

/**
 * Cart link with a count badge. No cart drawer can be opened from outside the
 * pages that mount one, so it goes to checkout when there is something in the
 * cart and to the menu when there isn't.
 */
function CartLink({ count, className }: { count: number; className: string }) {
  const name = count > 0 ? `Cart, ${count} ${count === 1 ? 'item' : 'items'}` : 'Cart, empty';
  return (
    <Link href={count > 0 ? '/checkout' : '/menu'} aria-label={name} title={name} className={className}>
      <span className="relative inline-flex">
        <CartIcon />
        {count > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-2 -top-2 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-tan-dark px-1 text-[10px] font-bold leading-none text-cream"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </span>
    </Link>
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
  const surface = useSurface();
  const [mobileOpen, setMobileOpen] = useState(false);
  const cartCount = useCartCount(pathname);
  const headerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close the mobile panel on every route change, so it never stays open
  // across a navigation triggered some other way (e.g. browser back).
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // While the mobile panel is open: Esc closes it (focus goes back to the
  // toggle) and so does a tap anywhere outside the header.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMobileOpen(false);
        toggleRef.current?.focus();
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setMobileOpen(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [mobileOpen]);

  // Path check alone is not enough once the backstage has its own domains:
  // on staff.hioc.in the browser's pathname is '/orders', not '/staff/orders',
  // so the customer chrome would render right on top of the staff portal.
  // The surface comes from the Host header, which is the only thing that knows.
  if (surface !== 'main' || pathname.startsWith('/staff') || pathname.startsWith('/owner')) {
    return null;
  }

  return (
    <header ref={headerRef} className="sticky top-0 z-40 border-b border-line bg-cream/95 backdrop-blur print:hidden">
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
                      'inline-flex min-h-[44px] items-center rounded-md px-3 text-sm font-semibold transition-colors ' +
                      (active ? 'text-tan-dark' : 'text-charcoal hover:text-tan-dark')
                    }
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
            <li>
              <CartLink
                count={cartCount}
                className="ml-1 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-charcoal transition-colors hover:text-tan-dark"
              />
            </li>
            <AccountNav />
          </ul>
        </nav>

        <div className="flex items-center md:hidden">
        <CartLink
          count={cartCount}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-charcoal transition-colors hover:text-tan-dark"
        />
        <button
          ref={toggleRef}
          type="button"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-charcoal transition-colors hover:text-tan-dark"
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
      </div>

      {mobileOpen ? (
        // Overlays the page (absolute under the sticky header) instead of pushing it down.
        <nav
          id="mobile-nav"
          aria-label="Primary"
          className="absolute inset-x-0 top-full border-b border-t border-line bg-cream shadow-elevated md:hidden"
        >
          <ul className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-3">
            {NAV_LINKS.map((link) => {
              const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
              return (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={
                      'flex min-h-[44px] items-center rounded-md px-3 text-base font-semibold transition-colors ' +
                      (active ? 'bg-surface text-tan-dark' : 'text-charcoal hover:bg-surface hover:text-tan-dark')
                    }
                  >
                    {link.label}
                  </Link>
                </li>
              );
            })}
            {/* Log out is not offered here: it is one tap from the menu and an
                easy mistake. A signed-in customer keeps "My Account", whose
                header has a Log out. */}
            <AccountNav hideLogout />
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
