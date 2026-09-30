'use client';

import { SurfaceLink } from '@/components/SurfaceLink';
import { buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useRitualOffer } from '@/components/passes/useRitualOffer';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { planHeadline, ritualOnSale } from '@/lib/passes/ui';

/**
 * The home page's HIOC Ritual teaser: what the plans are, in a line each, and a
 * way in. Nothing at all while the feature is off or no plan is on sale (the
 * page it links to would only say "no plans"), so the home page is unchanged
 * until the owner switches the Ritual on.
 */
export function RitualTeaser() {
  const { offer } = useRitualOffer();
  if (!offer || !ritualOnSale(offer)) return null;
  return (
    <section aria-labelledby="ritual-teaser-heading" className="mx-auto max-w-6xl px-4 pb-4">
      <Card className="flex flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">{PASS_PROGRAM_NAME}</p>
          <h2 id="ritual-teaser-heading" className="mt-1 text-lg font-bold text-charcoal">
            Your daily cup, sorted
          </h2>
          <ul className="mt-1 space-y-0.5 text-sm text-muted">
            {offer.plans.slice(0, 2).map((plan) => (
              <li key={plan.id}>
                <span className="font-semibold text-charcoal">{plan.name}</span> — {planHeadline(plan)}
              </li>
            ))}
          </ul>
        </div>
        <SurfaceLink href="/ritual" className={buttonVariants({ variant: 'secondary' })}>
          See the plans
        </SurfaceLink>
      </Card>
    </section>
  );
}
