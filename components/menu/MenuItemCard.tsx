'use client';

import { useState } from 'react';
import { useCart } from '@/lib/cart/CartContext';
import { computeCartKey } from '@/lib/cart/cartKey';
import { MenuItemCustomizeModal } from '@/components/menu/MenuItemCustomizeModal';
import type { MenuItem } from '@/lib/types';

function priceLabel(item: MenuItem): string {
  const prices = item.variants.map((v) => v.price_inr);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `₹${min}` : `₹${min}–₹${max}`;
}

export function MenuItemCard({ item }: { item: MenuItem }) {
  const { getQty, addItem, increment, decrement } = useCart();
  const [customizing, setCustomizing] = useState(false);

  const isSimple = item.variants.length === 1 && item.addon_groups.length === 0;
  const onlyVariant = item.variants[0];
  const simpleKey = onlyVariant ? computeCartKey(item.id, onlyVariant.id, []) : '';
  const qty = isSimple ? getQty(simpleKey) : 0;

  return (
    <div className="flex flex-col rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
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
      <div className="mt-4">
        {isSimple && onlyVariant ? (
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

      {customizing ? (
        <MenuItemCustomizeModal item={item} onClose={() => setCustomizing(false)} />
      ) : null}
    </div>
  );
}
