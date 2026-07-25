import Link from 'next/link';

// Shown for any /t/<token> that can't start an order: the QR feature is
// dark (flag off), or the scanned token is unknown / inactive / regenerated
// (QR-1 "friendly ask-staff screen — never a broken cart"). Deliberately does
// NOT distinguish these cases — a diner just needs to know to flag down staff,
// and we never confirm whether a given token is real.
export function TableQrUnavailable() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-[#f6efe9] text-3xl">
        ☕
      </div>
      <h1 className="text-xl font-bold text-charcoal md:text-2xl">
        This QR isn&apos;t ready to take an order
      </h1>
      <p className="mt-3 text-muted">
        The code on your table may have been refreshed. Please ask our staff to
        re-scan or bring you the latest QR — we&apos;ll get your order in right
        away.
      </p>
      <Link
        href="/menu"
        className="mt-6 rounded-md border border-line px-5 py-2.5 text-sm font-bold text-charcoal transition-colors hover:border-tan hover:text-tan"
      >
        Browse the menu
      </Link>
    </div>
  );
}
