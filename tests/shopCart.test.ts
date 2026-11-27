import { describe, expect, it } from 'vitest';
import {
  SHOP_CART_KEY, addCartItem, cartUnits, clearShopCart, readShopCart, removeCartItem, setCartItemQuantity, writeShopCart,
} from '@/lib/shop/cart';
import { cartItemKey } from '@/lib/shop/pricing';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  const s = {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
  };
  return s as unknown as Storage & { data: Record<string, string> };
}
const throwing = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
} as unknown as Storage;

const base = { items: [{ product_id: 'classic', quantity: 2 }], address_id: null, address: null, notice: null, step: 'choose' as const };

describe('shop cart storage', () => {
  it('uses its own key', () => {
    expect(SHOP_CART_KEY).toBe('hioc_shop_cart_v2');
  });
  it('round-trips and clears', () => {
    const s = fakeStorage({ hioc_cart: 'cafe' });
    writeShopCart({ ...base, step: 'pay', notice: 'hi', address_id: 'a1' }, s);
    const got = readShopCart(s);
    expect(got).toMatchObject({ v: 2, step: 'pay', notice: 'hi', address_id: 'a1', items: base.items });
    clearShopCart(s);
    expect(readShopCart(s)).toBeNull();
    expect(s.data.hioc_cart).toBe('cafe'); // the café cart is untouched
  });
  it('drops malformed, wrong-version and over-limit data', () => {
    for (const bad of ['not json', '{}', JSON.stringify({ v: 1, items: base.items, saved_at: Date.now() }),
      JSON.stringify({ v: 2, items: [{ product_id: 'x', quantity: -1 }], saved_at: Date.now() }),
      JSON.stringify({ v: 2, items: [{ product_id: 'x', quantity: 13 }], saved_at: Date.now() }),
      JSON.stringify({ v: 2, items: base.items })]) {
      expect(readShopCart(fakeStorage({ [SHOP_CART_KEY]: bad }))).toBeNull();
    }
  });
  it('drops a cart older than 14 days', () => {
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const s = fakeStorage({ [SHOP_CART_KEY]: JSON.stringify({ v: 2, ...base, saved_at: old }) });
    expect(readShopCart(s)).toBeNull();
    const fresh = Date.now() - 13 * 24 * 60 * 60 * 1000;
    expect(readShopCart(fakeStorage({ [SHOP_CART_KEY]: JSON.stringify({ v: 2, ...base, saved_at: fresh }) }))).not.toBeNull();
  });
  it('tolerates broken storage', () => {
    expect(() => writeShopCart(base, throwing)).not.toThrow();
    expect(readShopCart(throwing)).toBeNull();
    expect(() => clearShopCart(throwing)).not.toThrow();
    expect(readShopCart(null)).toBeNull();
  });
});

describe('cart helpers', () => {
  it('merges the same product and grind, keeps different grinds apart', () => {
    let items = addCartItem([], { product_id: 'hb', quantity: 1, grind: 'filter' });
    items = addCartItem(items, { product_id: 'hb', quantity: 2, grind: 'filter' });
    items = addCartItem(items, { product_id: 'hb', quantity: 1, grind: 'moka' });
    expect(items).toEqual([
      { product_id: 'hb', quantity: 3, grind: 'filter' },
      { product_id: 'hb', quantity: 1, grind: 'moka' },
    ]);
    expect(cartUnits(items)).toBe(4);
  });
  it('never goes above 12 units', () => {
    let items = addCartItem([], { product_id: 'a', quantity: 10 });
    items = addCartItem(items, { product_id: 'b', quantity: 5 });
    expect(cartUnits(items)).toBe(12);
    expect(addCartItem(items, { product_id: 'c', quantity: 1 })).toBe(items);
    expect(cartUnits(setCartItemQuantity(items, 'a:', 20))).toBe(12);
  });
  it('sets, removes and ignores unknown keys', () => {
    const items = [{ product_id: 'a', quantity: 2 }, { product_id: 'b', quantity: 1 }];
    expect(setCartItemQuantity(items, 'a:', 5)[0].quantity).toBe(5);
    expect(setCartItemQuantity(items, 'a:', 0).map(cartItemKey)).toEqual(['b:']);
    expect(removeCartItem(items, 'b:')).toEqual([items[0]]);
    expect(setCartItemQuantity(items, 'zzz:', 3)).toBe(items);
  });
});
