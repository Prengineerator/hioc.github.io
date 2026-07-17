'use client';

import { useState } from 'react';
import { useCart } from '@/lib/cart/CartContext';
import { computeCartKey } from '@/lib/cart/cartKey';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { formatIstTime } from '@/lib/store/hours';
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

export function MenuItemCard({ item }: { item: MenuItem }) {
  const { getQty, addItem, increment, decrement } = useCart();
  const [customizing, setCustomizing] = useState(false);

  const available = isMenuItemAvailable(item);
  const isSimple = item.variants.length === 1 && item.addon_groups.length === 0;
  const onlyVariant = item.variants[0];
  const simpleKey = onlyVariant ? computeCartKey(item.id, onlyVariant.id, [], '') : '';
  const qty = isSimple ? getQty(simpleKey) : 0;

  return (
    <div
      className={
        'flex flex-col rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm transition-opacity ' +
        (available ? '' : 'opacity-60')
      }
    >
      <MenuItemImage item={item} />
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <span
            aria-label={item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
            className={
              'mt-1 flex h-3 w-3 shrink-0 items-center justify-center border ' +
              (item.is_veg ? 'border-green-700' : 'border-red-700')
            }
          >
            <span
              className={'h-1.5 w-1.5 rounded-full ' + (item.is_veg ? 'bg-green-700' : 'bg-red-700')}
            />
          </span>
          <h4 className="font-bold text-charcoal">{item.name}</h4>
        </div>
        <span className="shrink-0 font-bold text-tan">{priceLabel(item)}</span>
      </div>
      {item.description ? (
        <p className="mt-1 line-clamp-2 text-sm text-muted">{item.description}</p>
      ) : null}

      {!available ? (
        <p className="mt-2 text-sm font-bold text-muted">{unavailableLabel(item)}</p>
      ) : null}

      <div className="mt-4">
        {!available ? (
          <button
            type="button"
            disabled
            className="w-full cursor-not-allowed rounded-md bg-[#e5e5e5] px-4 py-2 text-sm font-bold text-muted"
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
                  addons: [],
                  specialInstructions: '',
                })
              }
              className="w-full rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
            >
              Add to Cart
            </button>
          ) : (
            <div className="flex items-center justify-center gap-4 rounded-md border border-[#e5e5e5] px-4 py-2">
              <button
                type="button"
                aria-label="Decrease quantity"
                onClick={() => decrement(simpleKey)}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-charcoal text-cream"
              >
                &minus;
              </button>
              <span className="min-w-[1.5rem] text-center font-bold text-charcoal">{qty}</span>
              <button
                type="button"
                aria-label="Increase quantity"
                onClick={() => increment(simpleKey)}
                className="flex h-6 w-6 items-center justify-center rounded-full bg-tan text-cream"
              >
                +
              </button>
            </div>
          )
        ) : (
          <button
            type="button"
            onClick={() => setCustomizing(true)}
            className="w-full rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
          >
            Customize &amp; Add
          </button>
        )}
      </div>

      {customizing && available ? (
        <MenuItemCustomizeModal item={item} onClose={() => setCustomizing(false)} />
      ) : null}
    </div>
  );
}
