import { CUSTOMER_MENU_CATEGORIES } from '@/lib/constants';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { groupEligibleByCategory, type RitualOffer } from '@/lib/passes/ui';

const CATEGORY_ORDER = CUSTOMER_MENU_CATEGORIES.map((c) => c.slug);
const CATEGORY_LABEL = new Map(CUSTOMER_MENU_CATEGORIES.map((c) => [c.slug, c.label]));

/**
 * The drinks a cup can pay for, as chips grouped by menu category, folded away
 * (the drink picker above lists the same drinks with their prices; this is the
 * "what else can I spend a cup on" answer, so it is there without taking the page). A drink that
 * is off the menu today stays in the list, greyed, rather than vanishing (the
 * same rule the menu follows). Renders nothing when the owner has not ticked any
 * drink yet: an empty list of "what's covered" would only raise doubt.
 */
export function EligibleDrinks({ eligible }: { eligible: RitualOffer['eligible'] }) {
  if (eligible.length === 0) return null;
  const groups = groupEligibleByCategory(eligible, CATEGORY_ORDER, (c) => CATEGORY_LABEL.get(c) ?? c);
  return (
    <section aria-labelledby="ritual-covered" className="mt-10">
      <details className="group">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <h2 id="ritual-covered" className="text-xl font-bold text-charcoal">
            What&apos;s covered
          </h2>
          <span aria-hidden="true" className="text-tan-dark transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <p className="mt-1 text-sm text-muted">
          A {PASS_PROGRAM_NAME} cup can pay for any of these drinks, up to the price of the drink you chose when you bought it.
        </p>
        <div className="mt-4 flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.category}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{group.label}</h3>
              <ul className="flex flex-wrap gap-2">
                {group.drinks.map((drink) => (
                  <li
                    key={drink.id}
                    className={
                      'rounded-full border border-line bg-cream px-3 py-1.5 text-sm text-charcoal ' +
                      (drink.is_available ? '' : 'opacity-60')
                    }
                  >
                    {drink.name}
                    {drink.is_available ? null : <span className="sr-only"> (not available today)</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
