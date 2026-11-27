'use client';

// The client half of /suggest — "Ask Coffey", the suggestion wizard (SUG-7,
// COFFEY-SPEC §1). app/suggest/page.tsx (a server component) checks the flag,
// reads the menu once to count flavours, and renders this with the counts.

import { useState } from 'react';
import { CartProvider } from '@/lib/cart/CartContext';
import { useStoreSettings } from '@/lib/cart/useStoreSettings';
import { StoreStatusBanner } from '@/components/menu/StoreStatusBanner';
import { FloatingCartBar } from '@/components/cart/FloatingCartBar';
import { CartDrawer } from '@/components/cart/CartDrawer';
import { SuggestWizard } from '@/components/suggest/SuggestWizard';
import type { MenuFacet } from '@/lib/suggest/facets';
import type { FlavourCounts } from '@/lib/suggest/types';

export function SuggestPageClient({ flavourCounts, facets }: { flavourCounts: FlavourCounts | null; facets: MenuFacet[] | null }) {
  return (
    <CartProvider>
      <SuggestPageContent flavourCounts={flavourCounts} facets={facets} />
    </CartProvider>
  );
}

function SuggestPageContent({ flavourCounts, facets }: { flavourCounts: FlavourCounts | null; facets: MenuFacet[] | null }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { settings, openState } = useStoreSettings();

  const checkoutDisabledReason =
    openState && !openState.acceptingOrders
      ? 'Checkout is unavailable right now. See the notice at the top of the page.'
      : null;

  return (
    <>
      <div className="mx-auto max-w-2xl px-4 pt-6">
        <StoreStatusBanner openState={openState} />
      </div>

      <SuggestWizard flavourCounts={flavourCounts} facets={facets} />
      {/* Room for the floating cart bar so it never covers the last pick. */}
      <div aria-hidden="true" className="h-20" />

      <FloatingCartBar onOpen={() => setDrawerOpen(true)} settings={settings} />
      <CartDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        settings={settings}
        openState={openState}
        checkoutDisabledReason={checkoutDisabledReason}
      />
    </>
  );
}
