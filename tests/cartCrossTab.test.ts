import { describe, expect, it } from 'vitest';
import {
  CART_STORAGE_KEY,
  cartFromStorageEvent,
  parseStoredCart,
  serializeCart,
  shouldWriteCart,
} from '@/lib/cart/cartStorage';

// The cart across tabs (lib/cart/cartStorage.ts, used by CartProvider): a cart
// cleared in one tab is not written back by another, and two tabs following
// each other don't echo writes forever.

type Line = { key: string; qty: number };

/** A tiny model of two tabs sharing one localStorage, wired the way CartProvider is. */
function twoTabs(initial: Line[]) {
  const store = new Map<string, string>([[CART_STORAGE_KEY, serializeCart({ items: initial })]]);
  let writes = 0;
  const tabs = {
    a: { items: initial },
    b: { items: initial },
  };
  type TabName = keyof typeof tabs;
  const other = (t: TabName): TabName => (t === 'a' ? 'b' : 'a');

  // The write effect: only a change is written; a write fires `storage` in the OTHER tab.
  function write(t: TabName) {
    const next = serializeCart({ items: tabs[t].items });
    if (!shouldWriteCart(store.get(CART_STORAGE_KEY) ?? null, next)) return;
    store.set(CART_STORAGE_KEY, next);
    writes += 1;
    if (writes > 20) throw new Error('write loop');
    receive(other(t), { key: CART_STORAGE_KEY, newValue: next });
  }
  // The storage listener: take the other tab's cart, then the write effect runs.
  function receive(t: TabName, event: { key: string | null; newValue: string | null }) {
    const next = cartFromStorageEvent<Line>(event);
    if (!next) return;
    tabs[t].items = next;
    write(t);
  }
  function change(t: TabName, items: Line[]) {
    tabs[t].items = items;
    write(t);
  }
  return { tabs, change, receive, writes: () => writes, stored: () => parseStoredCart<Line>(store.get(CART_STORAGE_KEY) ?? null).items };
}

describe('cart across tabs', () => {
  it('an order placed (cart cleared) in one tab is not resurrected by the other', () => {
    const t = twoTabs([{ key: 'latte', qty: 1 }]);
    t.change('a', []); // tab A places the order
    expect(t.tabs.b.items).toEqual([]); // tab B follows
    t.change('b', [...t.tabs.b.items, { key: 'cookie', qty: 1 }]); // the customer taps "+" in tab B
    expect(t.stored()).toEqual([{ key: 'cookie', qty: 1 }]); // no latte coming back
  });

  it('following each other does not echo: one change, one write', () => {
    const t = twoTabs([]);
    t.change('a', [{ key: 'latte', qty: 2 }]);
    expect(t.writes()).toBe(1);
    expect(t.tabs.b.items).toEqual([{ key: 'latte', qty: 2 }]);
  });

  it('storage.clear() in another tab empties the cart; other keys are ignored', () => {
    expect(cartFromStorageEvent({ key: null, newValue: null })).toEqual([]);
    expect(cartFromStorageEvent({ key: 'something.else', newValue: '{"items":[1]}' })).toBeNull();
    expect(cartFromStorageEvent({ key: CART_STORAGE_KEY, newValue: null })).toEqual([]);
    expect(cartFromStorageEvent({ key: CART_STORAGE_KEY, newValue: 'not json' })).toEqual([]);
  });

  it('a stored cart reads back exactly as written (so a tab that took it has nothing to write)', () => {
    const s = serializeCart({ items: [{ key: 'latte', qty: 1, addons: [] }] });
    expect(shouldWriteCart(s, serializeCart(parseStoredCart(s)))).toBe(false);
  });
});
