'use client';

// Pending / Approved / Undone pill for an expense row, plus the one call the
// owner Cash screen makes to approve expenses (POST /api/cash-expenses/approve).

import type { ApproveExpensesBody, ApproveExpensesResponse, ExpenseStatus } from '@/lib/cash/expenses';

const PILL: Record<ExpenseStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-amber-100 text-amber-900' },
  approved: { label: 'Approved', className: 'bg-green-100 text-green-800' },
  undone: { label: 'Undone', className: 'bg-surface text-muted' },
};

export function ExpenseStatusPill({ status }: { status: ExpenseStatus }) {
  const p = PILL[status];
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${p.className}`}>{p.label}</span>
  );
}

/** Approves the given expenses; throws an Error with a message fit to show on failure. */
export async function approveExpenses(ids: string[]): Promise<ApproveExpensesResponse> {
  const body: ApproveExpensesBody = { ids };
  const res = await fetch('/api/cash-expenses/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Could not approve.');
  return data as ApproveExpensesResponse;
}
