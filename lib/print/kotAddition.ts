// Items added to an order that was already sent to the kitchen (running tab /
// "add items") print as their own KOT carrying ONLY the new lines, headed
// "ADDED ITEMS" — reprinting the whole order reads as a second order on the
// rail, and the kitchen remakes what it already made.
//
// The added line ids ride on the print URL (`?items=a,b`), for the browser
// print page and the desktop ticket route alike.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 100;

/** `?items=` → the line ids to print, or null for "the whole order". */
export function parseKotItemsParam(raw: string | string[] | null | undefined): string[] | null {
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (!value) return null;
  const ids = [...new Set(value.split(',').map((s) => s.trim()).filter((s) => UUID.test(s)))].slice(0, MAX_ITEMS);
  return ids.length > 0 ? ids : null;
}

/** The query string for a KOT of just these lines ('' for the whole order). */
export function kotItemsQuery(itemIds: readonly string[] | null | undefined): string {
  return itemIds && itemIds.length > 0 ? `items=${itemIds.join(',')}` : '';
}

/**
 * The order narrowed to the added lines, flagged so the ticket says so. The
 * whole order when `itemIds` is null, or when none of them are on it (never
 * an empty ticket).
 */
export function onlyKotItems<T extends { items: { id: string }[] }>(
  order: T,
  itemIds: readonly string[] | null,
): T & { kot_addition?: boolean } {
  if (!itemIds) return order;
  const wanted = new Set(itemIds);
  const items = order.items.filter((i) => wanted.has(i.id));
  if (items.length === 0) return order;
  return { ...order, items, kot_addition: true };
}
