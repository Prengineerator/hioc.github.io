'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CartProvider } from '@/lib/cart/CartContext';
import { useStoreSettings } from '@/lib/cart/useStoreSettings';
import { MenuCategoryTabs } from '@/components/menu/MenuCategoryTabs';
import { MenuItemCard } from '@/components/menu/MenuItemCard';
import { StoreStatusBanner } from '@/components/menu/StoreStatusBanner';
import { FloatingCartBar } from '@/components/cart/FloatingCartBar';
import { CartDrawer } from '@/components/cart/CartDrawer';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { MENU_CATEGORIES } from '@/lib/constants';
import { useMenuAvailabilityRealtime } from '@/lib/realtime/hooks';
import type { MenuItem } from '@/lib/types';

const DEFAULT_CATEGORY = MENU_CATEGORIES[0].slug;
const VALID_CATEGORIES = MENU_CATEGORIES.map((c) => c.slug);

function isMenuCategory(value: string | null): value is string {
  return !!value && VALID_CATEGORIES.includes(value);
}

// Mirrors the real MenuItemCard's box dimensions so swapping it in for the
// loaded grid causes no layout shift, and reads as a smoother "filling in"
// than a page-centered spinner replacing the whole grid at once.
function MenuGridSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-md border border-line bg-cream p-4 shadow-card">
          <Skeleton className="mb-3 aspect-[4/3] w-full" />
          <Skeleton className="mb-2 h-4 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ))}
    </div>
  );
}

export default function MenuPage() {
  return (
    <CartProvider>
      <Suspense fallback={<Spinner label="Loading menu…" />}>
        <MenuPageContent />
      </Suspense>
    </CartProvider>
  );
}

function MenuPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const categoryParam = searchParams.get('category');
  const category: string = isMenuCategory(categoryParam)
    ? categoryParam
    : DEFAULT_CATEGORY;

  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { settings, openState } = useStoreSettings();

  useEffect(() => {
    // Default to `coffee` in the URL when no/invalid category is present,
    // without adding a history entry.
    if (!isMenuCategory(categoryParam)) {
      const params = new URLSearchParams(searchParams.toString());
      params.set('category', DEFAULT_CATEGORY);
      router.replace(`/menu?${params.toString()}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryParam]);

  const fetchItems = useCallback(() => {
    let cancelled = false;
    // includeUnavailable=true (C3): 86'd items still render, greyed out and
    // disabled, rather than silently disappearing from the menu.
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

  // Live availability (C3, XC-011): a staff 86/un-86 anywhere refetches the
  // current category so the grey-out state updates in under ~5s.
  useMenuAvailabilityRealtime(fetchItems);

  const handleCategoryChange = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('category', next);
      router.replace(`/menu?${params.toString()}`);
    },
    [router, searchParams],
  );

  const checkoutDisabledReason =
    openState && !openState.acceptingOrders
      ? 'Checkout is unavailable right now — see notice above.'
      : null;

  return (
    <>
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-charcoal md:text-3xl">
            Our Menu
          </h1>
          <p className="mt-2 text-muted">
            Pure vegetarian, always. Ask for oat or soya milk with any
            coffee.
          </p>
          <p className="mt-1 text-sm italic text-muted">
            Pay at the counter when you pick up — no online payment needed.
          </p>
        </div>

        <StoreStatusBanner openState={openState} />

        <MenuCategoryTabs active={category} onChange={handleCategoryChange} />

        <div className="mt-8">
          {loading ? (
            <MenuGridSkeleton />
          ) : items.length === 0 ? (
            <EmptyState
              heading="Nothing here yet"
              body="No items in this category yet"
            />
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((item) => (
                <MenuItemCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
      </div>

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
