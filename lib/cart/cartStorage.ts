// How the cart is kept in localStorage, and how one tab hears another's change
// (lib/cart/CartContext.tsx). Pure, so it is unit-tested without a browser.
//
// Every open tab holds its own copy of the cart in memory and writes it back
// whenever it changes. Nothing told a tab when ANOTHER tab changed it, so: the
// order is placed in tab A (cart cleared), the menu is still open in tab B with
// the old cart, the customer taps "+" there — and tab B writes the whole old
// cart back, items already ordered and all. Now each tab follows the `storage`
// event (which the browser fires in the OTHER tabs of the same origin), and a
// tab never writes back what is already stored, so two tabs following each
// other can't ping-pong.

export const CART_STORAGE_KEY = 'hioc.cart.v2';

/** A stored cart's lines; an empty cart for anything missing or malformed. */
export function parseStoredCart<T = unknown>(raw: string | null): { items: T[] } {
  if (!raw) return { items: [] };
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.items) ? { items: parsed.items as T[] } : { items: [] };
  } catch {
    return { items: [] };
  }
}

export function serializeCart<T>(state: { items: T[] }): string {
  return JSON.stringify(state);
}

/**
 * The cart another tab just stored, or null when the event isn't about the cart.
 * `key` null means that tab cleared all of storage: the cart went with it.
 */
export function cartFromStorageEvent<T = unknown>(event: { key: string | null; newValue: string | null }): T[] | null {
  if (event.key !== null && event.key !== CART_STORAGE_KEY) return null;
  return parseStoredCart<T>(event.key === null ? null : event.newValue).items;
}

/** Write only a change: a tab that just took another tab's cart has nothing new to say. */
export function shouldWriteCart(stored: string | null, next: string): boolean {
  return stored !== next;
}
