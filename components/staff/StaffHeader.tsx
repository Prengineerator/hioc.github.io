'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { StoreOpenState } from '@/lib/store/hours';

const TABS = [
  { href: '/staff', label: 'Orders' },
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
  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  const [openState, setOpenState] = useState<StoreOpenState | null>(null);

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
    router.push('/staff/login');
  }

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
          <nav>
            <ul className="flex items-center gap-4 text-sm">
              {TABS.map((tab) => {
                const isActive = pathname === tab.href;
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
        <div className="flex items-center gap-3">
          {openState ? (
            <Link
              href="/staff/menu#store"
              className={
                'rounded-md px-3 py-2 text-xs font-bold transition-colors ' +
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
          ) : null}
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
      </div>
    </header>
  );
}
