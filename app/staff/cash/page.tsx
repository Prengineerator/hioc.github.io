import Link from 'next/link';
import { flags } from '@/lib/flags';
import { getCounterActor } from '@/lib/api/auth';
import { CashDayManager } from '@/components/staff/CashDayManager';
import { CashMovementForm } from '@/components/staff/CashMovementForm';

export const dynamic = 'force-dynamic';

// Staff cash management (OPS-2). The /staff/** layout already gates this route
// behind getCounterActor() (PIN-3: classic session, or an enrolled device's
// PIN operator), so a resolved actor is guaranteed here — the per-action
// permission gates (cash_day_open / cash_day_close) are enforced server-side
// by the API. Dark-launched behind the same staffPos flag as POS-1 (default
// ON): when off it renders a clear "not enabled" state, matching the
// New-order and Tables pages.
//
// CC-3 — role resolved server-side (same pattern as app/staff/leave/page.tsx)
// to decide whether CashMovementForm (cash-out/cash-in, manager/owner only)
// mounts at all; the API re-checks regardless. getCounterActor() already caps
// a device-unlocked owner at 'manager' (lib/api/operator.ts), so this
// role-string comparison stays correct for that path without change.
export default async function CashPage() {
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

  const account = await getCounterActor();
  const canManageCash = account ? account.role === 'manager' || account.role === 'owner' : false;

  return (
    <>
      <CashDayManager />
      {canManageCash ? <CashMovementForm /> : null}
    </>
  );
}
