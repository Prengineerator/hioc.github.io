'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import {
  CATEGORY_ORDER,
  NO_CHOICE,
  categoryLabel,
  chooseDrink,
  chooseSize,
  drinkSelectable,
  pickerNeedsSearch,
  pickerView,
  priceRangeLabel,
  resolveChoice,
  sizesOnSale,
  type DrinkChoice,
} from '@/lib/passes/ritualDrinks';
import type { RitualDrink } from '@/lib/passes/types';

/**
 * "Choose your drink" on /ritual (docs/COFFEE-PASS-SPEC.md CP-D22): the drinks a
 * Ritual can be bought for, then a size. The Ritual's price follows the choice, so
 * this is the step that sets it.
 *
 * Two looks, one at a time, so a phone never shows a 59-drink list beside the
 * answer:
 *   no drink yet   a search box (once the list is long), category chips and the
 *                  drinks grouped by category, one per row
 *   a drink        that drink with its sizes (price on each) and "Change drink"
 *
 * A drink that is off the menu today stays in the list, greyed and labelled, rather
 * than vanishing (the menu's own rule); it cannot be picked because the server
 * would refuse it. The choice is held by the parent, which prices it.
 */
export function DrinkPicker({
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
  const resolved = useMemo(() => resolveChoice(drinks, choice), [drinks, choice]);
  const view = useMemo(
    () => pickerView(drinks, { query, category, categoryOrder: CATEGORY_ORDER, labelFor: categoryLabel }),
    [drinks, query, category],
  );

  // Choosing collapses a long list into one card, so whatever was tapped has moved:
  // bring the card back into view rather than leave the customer mid-page.
  const sectionRef = useRef<HTMLDivElement>(null);
  const pickedId = resolved?.drink.id ?? null;
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (pickedId) sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [pickedId]);

  if (drinks.length === 0) {
    return (
      <p className="rounded-md bg-surface px-4 py-3 text-sm text-charcoal">
        No drinks are set up for a Ritual yet. Ask us at the counter.
      </p>
    );
  }

  if (resolved) {
    const { drink } = resolved;
    return (
      <div ref={sectionRef} className="scroll-mt-24">
        <Card padding="md">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">{categoryLabel(drink.category)}</p>
              <p className="text-lg font-bold text-charcoal">{drink.name}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onChoice(NO_CHOICE)}>
              Change drink
            </Button>
          </div>
          <fieldset className="mt-3">
            <legend className="text-sm font-semibold text-charcoal">Size</legend>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {sizesOnSale(drink).map((size) => {
                const on = resolved.size?.variant_id === size.variant_id;
                return (
                  <label key={size.variant_id} className="block cursor-pointer">
                    <input
                      type="radio"
                      name="ritual-size"
                      value={size.variant_id}
                      checked={on}
                      onChange={() => onChoice(chooseSize(choice, size.variant_id))}
                      className="peer sr-only"
                    />
                    <span
                      className={
                        'flex min-h-[52px] items-center justify-between gap-2 rounded-md border-2 px-3 py-2 text-sm font-semibold transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-tan ' +
                        (on
                          ? 'border-tan-dark bg-tan-dark text-cream'
                          : 'border-line bg-cream text-charcoal hover:border-tan')
                      }
                    >
                      <span>{size.label.trim() || 'One size'}</span>
                      <span className="font-mono tabular-nums">₹{size.price_inr}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </Card>
      </div>
    );
  }

  const searchable = pickerNeedsSearch(drinks.length);
  return (
    <div ref={sectionRef} className="flex flex-col gap-3">
      {searchable ? (
        <Input
          label="Search drinks"
          type="search"
          inputMode="search"
          autoComplete="off"
          placeholder="Cappuccino, iced, cold brew…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}

      {view.chips.length > 1 ? (
        <div role="group" aria-label="Category" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
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

      {view.shown === 0 ? (
        <div className="rounded-md border border-line bg-cream px-4 py-6 text-center text-sm text-muted">
          <p>{query.trim() ? `No drink matches “${query.trim()}”.` : 'Nothing in this category.'}</p>
          <Button
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
        view.groups.map((group) => (
          <div key={group.category}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{group.label}</h3>
            <ul className="flex flex-col gap-2">
              {group.drinks.map((drink) => {
                const ok = drinkSelectable(drink);
                return (
                  <li key={drink.id}>
                    <button
                      type="button"
                      disabled={!ok}
                      onClick={() => onChoice(chooseDrink(drink, choice))}
                      className="flex min-h-[52px] w-full items-center justify-between gap-3 rounded-md border border-line bg-cream px-4 py-2 text-left transition-colors hover:border-tan focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-line"
                    >
                      <span className="min-w-0 font-semibold text-charcoal">{drink.name}</span>
                      {ok ? (
                        <span className="shrink-0 font-mono text-sm tabular-nums text-muted">{priceRangeLabel(drink)}</span>
                      ) : (
                        <span className="shrink-0 text-xs font-semibold text-muted">Not available today</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
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
        'inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
        (active ? 'border-tan-dark bg-tan-dark text-cream' : 'border-line bg-cream text-charcoal hover:border-tan')
      }
    >
      {children}
    </button>
  );
}
