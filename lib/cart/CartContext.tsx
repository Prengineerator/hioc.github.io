'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { computeCartKey } from '@/lib/cart/cartKey';

const STORAGE_KEY = 'hioc.cart.v2';

export interface CartAddonSelection {
  optionId: string;
  groupName: string;
  optionName: string;
  priceInr: number;
}

export interface CartItem {
  key: string;
  menuItemId: string;
  variantId: string;
  name: string;
  variantLabel: string;
  unitPriceInr: number;
  addons: CartAddonSelection[];
  specialInstructions: string; // per-line note (C4); sent as items[].special_instructions
  qty: number;
}

interface CartState {
  items: CartItem[];
}

interface CartContextValue {
  items: CartItem[];
  totalItems: number;
  totalPrice: number;
  hydrated: boolean;
  addItem: (line: Omit<CartItem, 'qty' | 'key'>, qty?: number) => void;
  removeItem: (key: string) => void;
  increment: (key: string) => void;
  decrement: (key: string) => void;
  setQty: (key: string, qty: number) => void;
  clearCart: () => void;
  getQty: (key: string) => number;
}

const CartContext = createContext<CartContextValue | undefined>(undefined);

function readFromStorage(): CartState {
  if (typeof window === 'undefined') return { items: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { items: [] };
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.items)) {
      return { items: parsed.items };
    }
    return { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeToStorage(state: CartState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private browsing, quota) — cart
    // simply won't persist across reloads in that case, which is an
    // acceptable degradation for MVP.
  }
}

/**
 * Cart provider — persists to localStorage so the cart survives navigation
 * between the public pages (Home/Menu/Checkout/Confirmation/About/Contact).
 *
 * A cart "line" is item + variant + the exact set of chosen addon options +
 * special-instructions text (see lib/cart/cartKey.ts) — ordering the same
 * drink two different ways produces two separate lines rather than merging
 * into one.
 *
 * NOTE: app/layout.tsx is a protected scaffold file this project's contract
 * says not to modify, and it does not currently mount a single app-wide
 * CartProvider. Each public page therefore wraps its own tree with
 * <CartProvider> (see app/page.tsx, app/menu/page.tsx, etc.) rather than the
 * root layout wrapping it once. Because state is rehydrated from/written to
 * localStorage on every mount/change, this still delivers the required
 * behavior — the cart persists across navigations within a browser session —
 * even though each route mounts its own provider instance.
 */
export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setItems(readFromStorage().items);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    writeToStorage({ items });
  }, [items, hydrated]);

  const addItem = useCallback((line: Omit<CartItem, 'qty' | 'key'>, qty = 1) => {
    const key = computeCartKey(
      line.menuItemId,
      line.variantId,
      line.addons.map((a) => a.optionId),
      line.specialInstructions,
    );
    setItems((prev) => {
      const existing = prev.find((i) => i.key === key);
      if (existing) {
        return prev.map((i) => (i.key === key ? { ...i, qty: i.qty + qty } : i));
      }
      return [...prev, { ...line, key, qty }];
    });
  }, []);

  const removeItem = useCallback((key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }, []);

  const increment = useCallback((key: string) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, qty: i.qty + 1 } : i)));
  }, []);

  const decrement = useCallback((key: string) => {
    setItems((prev) =>
      prev.map((i) => (i.key === key ? { ...i, qty: i.qty - 1 } : i)).filter((i) => i.qty > 0),
    );
  }, []);

  const setQty = useCallback((key: string, qty: number) => {
    setItems((prev) => {
      if (qty <= 0) return prev.filter((i) => i.key !== key);
      return prev.map((i) => (i.key === key ? { ...i, qty } : i));
    });
  }, []);

  const clearCart = useCallback(() => {
    setItems([]);
    writeToStorage({ items: [] });
  }, []);

  const getQty = useCallback(
    (key: string) => items.find((i) => i.key === key)?.qty ?? 0,
    [items],
  );

  const totalItems = useMemo(() => items.reduce((sum, i) => sum + i.qty, 0), [items]);
  const totalPrice = useMemo(
    () => items.reduce((sum, i) => sum + i.qty * i.unitPriceInr, 0),
    [items],
  );

  const value = useMemo<CartContextValue>(
    () => ({
      items,
      totalItems,
      totalPrice,
      hydrated,
      addItem,
      removeItem,
      increment,
      decrement,
      setQty,
      clearCart,
      getQty,
    }),
    [
      items,
      totalItems,
      totalPrice,
      hydrated,
      addItem,
      removeItem,
      increment,
      decrement,
      setQty,
      clearCart,
      getQty,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return ctx;
}
