// In-store-only menu items (supabase/2026-09-in-store-only.sql) — things sold
// only at the counter, like water bottles, that no customer menu shows and no
// online or table-QR order may carry.
//
// An item is in-store only when it is flagged OR it sits in an in-store
// category (lib/constants.ts MENU_CATEGORIES `inStoreOnly`). The category
// fallback means an item added to "In-store" without ticking the box is still
// kept off customer menus, and it also covers a row read before the migration
// added the column (`in_store_only` undefined).

import { MENU_CATEGORIES } from '@/lib/constants';

const IN_STORE_CATEGORIES = new Set(MENU_CATEGORIES.filter((c) => c.inStoreOnly).map((c) => c.slug));

export function isInStoreOnlyCategory(category: string): boolean {
  return IN_STORE_CATEGORIES.has(category);
}

export function isInStoreOnly(item: { in_store_only?: boolean | null; category: string }): boolean {
  return item.in_store_only === true || isInStoreOnlyCategory(item.category);
}

/**
 * The first in-store-only item on an order a CUSTOMER is placing (website or
 * table QR), or null when there is none. The order route refuses such an
 * order outright rather than dropping the line: silently removing something
 * the customer asked for would charge them for a different order than the one
 * they saw.
 */
export function firstInStoreOnlyItem<T extends { in_store_only?: boolean | null; category: string; name: string }>(
  lines: { menu_item_id: string }[],
  menuById: Map<string, T>,
): T | null {
  for (const line of lines) {
    const item = menuById.get(line.menu_item_id);
    if (item && isInStoreOnly(item)) return item;
  }
  return null;
}
