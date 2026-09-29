import Link from 'next/link';
import { flags } from '@/lib/flags';
import { CashExpenseForm } from '@/components/staff/CashExpenseForm';

export const dynamic = 'force-dynamic';

// Store expenses paid from the drawer (ice, water, milk …) — any counter
// actor. The /staff/** layout already guarantees one; POST /api/cash-expenses
// re-checks the 'cash_expense' permission. Same staffPos flag as the Cash page.
export default async function ExpensesPage() {
  if (!flags.staffPos) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Cash management is not enabled</h1>
        <p className="mt-3 text-muted">
          The cash drawer screens are turned off for this environment.
        </p>
        <Link
          href="/staff"
          className="mt-6 inline-flex rounded-md bg-tan-dark px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-darker"
        >
          Back to Orders
        </Link>
      </div>
    );
  }

  return <CashExpenseForm />;
}
