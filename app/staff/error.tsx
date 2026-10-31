'use client';

// A staff screen that throws while rendering. The nearest boundary used to be
// app/error.tsx, ABOVE the staff layout: one failing screen replaced the whole
// back office — header included — with a generic "Something went wrong", so
// the counter had no way to another screen but a reload. This boundary sits
// inside the staff layout: the header stays, and the screen offers both ways
// out — try the screen again (the app, and any order draft, stay as they are)
// or reload the app. Reported through the same monitoring layer (F5t).

import { startTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { captureError } from '@/lib/monitoring';

export default function StaffError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    captureError(error, { where: 'staff-error-boundary', digest: error.digest });
  }, [error]);

  // A server-side failure needs the server asked again, not just a re-render.
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center" role="alert">
      <h1 className="text-2xl font-bold text-charcoal">This screen hit a problem</h1>
      <p className="mt-3 text-muted">
        Nothing was lost — an order being punched is kept on this machine. Try the screen again, or reload the app if
        it keeps happening.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={retry}
          className="min-h-[44px] rounded-md bg-tan-dark px-5 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-darker"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="min-h-[44px] rounded-md border border-line px-5 py-2 text-sm font-bold text-charcoal transition-colors hover:border-tan"
        >
          Reload app
        </button>
      </div>
      {error.digest ? <p className="mt-4 text-xs text-muted">Ref: {error.digest}</p> : null}
    </div>
  );
}
