import Link from 'next/link';
import { flags } from '@/lib/flags';
import { PayrollScreen } from '@/components/owner/PayrollScreen';

export const dynamic = 'force-dynamic';

// PAY-3 — owner-only, both by the /owner/** gate and by getOwnerUser() in the
// API. Deliberately not in the permission matrix: salary is not a
// manager-delegable surface in this phase (D5-8).
export default function OwnerPayrollPage() {
  if (!flags.attendance) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Payroll is not enabled yet</h1>
        <p className="mt-3 text-muted">
          Payroll computes from attendance, so attendance has to be running first.
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

  return <PayrollScreen />;
}
