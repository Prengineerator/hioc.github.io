// Rendered instead of the wizard whenever flags.suggest is off (SUG-7 AC).
// No API calls happen anywhere on this page in that case — this component
// makes none itself.

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/Button';

export function SuggestComingSoon() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      <span aria-hidden="true" className="text-4xl">
        ☕
      </span>
      <h1 className="text-2xl font-bold text-charcoal">Help me choose is brewing</h1>
      <p className="text-muted">
        We&apos;re still working on this one. In the meantime, our full menu is right this way.
      </p>
      <Link href="/menu" className={buttonVariants({ size: 'lg' })}>
        Browse the menu
      </Link>
    </div>
  );
}
