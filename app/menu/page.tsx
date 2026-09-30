'use client';

import { Suspense, useCallback, useEffect, useRef, useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CartProvider } from '@/lib/cart/CartContext';
import { useStoreSettings } from '@/lib/cart/useStoreSettings';
import { MenuCategoryTabs } from '@/components/menu/MenuCategoryTabs';
import { MenuItemCard } from '@/components/menu/MenuItemCard';
import { StoreStatusBanner } from '@/components/menu/StoreStatusBanner';
import { FloatingCartBar } from '@/components/cart/FloatingCartBar';
import { CartDrawer } from '@/components/cart/CartDrawer';
import { OrderAgainStrip } from '@/components/account/OrderAgainStrip';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { CUSTOMER_MENU_CATEGORIES } from '@/lib/constants';
import { useMenuAvailabilityRealtime } from '@/lib/realtime/hooks';
import { flags } from '@/lib/flags';
import { CoffeyMascot } from '@/components/coffey/CoffeyMascot';
import { useRitualOffer } from '@/components/passes/useRitualOffer';
import { ritualOnSale } from '@/lib/passes/ui';
import type { MenuItem } from '@/lib/types';

const DEFAULT_CATEGORY = CUSTOMER_MENU_CATEGORIES[0].slug;
const VALID_CATEGORIES = CUSTOMER_MENU_CATEGORIES.map((c) => c.slug);

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
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3"
    >
      {Array.from({ length: 6 }).map((_, i) => (
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

  // HIOC Ritual: the "Ritual" chip on eligible drinks shows only while a plan is
  // on sale. One shared read of the public plans (nothing per item), and none at
  // all while the feature is off.
  const showRitual = ritualOnSale(useRitualOffer().offer);

  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // Menu search (CUS-004). The category endpoint only returns one category,
  // so the first keystroke lazily fetches the whole customer menu once (the
  // same public GET /api/menu, just without ?category=) and filters it on the
  // client — the full menu is a few dozen items, so this is cheaper than a
  // request per keystroke and needs no API change.
  const [query, setQuery] = useState('');
  const [allItems, setAllItems] = useState<MenuItem[] | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const searching = query.trim().length > 0;
  const fetchAllItems = useCallback(() => {
    setAllLoading(true);
    return fetch('/api/menu?includeUnavailable=true')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { items?: MenuItem[] }) => setAllItems(data.items ?? []))
      .catch(() => setAllItems(null))
      .finally(() => setAllLoading(false));
  }, []);
  useEffect(() => {
    if (searching && allItems === null && !allLoading) fetchAllItems();
  }, [searching, allItems, allLoading, fetchAllItems]);
  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !allItems) return [];
    return allItems.filter(
      (item) =>
        item.name.toLowerCase().includes(q) || (item.description ?? '').toLowerCase().includes(q),
    );
  }, [query, allItems]);
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
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { items?: MenuItem[] }) => {
        if (cancelled) return;
        setItems(data.items ?? []);
        setLoadFailed(false);
      })
      .catch(() => {
        // A failed load is not an empty category — say so and offer a retry
        // instead of the misleading "Nothing here yet".
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

  // Live availability (C3, XC-011): a staff 86/un-86 anywhere refetches the
  // current category so the grey-out state updates in under ~5s.
  // The search index goes stale the same way, so refresh it too once loaded.
  const refreshAll = useCallback(() => {
    fetchItems();
    if (allItems !== null) fetchAllItems();
  }, [fetchItems, fetchAllItems, allItems]);
  useMenuAvailabilityRealtime(refreshAll);

  // A category switched off for now (POS → Menu → On / off) has no tab; if the
  // URL points at one, move to the first category that is on.
  const hiddenCategories = useMemo(() => settings?.hidden_categories ?? [], [settings]);
  useEffect(() => {
    if (!hiddenCategories.includes(category)) return;
    const firstOn = CUSTOMER_MENU_CATEGORIES.find((c) => !hiddenCategories.includes(c.slug));
    if (!firstOn) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('category', firstOn.slug);
    router.replace(`/menu?${params.toString()}`);
  }, [hiddenCategories, category, router, searchParams]);

  const handleCategoryChange = useCallback(
    (next: string) => {
      setQuery('');
      const params = new URLSearchParams(searchParams.toString());
      params.set('category', next);
      router.replace(`/menu?${params.toString()}`, { scroll: false });
      // The tab strip is sticky, so a tab can be tapped from deep in a long
      // category — bring the new category's first items into view instead of
      // leaving the customer mid-page in a list they didn't pick.
      const grid = gridRef.current;
      if (grid && grid.getBoundingClientRect().top < 0) {
        grid.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
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
            {process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID
              ? 'Pay online, or at the counter when you pick up.'
              : 'Pay at the counter when you pick up — no online payment needed.'}
          </p>
        </div>

        <StoreStatusBanner openState={openState} />

        <OrderAgainStrip onAdded={() => setDrawerOpen(true)} />

        {flags.suggest ? (
          <Link
            href="/suggest"
            className="mb-6 flex items-center justify-center gap-2 rounded-md border border-tan bg-surface px-4 py-3 text-center text-sm font-semibold text-charcoal transition-colors hover:bg-[#f0e6da]"
          >
            <CoffeyMascot size={24} />
            Can&apos;t decide? Ask Coffey <span aria-hidden="true">→</span>
          </Link>
        ) : null}

        {/* Sticky just under the site header (44px tap-target row + py-3 +
            border ≈ 69px; 68 so there is never a hairline gap) so search and
            category switching stay one tap away while scrolling a long list. */}
        <div className="sticky top-[68px] z-30 -mx-4 border-b border-line bg-cream/95 px-4 pb-2 pt-3 backdrop-blur">
          <div className="relative mb-3">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search coffee, shakes, snacks…"
              aria-label="Search the menu"
              enterKeyHint="search"
              autoComplete="off"
              className="h-11 w-full rounded-full border border-line bg-cream pl-10 pr-11 text-base text-charcoal outline-none transition-colors placeholder:text-muted focus:border-tan"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-full text-xl leading-none text-muted hover:text-charcoal"
              >
                &times;
              </button>
            ) : null}
          </div>
          <MenuCategoryTabs active={category} onChange={handleCategoryChange} hidden={hiddenCategories} />
        </div>

        <div ref={gridRef} className="mt-6 scroll-mt-52 md:mt-8">
          {searching ? (
            allLoading && allItems === null ? (
              <MenuGridSkeleton />
            ) : allItems === null ? (
              <EmptyState
                icon="⚠️"
                heading="Couldn't search the menu"
                body="Check your connection and try again."
                action={
                  <button
                    type="button"
                    onClick={() => fetchAllItems()}
                    className="inline-flex min-h-[44px] items-center rounded-md bg-tan-dark px-4 text-sm font-semibold text-cream hover:bg-tan-darker"
                  >
                    Try again
                  </button>
                }
              />
            ) : searchResults.length === 0 ? (
              <EmptyState
                icon="🔍"
                heading={`No matches for “${query.trim()}”`}
                body="Try a shorter word, or browse the categories above."
              />
            ) : (
              <>
                <p className="mb-4 text-sm text-muted" aria-live="polite">
                  {searchResults.length} result{searchResults.length === 1 ? '' : 's'} for “{query.trim()}”
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
                  {searchResults.map((item) => (
                    <MenuItemCard key={item.id} item={item} showRitual={showRitual} />
                  ))}
                </div>
              </>
            )
          ) : loading ? (
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
                  className="inline-flex min-h-[44px] items-center rounded-md bg-tan-dark px-4 text-sm font-semibold text-cream hover:bg-tan-darker"
                >
                  Try again
                </button>
              }
            />
          ) : items.length === 0 ? (
            <EmptyState
              heading="Nothing here yet"
              body="No items in this category yet"
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
              {items.map((item) => (
                <MenuItemCard key={item.id} item={item} showRitual={showRitual} />
              ))}
            </div>
          )}
        </div>
        {/* Room for the floating cart bar so it never covers the last item. */}
        <div aria-hidden="true" className="h-20" />
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
