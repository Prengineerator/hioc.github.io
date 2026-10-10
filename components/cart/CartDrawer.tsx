'use client';

import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { cartTaxableSubtotal, useCart } from '@/lib/cart/CartContext';
import { useDialogBehavior } from '@/components/ui/useDialogBehavior';
import { computeBill } from '@/lib/store/hours';
import { lineSizeLabel } from '@/lib/menu/weight';
import type { StoreSettings } from '@/lib/types';

export function CartDrawer({
  open,
  onClose,
  settings = null,
  checkoutDisabledReason = null,
}: {
  open: boolean;
  onClose: () => void;
  // Both optional (C5/C3): the drawer still works standalone while settings
  // are loading, or if the caller doesn't wire the closed-store gate.
  settings?: StoreSettings | null;
  checkoutDisabledReason?: string | null;
}) {
  const { items, totalPrice, totalItems, increment, decrement, removeItem } = useCart();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Same Escape / scroll-lock / focus-trap / focus-restore behaviour as every
  // Modal — the drawer used to be a bare overlay a keyboard or screen-reader
  // user could tab straight out of, with the menu still scrolling behind it.
  useDialogBehavior(open, onClose, panelRef);

  if (!open || typeof document === 'undefined') return null;

  const isEmpty = items.length === 0;
  // Items + GST only: packaging depends on Takeaway vs Dine-in (D5), which is
  // chosen at checkout, so it is added there.
  const bill = settings
    ? computeBill(totalPrice, { ...settings, packaging_charge_inr: 0 }, 0, cartTaxableSubtotal(items))
    : null;
  const packagingAtCheckout = (settings?.packaging_charge_inr ?? 0) > 0;
  const checkoutDisabled = isEmpty || !!checkoutDisabledReason;

  // Portalled for the same reason as Modal: a transformed ancestor would
  // otherwise become the fixed overlay's containing block.
  return createPortal(
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close cart"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 animate-fade-in bg-charcoal/50"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col bg-cream shadow-elevated outline-none"
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id={titleId} className="text-lg font-semibold text-charcoal">
            Your Cart
            {totalItems > 0 ? (
              <span className="ml-2 text-sm font-normal text-muted">
                {totalItems} item{totalItems === 1 ? '' : 's'}
              </span>
            ) : null}
          </h2>
          <button
            type="button"
            aria-label="Close cart"
            data-dialog-close
            onClick={onClose}
            className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-2xl leading-none text-charcoal transition-colors hover:bg-surface hover:text-tan-dark"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {isEmpty ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span aria-hidden="true" className="text-3xl">
                ☕
              </span>
              <p className="text-sm text-muted">Your cart is empty. Add something delicious from the menu!</p>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-[44px] items-center rounded-md border border-line px-4 text-sm font-semibold text-charcoal transition-colors hover:border-tan"
              >
                Browse the menu
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-4">
              {items.map((item) => (
                <li
                  key={item.key}
                  className="flex flex-col gap-2 border-b border-line pb-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="font-semibold text-charcoal">
                        {item.name}
                      </span>
                      <span className="ml-1 text-sm text-muted">
                        ({lineSizeLabel(item.variantLabel, item.weightGrams)})
                      </span>
                      {item.addons.length > 0 ? (
                        <p className="mt-0.5 text-sm text-muted">
                          {item.addons.map((a) => a.optionName).join(', ')}
                        </p>
                      ) : null}
                      {item.specialInstructions ? (
                        <p className="mt-0.5 text-sm italic text-muted">
                          Note: {item.specialInstructions}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${item.name} from cart`}
                      onClick={() => removeItem(item.key)}
                      className="-mr-2 -mt-2 inline-flex min-h-[44px] shrink-0 items-center px-2 text-sm text-muted underline-offset-2 hover:text-charcoal hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    {/* 36px steppers inside a 44px-tall pill — the old 20px dots
                        were the smallest tap targets on the whole customer site. */}
                    <div className="flex items-center gap-2 rounded-full border border-line p-1">
                      <button
                        type="button"
                        aria-label={item.qty === 1 ? `Remove ${item.name}` : `Decrease ${item.name} quantity`}
                        onClick={() => decrement(item.key)}
                        className="flex h-9 w-9 items-center justify-center rounded-full bg-charcoal text-base text-cream transition-opacity hover:opacity-90"
                      >
                        &minus;
                      </button>
                      <span
                        aria-live="polite"
                        className="min-w-[1.5rem] text-center font-mono font-semibold tabular-nums text-charcoal"
                      >
                        {item.qty}
                      </span>
                      <button
                        type="button"
                        aria-label={`Increase ${item.name} quantity`}
                        onClick={() => increment(item.key)}
                        className="flex h-9 w-9 items-center justify-center rounded-full bg-tan-dark text-base text-cream transition-colors hover:bg-tan-darker"
                      >
                        +
                      </button>
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-mono tabular-nums text-muted">₹{item.unitPriceInr} each</div>
                      <div className="font-mono font-bold tabular-nums text-charcoal">
                        ₹{item.unitPriceInr * item.qty}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-line px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
          <div className="mb-4 flex flex-col gap-1 text-sm text-charcoal">
            <div className="flex items-center justify-between">
              <span>Subtotal</span>
              <span className="font-mono tabular-nums">₹{bill ? bill.subtotal_inr : totalPrice}</span>
            </div>
            {bill && bill.tax_inr > 0 ? (
              <div className="flex items-center justify-between font-bold text-charcoal">
                <span>Total (incl. GST)</span>
                <span className="font-mono tabular-nums text-tan-dark">₹{bill.total_inr}</span>
              </div>
            ) : null}
            {!isEmpty && packagingAtCheckout ? (
              <p className="text-xs text-muted">Takeaway packaging is added at checkout.</p>
            ) : null}
          </div>
          {checkoutDisabledReason ? (
            <p className="mb-3 text-center text-sm font-semibold text-charcoal">
              {checkoutDisabledReason}
            </p>
          ) : null}
          <Link
            href="/checkout"
            aria-disabled={checkoutDisabled ? 'true' : undefined}
            title={
              isEmpty
                ? 'Add items to your cart to checkout'
                : checkoutDisabledReason ?? undefined
            }
            onClick={(e) => {
              if (checkoutDisabled) e.preventDefault();
            }}
            className={
              'block w-full rounded-md px-4 py-3 text-center font-semibold transition-colors ' +
              (checkoutDisabled
                ? 'cursor-not-allowed bg-line text-muted'
                : 'bg-tan-dark text-cream hover:bg-tan-darker')
            }
          >
            Proceed to Checkout
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}
