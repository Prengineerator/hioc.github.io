import Link from 'next/link';
import { ORDERING_OFF_MESSAGE } from '@/lib/staff/surfaceRules';

/** Shown on New order / Tables on the staff website while it may not take
 * orders (store_settings.staff_web_ordering off — the default). */
export function OrderingOffNotice() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-charcoal">Orders are taken on the POS</h1>
      <p className="mt-3 text-muted">{ORDERING_OFF_MESSAGE}</p>
      <Link
        href="/staff/orders"
        className="mt-6 inline-flex rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
      >
        See today&apos;s orders
      </Link>
    </div>
  );
}
