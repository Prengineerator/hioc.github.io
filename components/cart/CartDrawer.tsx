'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { cartTaxableSubtotal, useCart } from '@/lib/cart/CartContext';
import { computeBill } from '@/lib/store/hours';
import type { StoreOpenState } from '@/lib/store/hours';
import { createClient } from '@/lib/supabase';
import { useDialogBehavior } from '@/components/ui/useDialogBehavior';
import { lineSizeLabel } from '@/lib/menu/weight';
import type { StoreSettings } from '@/lib/types';

// Same switch the checkout uses: without a public Razorpay key a guest cannot pay.
const ONLINE_PAYMENT_AVAILABLE = Boolean(process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID);

export function CartDrawer({
  open,
  onClose,
  settings = null,
  openState = null,
  checkoutDisabledReason = null,
}: {
  open: boolean;
  onClose: () => void;
  // Both optional (C5/C3): the drawer still works standalone while settings
  // are loading, or if the caller doesn't wire the closed-store gate.
  settings?: StoreSettings | null;
  // Optional: when a caller doesn't pass it, the drawer reads it from the same
  // /api/store-settings the checkout uses, so a closed store can say when it opens.
  openState?: StoreOpenState | null;
  // Only whether it is set matters here; the drawer words the closed state itself.
  checkoutDisabledReason?: string | null;
}) {
  const { items, totalPrice, totalItems, increment, decrement, removeItem } = useCart();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Same Escape / scroll-lock / focus-trap / focus-restore behaviour as every
  // Modal — the drawer used to be a bare overlay a keyboard or screen-reader
  // user could tab straight out of, with the menu still scrolling behind it.
  useDialogBehavior(open, onClose, panelRef);

  // Store settings and the open state: from the caller when it has them,
  // otherwise fetched once the drawer opens (the same client-side read the
  // checkout does). Until they load the drawer shows the items' price alone.
  const [fetched, setFetched] = useState<{ settings: StoreSettings | null; openState: StoreOpenState | null } | null>(null);
  const needsFetch = !settings || (!!checkoutDisabledReason && !openState);
  useEffect(() => {
    if (!open || !needsFetch || fetched) return;
    let cancelled = false;
    fetch('/api/store-settings')
      .then((res) => res.json())
      .then((data: { settings?: StoreSettings | null; openState?: StoreOpenState | null }) => {
        if (!cancelled) setFetched({ settings: data.settings ?? null, openState: data.openState ?? null });
      })
      .catch(() => {
        // Keep the current figure; the checkout re-prices everything anyway.
      });
    return () => {
      cancelled = true;
    };
  }, [open, needsFetch, fetched]);

  // Guests pay online; say so before checkout. null until the session answers.
  const [isGuest, setIsGuest] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open || isGuest !== null) return;
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!cancelled) setIsGuest(!data.user);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, isGuest]);

  if (!open || typeof document === 'undefined') return null;

  const isEmpty = items.length === 0;
  const storeSettings = settings ?? fetched?.settings ?? null;
  const storeOpenState = openState ?? fetched?.openState ?? null;
  // The total checkout shows by default (takeaway, packaging included), so the
  // figure doesn't jump at the last step. Dine-in drops the packaging there.
  const bill = storeSettings
    ? computeBill(totalPrice, storeSettings, 0, cartTaxableSubtotal(items))
    : null;
  const closed = !!checkoutDisabledReason;
  const checkoutDisabled = isEmpty || closed;
  const includes = bill
    ? [bill.tax_inr > 0 ? 'GST' : null, bill.packaging_inr > 0 ? 'packaging' : null].filter(Boolean)
    : [];

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
            Your cart
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
              <p className="text-sm text-muted">Your cart is empty. Add something from the menu.</p>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-[44px] items-center rounded-md border border-muted/80 px-4 text-sm font-semibold text-charcoal transition-colors hover:border-tan"
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
                    {/* 44px steppers (WCAG 2.5.8), named for the item they change. */}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Remove one ${item.name}`}
                        onClick={() => decrement(item.key)}
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-charcoal text-lg text-cream transition-opacity hover:opacity-90"
                      >
                        <span aria-hidden="true">&minus;</span>
                      </button>
                      <span
                        aria-live="polite"
                        className="min-w-[2rem] text-center font-semibold tabular-nums text-charcoal"
                      >
                        {item.qty}
                      </span>
                      <button
                        type="button"
                        aria-label={`Add one ${item.name}`}
                        onClick={() => increment(item.key)}
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-tan-dark text-lg text-cream transition-colors hover:bg-tan-darker"
                      >
                        <span aria-hidden="true">+</span>
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
              <div className="flex items-center justify-between text-muted">
                <span>GST</span>
                <span className="font-mono tabular-nums">₹{bill.tax_inr}</span>
              </div>
            ) : null}
            {bill && bill.packaging_inr > 0 ? (
              <div className="flex items-center justify-between text-muted">
                <span>Packaging</span>
                <span className="font-mono tabular-nums">₹{bill.packaging_inr}</span>
              </div>
            ) : null}
            {bill && includes.length > 0 ? (
              <div className="mt-1 flex items-center justify-between border-t border-line pt-2 font-bold text-charcoal">
                <span>Total, incl. {includes.join(' and ')}</span>
                <span className="font-mono tabular-nums text-tan-dark">₹{bill.total_inr}</span>
              </div>
            ) : null}
            {!isEmpty && bill && bill.packaging_inr > 0 ? (
              <p className="text-xs text-muted">Dine-in orders have no packaging charge.</p>
            ) : null}
          </div>
          {closed ? (
            // In place, not a pointer to a notice the open drawer covers.
            <p role="status" className="mb-3 text-center text-sm font-semibold text-charcoal">
              We&apos;re not taking orders right now.
              {storeOpenState?.nextOpenLabel ? ` We open ${storeOpenState.nextOpenLabel}.` : ''}
            </p>
          ) : null}
          {!isEmpty && !closed && isGuest ? (
            <p className="mb-3 text-center text-sm text-charcoal">
              {ONLINE_PAYMENT_AVAILABLE ? (
                'Guests pay online. '
              ) : (
                <>Online payment isn&apos;t available right now. </>
              )}
              <Link href="/login?next=/checkout" className="font-semibold text-tan-dark underline">
                Sign in
              </Link>{' '}
              {ONLINE_PAYMENT_AVAILABLE ? 'to pay at the counter.' : 'to order and pay at the counter.'}
            </p>
          ) : null}
          <Link
            href="/checkout"
            aria-disabled={checkoutDisabled ? 'true' : undefined}
            title={
              isEmpty
                ? 'Add items to your cart to checkout'
                : closed
                  ? 'The cafe is not taking orders right now'
                  : undefined
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
            Proceed to checkout
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  );
}
