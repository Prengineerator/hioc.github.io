'use client';

// One HIOC Ritual plan on the Passes screen: name, "7 cups · 7 days", the price
// (with "+ GST" when tax is added on top), what a cup works out to, and Sell.

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { CoffeePassPlan } from '@/lib/passes/types';
import { planPerCupInr, planPriceNote, planSaveLabel, planSummaryLabel, type PlanGst } from '@/lib/pos/ritual';

export function PlanCard({
  plan,
  gst,
  sellBlocked,
  blockedReasonId,
  onSell,
}: {
  plan: CoffeePassPlan;
  gst: PlanGst | null;
  /** Sell is off (no valid phone or name yet, or this screen cannot sell): the reason is shown once above the plans. */
  sellBlocked: boolean;
  /** The id of the element that gives that reason, so the disabled button is explained to a screen reader. */
  blockedReasonId: string;
  onSell: (plan: CoffeePassPlan) => void;
}) {
  const save = planSaveLabel(plan);
  const gstNote = planPriceNote(plan, gst);

  return (
    <li className="flex flex-col gap-3 rounded-md border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-charcoal">{plan.name}</h3>
          <p className="text-sm text-muted">{planSummaryLabel(plan)}</p>
        </div>
        {save ? <Badge variant="tan">{save}</Badge> : null}
      </div>

      <div>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-2xl font-bold tabular-nums text-charcoal">₹{plan.price_inr}</span>
          {gstNote ? <span className="text-sm font-bold text-muted">{gstNote}</span> : null}
        </p>
        <p className="text-sm text-muted">
          <span className="font-mono tabular-nums">₹{planPerCupInr(plan)}</span> a cup · pay for {plan.drinks_paid}, get{' '}
          {plan.drinks_total}
        </p>
      </div>

      <p className="text-xs text-muted">
        Each cup covers up to <span className="font-mono tabular-nums">₹{plan.drink_value_inr}</span> of one eligible drink
        {plan.max_per_day != null ? `, up to ${plan.max_per_day} a day` : ''}.
      </p>

      <Button
        type="button"
        fullWidth
        disabled={sellBlocked}
        aria-describedby={sellBlocked ? blockedReasonId : undefined}
        onClick={() => onSell(plan)}
      >
        Sell {plan.name}
      </Button>
    </li>
  );
}
