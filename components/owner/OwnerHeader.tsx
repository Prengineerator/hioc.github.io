'use client';

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
  { href: '/owner/notifications', label: 'Notifications' },
  { href: '/owner/staff', label: 'Team' },
  // SHEET-1. Sits next to Team on purpose — attendance is a fact about the
  // people managed there, and the two get used in the same sitting.
  ...(flags.attendance
    ? [
        { href: '/owner/attendance', label: 'Attendance' },
        { href: '/owner/payroll', label: 'Payroll' },
      ]
    : []),
  { href: '/owner/settings', label: 'Settings' },
  { href: '/staff', label: 'Staff board' },
];

export function OwnerHeader() {
  const pathname = usePathname();
  // See StaffHeader: compare the RESOLVED href, not the canonical one.
  const toHref = useSurfaceHref();
  return (
    <header className="border-b border-[#e5e5e5] bg-cream">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <span className="font-bold text-charcoal">HIOC · Owner</span>
        <nav className="flex gap-1">
          {LINKS.map((l) => {
            const resolved = toHref(l.href);
            const active = resolved === '/' ? pathname === '/' : pathname.startsWith(resolved);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={
                  'rounded-md px-3 py-1.5 text-sm font-bold ' +
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
