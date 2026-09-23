import Link from 'next/link';
import { flags } from '@/lib/flags';
import { CashScreen } from '@/components/owner/cash/CashScreen';

export const dynamic = 'force-dynamic';

// CC-4 — the owner's cash-shortage review + count log
// (docs/PHASE-5-CASH-COUNTS.md). Gated on the attendance flag: cash counts
// ride the same clock-in/out punch attendance does, so there's nothing here
// while that's off. /owner/** is already gated to role 'owner' by middleware
// and the layout; every API this page calls re-checks getOwnerUser() itself.
export default function OwnerCashPage() {
  if (!flags.attendance) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Cash counts aren&apos;t enabled yet</h1>
        <p className="mt-3 text-muted">
          Cash counts ride the clock-in/out punch — turn on the attendance flag first.
        </p>
        <Link
          href="/owner/settings"
          className="mt-6 inline-flex rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Go to Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <CashScreen />
    </div>
  );
}
