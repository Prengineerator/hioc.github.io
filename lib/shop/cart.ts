// The shop cart as it lives in the browser (docs/SHOP-V2-SPEC.md E8): kept
// under its own key, `hioc_shop_cart_v2`, so a reload, a sign-in redirect or a
// "Order again" hand-off lands back on the same cart. The café cart has its
// own storage and is never read or written here.
//
// Client-safe and defensive: storage can be missing (server render), blocked
// or full (private mode), so every access is in try/catch and a broken store
// reads as "no saved cart". A stored cart is re-validated with parseCartItems
// on the way in (it is only ever a hint; checkout re-prices on the server) and
// dropped when malformed or older than 14 days.
//
// The add / set / remove helpers are pure and never take a cart above
// MAX_UNITS_PER_ORDER units.

import { isGrindCode } from '@/lib/shop/catalog';
import { MAX_UNITS_PER_ORDER, cartItemKey, parseCartItems, type CartItem } from '@/lib/shop/pricing';
import type { ShopAddress } from '@/lib/shop/types';

export const SHOP_CART_KEY = 'hioc_shop_cart_v2';

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type ShopCartStep = 'choose' | 'deliver' | 'pay';

export interface StoredShopCart {
  v: 2;
  items: CartItem[];
  address_id: string | null;
  address: ShopAddress | null;
  notice: string | null;
  step: ShopCartStep;
  saved_at: number;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

const ADDRESS_FIELDS = [
  'customer_name', 'phone', 'email', 'address_line1', 'address_line2', 'landmark', 'city', 'state', 'pincode',
] as const;

function readAddress(raw: unknown): ShopAddress | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of ADDRESS_FIELDS) {
    const v = r[f];
    if (typeof v === 'string') out[f] = v;
    else if (v === undefined || v === null) out[f] = '';
    else return null;
  }
  return out as unknown as ShopAddress;
}

/** The saved cart, or null when there is none, it is malformed or it is stale. */
export function readShopCart(storage: Storage | null = defaultStorage()): StoredShopCart | null {
  if (!storage) return null;
  try {
    const text = storage.getItem(SHOP_CART_KEY);
    if (!text) return null;
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || raw.v !== 2) return null;
    const savedAt = raw.saved_at;
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
    if (Date.now() - savedAt > MAX_AGE_MS) return null;
    const parsed = parseCartItems(raw.items);
    if (!parsed.ok) return null;
    const step: ShopCartStep = raw.step === 'deliver' || raw.step === 'pay' ? raw.step : 'choose';
    return {
      v: 2,
      items: parsed.items,
      address_id: typeof raw.address_id === 'string' ? raw.address_id : null,
      address: readAddress(raw.address),
      notice: typeof raw.notice === 'string' && raw.notice ? raw.notice : null,
      step,
      saved_at: savedAt,
    };
  } catch {
    return null;
  }
}

export function writeShopCart(
  cart: Omit<StoredShopCart, 'v' | 'saved_at'>,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const value: StoredShopCart = { v: 2, ...cart, saved_at: Date.now() };
    storage.setItem(SHOP_CART_KEY, JSON.stringify(value));
  } catch {
    // Private mode / full / blocked: the cart simply isn't remembered.
  }
}

export function clearShopCart(storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(SHOP_CART_KEY);
  } catch {
    // Nothing to clear if storage is blocked.
  }
}

export function cartUnits(items: CartItem[]): number {
  return items.reduce((n, i) => n + i.quantity, 0);
}

/** Adds an item, merging with the same product and grind; stops at 12 units in all. */
export function addCartItem(items: CartItem[], item: CartItem): CartItem[] {
  const room = MAX_UNITS_PER_ORDER - cartUnits(items);
  const quantity = Math.min(Math.max(0, Math.floor(item.quantity)), Math.max(0, room));
  if (quantity <= 0) return items;
  const grind = isGrindCode(item.grind) ? item.grind : null;
  const clean: CartItem = grind ? { product_id: item.product_id, quantity, grind } : { product_id: item.product_id, quantity };
  const key = cartItemKey(clean);
  if (items.some((i) => cartItemKey(i) === key)) {
    return items.map((i) => (cartItemKey(i) === key ? { ...i, quantity: i.quantity + quantity } : i));
  }
  return [...items, clean];
}

/** Sets one line's quantity (0 removes it), never taking the cart above 12 units. */
export function setCartItemQuantity(items: CartItem[], key: string, quantity: number): CartItem[] {
  const target = items.find((i) => cartItemKey(i) === key);
  if (!target) return items;
  const wanted = Math.max(0, Math.floor(Number.isFinite(quantity) ? quantity : 0));
  if (wanted === 0) return removeCartItem(items, key);
  const room = MAX_UNITS_PER_ORDER - (cartUnits(items) - target.quantity);
  const next = Math.min(wanted, room);
  return items.map((i) => (i === target ? { ...i, quantity: next } : i));
}

export function removeCartItem(items: CartItem[], key: string): CartItem[] {
  return items.filter((i) => cartItemKey(i) !== key);
}
