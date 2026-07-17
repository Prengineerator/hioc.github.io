'use client';

import { useCart } from '@/lib/cart/CartContext';

export function FloatingCartBar({ onOpen }: { onOpen: () => void }) {
  const { totalItems, totalPrice } = useCart();

  if (totalItems === 0) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full bg-charcoal px-6 py-3 font-bold text-cream shadow-sm transition-transform hover:scale-105 sm:left-auto sm:right-6 sm:translate-x-0"
    >
      View Cart ({totalItems} item{totalItems === 1 ? '' : 's'} · ₹
      {totalPrice})
    </button>
  );
}
