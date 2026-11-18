'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CartProvider, useCart } from '@/lib/cart/CartContext';
import { useStoreSettings } from '@/lib/cart/useStoreSettings';
import { CartSummary } from '@/components/cart/CartSummary';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';
import { PairsWellWith } from '@/components/checkout/PairsWellWith';
import { Skeleton } from '@/components/ui/Skeleton';
import { StoreStatusBanner } from '@/components/menu/StoreStatusBanner';
import type { OrderType } from '@/lib/types';

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
  const { settings, openState } = useStoreSettings();
  // Owned here so the form and the page agree on it; dine-in has no packaging (D5).
  const [orderType, setOrderType] = useState<OrderType>('takeaway');

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

  // Until the saved cart has been read, show the shape of the page (summary and
  // form) instead of a blank screen. Once we know the cart is empty we are
  // redirecting away, so render nothing.
  if (!hydrated) return <CheckoutSkeleton />;
  if (items.length === 0) {
    return <div className="mx-auto max-w-6xl px-4 py-10" aria-hidden="true" />;
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="mb-8 text-2xl font-bold text-charcoal md:text-3xl">
        Checkout
      </h1>
      <StoreStatusBanner openState={openState} />
      {/* The form lays itself out: fields on the left, and from lg up the order
          summary, bill and Place Order in a sticky sidebar. */}
      <CheckoutForm
        settings={settings}
        openState={openState}
        orderType={orderType}
        onOrderTypeChange={setOrderType}
        summary={<CartSummary />}
        pairings={<PairsWellWith />}
      />
    </div>
  );
}

function CheckoutSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10" aria-busy="true">
      <h1 className="mb-8 text-2xl font-bold text-charcoal md:text-3xl">Checkout</h1>
      <p role="status" className="sr-only">
        Loading your cart
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-8">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    </div>
  );
}
