'use client';

// Read-only log of recent checkpoints + cash movements
// (docs/PHASE-5-CASH-COUNTS.md). Cards, not a table — the same reasoning as
// ShortageCard: this content doesn't fit a fixed column layout at 360px.

import { Card } from '@/components/ui/Card';
import type { OwnerCashCountRow, OwnerCashMovementRow } from './types';
import { KIND_LABEL, formatWhen, rupees } from './types';

function varianceText(v: number | null): string {
  if (v === null || v === 0) return '';
  return ` · ${v < 0 ? '−' : '+'}${rupees(Math.abs(v))}`;
}

function varianceClass(v: number | null): string {
  if (v === null || v === 0) return 'text-muted';
  return v < 0 ? 'text-red-700' : 'text-green-700';
}

export function CountLog({ counts, movements }: { counts: OwnerCashCountRow[]; movements: OwnerCashMovementRow[] }) {
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
              <p className="truncate font-bold text-charcoal">
                {m.direction === 'in' ? 'Cash in' : 'Cash out'} · {m.recordedByName}
              </p>
              <p className="truncate text-xs text-muted">{m.reason}</p>
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
