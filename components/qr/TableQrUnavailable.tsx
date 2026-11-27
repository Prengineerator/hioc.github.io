import Link from 'next/link';

// Shown for any /t/<token> that can't start an order: the QR feature is
// dark (flag off), or the scanned token is unknown / inactive / regenerated
// (QR-1 "friendly screen, never a broken cart"). Deliberately does NOT
// distinguish these cases and never says why: we never confirm whether a given
// token is real. The copy only says table ordering isn't available and where
// to order instead.
export function TableQrUnavailable() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 py-16 text-center">
      <h1 className="text-xl font-bold text-charcoal md:text-2xl">
        Table ordering isn&apos;t available yet
      </h1>
      <p className="mt-3 text-base text-muted">
        Please order at the counter, or on our website menu and collect it when it&apos;s ready.
      </p>
      <Link
        href="/menu"
        className="mt-6 inline-flex min-h-[44px] items-center rounded-md border border-line px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:border-tan hover:text-tan-dark"
      >
        Browse the menu
      </Link>
    </div>
  );
}
