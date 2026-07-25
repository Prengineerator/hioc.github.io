'use client';

import { useCallback, useEffect, useState } from 'react';
import { CartProvider, useCart } from '@/lib/cart/CartContext';
import { useStoreSettings } from '@/lib/cart/useStoreSettings';
import { MenuCategoryTabs } from '@/components/menu/MenuCategoryTabs';
import { MenuItemCard } from '@/components/menu/MenuItemCard';
import { StoreStatusBanner } from '@/components/menu/StoreStatusBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { MENU_CATEGORIES } from '@/lib/constants';
import { useMenuAvailabilityRealtime } from '@/lib/realtime/hooks';
import type { MenuItem } from '@/lib/types';
import type { ResolvedQrTable } from '@/lib/tables/resolveTableByToken';
import { QrCheckout } from '@/components/qr/QrCheckout';

const DEFAULT_CATEGORY = MENU_CATEGORIES[0].slug;

// Mirrors the /menu grid skeleton so the first paint doesn't jump.
function MenuGridSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-md border border-line bg-cream p-4 shadow-card">
          <Skeleton className="mb-3 aspect-[4/3] w-full" />
          <Skeleton className="mb-2 h-4 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * QR scan-to-order experience (QR-1). Wraps the shared cart + menu components
 * in DINE-IN context for one physical table: a visible table badge, no
 * pickup-slot picker, packaging shown as ₹0 (the create/quote paths force it),
 * and a checkout that pays online first (D6). Reuses MenuItemCard / the cart /
 * the quote endpoint — pricing is never forked here.
 */
export function TableQrOrder({ token, table }: { token: string; table: ResolvedQrTable }) {
  return (
    <CartProvider>
      <TableQrOrderContent token={token} table={table} />
    </CartProvider>
  );
}

function TableQrOrderContent({ token, table }: { token: string; table: ResolvedQrTable }) {
  const { settings, openState } = useStoreSettings();
  const { totalItems, totalPrice } = useCart();

  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'menu' | 'checkout'>('menu');

  const fetchItems = useCallback(() => {
    let cancelled = false;
    // includeUnavailable=true (C3): 86'd items render greyed-out rather than
    // vanishing — same behavior as the web /menu.
    fetch(`/api/menu?category=${encodeURIComponent(category)}&includeUnavailable=true`)
      .then((res) => res.json())
      .then((data: { items?: MenuItem[] }) => {
        if (cancelled) return;
        setItems(data.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [category]);

  useEffect(() => {
    setLoading(true);
    return fetchItems();
  }, [fetchItems]);

  // Live availability (C3): a staff 86/un-86 refetches the current category.
  useMenuAvailabilityRealtime(fetchItems);

  if (view === 'checkout') {
    return (
      <QrCheckout
        token={token}
        table={table}
        settings={settings}
        openState={openState}
        onBackToMenu={() => setView('menu')}
      />
    );
  }

  return (
    <>
      <div className="mx-auto max-w-3xl px-4 py-8 pb-28">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-2 inline-flex items-center gap-2 rounded-full bg-tan px-4 py-1.5 text-sm font-bold text-cream">
            <span aria-hidden>🍽️</span>
            Table {table.label}
          </span>
          <h1 className="text-2xl font-bold text-charcoal md:text-3xl">Order to your table</h1>
          <p className="mt-1 text-sm text-muted">
            Add what you&apos;d like and pay securely from your phone — we&apos;ll bring it over.
          </p>
        </div>

        <StoreStatusBanner openState={openState} />

        <MenuCategoryTabs active={category} onChange={setCategory} />

        <div className="mt-6">
          {loading ? (
            <MenuGridSkeleton />
          ) : items.length === 0 ? (
            <EmptyState heading="Nothing here yet" body="No items in this category yet" />
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {items.map((item) => (
                <MenuItemCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Review-order bar → the QR checkout view (stays on /t/<token>, keeping
          the table context; never navigates to the web /checkout flow). */}
      {totalItems > 0 ? (
        <button
          type="button"
          onClick={() => setView('checkout')}
          className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full bg-charcoal px-6 py-3 font-bold text-cream shadow-sm transition-transform hover:scale-105"
        >
          Review order ({totalItems} item{totalItems === 1 ? '' : 's'} · ₹{totalPrice})
        </button>
      ) : null}
    </>
  );
}
