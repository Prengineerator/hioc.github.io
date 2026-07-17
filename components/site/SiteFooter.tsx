'use client';

import Image from 'next/image';
import { usePathname } from 'next/navigation';

/**
 * The public site's footer. Hidden on /staff/** — see SiteHeader for the
 * same rationale.
 */
export function SiteFooter() {
  const pathname = usePathname();
  if (pathname.startsWith('/staff')) {
    return null;
  }

  return (
    <footer className="border-t border-[#e5e5e5] bg-charcoal text-cream">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Image
            src="/images/logo-light.png"
            alt="HIOC."
            width={40}
            height={40}
            className="h-10 w-10 object-contain"
          />
          <p className="text-cream">
            HIOC<span className="text-tan">.</span>{' '}
            <span className="text-muted">— High on Coffee</span>
          </p>
        </div>
        <a
          href="https://www.instagram.com/hioc.in/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-cream transition-colors hover:text-tan"
        >
          @hioc.in
        </a>
      </div>
    </footer>
  );
}
