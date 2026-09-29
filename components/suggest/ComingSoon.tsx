// Rendered instead of the wizard whenever flags.suggest is off (SUG-7 AC).
// No API calls happen anywhere on this page in that case — this component
// makes none itself.

import Link from 'next/link';
import { CoffeyMascot } from '@/components/coffey/CoffeyMascot';
import { buttonVariants } from '@/components/ui/Button';

export function SuggestComingSoon() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
      {/* Decorative: the heading below names Coffey. */}
      <CoffeyMascot size={112} expression="thinking" />
      <h1 className="text-2xl font-bold text-charcoal">Coffey is still brewing</h1>
      <p className="text-muted">
        I&apos;m almost ready to help you pick. In the meantime, the full menu is right this way.
      </p>
      <Link href="/menu" className={buttonVariants({ size: 'lg' })}>
        Browse the menu
      </Link>
    </div>
  );
}
