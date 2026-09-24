'use client';

// /suggest — the "Help me choose" wizard (SUG-7). Flag-gated: when
// flags.suggest is off this renders only the coming-soon state below and
// makes no API calls at all.

import { useState } from 'react';
import { CartProvider } from '@/lib/cart/CartContext';
import { useStoreSettings } from '@/lib/cart/useStoreSettings';
import { StoreStatusBanner } from '@/components/menu/StoreStatusBanner';
import { FloatingCartBar } from '@/components/cart/FloatingCartBar';
import { CartDrawer } from '@/components/cart/CartDrawer';
import { SuggestWizard } from '@/components/suggest/SuggestWizard';
import { SuggestComingSoon } from '@/components/suggest/ComingSoon';
import { flags } from '@/lib/flags';

export default function SuggestPage() {
  if (!flags.suggest) {
    return <SuggestComingSoon />;
  }
  return (
    <CartProvider>
      <SuggestPageContent />
    </CartProvider>
  );
}

function SuggestPageContent() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { settings, openState } = useStoreSettings();

  const checkoutDisabledReason =
    openState && !openState.acceptingOrders
      ? 'Checkout is unavailable right now — see notice above.'
      : null;

  return (
    <>
      <div className="mx-auto max-w-2xl px-4 pt-6">
        <StoreStatusBanner openState={openState} />
      </div>

      <SuggestWizard />

      <FloatingCartBar onOpen={() => setDrawerOpen(true)} />
      <CartDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        settings={settings}
        checkoutDisabledReason={checkoutDisabledReason}
      />
    </>
  );
}
