'use client';

// One pending shortage, as a self-contained card (not a table row) so it
// reads correctly at any width down to 360px without a separate mobile
// markup block — the content itself (a count vs. expected line, the
// previous count, action buttons) already wraps via flex-wrap.

import { Button } from '@/components/ui/Button';
import type { OwnerShortageRow } from './types';
import { KIND_LABEL, formatWhen, rupees } from './types';
import type { ShortageAction } from './ShortageDecisionModal';

export function ShortageCard({
  shortage,
  onAction,
}: {
  shortage: OwnerShortageRow;
  onAction: (action: ShortageAction) => void;
}) {
  const { count, previousCount } = shortage;
  const reassigned = shortage.userId !== shortage.originalUserId;

  return (
    <li className="flex flex-col gap-3 rounded-md border border-line bg-cream p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-bold text-charcoal">{shortage.originalUserName}</p>
          <p className="text-xs text-muted">
            {formatWhen(shortage.createdAt)} · {KIND_LABEL[count?.kind ?? ''] ?? 'Count'}
          </p>
        </div>
        <span className="whitespace-nowrap text-lg font-bold text-red-700">−{rupees(shortage.amountInr)}</span>
      </div>

      <div className="rounded-md bg-[#faf7f4] p-3 text-sm text-charcoal">
        <p>
          Counted <strong>{rupees(count?.countedTotalInr ?? 0)}</strong>, expected{' '}
          <strong>{rupees(count?.expectedTotalInr ?? 0)}</strong>.
        </p>
        {previousCount ? (
          <p className="mt-1 text-xs text-muted">
            Previous count {rupees(previousCount.countedTotalInr ?? 0)} by {previousCount.userName} ·{' '}
            {formatWhen(previousCount.createdAt)}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted">No previous count to compare with — this was the first.</p>
        )}
      </div>

      {reassigned ? (
        <p className="text-xs text-amber-900">
          Currently assigned to <strong>{shortage.userName}</strong> — reassigned from {shortage.originalUserName}.
          {shortage.decisionNote ? ` "${shortage.decisionNote}"` : ''}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => onAction('approve')}>
          Approve
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => onAction('waive')}>
          Waive
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onAction('reassign')}>
          Reassign
        </Button>
      </div>
    </li>
  );
}
