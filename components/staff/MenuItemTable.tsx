'use client';

import { Fragment } from 'react';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { MENU_CATEGORIES } from '@/lib/constants';
import type { MenuItem } from '@/lib/types';

function variantSummary(item: MenuItem): string {
  return item.variants
    .map((v) => (item.variants.length === 1 ? `₹${v.price_inr}` : `${v.label} ₹${v.price_inr}`))
    .join(' / ');
}

export function MenuItemTable({
  items,
  onToggleAvailable,
  onEdit,
  onDelete,
}: {
  items: MenuItem[];
  onToggleAvailable: (item: MenuItem, next: boolean) => void;
  onEdit: (item: MenuItem) => void;
  onDelete: (item: MenuItem) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-[#e5e5e5] bg-cream shadow-sm">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[#e5e5e5] text-left text-charcoal">
            <th className="px-4 py-3">Sort Order</th>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Prices</th>
            <th className="px-4 py-3">Addons</th>
            <th className="px-4 py-3">Available</th>
            <th className="px-4 py-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {MENU_CATEGORIES.map((cat) => {
            const catItems = items
              .filter((i) => i.category === cat.slug)
              .sort((a, b) => a.sort_order - b.sort_order);
            if (catItems.length === 0) return null;
            return (
              <Fragment key={cat.slug}>
                <tr className="bg-[#faf7f4]">
                  <td colSpan={6} className="px-4 py-2 font-bold text-charcoal">
                    {cat.parent ? `${cat.parent} — ${cat.label}` : cat.label}
                  </td>
                </tr>
                {catItems.map((item) => (
                  <tr key={item.id} className="border-b border-[#e5e5e5]">
                    <td className="px-4 py-3 text-charcoal">{item.sort_order}</td>
                    <td className="px-4 py-3 font-bold text-charcoal">{item.name}</td>
                    <td className="px-4 py-3 text-tan">{variantSummary(item)}</td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-muted">
                      {item.addon_groups.map((g) => g.display_name).join(', ') || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <ToggleSwitch
                        checked={item.is_available}
                        onChange={(next) => onToggleAvailable(item, next)}
                        label={`Toggle availability for ${item.name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-3">
                        <button
                          type="button"
                          onClick={() => onEdit(item)}
                          className="font-bold text-tan hover:underline"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(item)}
                          className="font-bold text-charcoal hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
