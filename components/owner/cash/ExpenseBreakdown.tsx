'use client';

// Where petty cash went: the recent cash-outs that carry an expense category
// (punched at the counter — lib/cash/expenses.ts), grouped by category. Built
// from the same movements the count log shows, so it covers that window only.

import { Card } from '@/components/ui/Card';
import { totalsByCategory } from '@/lib/cash/expenses';
import type { OwnerCashMovementRow } from './types';
import { rupees } from './types';

export function ExpenseBreakdown({ movements }: { movements: OwnerCashMovementRow[] }) {
  const expenses = movements.filter((m) => m.direction === 'out' && m.category);
  const byCategory = totalsByCategory(expenses.map((m) => ({ category: m.category, amountInr: m.amountInr })));
  const total = byCategory.reduce((s, c) => s + c.amountInr, 0);

  return (
    <Card>
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Expenses</h2>
      <p className="mt-1 text-xs text-muted">Paid from the drawer, across the recent entries in the log below.</p>
      {byCategory.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No expenses recorded yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-line">
          {byCategory.map((c) => (
            <li key={c.category} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate font-bold text-charcoal">
                {c.label} <span className="font-normal text-muted">· {c.count}</span>
              </span>
              <span className="text-charcoal">{rupees(c.amountInr)}</span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 py-2 text-sm font-bold text-charcoal">
            <span>Total</span>
            <span>{rupees(total)}</span>
          </li>
        </ul>
      )}
    </Card>
  );
}
