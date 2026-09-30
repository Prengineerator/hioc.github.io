'use client';

// One HIOC Ritual plan on the Passes screen: name, "7 cups · 7 days", the saving,
// and Sell. A plan has no price of its own (docs/COFFEE-PASS-SPEC.md CP-D22,
// CP-D24): Sell opens the drink and size picker, and the price follows the drink.

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PRICE_FOLLOWS_DRINK } from '@/lib/passes/ritualDrinks';
import type { CoffeePassPlan } from '@/lib/passes/types';
import { planSaveLabel, planSummaryLabel } from '@/lib/pos/ritual';

export function PlanCard({
  plan,
  sellBlocked,
  blockedReasonId,
  onSell,
}: {
  plan: CoffeePassPlan;
  /** Sell is off (no valid phone or name yet, or this screen cannot sell): the reason is shown once above the plans. */
  sellBlocked: boolean;
  /** The id of the element that gives that reason, so the disabled button is explained to a screen reader. */
  blockedReasonId: string;
  onSell: (plan: CoffeePassPlan) => void;
}) {
  const save = planSaveLabel(plan);

  return (
    <li className="flex flex-col gap-3 rounded-md border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-charcoal">{plan.name}</h3>
          <p className="text-sm text-muted">{planSummaryLabel(plan)}</p>
        </div>
        {save ? <Badge variant="tan">{save}</Badge> : null}
      </div>

      <p className="text-sm text-charcoal">
        Pay for <span className="font-mono font-bold tabular-nums">{plan.drinks_paid}</span>, get{' '}
        <span className="font-mono font-bold tabular-nums">{plan.drinks_total}</span>. {PRICE_FOLLOWS_DRINK}
      </p>

      <p className="text-xs text-muted">
        Each cup covers up to the price of the drink chosen
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
