'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
  // Phase-7 (SUG-8): set when this line was added from the /suggest wizard, so
  // the order it ends up in can be attributed back to that suggestion session
  // (components/checkout/CheckoutForm.tsx → suggestion_session_ids). Optional
  // and never set by the existing /menu flow, so old stored carts (which have
  // no such field) keep working unchanged.
  suggestionSessionId?: string;
  // GST-exempt item (2026-09-gst-exempt), for the bill PREVIEW only — the
  // server re-derives it from the menu when the order is placed. Absent on
  // carts saved before this existed, which just previews GST on everything.
  gstExempt?: boolean;
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
  // Phase-7 (SUG-8): a one-shot "next addItem call carries this session id"
  // hint. It exists so a caller that can't attach `suggestionSessionId`
  // directly — namely components/menu/MenuItemCustomizeModal.tsx, which this
  // phase does not own/modify and which calls addItem() itself once the
  // customer confirms — still produces an attributed line when opened from
  // /suggest. components/suggest/* sets it right before opening that modal
  // for a pick, and clears it again when the modal closes either way; addItem
  // consumes (and clears) it on its very next call regardless, so it can
  // never leak onto an unrelated line added later from /menu.
  setPendingSuggestionSessionId: (id: string | null) => void;
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
  // See setPendingSuggestionSessionId in CartContextValue above. A ref (not
  // state) is correct here: it's consumed synchronously by the very next
  // addItem() call and never itself drives a render.
  const pendingSuggestionSessionId = useRef<string | null>(null);

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
    // An explicit suggestionSessionId on the line wins; otherwise fall back to
    // the one-shot pending hint (set by /suggest right before opening the
    // customize modal for a pick). Consumed unconditionally so it can't leak
    // onto a later, unrelated addItem() call.
    const suggestionSessionId = line.suggestionSessionId ?? pendingSuggestionSessionId.current ?? undefined;
    pendingSuggestionSessionId.current = null;
    setItems((prev) => {
      const existing = prev.find((i) => i.key === key);
      if (existing) {
        // The cart key is unchanged (same item/variant/addons/instructions),
        // so a suggested line and the same line added plainly from /menu
        // still merge into one — keep whichever suggestionSessionId is
        // already on the line, or take the new one if it didn't have one.
        return prev.map((i) =>
          i.key === key
            ? { ...i, qty: i.qty + qty, suggestionSessionId: i.suggestionSessionId ?? suggestionSessionId }
            : i,
        );
      }
      return [...prev, { ...line, key, qty, suggestionSessionId }];
    });
  }, []);

  const setPendingSuggestionSessionId = useCallback((id: string | null) => {
    pendingSuggestionSessionId.current = id;
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
      setPendingSuggestionSessionId,
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
      setPendingSuggestionSessionId,
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

/** The part of a cart's subtotal GST applies to — every line except
 * GST-exempt items. For bill previews; the server recomputes it. */
export function cartTaxableSubtotal(items: Pick<CartItem, 'qty' | 'unitPriceInr' | 'gstExempt'>[]): number {
  return items.filter((i) => !i.gstExempt).reduce((sum, i) => sum + i.qty * i.unitPriceInr, 0);
}
