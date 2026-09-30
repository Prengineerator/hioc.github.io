import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { CoffeePassPlan } from '@/lib/passes/types';
import {
  planCoverageLabel,
  planGstNote,
  planHeadline,
  planPerCupInr,
  planSaveLabel,
  planValidityLabel,
} from '@/lib/passes/ui';

/**
 * One plan on /ritual. Every figure is derived from the plan and the store's GST
 * setting (lib/passes/ui.ts), so an owner's edit changes the card with it. The
 * buy control is passed in as `action`, because what it does depends on whether
 * the customer is signed in and whether the shop can take the payment online.
 */
export function PlanCard({
  plan,
  gst,
  action,
}: {
  plan: CoffeePassPlan;
  gst: { percent: number; inclusive: boolean };
  action: ReactNode;
}) {
  const save = planSaveLabel(plan);
  const gstNote = planGstNote(plan, gst);
  return (
    <Card padding="lg" className="flex h-full flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-bold text-charcoal">{plan.name}</h3>
        {save ? <Badge variant="success">{save}</Badge> : null}
      </div>

      <div>
        <p className="font-semibold text-charcoal">{planHeadline(plan)}</p>
        {plan.description ? <p className="mt-1 text-sm text-muted">{plan.description}</p> : null}
      </div>

      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-3xl font-bold tabular-nums text-tan-dark">₹{plan.price_inr}</span>
        {gstNote ? <span className="text-sm text-muted">{gstNote}</span> : null}
        <span className="text-sm text-muted">
          · <span className="font-mono tabular-nums">₹{planPerCupInr(plan)}</span> a cup
        </span>
      </p>

      <ul className="flex flex-col gap-1.5 text-sm text-charcoal">
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-tan" />
          <span>{planValidityLabel(plan)}</span>
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-tan" />
          <span>{planCoverageLabel(plan)}</span>
        </li>
      </ul>

      <div className="mt-auto pt-1">{action}</div>
    </Card>
  );
}
