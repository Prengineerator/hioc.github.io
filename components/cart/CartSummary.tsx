'use client';

import Link from 'next/link';
import { useCart } from '@/lib/cart/CartContext';
import { computeBill } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

// `settings` is optional so this still renders (subtotal-only) while the
// checkout page's store-settings fetch is in flight (C5).
export function CartSummary({ settings }: { settings?: StoreSettings | null }) {
  const { items, totalPrice } = useCart();
  const bill = settings ? computeBill(totalPrice, settings) : null;

  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold text-charcoal">Your Order</h2>
        <Link href="/menu" className="text-sm font-bold text-tan hover:underline">
          Edit cart
        </Link>
      </div>
      <ul className="flex flex-col gap-3">
        {items.map((item) => {
          const lineTotal = item.unitPriceInr * item.qty;
          return (
            <li key={item.key} className="text-sm text-charcoal">
              <div className="flex items-start justify-between">
                <span>
                  {item.name} ({item.variantLabel}) × {item.qty}
                </span>
                <span className="shrink-0 font-bold">₹{lineTotal}</span>
              </div>
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
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex flex-col gap-1.5 border-t border-[#e5e5e5] pt-4 text-sm text-charcoal">
        <div className="flex items-center justify-between">
          <span>Subtotal</span>
          <span>₹{bill ? bill.subtotal_inr : totalPrice}</span>
        </div>
        {bill ? (
          <>
            {bill.tax_inr > 0 ? (
              <div className="flex items-center justify-between text-muted">
                <span>GST</span>
                <span>₹{bill.tax_inr}</span>
              </div>
            ) : null}
            {bill.packaging_inr > 0 ? (
              <div className="flex items-center justify-between text-muted">
                <span>Packaging</span>
                <span>₹{bill.packaging_inr}</span>
              </div>
            ) : null}
            {bill.discount_inr > 0 ? (
              <div className="flex items-center justify-between text-muted">
                <span>Discount</span>
                <span>&minus;₹{bill.discount_inr}</span>
              </div>
            ) : null}
            <div className="flex items-center justify-between border-t border-[#e5e5e5] pt-1.5 font-bold text-charcoal">
              <span>Total</span>
              <span className="text-tan">₹{bill.total_inr}</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
