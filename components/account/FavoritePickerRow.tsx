'use client';

// A single row in the "browse menu to add favorites" picker (ACC-5) — no
// add-to-cart affordance here (that lives on the favorited-items grid via
// MenuItemCard); this row is purely for hearting an item.

import { useState } from 'react';
import type { MenuItem } from '@/lib/types';

function priceLabel(item: MenuItem): string {
  const prices = item.variants.map((v) => v.price_inr);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `₹${min}` : `₹${min}–₹${max}`;
}

export function FavoritePickerRow({
  item,
  onAdded,
}: {
  item: MenuItem;
  onAdded: (item: MenuItem) => void;
}) {
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    setSaving(true);
    try {
      const res = await fetch('/api/account/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menu_item_id: item.id }),
      });
      if (res.ok) {
        onAdded(item);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#f2efe9] py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={
            'flex h-3 w-3 shrink-0 items-center justify-center border ' +
            (item.is_veg ? 'border-green-700' : 'border-red-700')
          }
        >
          <span className={'h-1.5 w-1.5 rounded-full ' + (item.is_veg ? 'bg-green-700' : 'bg-red-700')} />
        </span>
        <span className="text-sm text-charcoal">{item.name}</span>
        <span className="text-xs text-muted">{priceLabel(item)}</span>
      </div>
      <button
        type="button"
        onClick={handleAdd}
        disabled={saving}
        aria-label={`Save ${item.name} to favorites`}
        className="text-lg text-tan transition-colors hover:text-tan-dark disabled:opacity-60"
      >
        ♡
      </button>
    </div>
  );
}
