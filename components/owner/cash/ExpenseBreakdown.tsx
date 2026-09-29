'use client';

// Where petty cash went: the recent cash-outs that carry an expense category
// (punched at the counter — lib/cash/expenses.ts), grouped by category. Built
// from the same movements the count log shows, so it covers that window only.
// Undone expenses are excluded; pending ones count but are flagged, with a
// one-tap "Approve all pending".

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { totalsByCategory } from '@/lib/cash/expenses';
import { approveExpenses } from './ExpenseStatusPill';
import type { OwnerCashMovementRow } from './types';
import { rupees } from './types';

export function ExpenseBreakdown({
  movements,
  onChanged,
}: {
  movements: OwnerCashMovementRow[];
  /** Called after "Approve all pending" so the screen reloads. */
  onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const expenses = movements.filter((m) => m.direction === 'out' && m.category && m.status !== 'undone');
  const byCategory = totalsByCategory(expenses.map((m) => ({ category: m.category, amountInr: m.amountInr })));
  const total = byCategory.reduce((s, c) => s + c.amountInr, 0);
  const pendingRows = expenses.filter((m) => m.status === 'pending');
  const pendingInr = pendingRows.reduce((s, m) => s + m.amountInr, 0);
  const approvableIds = pendingRows.filter((m) => m.canApprove).map((m) => m.id);

  async function approveAll() {
    if (busy || approvableIds.length === 0) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await approveExpenses(approvableIds);
      setNotice(`Approved ${res.approved.length}${res.skipped.length ? `; skipped ${res.skipped.length}` : ''}.`);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve.');
    } finally {
      setBusy(false);
    }
  }

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
      {pendingRows.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-bold text-amber-900">
            {rupees(pendingInr)} awaiting approval ({pendingRows.length})
          </p>
          {approvableIds.length > 0 ? (
            <button
              type="button"
              onClick={() => void approveAll()}
              disabled={busy}
              className="min-h-[44px] rounded-md bg-tan-dark px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-darker disabled:opacity-50"
            >
              {busy ? 'Approving…' : 'Approve all pending'}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm font-bold text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? <p className="mt-2 text-sm text-green-700">{notice}</p> : null}
    </Card>
  );
}
