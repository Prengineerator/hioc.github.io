'use client';

import { Fragment, useState } from 'react';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { formatIstTime } from '@/lib/store/hours';
import { MENU_CATEGORIES } from '@/lib/constants';
import type { MenuItem } from '@/lib/types';

// S6 86/snooze durations the table offers. Page-level handler turns these
// into the actual { is_available, unavailable_until } PATCH body — see
// app/staff/menu/page.tsx's handleSnooze.
export type SnoozeDuration = '2h' | 'eod' | 'indefinite';

function variantSummary(item: MenuItem): string {
  return item.variants
    .map((v) => (item.variants.length === 1 ? `₹${v.price_inr}` : `${v.label} ₹${v.price_inr}`))
    .join(' / ');
}

// Live availability label — trusts isMenuItemAvailable (not the raw
// is_available/unavailable_until columns) so an expired timed-86 shows as
// "Available" immediately, with no cron needed to clear the stale column.
function availabilityLabel(item: MenuItem): string {
  if (isMenuItemAvailable(item)) return 'Available';
  if (!item.is_available) return 'Sold out';
  return `Sold out until ${formatIstTime(new Date(item.unavailable_until as string))}`;
}

export function MenuItemTable({
  items,
  onEdit,
  onDelete,
  onSnooze,
  onReenable,
}: {
  items: MenuItem[];
  onEdit: (item: MenuItem) => void;
  onDelete: (item: MenuItem) => void;
  onSnooze: (item: MenuItem, duration: SnoozeDuration) => void;
  onReenable: (item: MenuItem) => void;
}) {
  // id of the row whose "86 this item" duration menu is open (one at a time).
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto rounded-md border border-[#e5e5e5] bg-cream shadow-sm">
      <table className="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-[#e5e5e5] text-left text-charcoal">
            <th className="px-4 py-3">Sort Order</th>
            <th className="px-4 py-3">Photo</th>
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Prices</th>
            <th className="px-4 py-3">Addons</th>
            <th className="px-4 py-3">Availability</th>
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
                  <td colSpan={7} className="px-4 py-2 font-bold text-charcoal">
                    {cat.parent ? `${cat.parent} — ${cat.label}` : cat.label}
                  </td>
                </tr>
                {catItems.map((item) => {
                  const available = isMenuItemAvailable(item);
                  return (
                    <tr key={item.id} className="border-b border-[#e5e5e5]">
                      <td className="px-4 py-3 text-charcoal">{item.sort_order}</td>
                      <td className="px-4 py-3">
                        {item.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.image_url}
                            alt=""
                            className="h-10 w-10 rounded-md border border-[#e5e5e5] object-cover"
                          />
                        ) : (
                          <span className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-[#e5e5e5] text-xs text-muted">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-bold text-charcoal">{item.name}</td>
                      <td className="px-4 py-3 text-tan">{variantSummary(item)}</td>
                      <td className="max-w-[220px] truncate px-4 py-3 text-muted">
                        {item.addon_groups.map((g) => g.display_name).join(', ') || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <span
                            className={
                              'text-xs font-bold ' + (available ? 'text-[#2f6b38]' : 'text-tan-dark')
                            }
                          >
                            {availabilityLabel(item)}
                          </span>
                          {available ? (
                            menuOpenFor === item.id ? (
                              // Inline duration buttons (not an absolute dropdown) so they can
                              // never be clipped by the table's overflow-x-auto scroll container.
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="text-[11px] text-muted">Sold out for:</span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    onSnooze(item, '2h');
                                    setMenuOpenFor(null);
                                  }}
                                  className="rounded-md border border-[#e5e5e5] px-2 py-1 text-xs font-bold text-charcoal hover:border-tan"
                                >
                                  2 hrs
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    onSnooze(item, 'eod');
                                    setMenuOpenFor(null);
                                  }}
                                  className="rounded-md border border-[#e5e5e5] px-2 py-1 text-xs font-bold text-charcoal hover:border-tan"
                                >
                                  Today
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    onSnooze(item, 'indefinite');
                                    setMenuOpenFor(null);
                                  }}
                                  className="rounded-md border border-[#e5e5e5] px-2 py-1 text-xs font-bold text-charcoal hover:border-tan"
                                >
                                  Indefinitely
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setMenuOpenFor(null)}
                                  className="px-1 text-xs text-muted hover:text-charcoal"
                                  aria-label="Cancel"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setMenuOpenFor(item.id)}
                                className="rounded-md border border-[#e5e5e5] px-2 py-1 text-xs font-bold text-charcoal hover:border-tan"
                              >
                                Mark sold out
                              </button>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => onReenable(item)}
                              className="rounded-md border border-tan px-2 py-1 text-xs font-bold text-tan hover:bg-[#f6efe9]"
                            >
                              Mark available
                            </button>
                          )}
                        </div>
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
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
