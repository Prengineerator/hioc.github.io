'use client';

// One suggestion (a pick, or the "Your usual" card — same shape, §3.2 step 3).

import { MenuItemImage } from '@/components/menu/MenuItemImage';
import { buttonVariants } from '@/components/ui/Button';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { MenuItem } from '@/lib/types';
import type { SuggestionPick } from '@/lib/suggest/types';

function priceLabel(item: MenuItem): string {
  const prices = item.variants.map((v) => v.price_inr);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `₹${min}` : `₹${min}–₹${max}`;
}

export function SuggestionCard({
  item,
  pick,
  isUsual = false,
  feedback,
  onAddToCart,
  onFeedback,
}: {
  item: MenuItem;
  pick: SuggestionPick;
  isUsual?: boolean;
  feedback?: 'up' | 'down';
  onAddToCart: () => void;
  onFeedback: (direction: 'up' | 'down') => void;
}) {
  const available = isMenuItemAvailable(item);

  return (
    <div className="flex flex-col rounded-md border border-line bg-cream p-4 shadow-card">
      {isUsual ? (
        <span className="mb-2 inline-block w-fit rounded-full bg-surface px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-tan">
          Your usual
        </span>
      ) : null}
      <MenuItemImage item={item} />
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span
            aria-label={item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
            title={item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
            className={
              'mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center border ' +
              (item.is_veg ? 'border-green-700' : 'border-red-700')
            }
          >
            <span
              className={'h-1.5 w-1.5 rounded-full ' + (item.is_veg ? 'bg-green-700' : 'bg-red-700')}
            />
          </span>
          <h3 className="font-bold text-charcoal">{item.name}</h3>
        </div>
        <span className="shrink-0 font-bold text-tan">{priceLabel(item)}</span>
      </div>
      <p className="mt-1 text-sm text-muted">{pick.reason}</p>
      {!available ? (
        <p className="mt-2 text-sm font-bold text-muted">Currently unavailable</p>
      ) : null}

      <div className="mt-3 flex items-center gap-2">
        {available ? (
          <button
            type="button"
            onClick={onAddToCart}
            className={buttonVariants({ size: 'sm' })}
          >
            Add to cart
          </button>
        ) : (
          <span className="text-xs text-muted">We&apos;ll suggest something else next time.</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="I like this suggestion"
            aria-pressed={feedback === 'up'}
            onClick={() => onFeedback('up')}
            className={
              'flex h-11 w-11 items-center justify-center rounded-full border text-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
              (feedback === 'up' ? 'border-tan bg-surface' : 'border-line hover:border-tan')
            }
          >
            <span aria-hidden="true">👍</span>
          </button>
          <button
            type="button"
            aria-label="Not for me"
            aria-pressed={feedback === 'down'}
            onClick={() => onFeedback('down')}
            className={
              'flex h-11 w-11 items-center justify-center rounded-full border text-lg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
              (feedback === 'down' ? 'border-tan bg-surface' : 'border-line hover:border-tan')
            }
          >
            <span aria-hidden="true">👎</span>
          </button>
        </div>
      </div>
    </div>
  );
}
