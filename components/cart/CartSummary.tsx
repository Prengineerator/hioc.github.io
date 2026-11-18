'use client';

import Link from 'next/link';
import { useCart } from '@/lib/cart/CartContext';
import { lineSizeLabel } from '@/lib/menu/weight';

// The order's lines only. The money (subtotal, GST, packaging, discounts and the
// total) is printed once, in the checkout form's bill block, because only that
// one is priced by the server quote with the coupon, Beanies and Ritual cups
// applied. This card used to compute its own bill with no discount, so after an
// offer it showed a different total from the bill below it.
export function CartSummary() {
  const { items } = useCart();

  return (
    <div className="rounded-md border border-line bg-cream p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-charcoal">Your order</h2>
        <Link
          href="/menu"
          className="-my-2 inline-flex min-h-[44px] items-center text-sm font-semibold text-tan-dark hover:underline"
        >
          Edit cart
        </Link>
      </div>
      <ul className="flex flex-col gap-3">
        {items.map((item) => {
          const lineTotal = item.unitPriceInr * item.qty;
          return (
            <li key={item.key} className="text-sm text-charcoal">
              <div className="flex items-start justify-between gap-3">
                <span>
                  {item.name} ({lineSizeLabel(item.variantLabel, item.weightGrams)}) × {item.qty}
                </span>
                <span className="shrink-0 font-mono font-bold tabular-nums">₹{lineTotal}</span>
              </div>
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
