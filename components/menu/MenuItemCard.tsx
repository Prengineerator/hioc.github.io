'use client';

import { useState } from 'react';
import { useCart } from '@/lib/cart/CartContext';
import { computeCartKey } from '@/lib/cart/cartKey';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { formatIstTime } from '@/lib/store/hours';
import { Card } from '@/components/ui/Card';
import { buttonVariants } from '@/components/ui/Button';
import { MenuItemCustomizeModal } from '@/components/menu/MenuItemCustomizeModal';
import { MenuItemImage } from '@/components/menu/MenuItemImage';
import type { MenuItem } from '@/lib/types';

function priceLabel(item: MenuItem): string {
  const prices = item.variants.map((v) => v.price_inr);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `₹${min}` : `₹${min}–₹${max}`;
}

// "Currently unavailable" for a manual 86, or "Back at 6:30 PM" for a timed
// snooze (unavailable_until) — matches the staff-side snooze semantics in
// lib/menu/availability.ts.
function unavailableLabel(item: MenuItem): string {
  if (item.unavailable_until) {
    return `Back at ${formatIstTime(new Date(item.unavailable_until))}`;
  }
  return 'Currently unavailable';
}

// 40px round steppers (were 32px) — comfortably tappable on a phone.
const stepperButtonClasses =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan';

export function MenuItemCard({ item }: { item: MenuItem }) {
  const { getQty, addItem, increment, decrement } = useCart();
  const [customizing, setCustomizing] = useState(false);

  const available = isMenuItemAvailable(item);
  const isSimple = item.variants.length === 1 && item.addon_groups.length === 0;
  const onlyVariant = item.variants[0];
  const simpleKey = onlyVariant ? computeCartKey(item.id, onlyVariant.id, [], '') : '';
  const qty = isSimple ? getQty(simpleKey) : 0;

  // Phone (< sm): a compact row — text left, square thumbnail right — so a
  // category shows ~4 items per screen instead of ~1.5 full-width 4:3 tiles,
  // which is what made the menu feel like endless scrolling on a phone.
  // sm and up keep the original vertical card grid unchanged.
  return (
    <Card
      interactive={available}
      className={'flex gap-3 transition-opacity sm:flex-col sm:gap-0 ' + (available ? '' : 'opacity-60')}
    >
      <MenuItemImage
        item={item}
        className="order-last h-24 w-24 shrink-0 self-start sm:order-none sm:mb-3 sm:aspect-[4/3] sm:h-auto sm:w-full"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
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
            <h4 className="font-semibold leading-snug text-charcoal">{item.name}</h4>
          </div>
          <span className="hidden shrink-0 font-mono font-bold tabular-nums text-tan sm:inline">{priceLabel(item)}</span>
        </div>
        <span className="mt-0.5 font-mono font-bold tabular-nums text-tan sm:hidden">{priceLabel(item)}</span>
        {item.description ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted">{item.description}</p>
        ) : null}

        {!available ? (
          <p className="mt-2 text-sm font-medium text-muted">{unavailableLabel(item)}</p>
        ) : null}

        <div className="mt-auto pt-3 sm:pt-4">
          {!available ? (
            <button
              type="button"
              disabled
              className="w-full cursor-not-allowed rounded-md bg-line px-4 py-2 text-sm font-semibold text-muted"
            >
              Unavailable
            </button>
          ) : isSimple && onlyVariant ? (
            qty === 0 ? (
              <button
                type="button"
                onClick={() =>
                  addItem({
                    menuItemId: item.id,
                    variantId: onlyVariant.id,
                    name: item.name,
                    variantLabel: onlyVariant.label,
                    unitPriceInr: onlyVariant.price_inr,
                    gstExempt: item.gst_exempt === true,
                    addons: [],
                    specialInstructions: '',
                  })
                }
                className={buttonVariants({ size: 'sm', fullWidth: true })}
              >
                Add to Cart
              </button>
            ) : (
              <div className="flex items-center justify-between gap-4 rounded-md border border-line p-0.5">
                <button
                  type="button"
                  aria-label={qty === 1 ? `Remove ${item.name}` : `Decrease ${item.name} quantity`}
                  onClick={() => decrement(simpleKey)}
                  className={stepperButtonClasses + ' bg-charcoal text-cream hover:opacity-90'}
                >
                  &minus;
                </button>
                <span aria-live="polite" className="min-w-[1.5rem] text-center font-mono font-semibold tabular-nums text-charcoal">{qty}</span>
                <button
                  type="button"
                  aria-label={`Increase ${item.name} quantity`}
                  onClick={() => increment(simpleKey)}
                  className={stepperButtonClasses + ' bg-tan text-cream hover:bg-tan-dark'}
                >
                  +
                </button>
              </div>
            )
          ) : (
            <button
              type="button"
              onClick={() => setCustomizing(true)}
              className={buttonVariants({ size: 'sm', fullWidth: true })}
            >
              Customize &amp; Add
            </button>
          )}
        </div>
      </div>

      {customizing && available ? (
        <MenuItemCustomizeModal item={item} onClose={() => setCustomizing(false)} />
      ) : null}
    </Card>
  );
}
