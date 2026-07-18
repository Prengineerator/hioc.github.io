'use client';

// Route-segment error boundary (F5t). Catches render/runtime errors in any
// page under app/, reports them via the monitoring layer, and shows a friendly
// recoverable state instead of a blank crash.

import { useEffect } from 'react';
import { captureError } from '@/lib/monitoring';

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
        We hit an unexpected error. Please try again — if it keeps happening, refresh the page.
      </p>
      <button
        onClick={reset}
        className="mt-6 rounded-md bg-tan px-6 py-3 font-bold text-cream transition-colors hover:bg-tan-dark"
      >
        Try again
      </button>
    </div>
  );
}
