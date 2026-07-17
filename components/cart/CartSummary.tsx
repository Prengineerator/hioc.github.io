'use client';

import Link from 'next/link';
import { useCart } from '@/lib/cart/CartContext';

export function CartSummary() {
  const { items, totalPrice } = useCart();

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
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex items-center justify-between border-t border-[#e5e5e5] pt-4">
        <span className="font-bold text-charcoal">Subtotal</span>
        <span className="font-bold text-tan">₹{totalPrice}</span>
      </div>
    </div>
  );
}
