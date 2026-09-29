import Link from 'next/link';
import { flags } from '@/lib/flags';
import { CashScreen } from '@/components/owner/cash/CashScreen';
import { CashDayLog } from '@/components/owner/cash/CashDayLog';

export const dynamic = 'force-dynamic';

// CC-4 — the owner's cash-shortage review + count log
// (docs/PHASE-5-CASH-COUNTS.md), headed by the cash day log (open → close →
// handover). Shortages and counts are gated on the attendance flag: cash counts
// ride the same clock-in/out punch attendance does. /owner/** is already gated to role 'owner' by middleware
// and the layout; every API this page calls re-checks getOwnerUser() itself.
export default function OwnerCashPage() {
  // The cash day log doesn't depend on attendance (the cash day is opened and
  // closed from the staff cash screen), so it stays visible; only the
  // shortage review + count log need the clock-in/out punch.
  if (!flags.attendance) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-bold text-charcoal">Cash</h1>
            <p className="text-sm text-muted">
              Shortage review and the count log need the attendance flag (cash counts ride the clock-in/out punch).{' '}
              <Link href="/owner/settings" className="font-bold text-tan-dark underline">
                Go to Settings
              </Link>
            </p>
          </div>
          <CashDayLog />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <CashScreen />
    </div>
  );
}
