'use client';

import { useCallback, useEffect, useState, useMemo } from 'react';
import { CartProvider, useCart } from '@/lib/cart/CartContext';
import { useStoreSettings } from '@/lib/cart/useStoreSettings';
import { MenuCategoryTabs } from '@/components/menu/MenuCategoryTabs';
import { MenuItemCard } from '@/components/menu/MenuItemCard';
import { StoreStatusBanner } from '@/components/menu/StoreStatusBanner';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { CUSTOMER_MENU_CATEGORIES } from '@/lib/constants';
import { useMenuAvailabilityRealtime } from '@/lib/realtime/hooks';
import type { MenuItem } from '@/lib/types';
import type { ResolvedQrTable } from '@/lib/tables/resolveTableByToken';
import { QrCheckout } from '@/components/qr/QrCheckout';

const DEFAULT_CATEGORY = CUSTOMER_MENU_CATEGORIES[0].slug;

// Mirrors the /menu grid skeleton so the first paint doesn't jump.
function MenuGridSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex gap-3 rounded-md border border-line bg-cream p-4 shadow-card sm:flex-col sm:gap-0">
          <Skeleton className="order-last h-24 w-24 shrink-0 sm:order-none sm:mb-3 sm:aspect-[4/3] sm:h-auto sm:w-full" />
          <div className="flex-1">
            <Skeleton className="mb-2 h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [view, setViewState] = useState<'menu' | 'checkout'>('menu');
  // Both views live on one URL, so switching doesn't reset scroll — without
  // this the checkout opened wherever the menu had been scrolled to (often
  // below its own fold, hiding the table badge and the first fields).
  const setView = useCallback((next: 'menu' | 'checkout') => {
    setViewState(next);
    window.scrollTo({ top: 0 });
  }, []);

  // Categories switched off for now have no tab; never sit on one.
  const hiddenCategories = useMemo(() => settings?.hidden_categories ?? [], [settings]);
  useEffect(() => {
    if (!hiddenCategories.includes(category)) return;
    const firstOn = CUSTOMER_MENU_CATEGORIES.find((c) => !hiddenCategories.includes(c.slug));
    if (firstOn) setCategory(firstOn.slug);
  }, [hiddenCategories, category]);

  const fetchItems = useCallback(() => {
    let cancelled = false;
    // includeUnavailable=true (C3): 86'd items render greyed-out rather than
    // vanishing — same behavior as the web /menu.
    fetch(`/api/menu?category=${encodeURIComponent(category)}&includeUnavailable=true`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { items?: MenuItem[] }) => {
        if (cancelled) return;
        setItems(data.items ?? []);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
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
          <span className="mb-2 inline-flex items-center gap-2 rounded-full bg-tan px-4 py-1.5 text-sm font-semibold text-cream">
            <span aria-hidden>🍽️</span>
            Table {table.label}
          </span>
          <h1 className="text-2xl font-bold text-charcoal md:text-3xl">Order to your table</h1>
          <p className="mt-1 text-sm text-muted">
            Add what you&apos;d like and pay securely from your phone — we&apos;ll bring it over.
          </p>
        </div>

        <StoreStatusBanner openState={openState} />

        {/* Sticky under the site header, same as /menu. */}
        <div className="sticky top-[68px] z-30 -mx-4 border-b border-line bg-cream/95 px-4 pb-2 pt-3 backdrop-blur">
          <MenuCategoryTabs active={category} onChange={setCategory} hidden={hiddenCategories} />
        </div>

        <div className="mt-6">
          {loading ? (
            <MenuGridSkeleton />
          ) : loadFailed ? (
            <EmptyState
              icon="⚠️"
              heading="Couldn't load the menu"
              body="Check your connection and try again."
              action={
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    fetchItems();
                  }}
                  className="inline-flex min-h-[44px] items-center rounded-md bg-tan px-4 text-sm font-semibold text-cream hover:bg-tan-dark"
                >
                  Try again
                </button>
              }
            />
          ) : items.length === 0 ? (
            <EmptyState heading="Nothing here yet" body="No items in this category yet" />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6">
              {items.map((item) => (
                <MenuItemCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Review-order bar → the QR checkout view (stays on /t/<token>, keeping
          the table context; never navigates to the web /checkout flow). */}
      {/* Same shape as FloatingCartBar: full-width and safe-area aware on a
          phone (which is every QR scan), a floating pill from sm up. */}
      {totalItems > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:bottom-6 sm:left-1/2 sm:-translate-x-1/2 sm:p-0">
          <button
            type="button"
            onClick={() => setView('checkout')}
            className="pointer-events-auto flex min-h-[52px] w-full animate-scale-in items-center justify-between gap-4 rounded-full bg-charcoal px-5 py-3 font-semibold text-cream shadow-elevated transition-transform hover:scale-[1.02] sm:w-auto"
          >
            <span>
              {totalItems} item{totalItems === 1 ? '' : 's'} ·{' '}
              <span className="font-mono tabular-nums">₹{totalPrice}</span>
            </span>
            <span className="flex items-center gap-1">
              Review order <span aria-hidden="true">→</span>
            </span>
          </button>
        </div>
      ) : null}
    </>
  );
}
