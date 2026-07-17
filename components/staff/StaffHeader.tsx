'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const TABS = [
  { href: '/staff', label: 'Orders' },
  { href: '/staff/menu', label: 'Menu' },
];

export function StaffHeader() {
  const pathname = usePathname();
  const router = useRouter();

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
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-md border border-cream/40 px-4 py-2 text-sm text-cream transition-colors hover:bg-cream hover:text-charcoal"
        >
          Logout
        </button>
      </div>
    </header>
  );
}
