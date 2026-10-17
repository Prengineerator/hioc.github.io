'use client';

import { useMemo, useState } from 'react';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { formatIstTime } from '@/lib/store/hours';
import { MENU_CATEGORIES } from '@/lib/constants';
import type { MenuItem } from '@/lib/types';
import { isInStoreOnly } from '@/lib/menu/inStore';
import { isSoldByWeight } from '@/lib/menu/weight';
import { DataTable } from '@/components/ui/DataTable';

// S6 86/snooze durations the table offers. Page-level handler turns these
// into the actual { is_available, unavailable_until } PATCH body — see
// app/staff/menu/page.tsx's handleSnooze.
export type SnoozeDuration = '2h' | 'eod' | 'indefinite';

function variantSummary(item: MenuItem): string {
  // A sold-by-weight item's prices are per kg (lib/menu/weight.ts).
  const unit = isSoldByWeight(item) ? '/kg' : '';
  return item.variants
    .map((v) => (item.variants.length === 1 ? `₹${v.price_inr}${unit}` : `${v.label} ₹${v.price_inr}${unit}`))
    .join(' / ');
}

// Live availability label — trusts isMenuItemAvailable (not the raw
// is_available/unavailable_until columns) so an expired timed-86 shows as
// "Available" immediately, with no cron needed to clear the stale column.
function availabilityLabel(item: MenuItem): string {
  if (isMenuItemAvailable(item)) return 'Available';
  // Hidden by inventory auto-hide (an ingredient ran out); comes back by
  // itself when stock is received, or now via Re-enable.
  if (!item.is_available && item.stock_out_auto) return 'Out of stock';
  if (!item.is_available) return 'Sold out';
  return `Sold out until ${formatIstTime(new Date(item.unavailable_until as string))}`;
}

export function MenuItemTable({
  items,
  onEdit,
  onDelete,
  onSnooze,
  onReenable,
  readOnly = false,
}: {
  items: MenuItem[];
  onEdit: (item: MenuItem) => void;
  onDelete: (item: MenuItem) => void;
  onSnooze: (item: MenuItem, duration: SnoozeDuration) => void;
  onReenable: (item: MenuItem) => void;
  /** Staff website: the menu is changed on the POS only, so no edit,
   * delete or sold-out controls here (the API refuses them anyway). */
  readOnly?: boolean;
}) {
  // id of the row whose "86 this item" duration menu is open (one at a time).
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);

  const catLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const cat of MENU_CATEGORIES) m.set(cat.slug, cat.parent ? `${cat.parent} — ${cat.label}` : cat.label);
    return m;
  }, []);

  // Menu order: category (in MENU_CATEGORIES order), then sort_order. Items in
  // a category the constants don't list stay hidden, as before.
  const rows = useMemo(
    () =>
      MENU_CATEGORIES.flatMap((cat) =>
        items.filter((i) => i.category === cat.slug).sort((a, b) => a.sort_order - b.sort_order),
      ),
    [items],
  );

  return (
    <DataTable
      rows={rows}
      rowKey={(item) => item.id}
      minWidth={900}
      cellPadding="px-4 py-3"
      headerTextClassName="text-charcoal"
      scrollClassName="rounded-md border border-line bg-cream shadow-sm"
      // Category banner rows, while the table is in its default (unsorted) order.
      groupHeader={(item, prev) =>
        prev && prev.category === item.category ? null : (
          <tr className="bg-[#faf7f4]">
            <td colSpan={8} className="px-4 py-2 font-bold text-charcoal">
              {catLabel.get(item.category)}
            </td>
          </tr>
        )
      }
      columns={[
        {
          key: 'sort_order',
          header: 'Sort Order',
          filter: 'number',
          value: (item) => item.sort_order,
          cellClassName: 'text-charcoal',
        },
        {
          key: 'photo',
          header: 'Photo',
          filter: 'none',
          value: () => null,
          render: (item) =>
            item.image_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.image_url}
                alt=""
                className="h-10 w-10 rounded-md border border-line object-cover"
              />
            ) : (
              <span className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-line text-xs text-muted">
                —
              </span>
            ),
        },
        {
          key: 'name',
          header: 'Name',
          filter: 'text',
          value: (item) => item.name,
          cellClassName: 'font-bold text-charcoal',
          render: (item) => (
            <>
              {item.name}
              {isInStoreOnly(item) ? (
                <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                  In-store
                </span>
              ) : null}
              {item.gst_exempt ? (
                <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                  No GST
                </span>
              ) : null}
              {isSoldByWeight(item) ? (
                <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-muted">
                  By weight
                </span>
              ) : null}
            </>
          ),
        },
        {
          key: 'category',
          header: 'Category',
          filter: 'select',
          value: (item) => catLabel.get(item.category) ?? item.category,
          cellClassName: 'text-muted',
        },
        {
          key: 'prices',
          header: 'Prices',
          filter: 'text',
          value: (item) => variantSummary(item),
          cellClassName: 'text-tan-dark',
        },
        {
          key: 'addons',
          header: 'Addons',
          filter: 'text',
          value: (item) => item.addon_groups.map((g) => g.display_name).join(', '),
          cellClassName: 'max-w-[220px] truncate text-muted',
        },
        {
          key: 'availability',
          header: 'Availability',
          filter: 'select',
          // Two buckets, not the full label: "Sold out until 4:30 pm" is different
          // for every item and would flood the dropdown.
          value: (item) => (isMenuItemAvailable(item) ? 'Available' : 'Sold out'),
          render: (item) => {
            const available = isMenuItemAvailable(item);
            return (
              <div className="flex flex-col items-start gap-1">
                <span
                  className={
                    'text-xs font-bold ' + (available ? 'text-[#2f6b38]' : 'text-tan-dark')
                  }
                >
                  {availabilityLabel(item)}
                </span>
                {readOnly ? null : available ? (
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
                        className="min-h-[40px] rounded-md border border-line px-3 text-xs font-bold text-charcoal hover:border-tan"
                      >
                        2 hrs
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onSnooze(item, 'eod');
                          setMenuOpenFor(null);
                        }}
                        className="min-h-[40px] rounded-md border border-line px-3 text-xs font-bold text-charcoal hover:border-tan"
                      >
                        Today
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onSnooze(item, 'indefinite');
                          setMenuOpenFor(null);
                        }}
                        className="min-h-[40px] rounded-md border border-line px-3 text-xs font-bold text-charcoal hover:border-tan"
                      >
                        Indefinitely
                      </button>
                      <button
                        type="button"
                        onClick={() => setMenuOpenFor(null)}
                        className="flex h-10 w-10 items-center justify-center text-sm text-muted hover:text-charcoal"
                        aria-label="Cancel"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setMenuOpenFor(item.id)}
                      className="min-h-[40px] rounded-md border border-line px-3 text-xs font-bold text-charcoal hover:border-tan"
                    >
                      Mark sold out
                    </button>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => onReenable(item)}
                    className="min-h-[40px] rounded-md border border-tan px-3 text-xs font-bold text-tan-dark hover:bg-surface"
                  >
                    Mark available
                  </button>
                )}
              </div>
            );
          },
        },
        {
          key: 'actions',
          header: 'Actions',
          filter: 'none',
          value: () => null,
          render: (item) =>
            readOnly ? (
              <span className="text-xs text-muted">On the POS</span>
            ) : (
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => onEdit(item)}
                  className="font-bold text-tan-dark hover:underline"
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
            ),
        },
      ]}
    />
  );
}
