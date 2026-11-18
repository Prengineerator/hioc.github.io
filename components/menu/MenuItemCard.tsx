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
import { RitualChip } from '@/components/passes/RitualChip';
import { isSoldByWeight } from '@/lib/menu/weight';
import type { MenuItem } from '@/lib/types';

// A sold-by-weight item's variant prices are per kg (lib/menu/weight.ts).
// Several prices read "From ₹135" with the number of sizes beside it, not a
// range: the customer picks the size in the dialog.
function priceParts(item: MenuItem): { price: string; sizes: string | null } {
  const prices = item.variants.map((v) => v.price_inr);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const byWeight = isSoldByWeight(item);
  const unit = byWeight ? '/kg' : '';
  if (min === max) return { price: `₹${min}${unit}`, sizes: null };
  return { price: `From ₹${min}${unit}`, sizes: `${prices.length} ${byWeight ? 'types' : 'sizes'}` };
}

function Price({ item, className }: { item: MenuItem; className: string }) {
  const { price, sizes } = priceParts(item);
  return (
    <span className={className}>
      <span className="font-mono font-bold tabular-nums text-tan-dark">{price}</span>
      {sizes ? <span className="ml-1.5 text-xs font-normal text-muted">{sizes}</span> : null}
    </span>
  );
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
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan';

// The name button stretches over the whole card through an ::after overlay, so
// the card opens its details without nesting one control inside another. The
// focus ring is drawn on the overlay, i.e. around the whole card.
const nameButtonClasses =
  "text-left outline-none after:absolute after:inset-0 after:rounded-md after:content-[''] " +
  'focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-tan';

// `showRitual`: a HIOC Ritual is on sale (the menu page asks once, not per card).
// The chip then marks the drinks a Ritual cup can pay for. `item.pass_eligible`
// is only ever true while the feature flag is on (GET /api/menu).
// `eager`: this card's photo is one of the first on screen, so load it now.
// `onAdded`: called with the item's name after any add (simple or customised),
// so the page can announce it once from a single live region.
export function MenuItemCard({
  item,
  showRitual = false,
  eager = false,
  onAdded,
  categoryLabel,
}: {
  item: MenuItem;
  showRitual?: boolean;
  eager?: boolean;
  onAdded?: (name: string) => void;
  /** Shown above the name: search results come from every category. */
  categoryLabel?: string;
}) {
  const { items: cartLines, getQty, addItem, increment, decrement } = useCart();
  const [customizing, setCustomizing] = useState(false);

  const available = isMenuItemAvailable(item);
  // A sold-by-weight item always opens the modal: the customer picks the grams.
  const byWeight = isSoldByWeight(item);
  const isSimple = item.variants.length === 1 && item.addon_groups.length === 0 && !byWeight;
  const onlyVariant = item.variants[0];
  const simpleKey = onlyVariant ? computeCartKey(item.id, onlyVariant.id, [], '') : '';
  const qty = isSimple ? getQty(simpleKey) : 0;
  // Every line of this item in the cart, whatever size or add-ons it was added with.
  const inCart = cartLines.reduce((n, l) => (l.menuItemId === item.id ? n + l.qty : n), 0);

  // Phone (< sm): a compact row — text left, square thumbnail right — so a
  // category shows ~4 items per screen instead of ~1.5 full-width 4:3 tiles,
  // which is what made the menu feel like endless scrolling on a phone.
  // sm and up keep the original vertical card grid unchanged. An item with no
  // photo has no image slot, so its row is just text.
  //
  // The whole card opens the item's details (the name is the one real button,
  // stretched over the card). The Add / stepper block sits above it (z-10).
  return (
    <Card interactive={available} className="relative flex gap-3 sm:flex-col sm:gap-0">
      <MenuItemImage
        item={item}
        eager={eager}
        className={
          'order-last h-24 w-24 shrink-0 self-start sm:order-none sm:mb-3 sm:aspect-[4/3] sm:h-auto sm:w-full ' +
          (available ? '' : 'opacity-60 grayscale')
        }
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {categoryLabel ? <p className="mb-0.5 text-xs text-muted">{categoryLabel}</p> : null}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span
              role="img"
              aria-label={item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
              title={item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
              className={
                'mt-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center border ' +
                (item.is_veg ? 'border-green-700' : 'border-red-700')
              }
            >
              <span
                aria-hidden="true"
                className={'h-1.5 w-1.5 rounded-full ' + (item.is_veg ? 'bg-green-700' : 'bg-red-700')}
              />
            </span>
            <h3 className={'font-semibold leading-snug ' + (available ? 'text-charcoal' : 'text-muted')}>
              {available ? (
                <button
                  type="button"
                  onClick={() => setCustomizing(true)}
                  // When the card's own action is "Customize & Add" (it opens
                  // this same dialog), keep the name out of the tab order so a
                  // keyboard user meets one stop per item, not two for one action.
                  tabIndex={isSimple ? undefined : -1}
                  className={nameButtonClasses}
                >
                  {item.name}
                </button>
              ) : (
                item.name
              )}
            </h3>
          </div>
          <Price item={item} className="hidden shrink-0 sm:inline" />
        </div>
        <Price item={item} className="mt-0.5 sm:hidden" />
        {item.description ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted">{item.description}</p>
        ) : null}

        {showRitual && item.pass_eligible === true ? (
          <div className="mt-2">
            <RitualChip />
          </div>
        ) : null}

        {/* Greyed-out items keep full-contrast text; only the photo is dimmed. */}
        {!available ? (
          <p className="mt-2 text-sm font-medium text-muted">{unavailableLabel(item)}</p>
        ) : null}

        {inCart > 0 ? <p className="mt-2 text-sm font-semibold text-tan-dark">{inCart} in cart</p> : null}

        <div className="relative z-10 mt-auto pt-3 sm:pt-4">
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
                onClick={() => {
                  addItem({
                    menuItemId: item.id,
                    variantId: onlyVariant.id,
                    name: item.name,
                    variantLabel: onlyVariant.label,
                    unitPriceInr: onlyVariant.price_inr,
                    gstExempt: item.gst_exempt === true,
                    addons: [],
                    specialInstructions: '',
                  });
                  onAdded?.(item.name);
                }}
                className={buttonVariants({ size: 'sm', fullWidth: true })}
              >
                Add to Cart
              </button>
            ) : (
              <div className="flex items-center justify-between gap-4 rounded-md border border-line bg-cream p-0.5">
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
                  className={stepperButtonClasses + ' bg-tan-dark text-cream hover:bg-tan-darker'}
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
              {byWeight ? 'Choose weight' : <>Customize &amp; Add</>}
            </button>
          )}
        </div>
      </div>

      {customizing && available ? (
        <MenuItemCustomizeModal item={item} onClose={() => setCustomizing(false)} onAdded={onAdded} />
      ) : null}
    </Card>
  );
}
