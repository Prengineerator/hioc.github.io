import Link from 'next/link';
import { flags } from '@/lib/flags';
import { getCounterActor } from '@/lib/api/auth';
import { CashMovementForm } from '@/components/staff/CashMovementForm';

export const dynamic = 'force-dynamic';

// CC-3 — manager/owner cash in / out (bank deposits, float top-ups). The role
// is resolved server-side (same pattern as app/staff/leave/page.tsx) and a
// plain staffer gets a clear message instead of the form; the API re-checks
// regardless. getCounterActor() already caps a device-unlocked owner at
// 'manager' (lib/api/operator.ts), so this role-string comparison stays
// correct for that path. The menu only links here for managers/owners
// (lib/staff/staffNav.ts); this guards a typed or bookmarked URL.
export default async function CashMovementsPage() {
  const account = flags.staffPos ? await getCounterActor() : null;
  const canManageCash = account ? account.role === 'manager' || account.role === 'owner' : false;

  if (!flags.staffPos || !canManageCash) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">
          {flags.staffPos ? 'Only a manager or the owner can record cash in or out' : 'Cash management is not enabled'}
        </h1>
        <p className="mt-3 text-muted">
          {flags.staffPos
            ? 'Paid for something from the drawer? Record it under Expenses.'
            : 'The cash drawer screens are turned off for this environment.'}
        </p>
        <Link
          href={flags.staffPos ? '/staff/expenses' : '/staff'}
          className="mt-6 inline-flex rounded-md bg-tan-dark px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-darker"
        >
          {flags.staffPos ? 'Go to Expenses' : 'Back to Orders'}
        </Link>
      </div>
    );
  }

  return <CashMovementForm />;
}
