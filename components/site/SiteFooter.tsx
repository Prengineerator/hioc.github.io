'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CAFE_ADDRESS,
  CAFE_HOURS,
  CAFE_INSTAGRAM_HANDLE,
  CAFE_INSTAGRAM_URL,
  CAFE_PHONE_DISPLAY,
  CAFE_PHONE_HREF,
} from '@/lib/constants';
import { BUSINESS } from '@/lib/legal';

const QUICK_LINKS = [
  { href: '/menu', label: 'Menu' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
];

// Policy pages required by our payment gateway — surfaced on every public page.
const POLICY_LINKS = [
  { href: '/terms', label: 'Terms & Conditions' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/refund-cancellation', label: 'Refund & Cancellation' },
  { href: '/shipping-delivery', label: 'Shipping & Delivery' },
];

/**
 * The public site's footer. Hidden on /staff/** and /owner/** — see
 * SiteHeader for the same rationale. Purely static (constants only, no
 * fetches) so it stays cheap on every page.
 */
export function SiteFooter() {
  const pathname = usePathname();
  if (pathname.startsWith('/staff') || pathname.startsWith('/owner')) {
    return null;
  }

  return (
    <footer className="border-t border-line bg-charcoal text-cream">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-4 py-10 text-sm sm:grid-cols-3">
        <div className="flex flex-col items-center gap-3 text-center sm:items-start sm:text-left">
          <Image
            src="/images/logo-light.png"
            alt="HIOC."
            width={40}
            height={40}
            className="h-10 w-10 object-contain"
          />
          <p>
            HIOC<span className="text-tan">.</span>{' '}
            <span className="text-cream/70">— High on Coffee</span>
          </p>
          <a
            href={CAFE_INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center text-cream/70 transition-colors hover:text-tan"
          >
            {CAFE_INSTAGRAM_HANDLE}
          </a>
        </div>

        <div className="flex flex-col items-center gap-2 text-center sm:items-start sm:text-left">
          <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-tan">Explore</h3>
          {QUICK_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex min-h-[44px] items-center text-cream/70 transition-colors hover:text-tan"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex flex-col items-center gap-1 text-center sm:items-start sm:text-left">
          <h3 className="mb-1 text-xs font-bold uppercase tracking-[0.2em] text-tan">Visit Us</h3>
          <p className="text-cream/70">{CAFE_ADDRESS}</p>
          <p className="text-cream/70">{CAFE_HOURS}</p>
          <a
            href={CAFE_PHONE_HREF}
            className="inline-flex min-h-[44px] items-center text-cream/70 transition-colors hover:text-tan"
          >
            {CAFE_PHONE_DISPLAY}
          </a>
        </div>
      </div>
      <div className="border-t border-cream/10 px-4 py-5 text-center text-xs text-cream/50">
        <div className="mb-3 flex flex-wrap justify-center gap-x-4 gap-y-1">
          {POLICY_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-cream/60 transition-colors hover:text-tan"
            >
              {link.label}
            </Link>
          ))}
        </div>
        <p>
          &copy; {new Date().getFullYear()} {BUSINESS.name}. Operated by {BUSINESS.legalName}
          {BUSINESS.gstin ? ` · GSTIN ${BUSINESS.gstin}` : ''}.
        </p>
      </div>
    </footer>
  );
}
