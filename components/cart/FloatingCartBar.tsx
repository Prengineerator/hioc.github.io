'use client';

import { useCart } from '@/lib/cart/CartContext';

// Phone: a full-width bar pinned to the bottom (thumb reach, clear of the
// iPhone home indicator via the safe-area inset) that reads like every food
// app's "3 items · ₹450 — View cart". sm and up: the original floating pill
// in the bottom-right corner. Pages that show it leave ~5rem of bottom space
// so it never covers the last menu item.
export function FloatingCartBar({ onOpen }: { onOpen: () => void }) {
  const { totalItems, totalPrice } = useCart();

  if (totalItems === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:bottom-6 sm:right-6 sm:p-0">
      <button
        type="button"
        onClick={onOpen}
        className="pointer-events-auto flex min-h-[52px] w-full animate-scale-in items-center justify-between gap-4 rounded-full bg-charcoal px-5 py-3 font-semibold text-cream shadow-elevated transition-transform hover:scale-[1.02] sm:w-auto"
      >
        <span>
          {totalItems} item{totalItems === 1 ? '' : 's'} ·{' '}
          <span className="font-mono tabular-nums">₹{totalPrice}</span>
        </span>
        <span className="flex items-center gap-1">
          View cart <span aria-hidden="true">→</span>
        </span>
      </button>
    </div>
  );
}
