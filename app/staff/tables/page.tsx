import Link from 'next/link';
import { flags } from '@/lib/flags';
import { TablesBoard } from '@/components/staff/TablesBoard';

// Staff tables board (POS-3). The /staff/** layout already gates this route
// behind getStaffOrOwner(), so no extra auth check is needed here — a signed-in
// staff/manager/owner is guaranteed. Dark-launched behind the same staffPos flag
// as POS-1 (default ON): when off it renders a clear "not enabled" state rather
// than the board, matching the New-order page.
export default function TablesPage() {
  if (!flags.staffPos) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Tables board is not enabled</h1>
        <p className="mt-3 text-muted">
          The tables view is turned off for this environment.
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

  return <TablesBoard />;
}
