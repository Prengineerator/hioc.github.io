'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CartProvider } from '@/lib/cart/CartContext';
import { MenuCategoryTabs } from '@/components/menu/MenuCategoryTabs';
import { MenuItemCard } from '@/components/menu/MenuItemCard';
import { FloatingCartBar } from '@/components/cart/FloatingCartBar';
import { CartDrawer } from '@/components/cart/CartDrawer';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { MENU_CATEGORIES } from '@/lib/constants';
import type { MenuItem } from '@/lib/types';

const DEFAULT_CATEGORY = MENU_CATEGORIES[0].slug;
const VALID_CATEGORIES = MENU_CATEGORIES.map((c) => c.slug);

function isMenuCategory(value: string | null): value is string {
  return !!value && VALID_CATEGORIES.includes(value);
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/menu?category=${encodeURIComponent(category)}`)
      .then((res) => res.json())
      .then((data: { items?: MenuItem[] }) => {
        if (cancelled) return;
        setItems((data.items ?? []).filter((i) => i.is_available));
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

  const handleCategoryChange = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('category', next);
      router.replace(`/menu?${params.toString()}`);
    },
    [router, searchParams],
  );

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

        <MenuCategoryTabs active={category} onChange={handleCategoryChange} />

        <div className="mt-8">
          {loading ? (
            <Spinner label="Loading menu…" />
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
      <CartDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  );
}
