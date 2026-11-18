'use client';

// Route-segment error boundary (F5t). Catches render/runtime errors in any
// page under app/, reports them via the monitoring layer, and shows a friendly
// recoverable state instead of a blank crash.

import { useEffect } from 'react';
import Link from 'next/link';
import { captureError } from '@/lib/monitoring';
import { buttonVariants } from '@/components/ui/Button';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureError(error, { where: 'client-error-boundary', digest: error.digest });
  }, [error]);

  return (
    <div className="mx-auto max-w-xl px-4 py-20 text-center">
      <h1 className="text-2xl font-bold text-charcoal">Something went wrong</h1>
      <p className="mt-3 text-muted">
        We hit an unexpected error. Please try again. If it keeps happening, refresh the page.
      </p>
      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <button type="button" onClick={reset} className={buttonVariants({ size: 'lg' })}>
          Try again
        </button>
        <Link href="/menu" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
          Menu
        </Link>
        <Link href="/" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
          Home
        </Link>
      </div>
    </div>
  );
}
