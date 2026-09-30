'use client';

// The drink and size half of selling a HIOC Ritual (docs/COFFEE-PASS-SPEC.md
// CP-D22): a search box first (the cashier types what the customer says), then
// category chips, then the drinks as big tiles, then the sizes of the drink picked.
// Built for a landscape counter tablet: every target is at least 48px, nothing is
// hover-only, and the tile list scrolls inside a fixed height so the size buttons
// and the price under it stay in view.
//
// The choice is held by the parent (SellDrinkDialog), which prices it. What is
// listed and how it is searched is lib/passes/ritualDrinks.ts.

import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  CATEGORY_ORDER,
  categoryLabel,
  chooseDrink,
  chooseSize,
  drinkSelectable,
  pickerView,
  priceRangeLabel,
  resolveChoice,
  sizesOnSale,
  type DrinkChoice,
} from '@/lib/passes/ritualDrinks';
import type { RitualDrink } from '@/lib/passes/types';

export function DrinkSizePicker({
  drinks,
  choice,
  onChoice,
}: {
  drinks: RitualDrink[];
  choice: DrinkChoice;
  onChoice: (choice: DrinkChoice) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const view = useMemo(
    () => pickerView(drinks, { query, category, categoryOrder: CATEGORY_ORDER, labelFor: categoryLabel }),
    [drinks, query, category],
  );
  const resolved = useMemo(() => resolveChoice(drinks, choice), [drinks, choice]);

  if (drinks.length === 0) {
    return (
      <p className="rounded-md bg-surface px-4 py-3 text-sm text-charcoal">
        No drinks are set up for a Ritual yet. The owner chooses them under Owner → Passes.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        label="Search drinks"
        type="search"
        inputMode="search"
        autoComplete="off"
        placeholder="Type a drink, e.g. cappuccino"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {view.chips.length > 1 ? (
        <div role="group" aria-label="Category" className="flex flex-wrap gap-2">
          <Chip active={category === null} onClick={() => setCategory(null)}>
            All
          </Chip>
          {view.chips.map((chip) => (
            <Chip key={chip.category} active={category === chip.category} onClick={() => setCategory(chip.category)}>
              {chip.label} <span className="font-mono text-xs tabular-nums">{chip.count}</span>
            </Chip>
          ))}
        </div>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {view.shown} {view.shown === 1 ? 'drink' : 'drinks'} shown
      </p>

      <div className="max-h-[34vh] overflow-y-auto rounded-md border border-line p-2">
        {view.shown === 0 ? (
          <div className="px-2 py-6 text-center text-sm text-muted">
            <p>{query.trim() ? `No drink matches “${query.trim()}”.` : 'Nothing in this category.'}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => {
                setQuery('');
                setCategory(null);
              }}
            >
              Show all drinks
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {view.groups.map((group) => (
              <div key={group.category}>
                <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted">{group.label}</h3>
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {group.drinks.map((drink) => {
                    const ok = drinkSelectable(drink);
                    const on = resolved?.drink.id === drink.id;
                    return (
                      <li key={drink.id}>
                        <button
                          type="button"
                          disabled={!ok}
                          aria-pressed={on}
                          onClick={() => onChoice(chooseDrink(drink, choice))}
                          className={
                            'flex min-h-[64px] w-full flex-col items-start justify-center gap-0.5 rounded-md border-2 px-3 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan disabled:cursor-not-allowed disabled:opacity-60 ' +
                            (on ? 'border-tan-dark bg-surface' : 'border-line bg-white hover:border-tan disabled:hover:border-line')
                          }
                        >
                          <span className="line-clamp-2 text-sm font-bold text-charcoal">{drink.name}</span>
                          {ok ? (
                            <span className="font-mono text-xs tabular-nums text-muted">{priceRangeLabel(drink)}</span>
                          ) : (
                            <span className="text-xs font-semibold text-muted">Not available today</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      {resolved ? (
        <fieldset>
          <legend className="mb-1.5 text-sm font-bold text-charcoal">Size for {resolved.drink.name}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {sizesOnSale(resolved.drink).map((size) => {
              const on = resolved.size?.variant_id === size.variant_id;
              return (
                <button
                  key={size.variant_id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChoice(chooseSize(choice, size.variant_id))}
                  className={
                    'flex min-h-[56px] flex-col items-center justify-center rounded-md border-2 px-3 py-2 text-sm font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
                    (on ? 'border-tan-dark bg-tan-dark text-cream' : 'border-line bg-white text-charcoal hover:border-tan')
                  }
                >
                  <span>{size.label.trim() || 'One size'}</span>
                  <span className="font-mono text-xs font-normal tabular-nums">₹{size.price_inr}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        'inline-flex min-h-[48px] items-center gap-1.5 rounded-full border px-4 text-sm font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
        (active ? 'border-tan-dark bg-tan-dark text-cream' : 'border-line bg-white text-charcoal hover:border-tan')
      }
    >
      {children}
    </button>
  );
}
