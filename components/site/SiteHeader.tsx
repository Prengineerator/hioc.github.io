'use client';

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

/**
 * The public site's header (logo, nav, AccountNav). Hidden on /staff/**,
 * which has its own separate chrome (StaffHeader) — staff pages are a
 * distinct "backstage" surface and must not show the customer nav or
 * account widget. Gated client-side via usePathname() rather than reading
 * headers()/cookies() in the root layout, so `/`, `/about`, `/contact` etc.
 * stay statically rendered. usePathname() resolves correctly during SSR of
 * the initial request too, so there's no header flash on a hard navigation
 * to a staff page.
 */
export function SiteHeader() {
  const pathname = usePathname();
  if (pathname.startsWith('/staff')) {
    return null;
  }

  return (
    <header className="border-b border-[#e5e5e5] bg-cream">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
        <Link href="/" className="flex items-center">
          <Image
            src="/images/logo-black.png"
            alt="HIOC."
            width={480}
            height={291}
            className="h-9 w-auto object-contain"
            priority
          />
        </Link>
        <nav>
          <ul className="flex items-center gap-6 text-sm">
            {NAV_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="text-charcoal transition-colors hover:text-tan"
                >
                  {link.label}
                </Link>
              </li>
            ))}
            <AccountNav />
          </ul>
        </nav>
      </div>
    </header>
  );
}
