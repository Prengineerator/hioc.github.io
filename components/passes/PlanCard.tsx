import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import type { CoffeePassPlan } from '@/lib/passes/types';
import { PRICE_FOLLOWS_DRINK } from '@/lib/passes/ritualDrinks';
import { passDailyLimitLabel, planHeadline, planSaveLabel, planValidityLabel } from '@/lib/passes/ui';

/**
 * One plan on /ritual, as a choice between plans (a radio: the keyboard and a
 * screen reader get arrow-key selection for free). A plan has no price of its own
 * (docs/COFFEE-PASS-SPEC.md CP-D22, CP-D24): what a customer pays follows the drink
 * they pick next, so the card says what they GET (cups, validity, the saving from
 * the cups) and says so. Every figure is derived from the plan
 * (lib/passes/ui.ts), so an owner's edit changes the card with it.
 *
 * No headings or lists inside the label (it is a radio's label, and a label is for
 * phrasing content), so the card's text is spans.
 */
export function PlanCard({
  plan,
  selected,
  groupName,
  onSelect,
}: {
  plan: CoffeePassPlan;
  selected: boolean;
  /** The radio group's name: every card in the set shares it. */
  groupName: string;
  onSelect: (plan: CoffeePassPlan) => void;
}) {
  const save = planSaveLabel(plan);
  const dailyLimit = passDailyLimitLabel(plan.max_per_day);
  const bullets = [planValidityLabel(plan), dailyLimit, PRICE_FOLLOWS_DRINK].filter((b): b is string => Boolean(b));
  return (
    <label className="block h-full cursor-pointer">
      <input
        type="radio"
        name={groupName}
        value={plan.id}
        checked={selected}
        onChange={() => onSelect(plan)}
        className="peer sr-only"
      />
      <Card
        padding="lg"
        className={
          'flex h-full flex-col gap-3 transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-tan ' +
          (selected ? 'border-2 border-tan-dark bg-surface' : 'hover:border-tan')
        }
      >
        <span className="flex items-start justify-between gap-3">
          <span className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className={
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ' +
                (selected ? 'border-tan-dark' : 'border-line')
              }
            >
              {selected ? <span className="h-2.5 w-2.5 rounded-full bg-tan-dark" /> : null}
            </span>
            <span className="text-lg font-bold text-charcoal">{plan.name}</span>
          </span>
          {save ? <Badge variant="success">{save}</Badge> : null}
        </span>

        <span className="block">
          <span className="block font-semibold text-charcoal">{planHeadline(plan)}</span>
          {plan.description ? <span className="mt-1 block text-sm text-muted">{plan.description}</span> : null}
        </span>

        <span className="flex flex-col gap-1.5 text-sm text-charcoal">
          {bullets.map((line) => (
            <span key={line} className="flex gap-2">
              <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-tan" />
              <span>{line}</span>
            </span>
          ))}
        </span>
      </Card>
    </label>
  );
}
