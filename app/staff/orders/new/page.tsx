import Link from 'next/link';
import { flags } from '@/lib/flags';
import { PosOrderEntry } from '@/components/staff/PosOrderEntry';

// Staff POS-lite order entry (POS-1). The /staff/** layout already gates this
// route behind getStaffOrOwner(), so no extra auth check is needed here — a
// signed-in staff/manager/owner is guaranteed. This page is dark-launched
// behind the staffPos flag (default ON): when off it renders a clear
// "not enabled" state rather than the entry screen.
export default function NewOrderPage({
  searchParams,
}: {
  searchParams: { table?: string | string[] };
}) {
  if (!flags.staffPos) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Order entry is not enabled</h1>
        <p className="mt-3 text-muted">
          The counter order-entry screen is turned off for this environment.
        </p>
        <Link
          href="/staff"
          className="mt-6 inline-flex rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Back to Orders
        </Link>
      </div>
    );
  }

  // POS-3 deep-link: /staff/orders/new?table=<id> pre-selects that dine-in table
  // (PosOrderEntry validates it against the active tables and ignores an unknown
  // id). Only a single string value is meaningful.
  const initialTableId =
    typeof searchParams.table === 'string' ? searchParams.table : null;

  return <PosOrderEntry initialTableId={initialTableId} />;
}
