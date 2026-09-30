'use client';

// One HIOC Ritual a customer holds, as the counter sees it: the plan, the cups
// left as dots (with the same thing in words, so colour is never the only
// signal), how long it is good for (IST), its state, a collapsible history of
// what it was spent on, and — for a manager — Extend and Give back a cup.

import { useId, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  cupDots,
  cupsLeftLabel,
  historyLine,
  historyTimeLabel,
  passStateLabel,
  passValidityLabel,
  type HolderPass,
} from '@/lib/pos/ritual';
import type { PassState } from '@/lib/passes/types';

const STATE_VARIANT: Record<PassState, BadgeVariant> = {
  active: 'success',
  used_up: 'neutral',
  expired: 'neutral',
  refunded: 'danger',
  void: 'danger',
};

export function PassCard({
  pass,
  canManage,
  onExtend,
  onGiveBack,
}: {
  pass: HolderPass;
  /** A manager or the owner: shows Extend and Give back a cup. The API is the real guard. */
  canManage: boolean;
  onExtend: (pass: HolderPass) => void;
  onGiveBack: (pass: HolderPass) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const historyId = useId();
  const { total, filled } = cupDots(pass);
  // A refunded or void pass cannot be changed (the API says "isn't active");
  // used-up and lapsed ones can, which is exactly when a manager needs to.
  const changeable = canManage && pass.status === 'active';
  const live = pass.state === 'active';

  return (
    <li className="rounded-md border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-bold text-charcoal">{pass.plan_name}</p>
          <p className="text-sm text-muted">{passValidityLabel(pass)}</p>
        </div>
        <Badge variant={STATE_VARIANT[pass.state]}>{passStateLabel(pass.state)}</Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* The dots are decorative; the text beside them is what is announced. */}
        <span aria-hidden="true" className="flex flex-wrap gap-1.5">
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={
                'h-3.5 w-3.5 rounded-full border-2 border-tan-dark ' + (i < filled && live ? 'bg-tan-dark' : i < filled ? 'bg-tan' : 'bg-transparent')
              }
            />
          ))}
        </span>
        <span className="font-mono text-sm font-bold tabular-nums text-charcoal">{cupsLeftLabel(pass)}</span>
      </div>
      {pass.max_per_day != null ? (
        <p className="mt-1 text-xs text-muted">
          Up to {pass.max_per_day} a day · {pass.used_today} used today
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          aria-expanded={showHistory}
          aria-controls={historyId}
          className="min-h-[44px] rounded-md px-2 text-sm font-bold text-tan-dark underline"
        >
          {showHistory ? 'Hide history' : `History (${pass.history.length})`}
        </button>
        {changeable ? (
          <>
            <Button type="button" variant="secondary" size="sm" onClick={() => onExtend(pass)}>
              Extend
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => onGiveBack(pass)}>
              Give back a cup
            </Button>
          </>
        ) : null}
      </div>

      {showHistory ? (
        <div id={historyId} className="mt-2 border-t border-line pt-2">
          {pass.history.length === 0 ? (
            <p className="text-sm text-muted">No cups used yet.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {pass.history.map((entry) => (
                <li
                  key={`${entry.order_id}-${entry.created_at}`}
                  className={'flex flex-wrap justify-between gap-x-3 text-sm ' + (entry.reversed ? 'text-muted' : 'text-charcoal')}
                >
                  <span>{historyLine(entry)}</span>
                  <span className="text-xs text-muted">{historyTimeLabel(entry.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}
