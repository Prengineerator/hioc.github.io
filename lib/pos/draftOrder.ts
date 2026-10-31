// The order being punched on New order, kept on this machine until it is placed.
//
// It used to live only in React state, so anything that unmounted the screen —
// a tap on Tables to check a seat, a reload of a stuck screen, the renderer
// crashing — threw the order away and the staffer punched it again. Now the
// screen saves a draft as it changes and puts it back when it opens again.
//
// What is kept, and what is not:
//  - the cart lines, order type, table and the customer fields: what the
//    staffer typed. Prices in the lines are only the quote's INPUT (the server
//    re-prices everything), so a draft from before a price change is harmless.
//  - the idempotency key. A reload while "Charge" was in flight is exactly
//    when the order may exist on the server with no answer on screen; keeping
//    the key means charging again REPLAYS that order instead of making a second.
//  - NOT coupons, points or Ritual cups: those spend a customer's balance and
//    must be asked for again, never carried silently.
//  - NOT the payment step: it re-opens from Charge.
//
// sessionStorage, not localStorage: customer names and numbers should not
// outlive the window, and a draft only matters for the shift it was made in.
// One draft per context: the counter's own (`counter`), one per table a
// staffer opened from the tables board (`table:<id>`) and one per running order
// being added to (`add:<orderId>`), so starting an order for table 4 never
// overwrites the walk-in being punched.

import type { CartItem } from '@/lib/cart/CartContext';
import type { OrderType } from '@/lib/types';

export const DRAFT_KEY_PREFIX = 'hioc.pos.draft.v1.';
/** A draft older than this belongs to a customer who has left. */
export const DRAFT_MAX_AGE_MS = 3 * 60 * 60 * 1000;

export interface DraftOrder {
  savedAt: number;
  idempotencyKey: string;
  cart: CartItem[];
  orderType: OrderType;
  tableId: string | null;
  custName: string;
  custPhone: string;
  custEmail: string;
  showCustomer: boolean;
}

/** Which draft slot a New order screen uses: an add to a running order, a table from the board, or the counter. */
export function draftContext(initialTableId: string | null | undefined, addToOrderId?: string | null): string {
  if (addToOrderId) return `add:${addToOrderId}`;
  return initialTableId ? `table:${initialTableId}` : 'counter';
}

export function draftStorageKey(context: string): string {
  return `${DRAFT_KEY_PREFIX}${context}`;
}

const ORDER_TYPES: readonly OrderType[] = ['takeaway', 'dine_in', 'delivery'];

function isCartLine(v: unknown): v is CartItem {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.key === 'string' &&
    typeof l.menuItemId === 'string' &&
    typeof l.variantId === 'string' &&
    typeof l.name === 'string' &&
    typeof l.variantLabel === 'string' &&
    typeof l.unitPriceInr === 'number' &&
    Array.isArray(l.addons) &&
    typeof l.specialInstructions === 'string' &&
    typeof l.qty === 'number' &&
    Number.isInteger(l.qty) &&
    l.qty > 0
  );
}

/** Worth keeping: something a staffer would be annoyed to type again. */
export function isDraftWorthKeeping(d: Pick<DraftOrder, 'cart' | 'custName' | 'custPhone' | 'custEmail'>): boolean {
  return d.cart.length > 0 || Boolean(d.custName.trim() || d.custPhone.trim() || d.custEmail.trim());
}

/** Pure: a stored value back into a draft, or null if missing, malformed, empty or too old. */
export function parseDraft(raw: string | null, now: number): DraftOrder | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<DraftOrder> | null;
    if (!d || typeof d !== 'object') return null;
    if (typeof d.savedAt !== 'number' || d.savedAt > now || now - d.savedAt > DRAFT_MAX_AGE_MS) return null;
    if (typeof d.idempotencyKey !== 'string' || !d.idempotencyKey) return null;
    if (!Array.isArray(d.cart) || !d.cart.every(isCartLine)) return null;
    if (!ORDER_TYPES.includes(d.orderType as OrderType)) return null;
    const draft: DraftOrder = {
      savedAt: d.savedAt,
      idempotencyKey: d.idempotencyKey,
      cart: d.cart,
      orderType: d.orderType as OrderType,
      tableId: typeof d.tableId === 'string' && d.tableId ? d.tableId : null,
      custName: typeof d.custName === 'string' ? d.custName : '',
      custPhone: typeof d.custPhone === 'string' ? d.custPhone : '',
      custEmail: typeof d.custEmail === 'string' ? d.custEmail : '',
      showCustomer: d.showCustomer === true,
    };
    return isDraftWorthKeeping(draft) ? draft : null;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readDraft(context: string, now: number = Date.now()): DraftOrder | null {
  const s = session();
  if (!s) return null;
  try {
    return parseDraft(s.getItem(draftStorageKey(context)), now);
  } catch {
    return null;
  }
}

/** Save the draft, or drop it when there is nothing in it worth keeping. */
export function writeDraft(context: string, draft: Omit<DraftOrder, 'savedAt'>, now: number = Date.now()): void {
  const s = session();
  if (!s) return;
  try {
    if (!isDraftWorthKeeping(draft)) {
      s.removeItem(draftStorageKey(context));
      return;
    }
    s.setItem(draftStorageKey(context), JSON.stringify({ ...draft, savedAt: now } satisfies DraftOrder));
  } catch {
    // Quota or private mode: the order still works, it just isn't kept.
  }
}

export function clearDraft(context: string): void {
  const s = session();
  if (!s) return;
  try {
    s.removeItem(draftStorageKey(context));
  } catch {
    /* nothing kept */
  }
}

/** Every draft (sign-out): the next person starts with an empty counter. */
export function clearAllDrafts(): void {
  const s = session();
  if (!s) return;
  try {
    for (let i = s.length - 1; i >= 0; i--) {
      const key = s.key(i);
      if (key && key.startsWith(DRAFT_KEY_PREFIX)) s.removeItem(key);
    }
  } catch {
    /* nothing kept */
  }
}
