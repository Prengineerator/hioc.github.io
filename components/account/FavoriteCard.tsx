'use client';

// A favorited menu item: the normal MenuItemCard (so "add to cart" behaves
// exactly like the main menu — simple items add directly, multi-variant/addon
// items open the customize modal) plus an unheart button overlay (ACC-5).

import { useState } from 'react';
import { MenuItemCard } from '@/components/menu/MenuItemCard';
import type { MenuItem } from '@/lib/types';

export function FavoriteCard({
  item,
  onRemoved,
}: {
  item: MenuItem;
  onRemoved: (menuItemId: string) => void;
}) {
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    setRemoving(true);
    try {
      await fetch(`/api/account/favorites/${item.id}`, { method: 'DELETE' });
      onRemoved(item.id);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleRemove}
        disabled={removing}
        aria-label={`Remove ${item.name} from favorites`}
        title="Remove from favorites"
        className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-cream text-tan shadow-sm transition-colors hover:bg-tan hover:text-cream disabled:opacity-60"
      >
        ♥
      </button>
      <MenuItemCard item={item} />
    </div>
  );
}
