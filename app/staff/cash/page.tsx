import Link from 'next/link';
import { flags } from '@/lib/flags';
import { CashDayManager } from '@/components/staff/CashDayManager';

// Staff cash management (OPS-2). The /staff/** layout already gates this route
// behind getStaffOrOwner(), so a signed-in staff/manager/owner is guaranteed —
// the per-action permission gates (cash_day_open / cash_day_close) are enforced
// server-side by the API. Dark-launched behind the same staffPos flag as POS-1
// (default ON): when off it renders a clear "not enabled" state, matching the
// New-order and Tables pages.
export default function CashPage() {
  if (!flags.staffPos) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Cash management is not enabled</h1>
        <p className="mt-3 text-muted">
          The cash drawer screen is turned off for this environment.
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

  return <CashDayManager />;
}
