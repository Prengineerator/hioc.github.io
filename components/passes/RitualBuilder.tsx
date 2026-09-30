'use client';

import { useId, useMemo, useState } from 'react';
import { SurfaceLink } from '@/components/SurfaceLink';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { DrinkPicker } from '@/components/passes/DrinkPicker';
import { PlanCard } from '@/components/passes/PlanCard';
import type { CoffeePassPlan } from '@/lib/passes/types';
import {
  NO_CHOICE,
  choiceLabel,
  resolveChoice,
  ritualCoverLine,
  ritualPerCupLine,
  ritualPriceLine,
  ritualPriceQuote,
  type DrinkChoice,
} from '@/lib/passes/ritualDrinks';
import { planBuyLabel, type RitualOffer } from '@/lib/passes/ui';

/** What the page sends to POST /api/passes/checkout: the plan, the drink and the size. */
export interface RitualPurchase {
  plan: CoffeePassPlan;
  menu_item_id: string;
  variant_id: string;
  /** "Cappuccino · Large": for the payment window's description. */
  drinkLabel: string;
}

/**
 * Buying a Ritual on /ritual (docs/COFFEE-PASS-SPEC.md CP-D22): pick a plan, pick
 * a drink and a size, see the price, buy. The price is the plan's cups paid for ×
 * the size's menu price plus GST, worked out here from the offer (a preview: the
 * server prices the cup again from the live menu, and the order's total is what
 * the payment window charges).
 *
 * The plan and the drink are held here; the purchase itself (checkout, Razorpay,
 * waiting for the pass) belongs to RitualExperience. One plan is always chosen (the
 * first), so the price shows as soon as a size is.
 */
export function RitualBuilder({
  offer,
  signedIn,
  opening,
  busy,
  onBuy,
}: {
  offer: RitualOffer;
  signedIn: boolean;
  /** The purchase is starting or opening the payment window: the button spins. */
  opening: 'starting' | 'paying' | null;
  /** Any purchase step is under way: nothing can be started again. */
  busy: boolean;
  onBuy: (purchase: RitualPurchase) => void;
}) {
  const groupName = useId();
  const [planId, setPlanId] = useState<string | null>(null);
  const [choice, setChoice] = useState<DrinkChoice>(NO_CHOICE);

  const plan = offer.plans.find((p) => p.id === planId) ?? offer.plans[0];
  const resolved = useMemo(() => resolveChoice(offer.eligible, choice), [offer.eligible, choice]);
  const size = resolved?.size ?? null;
  const quote = plan && size ? ritualPriceQuote(plan, size.price_inr, offer.gst) : null;

  function buyControl() {
    if (!offer.online_purchase) {
      return (
        <p className="rounded-md bg-surface px-4 py-3 text-sm font-semibold text-charcoal">
          Buy at the counter — just give us your number.
        </p>
      );
    }
    if (!signedIn) {
      return (
        <SurfaceLink href="/login?next=/ritual" className={buttonVariants({ fullWidth: true })}>
          Log in to buy
        </SurfaceLink>
      );
    }
    return (
      <Button
        fullWidth
        loading={opening !== null}
        disabled={busy || !quote}
        onClick={() => {
          if (plan && resolved && size) {
            onBuy({
              plan,
              menu_item_id: resolved.drink.id,
              variant_id: size.variant_id,
              drinkLabel: choiceLabel({ drink: resolved.drink, size }),
            });
          }
        }}
      >
        {opening === 'starting' ? 'Starting…' : opening === 'paying' ? 'Opening payment…' : planBuyLabel(plan, quote?.totalInr)}
      </Button>
    );
  }

  return (
    <>
      <section aria-labelledby="ritual-plans" className="mt-8">
        <h2 id="ritual-plans" className="text-xl font-bold text-charcoal">
          Pick a plan
        </h2>
        <div role="radiogroup" aria-labelledby="ritual-plans" className="mt-4 grid gap-4 sm:grid-cols-2">
          {offer.plans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              selected={p.id === plan?.id}
              groupName={groupName}
              onSelect={(next) => setPlanId(next.id)}
            />
          ))}
        </div>
      </section>

      <section aria-labelledby="ritual-drink" className="mt-8">
        <h2 id="ritual-drink" className="text-xl font-bold text-charcoal">
          Choose your drink
        </h2>
        <p className="mt-1 text-sm text-muted">
          Your Ritual is priced from it, and each cup covers up to its price on any Ritual coffee.
        </p>
        <div className="mt-4">
          <DrinkPicker drinks={offer.eligible} choice={choice} onChoice={setChoice} />
        </div>
      </section>

      <section aria-labelledby="ritual-price" className="mt-8">
        <h2 id="ritual-price" className="text-xl font-bold text-charcoal">
          Your price
        </h2>
        <Card padding="lg" className="mt-4 flex flex-col gap-3">
          <div aria-live="polite" className="flex flex-col gap-1">
            {plan && resolved && size && quote ? (
              <>
                <p className="text-sm text-muted">
                  {plan.name} · {choiceLabel({ drink: resolved.drink, size })}
                </p>
                <p className="font-mono text-3xl font-bold tabular-nums text-tan-dark">₹{quote.totalInr}</p>
                <p className="font-mono text-sm tabular-nums text-charcoal">{ritualPriceLine(quote)}</p>
                <p className="mt-1 text-sm text-charcoal">{ritualCoverLine(size.price_inr)}</p>
                {ritualPerCupLine(plan, size.price_inr) ? (
                  <p className="text-sm text-muted">{ritualPerCupLine(plan, size.price_inr)}</p>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted">
                {resolved ? 'Choose a size to see your price.' : 'Choose a drink to see your price.'}
              </p>
            )}
          </div>
          {buyControl()}
        </Card>
      </section>
    </>
  );
}
