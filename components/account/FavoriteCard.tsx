'use client';

// A favorited menu item: the normal MenuItemCard (so "add to cart" behaves
// exactly like the main menu — simple items add directly, multi-variant/addon
// items open the customize modal) plus an unheart button overlay (a filled heart SVG, 44px) (ACC-5).

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
        aria-label={`Remove ${item.name} from favourites`}
        title="Remove from favourites"
        className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-cream text-tan-dark shadow-sm transition-colors hover:bg-tan-dark hover:text-cream disabled:opacity-60"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M12 21s-7.5-4.6-9.5-9.2C1.1 8.3 3 5 6.4 5c2 0 3.6 1.1 4.6 2.6h2C14 6.1 15.600 5 17.600 5 21 5 22.900 8.300 21.500 11.800 19.500 16.400 12 21 12 21z" />
        </svg>
      </button>
      <MenuItemCard item={item} />
    </div>
  );
}
