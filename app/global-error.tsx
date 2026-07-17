'use client';

// Global error boundary (F5t) — catches errors thrown in the root layout that
// the per-segment error.tsx can't. Must render its own <html>/<body>.

import { useEffect } from 'react';
import { captureError } from '@/lib/monitoring';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureError(error, { where: 'global-error-boundary', digest: error.digest });
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-monospace, monospace', textAlign: 'center', padding: '5rem 1rem' }}>
        <h1 style={{ fontWeight: 700 }}>Something went wrong</h1>
        <p style={{ color: '#828282' }}>Please refresh the page.</p>
        <button
          onClick={reset}
          style={{ marginTop: '1.5rem', padding: '0.75rem 1.5rem', background: '#ad825e', color: '#fff', border: 0, borderRadius: 6, fontWeight: 700 }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
