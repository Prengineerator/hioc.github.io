'use client';

import { cartTaxableSubtotal, useCart } from '@/lib/cart/CartContext';
import { computeBill } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

// Phone: a full-width bar pinned to the bottom (thumb reach, clear of the
// iPhone home indicator via the safe-area inset) that reads like every food
// app's "3 items, ₹450, View cart". sm and up: the original floating pill in
// the bottom-right corner.
//
// Height contract with the matching body padding in globals.css
// (keyed on [data-floating-cart-bar]): the button is 56px tall plus the
// wrapper's bottom padding of max(1rem, safe-area inset), i.e. 4.5rem plus any
// inset above 1rem. The data attribute sits on the fixed root so the page can
// reserve exactly that space and the footer's last lines are never covered.
//
// The amount is what checkout will show by default (takeaway): items + GST +
// packaging. Dine-in drops the packaging at checkout. Until `settings` loads it
// is the items' price alone.
export function FloatingCartBar({
  onOpen,
  settings = null,
}: {
  onOpen: () => void;
  settings?: StoreSettings | null;
}) {
  const { items, totalItems, totalPrice } = useCart();

  if (totalItems === 0) return null;

  const bill = settings ? computeBill(totalPrice, settings, 0, cartTaxableSubtotal(items)) : null;
  const includes = bill
    ? [bill.tax_inr > 0 ? 'GST' : null, bill.packaging_inr > 0 ? 'packaging' : null].filter(Boolean)
    : [];

  return (
    <div
      data-floating-cart-bar
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:bottom-6 sm:right-6 sm:p-0"
    >
      <button
        type="button"
        onClick={onOpen}
        // The light ring keeps the charcoal bar distinct over the charcoal footer.
        className="pointer-events-auto flex min-h-[56px] w-full animate-scale-in items-center justify-between gap-4 rounded-full bg-charcoal px-5 py-2 text-left font-semibold text-cream shadow-elevated ring-1 ring-cream/30 transition-transform hover:scale-[1.02] sm:w-auto"
      >
        <span className="flex flex-col leading-tight">
          <span className="flex items-baseline gap-2">
            <span>
              {totalItems} item{totalItems === 1 ? '' : 's'}
            </span>
            {/* No figure until the store settings arrive: the bare items total
                would read as the total and then jump when GST and packaging land. */}
            {bill ? <span className="font-mono tabular-nums">₹{bill.total_inr}</span> : null}
          </span>
          {includes.length > 0 ? (
            <span className="text-xs font-normal text-cream/80">incl. {includes.join(' and ')}</span>
          ) : null}
        </span>
        <span>View cart</span>
      </button>
    </div>
  );
}
