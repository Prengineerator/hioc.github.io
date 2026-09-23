'use client';

import Image from 'next/image';
import { SurfaceLink as Link, useSurfaceHref } from '@/components/SurfaceLink';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { StoreOpenState } from '@/lib/store/hours';
import { flags } from '@/lib/flags';

const TABS = [
  { href: '/staff', label: 'Orders' },
  // POS-1/POS-3: the counter-tablet order-entry surface + tables board. Only
  // shown when the staffPos flag is on (default ON, NEXT_PUBLIC_FLAG_STAFF_POS=
  // false to hide both).
  ...(flags.staffPos
    ? [
        { href: '/staff/orders/new', label: 'New order' },
        { href: '/staff/tables', label: 'Tables' },
        // OPS-2: cash drawer day-open/close by denomination.
        { href: '/staff/cash', label: 'Cash' },
      ]
    : []),
  // ATT-1: attendance. Its own flag, not staffPos — clocking in has nothing to
  // do with whether the counter POS is enabled, and it stays dark until the
  // geofence is tuned on site.
  ...(flags.attendance
    ? [
        { href: '/staff/attendance', label: 'Attendance' },
        // LEAVE-3. Under /staff, not /owner, because managers approve here and
        // /owner/** is owner-only.
        { href: '/staff/leave', label: 'Leave' },
      ]
    : []),
  { href: '/staff/menu', label: 'Menu' },
];

export function StaffHeader({
  userEmail,
  userName,
  role,
}: {
  userEmail: string;
  userName?: string;
  role: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // usePathname() reports the BROWSER's path, which on staff.hioc.in is
  // '/orders' while the tab href is '/staff/orders'. Compare like with like or
  // no tab ever highlights on the subdomain.
  const toHref = useSurfaceHref();
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  const [openState, setOpenState] = useState<StoreOpenState | null>(null);
  // Mobile nav (< md): the tab row + account controls that sit inline on a
  // tablet/desktop header don't fit a 360–414px phone, so below md they move
  // into a collapsible drawer behind a hamburger button instead.
  const [menuOpen, setMenuOpen] = useState(false);

  // S7: live "is the store taking orders" badge, doubling as a quick link to
  // the Store controls section on the Menu page. Best-effort — a failed fetch
  // just leaves the badge hidden. Refreshed on a poll, on window focus, and
  // instantly when the Store controls fire 'hioc:store-changed', so it never
  // goes stale after an override/pause toggle (or a time-based open/close).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/store-settings', { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) setOpenState(data.openState ?? null);
        })
        .catch(() => {});
    };
    load();
    const poll = setInterval(load, 15000);
    window.addEventListener('focus', load);
    window.addEventListener('hioc:store-changed', load);
    return () => {
      cancelled = true;
      clearInterval(poll);
      window.removeEventListener('focus', load);
      window.removeEventListener('hioc:store-changed', load);
    };
  }, []);

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push(toHref('/staff/login'));
  }

  // The drawer is per-navigation, not per-render — a tapped link (or a route
  // change from anywhere else, e.g. router.push after logout) should always
  // leave it closed on the next screen rather than reopened over it.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const storeBadge = openState ? (
    <Link
      href="/staff/menu#store"
      onClick={() => setMenuOpen(false)}
      className={
        'inline-block rounded-md px-3 py-2 text-xs font-bold transition-colors ' +
        (openState.acceptingOrders
          ? 'bg-[#e8f3ea] text-[#2f6b38] hover:opacity-80'
          : 'bg-[#f6efe9] text-tan-dark hover:opacity-80')
      }
    >
      {openState.acceptingOrders
        ? 'Store: Accepting'
        : openState.reason === 'paused'
          ? 'Store: Paused'
          : 'Store: Closed'}
    </Link>
  ) : null;

  return (
    <header className="sticky top-0 z-40 bg-charcoal text-cream">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-2">
            <Image
              src="/images/logo-light.png"
              alt="HIOC."
              width={480}
              height={291}
              className="h-7 w-auto object-contain"
            />
            <span className="text-sm font-normal text-cream/60">Staff</span>
          </span>
          {/* Tablet/desktop tab row — unchanged from before; just hidden below
              md, where it moves into the drawer instead. */}
          <nav className="hidden md:block">
            <ul className="flex items-center gap-4 text-sm">
              {TABS.map((tab) => {
                const isActive = pathname === toHref(tab.href);
                return (
                  <li key={tab.href}>
                    <Link
                      href={tab.href}
                      className={
                        'border-b-2 pb-1 transition-colors ' +
                        (isActive
                          ? 'border-tan text-tan'
                          : 'border-transparent text-cream/70 hover:text-cream')
                      }
                    >
                      {tab.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>

        {/* Tablet/desktop account controls — unchanged, hidden below md. */}
        <div className="hidden items-center gap-3 md:flex">
          {storeBadge}
          <div className="text-right leading-tight" title={userEmail}>
            <div className="max-w-[36vw] truncate text-xs font-medium text-cream sm:max-w-none">
              {userName || userEmail || 'Signed in'}
            </div>
            {roleLabel ? (
              <div className="text-[10px] uppercase tracking-wide text-cream/50">{roleLabel}</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-md border border-cream/40 px-4 py-2 text-sm text-cream transition-colors hover:bg-cream hover:text-charcoal"
          >
            Logout
          </button>
        </div>

        {/* Phone hamburger — the tab row + account controls above don't fit a
            360–414px header, so they collapse into the drawer below instead of
            wrapping or overflowing. min 40px square tap target. */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-controls="staff-mobile-menu"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-cream/30 text-cream md:hidden"
        >
          <span aria-hidden className="text-xl leading-none">
            {menuOpen ? '×' : '☰'}
          </span>
        </button>
      </div>

      {/* Phone drawer: tab list + store badge + account + logout, all stacked
          so every tap target stays full-width and ≥40px tall. */}
      {menuOpen ? (
        <div id="staff-mobile-menu" className="border-t border-cream/10 px-4 pb-4 md:hidden">
          <nav>
            <ul className="flex flex-col gap-1 pt-3 text-sm">
              {TABS.map((tab) => {
                const isActive = pathname === toHref(tab.href);
                return (
                  <li key={tab.href}>
                    <Link
                      href={tab.href}
                      className={
                        'block rounded-md px-3 py-2.5 font-bold transition-colors ' +
                        (isActive
                          ? 'bg-cream/10 text-tan'
                          : 'text-cream/80 hover:bg-cream/5 hover:text-cream')
                      }
                    >
                      {tab.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="mt-3 flex flex-col gap-3 border-t border-cream/10 pt-3">
            {storeBadge}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 leading-tight" title={userEmail}>
                <div className="truncate text-xs font-medium text-cream">
                  {userName || userEmail || 'Signed in'}
                </div>
                {roleLabel ? (
                  <div className="text-[10px] uppercase tracking-wide text-cream/50">{roleLabel}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="shrink-0 rounded-md border border-cream/40 px-4 py-2 text-sm text-cream transition-colors hover:bg-cream hover:text-charcoal"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
