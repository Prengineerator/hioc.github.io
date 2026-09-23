'use client';

import { useEffect, useRef } from 'react';
import { SurfaceLink as Link, useSurfaceHref } from '@/components/SurfaceLink';
import { usePathname } from 'next/navigation';
import { flags } from '@/lib/flags';

const LINKS = [
  { href: '/owner', label: 'Overview' },
  { href: '/owner/customers', label: 'Customers' },
  { href: '/owner/payments', label: 'Payments' },
  { href: '/owner/promotions', label: 'Promotions' },
  { href: '/owner/reviews', label: 'Reviews' },
  { href: '/owner/tables', label: 'Tables' },
  // DEV-2. Next to Tables because both are the physical cafe described to the
  // software — the furniture and the machines.
  { href: '/owner/devices', label: 'Devices' },
  { href: '/owner/notifications', label: 'Notifications' },
  { href: '/owner/staff', label: 'Team' },
  // SHEET-1. Sits next to Team on purpose — attendance is a fact about the
  // people managed there, and the two get used in the same sitting.
  ...(flags.attendance
    ? [
        { href: '/owner/attendance', label: 'Attendance' },
        { href: '/owner/payroll', label: 'Payroll' },
        // CC-4 — shortages the clock-in/out drawer count revealed, and the
        // count log behind them (docs/PHASE-5-CASH-COUNTS.md). Grouped with
        // Attendance/Payroll: the count rides the same punch and a decided
        // shortage lands on the same payroll run.
        { href: '/owner/cash', label: 'Cash' },
      ]
    : []),
  { href: '/owner/settings', label: 'Settings' },
  { href: '/staff', label: 'Staff board' },
];

export function OwnerHeader() {
  const pathname = usePathname();
  // See StaffHeader: compare the RESOLVED href, not the canonical one.
  const toHref = useSurfaceHref();
  const navRef = useRef<HTMLElement>(null);

  // Mobile nav is a horizontally scrolling pill row (see className below) — on
  // first paint (and on every navigation) the active pill may be off-screen,
  // so bring it into view. data-active (not a ref) because SurfaceLink is a
  // plain function component and can't take a forwarded ref.
  useEffect(() => {
    const active = navRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);

  return (
    <header className="border-b border-[#e5e5e5] bg-cream">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <span className="font-bold text-charcoal">HIOC · Owner</span>
        <nav
          ref={navRef}
          aria-label="Owner navigation"
          className="-mx-4 flex w-full gap-1 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden"
        >
          {LINKS.map((l) => {
            const resolved = toHref(l.href);
            const active = resolved === '/' ? pathname === '/' : pathname.startsWith(resolved);
            return (
              <Link
                key={l.href}
                href={l.href}
                data-active={active ? 'true' : undefined}
                className={
                  'shrink-0 whitespace-nowrap rounded-md px-3 py-2.5 text-sm font-bold sm:py-1.5 ' +
                  (active ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-[#f2efe9]')
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
