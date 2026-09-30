'use client';

// "What is left before this is ready" (docs/COFFEE-PASS-SPEC.md §9 B), at the
// top of Owner → HIOC Ritual. The steps are read from the data (a plan on sale,
// drinks chosen), so it updates as the owner works below it. Settled facts (the
// feature is on, the GST rule the owner decided) are listed too, already ticked,
// so the owner can see them without them counting as a step. Dismissible for
// this visit only: it comes back on the next load, on purpose, until the steps
// are done.

import { useState } from 'react';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { setupChecklist, type ChecklistItem } from '@/lib/passes/ownerUi';
import type { CoffeePassPlan } from '@/lib/passes/types';

function Mark({ item }: { item: ChecklistItem }) {
  // A word as well as a shape, so "done" is never colour alone.
  if (item.done) {
    return (
      <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-700 text-xs font-bold text-cream">
        ✓
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-tan-dark"
    />
  );
}

export function SetupChecklist({ plans, eligibleCount }: { plans: CoffeePassPlan[]; eligibleCount: number }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const { items, todo } = setupChecklist({ plans, eligibleCount });

  return (
    <section aria-labelledby="ritual-setup-heading" className="rounded-md border border-tan bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="ritual-setup-heading" className="text-sm font-bold uppercase tracking-wide text-charcoal">
            {todo > 0 ? `${todo} ${todo === 1 ? 'step' : 'steps'} left before ${PASS_PROGRAM_NAME} is ready` : `${PASS_PROGRAM_NAME} is set up`}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {todo > 0
              ? 'Nothing is sold until a plan is switched on and drinks are chosen.'
              : 'Everything here is done.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="flex min-h-[44px] shrink-0 items-center rounded-md px-3 text-sm font-semibold text-charcoal hover:bg-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          Hide for now
        </button>
      </div>

      <ul className="mt-4 flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id} className="flex items-start gap-3">
            <Mark item={item} />
            <div className="min-w-0 text-sm">
              <p className="font-semibold text-charcoal">
                {item.href && !item.done ? (
                  <a href={item.href} className="text-tan-dark underline-offset-2 hover:underline">
                    {item.label}
                  </a>
                ) : (
                  item.label
                )}
                <span className="sr-only">{item.done ? ' (done)' : ' (to do)'}</span>
              </p>
              <p className="text-muted">{item.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
