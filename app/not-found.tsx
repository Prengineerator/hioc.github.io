import Link from 'next/link';
import { buttonVariants } from '@/components/ui/Button';
import { CAFE_PHONE_DISPLAY, CAFE_PHONE_HREF } from '@/lib/constants';

// Branded 404. Rendered inside the root layout, so the header and footer stay.
export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-20 text-center">
      <h1 className="text-2xl font-bold text-charcoal">Page not found</h1>
      <p className="mt-3 text-muted">
        That page doesn&apos;t exist, or it has moved. The menu is the best place to start.
      </p>
      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link href="/menu" className={buttonVariants({ size: 'lg' })}>
          Menu
        </Link>
        <Link href="/" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
          Home
        </Link>
      </div>
      <p className="mt-6 text-sm text-muted">
        Need a hand? Call{' '}
        <a
          href={CAFE_PHONE_HREF}
          className="inline-flex min-h-[44px] items-center font-semibold text-tan-dark hover:underline"
        >
          {CAFE_PHONE_DISPLAY}
        </a>
        .
      </p>
    </div>
  );
}
