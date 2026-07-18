'use client';

import Link from 'next/link';
import { useCart } from '@/lib/cart/CartContext';
import { computeBill } from '@/lib/store/hours';
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
  const { items, totalPrice, increment, decrement, removeItem } = useCart();

  if (!open) return null;

  const isEmpty = items.length === 0;
  const bill = settings ? computeBill(totalPrice, settings) : null;
  const checkoutDisabled = isEmpty || !!checkoutDisabledReason;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close cart"
        onClick={onClose}
        className="absolute inset-0 bg-charcoal/50"
      />
      <div className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col bg-cream shadow-sm">
        <div className="flex items-center justify-between border-b border-[#e5e5e5] px-4 py-4">
          <h2 className="text-lg font-bold text-charcoal">Your Cart</h2>
          <button
            type="button"
            aria-label="Close cart"
            onClick={onClose}
            className="text-2xl leading-none text-charcoal hover:text-tan"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {isEmpty ? (
            <p className="py-8 text-center text-sm text-muted">
              Your cart is empty. Add something delicious from the menu!
            </p>
          ) : (
            <ul className="flex flex-col gap-4">
              {items.map((item) => (
                <li
                  key={item.key}
                  className="flex flex-col gap-2 border-b border-[#e5e5e5] pb-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <span className="font-bold text-charcoal">
                        {item.name}
                      </span>
                      <span className="ml-1 text-sm text-muted">
                        ({item.variantLabel})
                      </span>
                      {item.addons.length > 0 ? (
                        <p className="mt-0.5 text-xs text-muted">
                          {item.addons.map((a) => a.optionName).join(', ')}
                        </p>
                      ) : null}
                      {item.specialInstructions ? (
                        <p className="mt-0.5 text-xs italic text-muted">
                          Note: {item.specialInstructions}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${item.name} from cart`}
                      onClick={() => removeItem(item.key)}
                      className="shrink-0 text-sm text-muted hover:text-charcoal"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 rounded-md border border-[#e5e5e5] px-3 py-1">
                      <button
                        type="button"
                        aria-label="Decrease quantity"
                        onClick={() => decrement(item.key)}
                        className="flex h-5 w-5 items-center justify-center rounded-full bg-charcoal text-xs text-cream"
                      >
                        &minus;
                      </button>
                      <span className="min-w-[1.25rem] text-center text-sm font-bold text-charcoal">
                        {item.qty}
                      </span>
                      <button
                        type="button"
                        aria-label="Increase quantity"
                        onClick={() => increment(item.key)}
                        className="flex h-5 w-5 items-center justify-center rounded-full bg-tan text-xs text-cream"
                      >
                        +
                      </button>
                    </div>
                    <div className="text-right text-sm">
                      <div className="text-muted">₹{item.unitPriceInr} each</div>
                      <div className="font-bold text-charcoal">
                        ₹{item.unitPriceInr * item.qty}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-[#e5e5e5] px-4 py-4">
          <div className="mb-4 flex flex-col gap-1 text-sm text-charcoal">
            <div className="flex items-center justify-between">
              <span>Subtotal</span>
              <span>₹{bill ? bill.subtotal_inr : totalPrice}</span>
            </div>
            {bill && (bill.tax_inr > 0 || bill.packaging_inr > 0) ? (
              <div className="flex items-center justify-between font-bold text-charcoal">
                <span>Total (incl. GST)</span>
                <span className="text-tan">₹{bill.total_inr}</span>
              </div>
            ) : null}
          </div>
          {checkoutDisabledReason ? (
            <p className="mb-3 text-center text-xs font-bold text-charcoal">
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
              'block w-full rounded-md px-4 py-3 text-center font-bold transition-colors ' +
              (checkoutDisabled
                ? 'cursor-not-allowed bg-[#e5e5e5] text-muted'
                : 'bg-tan text-cream hover:bg-tan-dark')
            }
          >
            Proceed to Checkout
          </Link>
        </div>
      </div>
    </div>
  );
}
