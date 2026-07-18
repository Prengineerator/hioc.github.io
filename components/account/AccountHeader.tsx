'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';

const LINKS = [
  { href: '/account', label: 'Overview' },
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/favorites', label: 'Favorites' },
  { href: '/account/profile', label: 'Profile' },
];

export function AccountHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/');
      router.refresh();
    }
  }

  return (
    <header className="border-b border-[#e5e5e5] bg-cream">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <Link href="/" className="font-bold text-charcoal">
          HIOC · My Account
        </Link>
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          className="text-sm font-bold text-muted hover:text-tan disabled:opacity-60"
        >
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
      </div>
      <nav className="mx-auto flex max-w-3xl gap-1 px-4 pb-3">
        {LINKS.map((l) => {
          const active = l.href === '/account' ? pathname === '/account' : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={
                'rounded-md px-3 py-1.5 text-sm font-bold transition-colors ' +
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
