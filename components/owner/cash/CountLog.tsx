'use client';

// Log of recent checkpoints + cash movements (counts read-only; the owner can re-tag a cash-out's expense category)
// (docs/PHASE-5-CASH-COUNTS.md). Cards, not a table — the same reasoning as
// ShortageCard: this content doesn't fit a fixed column layout at 360px.

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { EXPENSE_CATEGORIES, expenseCategoryLabel } from '@/lib/cash/expenses';
import type { OwnerCashCountRow, OwnerCashMovementRow } from './types';
import { KIND_LABEL, formatWhen, isHandoverMovement, rupees } from './types';

function varianceText(v: number | null): string {
  if (v === null || v === 0) return '';
  return ` · ${v < 0 ? '−' : '+'}${rupees(Math.abs(v))}`;
}

function varianceClass(v: number | null): string {
  if (v === null || v === 0) return 'text-muted';
  return v < 0 ? 'text-red-700' : 'text-green-700';
}

// An expense reads "Expense · Ice cubes · Asha"; the reason line then only
// shows a note that says more than the label (no note stores the label itself).
function movementTitle(m: OwnerCashMovementRow): string {
  if (m.category) return `Expense · ${m.categoryLabel || m.category} · ${m.recordedByName}`;
  return `${m.direction === 'in' ? 'Cash in' : 'Cash out'} · ${m.recordedByName}`;
}

function movementNote(m: OwnerCashMovementRow): string {
  if (m.category && (m.reason === m.categoryLabel || m.reason === m.category)) return '';
  return m.reason;
}

// Owner re-tag of a past cash-out: expenses entered as a plain "Cash out" before
// the Expenses option existed can be filed under the right category (or a wrong
// tag cleared). Only the category changes — the drawer math never does.
function CategoryControl({ movement, onChanged }: { movement: OwnerCashMovementRow; onChanged?: () => void }) {
  const saved = movement.category ?? '';
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setValue(saved), [saved]);

  async function change(next: string) {
    const previous = value;
    setValue(next);
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/owner/cash-movements/${movement.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: next || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not save the category.');
      onChanged?.();
    } catch (err) {
      setValue(previous);
      setError(err instanceof Error ? err.message : 'Could not save the category.');
    } finally {
      setBusy(false);
    }
  }

  const known = EXPENSE_CATEGORIES.some((c) => c.key === value);
  return (
    <div className="mt-1">
      <label className="sr-only" htmlFor={`cat-${movement.id}`}>
        Expense category
      </label>
      <select
        id={`cat-${movement.id}`}
        value={value}
        disabled={busy}
        onChange={(e) => void change(e.target.value)}
        className="max-w-full rounded border border-line bg-white px-1 py-1 text-xs text-charcoal disabled:opacity-60"
      >
        <option value="">Not an expense</option>
        {value && !known ? <option value={value}>{expenseCategoryLabel(value)}</option> : null}
        {EXPENSE_CATEGORIES.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
          </option>
        ))}
      </select>
      {busy ? <span className="ml-2 text-xs text-muted">Saving…</span> : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs font-bold text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CountLog({
  counts,
  movements,
  onChanged,
}: {
  counts: OwnerCashCountRow[];
  movements: OwnerCashMovementRow[];
  /** Called after a category change is saved, so the screen reloads (the Expenses breakdown follows). */
  onChanged?: () => void;
}) {
  return (
    <Card>
      <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Count log</h2>
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {counts.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate font-bold text-charcoal">
                {KIND_LABEL[c.kind] ?? c.kind} · {c.userName}
              </p>
              <p className="text-xs text-muted">{formatWhen(c.createdAt)}</p>
            </div>
            {c.kind === 'override' ? (
              <p className="text-xs text-amber-900">
                Excused by {c.overrideByName ?? 'a manager'}
                {c.overrideReason ? ` — ${c.overrideReason}` : ''}
              </p>
            ) : (
              <p className={varianceClass(c.varianceInr)}>
                {rupees(c.countedTotalInr ?? 0)} counted
                {varianceText(c.varianceInr)}
              </p>
            )}
          </li>
        ))}
        {counts.length === 0 ? <li className="py-3 text-sm text-muted">No counts recorded yet.</li> : null}
      </ul>

      <h3 className="mt-5 text-sm font-bold uppercase tracking-wide text-muted">Cash movements</h3>
      <ul className="mt-3 flex flex-col divide-y divide-line">
        {movements.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
            <div className="min-w-0">
              <p className="truncate font-bold text-charcoal">{movementTitle(m)}</p>
              {movementNote(m) ? <p className="truncate text-xs text-muted">{movementNote(m)}</p> : null}
              {m.direction === 'out' && !isHandoverMovement(m) ? (
                <CategoryControl movement={m} onChanged={onChanged} />
              ) : null}
            </div>
            <div className="text-right">
              <p className="text-charcoal">
                {m.direction === 'in' ? '+' : '−'}
                {rupees(m.amountInr)}
              </p>
              <p className="text-xs text-muted">{formatWhen(m.createdAt)}</p>
            </div>
          </li>
        ))}
        {movements.length === 0 ? <li className="py-3 text-sm text-muted">No cash-in/out entries yet.</li> : null}
      </ul>
    </Card>
  );
}
