'use client';

// Favourites (ACC-5): heart/unheart menu items, list them, add-to-cart from
// there. The favorited-items grid reuses components/menu/MenuItemCard (same
// add-to-cart/customize behavior as the main menu); a separate "browse to
// add" picker lets a customer heart new items without leaving /account.

import { useEffect, useState } from 'react';
import { CartProvider } from '@/lib/cart/CartContext';
import { FavoriteCard } from '@/components/account/FavoriteCard';
import { FavoritePickerRow } from '@/components/account/FavoritePickerRow';
import { Spinner } from '@/components/ui/Spinner';
import { buttonVariants } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { MenuItem } from '@/lib/types';

interface FavoriteRow {
  menu_item_id: string;
  item: MenuItem | null;
}

export default function FavoritesPage() {
  return (
    <CartProvider>
      <FavoritesContent />
    </CartProvider>
  );
}

function FavoritesContent() {
  const [favorites, setFavorites] = useState<FavoriteRow[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    (async () => {
      const [favRes, menuRes] = await Promise.all([
        fetch('/api/account/favorites', { cache: 'no-store' }),
        fetch('/api/menu', { cache: 'no-store' }),
      ]);
      if (favRes.ok) {
        const data = await favRes.json();
        setFavorites(data.favorites ?? []);
      }
      if (menuRes.ok) {
        const data = await menuRes.json();
        setMenu(data.items ?? []);
      }
      setLoading(false);
    })();
  }, []);

  function handleRemoved(menuItemId: string) {
    setFavorites((prev) => prev.filter((f) => f.menu_item_id !== menuItemId));
  }

  function handleAdded(item: MenuItem) {
    setFavorites((prev) => [{ menu_item_id: item.id, item }, ...prev]);
  }

  if (loading) {
    return <Spinner label="Loading your favourites…" />;
  }

  const favoriteIds = new Set(favorites.map((f) => f.menu_item_id));
  const pickable = menu.filter((m) => !favoriteIds.has(m.id));
  const validFavorites = favorites.filter(
    (f): f is FavoriteRow & { item: MenuItem } => f.item !== null,
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-charcoal">Favourites</h1>

      {validFavorites.length === 0 ? (
        <EmptyState
          icon=""
          heading="No favourites yet"
          body="Save the items you love and they will wait for you here."
          action={
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              className={buttonVariants()}
            >
              Choose favourites
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {validFavorites.map((f) => (
            <FavoriteCard key={f.menu_item_id} item={f.item} onRemoved={handleRemoved} />
          ))}
        </div>
      )}

      <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
        <button
          type="button"
          onClick={() => setShowPicker((v) => !v)}
          aria-expanded={showPicker}
          className="min-h-[44px] text-sm font-semibold text-tan-dark hover:underline"
        >
          {showPicker ? 'Hide menu' : 'Browse menu to add favourites'}
        </button>
        {showPicker ? (
          <div className="mt-3">
            {pickable.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted">Everything is already a favourite.</p>
            ) : (
              pickable.map((item) => (
                <FavoritePickerRow key={item.id} item={item} onAdded={handleAdded} />
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
