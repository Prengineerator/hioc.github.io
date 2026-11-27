'use client';

// The bar fixed to the bottom of /shop (docs/SHOP-V2-SPEC.md E8). On every
// step it shows the item count (a button: it opens the cart drawer), the total
// (aria-live, so a change is announced) and the page's ONE primary action:
// Continue, Continue to pay, then Pay ₹X. Safe-area padding keeps it clear of
// the phone's home indicator. The total is the server's quote when it has
// arrived, the local figure before that.

import { Button } from '@/components/ui/Button';
import { primaryActionLabel, type ShopStep } from '@/lib/shop/checkoutFlow';
import { rupees, unitsLabel } from '@/lib/shop/pricing';

export function StickyCheckoutBar({
  step,
  itemCount,
  totalInr,
  refreshing,
  busy,
  disabled,
  onOpenCart,
  onPrimary,
}: {
  step: ShopStep;
  itemCount: number;
  totalInr: number | null;
  /** The server is still working out the total. */
  refreshing: boolean;
  /** The Pay request is in flight. */
  busy: boolean;
  disabled: boolean;
  onOpenCart: () => void;
  onPrimary: () => void;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-cream shadow-elevated pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onOpenCart}
          aria-label={itemCount > 0 ? `${unitsLabel(itemCount)} in your order. View your order` : 'Your order is empty'}
          className="flex min-h-[44px] min-w-0 flex-1 flex-col items-start justify-center rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
        >
          <span className="text-sm font-semibold text-charcoal underline decoration-tan underline-offset-4">
            {itemCount > 0 ? unitsLabel(itemCount) : 'Nothing added yet'}
          </span>
          <span className="text-base font-bold text-charcoal" aria-live="polite" aria-atomic="true">
            <span className="sr-only">Total </span>
            {totalInr !== null && itemCount > 0 ? (
              <span className="font-mono tabular-nums">{rupees(totalInr)}</span>
            ) : (
              <span className="font-mono">—</span>
            )}
            {refreshing && itemCount > 0 ? <span className="sr-only"> (updating)</span> : null}
          </span>
        </button>
        <Button size="lg" className="shrink-0 !px-6" loading={busy} disabled={disabled} onClick={onPrimary}>
          {primaryActionLabel(step, totalInr)}
        </Button>
      </div>
    </div>
  );
}
