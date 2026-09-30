'use client';

// Step one of selling a HIOC Ritual (docs/COFFEE-PASS-SPEC.md CP-D22): choose the
// drink and size, see what the Ritual comes to, Continue. Step two is the confirm
// sheet (SellConfirmDialog), which sends the sale. The price is the plan's cups
// paid for × the size's menu price plus GST (ritualPriceQuote); it is a preview,
// the order the server makes is what is charged.

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { DrinkSizePicker } from '@/components/staff/passes/DrinkSizePicker';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import {
  completeChoice,
  choiceLabel,
  ritualCoverLine,
  ritualPriceLine,
  ritualPriceQuote,
  type CompleteChoice,
  type DrinkChoice,
} from '@/lib/passes/ritualDrinks';
import type { CoffeePassPlan, RitualDrink } from '@/lib/passes/types';
import { planSummaryLabel, type PlanGst } from '@/lib/pos/ritual';

export function SellDrinkDialog({
  plan,
  gst,
  drinks,
  initial,
  onCancel,
  onContinue,
}: {
  plan: CoffeePassPlan;
  gst: PlanGst | null;
  drinks: RitualDrink[];
  /** What was chosen before (coming back from the confirm sheet), so "Change drink" does not start over. */
  initial: DrinkChoice;
  onCancel: () => void;
  onContinue: (choice: CompleteChoice) => void;
}) {
  const [choice, setChoice] = useState<DrinkChoice>(initial);
  const complete = completeChoice(drinks, choice);
  const quote = complete ? ritualPriceQuote(plan, complete.size.price_inr, gst) : null;

  return (
    <Modal
      open
      onClose={onCancel}
      title={`Sell ${plan.name}`}
      subtitle={`${PASS_PROGRAM_NAME} · ${planSummaryLabel(plan)} · choose the customer’s drink`}
      size="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div aria-live="polite" className="min-w-0 flex-1 basis-56">
            {complete && quote ? (
              <>
                <p className="text-sm font-bold text-charcoal">{choiceLabel(complete)}</p>
                <p className="font-mono text-sm tabular-nums text-charcoal">{ritualPriceLine(quote)}</p>
                <p className="text-xs text-muted">{ritualCoverLine(complete.size.price_inr)}</p>
              </>
            ) : (
              <p className="text-sm text-muted">
                {choice.drinkId ? 'Choose a size to see the price.' : 'Choose a drink to see the price.'}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" disabled={!complete} onClick={() => complete && onContinue(complete)}>
              {quote ? `Continue · ₹${quote.totalInr}` : 'Continue'}
            </Button>
          </div>
        </div>
      }
    >
      <DrinkSizePicker drinks={drinks} choice={choice} onChoice={setChoice} />
    </Modal>
  );
}
