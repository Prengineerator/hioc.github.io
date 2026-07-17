'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/owner', label: 'Overview' },
  { href: '/owner/settings', label: 'Settings' },
  { href: '/staff', label: 'Staff board' },
];

export function OwnerHeader() {
  const pathname = usePathname();
  return (
    <header className="border-b border-[#e5e5e5] bg-cream">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <span className="font-bold text-charcoal">HIOC · Owner</span>
        <nav className="flex gap-1">
          {LINKS.map((l) => {
            const active = l.href === '/owner' ? pathname === '/owner' : pathname.startsWith(l.href);
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
