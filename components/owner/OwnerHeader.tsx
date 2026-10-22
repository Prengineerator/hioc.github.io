'use client';

import { useEffect, useRef, useState } from 'react';
import { SurfaceLink as Link, useSurfaceHref } from '@/components/SurfaceLink';
import { usePathname } from 'next/navigation';
import { flags } from '@/lib/flags';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { MENU_PENDING_COUNT_EVENT } from '@/components/owner/menu/menuEvents';

const MENU_HREF = '/owner/menu';

const LINKS = [
  { href: '/owner', label: 'Overview' },
  { href: '/owner/customers', label: 'Customers' },
  // The owner's own menu editor, plus the menu changes staff ask for on the POS
  // (approve / reject). Before Suggestions because that tab tags this menu.
  { href: MENU_HREF, label: 'Menu' },
  // Phase-7 SUG-10. Always shown (not flag-gated): the owner needs the Traits
  // tab to tag the menu before NEXT_PUBLIC_FLAG_SUGGEST can go on (Gate 7A).
  { href: '/owner/suggestions', label: 'Suggestions' },
  { href: '/owner/payments', label: 'Payments' },
  // Zomato/Swiggy payouts read from the settlement reports they email
  // (docs/ONLINE-SETTLEMENTS.md). Next to Payments: it is the delivery apps'
  // side of the same money.
  { href: '/owner/online', label: 'Online orders' },
  // Reconcile any date range: sales, money in by method, refunds, drawer.
  { href: '/owner/reports', label: 'Reports' },
  { href: '/owner/promotions', label: 'Promotions' },
  // CP-9. HIOC Ritual (prepaid coffee plans): its plans, numbers and eligible
  // drinks. Hidden while the flag is off, like the page itself (which 404s).
  // Beside Promotions because both are offers the owner sets up for regulars.
  ...(flags.coffeePass ? [{ href: '/owner/passes', label: PASS_PROGRAM_NAME }] : []),
  // Marketing agent (docs/MARKETING-AGENT-SPEC.md). Right after Promotions because
  // the two are used in the same sitting — coupons you make by hand vs. campaigns
  // the agent prepares for you. Flag-gated like Attendance below: with it off the
  // link would lead to a "Marketing isn't enabled" page, which is noise in the nav.
  ...(flags.marketing ? [{ href: '/owner/marketing', label: 'Marketing' }] : []),
  { href: '/owner/reviews', label: 'Reviews' },
  { href: '/owner/feedback', label: 'Feedback' },
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
  // Staff menu changes waiting for the owner, shown as a badge on the Menu tab.
  const [pendingMenu, setPendingMenu] = useState(0);

  // Mobile nav is a horizontally scrolling pill row (see className below) — on
  // first paint (and on every navigation) the active pill may be off-screen,
  // so bring it into view. data-active (not a ref) because SurfaceLink is a
  // plain function component and can't take a forwarded ref.
  useEffect(() => {
    const active = navRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);

  // One fetch on load (and when the tab regains focus); the Menu screen pushes
  // fresh counts through MENU_PENDING_COUNT_EVENT after each decision, so no
  // polling. A failed fetch just leaves the badge off.
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetch('/api/owner/menu-requests?status=pending', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { pendingCount?: number } | null) => {
          if (alive && data && typeof data.pendingCount === 'number') setPendingMenu(data.pendingCount);
        })
        .catch(() => undefined);
    };
    const onCount = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n === 'number') setPendingMenu(n);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') load();
    };
    load();
    window.addEventListener(MENU_PENDING_COUNT_EVENT, onCount);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.removeEventListener(MENU_PENDING_COUNT_EVENT, onCount);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return (
    // Sticky so the section nav stays one tap away on the long overview.
    <header className="sticky top-0 z-30 border-b border-line bg-cream/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <span className="font-bold text-charcoal">HIOC · Owner</span>
        <nav
          ref={navRef}
          aria-label="Owner navigation"
          className="-mx-4 flex w-full gap-1 overflow-x-auto px-4 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden"
        >
          {LINKS.map((l) => {
            const resolved = toHref(l.href);
            // The surface root (Overview: '/owner', or '/' on owner.hioc.in) is
            // a prefix of every owner page, so it must match exactly — a
            // plain startsWith lit up "Overview" alongside whatever page was
            // actually open. Other tabs match their own subtree.
            const isRoot = l.href === '/owner';
            const active = isRoot
              ? pathname === resolved || pathname === `${resolved}/`
              : pathname === resolved || pathname.startsWith(`${resolved}/`);
            return (
              <Link
                key={l.href}
                href={l.href}
                data-active={active ? 'true' : undefined}
                aria-current={active ? 'page' : undefined}
                className={
                  'flex min-h-[44px] shrink-0 items-center whitespace-nowrap rounded-md px-3 text-sm font-bold sm:min-h-[36px] ' +
                  (active ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-[#f2efe9]')
                }
              >
                {l.label}
                {l.href === MENU_HREF && pendingMenu > 0 ? (
                  <span
                    className={
                      'ml-2 rounded-full px-1.5 py-0.5 text-[11px] font-bold ' +
                      (active ? 'bg-cream text-charcoal' : 'bg-tan-dark text-cream')
                    }
                  >
                    {pendingMenu}
                    <span className="sr-only"> menu changes waiting</span>
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
