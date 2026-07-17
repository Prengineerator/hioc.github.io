'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { CartProvider, useCart } from '@/lib/cart/CartContext';
import { CartSummary } from '@/components/cart/CartSummary';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';

export default function CheckoutPage() {
  return (
    <CartProvider>
      <CheckoutPageContent />
    </CartProvider>
  );
}

function CheckoutPageContent() {
  const router = useRouter();
  const { items, hydrated } = useCart();

  // Deliberately only depends on `hydrated`, not `items.length`: this guard
  // exists to bounce someone who *lands* on /checkout with nothing in their
  // cart. It must NOT re-fire when a successful order clears the cart via
  // clearCart() right before navigating to the confirmation page — that
  // would race the confirmation redirect and send the user back to /menu
  // instead of showing their just-placed order.
  useEffect(() => {
    if (hydrated && items.length === 0) {
      router.replace('/menu');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // Avoid a flash of the form before we know whether the cart is empty, and
  // avoid rendering it at all once we've decided to redirect away.
  if (!hydrated || items.length === 0) {
    return <div className="mx-auto max-w-6xl px-4 py-10" aria-hidden="true" />;
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="mb-8 text-2xl font-bold text-charcoal md:text-3xl">
        Checkout
      </h1>
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <CartSummary />
        <CheckoutForm />
      </div>
    </div>
  );
}
