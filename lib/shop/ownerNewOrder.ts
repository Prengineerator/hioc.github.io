// The owner's "New order" page (docs/SHOP-OWNER-ORDERS-SPEC.md): the pure parts. Cart lines for
// display, the idempotency-key lifecycle, the WhatsApp text, the bill rows and the plain-words
// reading of the server's errors. No React and no fetch here, so it is all unit-tested.
// The server prices every order; nothing here works out a price.

import { normalizeIndianMobile } from '../phone';
import { shouldRotateKey } from './checkoutFlow';
import { GRINDS, packLabel } from './catalog';
import { addCartItem, setCartItemQuantity } from './cart';
import { cartItemKey, rupees, type CartItem } from './pricing';
import type { GrindCode, ShopProduct } from './types';

// ---------------------------------------------------------------------------
// Cart lines (display only)
// ---------------------------------------------------------------------------

export interface OwnerCartLine {
  key: string;
  product_id: string;
  quantity: number;
  grind: GrindCode | null;
  /** "Hazelnut" or "Home Blend 250 g · Filter" */
  title: string;
  unit_price_inr: number;
  /** quantity × list price. A display aid; the bill is the server's. */
  line_total_inr: number;
}

/** The cart as rows the owner can edit. Items whose product is no longer on the page are left out. */
export function ownerCartLines(products: readonly ShopProduct[], items: readonly CartItem[]): OwnerCartLine[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: OwnerCartLine[] = [];
  for (const item of items) {
    const p = byId.get(item.product_id);
    if (!p || !(item.quantity > 0)) continue;
    const grind = item.grind ?? null;
    const g = grind ? GRINDS.find((x) => x.code === grind) : undefined;
    const base = p.line === 'home_blend' ? `${p.display_name || p.name} ${packLabel(p.pack_grams)}` : p.name;
    out.push({
      key: cartItemKey(item),
      product_id: p.id,
      quantity: item.quantity,
      grind,
      title: g ? `${base} · ${g.short}` : base,
      unit_price_inr: p.price_inr,
      line_total_inr: p.price_inr * item.quantity,
    });
  }
  return out;
}

/** Units of one product in the cart, over all its grinds. */
export function unitsOfProduct(items: readonly CartItem[], productId: string): number {
  return items.filter((i) => i.product_id === productId).reduce((n, i) => n + i.quantity, 0);
}

/** Sets the units of an instant jar (no grind): adds the line, changes it, or removes it at 0. Never more than 12 units in all. */
export function setInstantQuantity(items: CartItem[], productId: string, quantity: number): CartItem[] {
  const key = cartItemKey({ product_id: productId, quantity: 0 });
  const have = items.find((i) => cartItemKey(i) === key);
  if (!have) return addCartItem(items, { product_id: productId, quantity });
  return setCartItemQuantity(items, key, quantity);
}

/** What the owner typed in the phone box → at most 10 digits. A pasted "+91 98765 43210" loses its +91. */
export function cleanPhoneInput(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length > 10) return normalizeIndianMobile(raw) ?? digits.slice(0, 10);
  return digits;
}

/** The discount box → whole rupees, or null when it is not a whole number. Empty is 0. */
export function parseDiscountInput(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return 0;
  if (!/^\d{1,6}$/.test(t)) return null;
  return Number(t);
}

/** The products the owner can sell: listed and in stock. */
export function sellableProducts(products: readonly ShopProduct[]): ShopProduct[] {
  return products.filter((p) => p.listed && p.in_stock);
}

// ---------------------------------------------------------------------------
// Idempotency key (one per attempt, kept across retries of the same form)
// ---------------------------------------------------------------------------

export interface AttemptKeyState {
  key: string;
  /** The form as it was when the key was first used; null once the key is spent. */
  fingerprint: string | null;
}

/**
 * The key for the next tap of "Create order".
 *   - no earlier attempt (or the last one succeeded)         -> a new key
 *   - the form changed since the earlier attempt             -> a new key (a different order)
 *   - the server called the key burnt (idempotency_mismatch / idempotency_expired) -> a new key
 *   - otherwise (network error, 5xx, a 409 that only showed a new total) -> the SAME key, so a
 *     retry finds the order the first try made and never doubles it.
 */
export function nextAttemptKey(
  prev: AttemptKeyState | null,
  fingerprint: string,
  lastCode: string | null | undefined,
  makeKey: () => string,
): AttemptKeyState {
  if (!prev || prev.fingerprint === null || shouldRotateKey(prev.fingerprint, fingerprint, lastCode)) {
    return { key: makeKey(), fingerprint };
  }
  return prev;
}

/** After a success the key is spent: the next order, even a copy of this one, takes a new key. */
export function spendKey(state: AttemptKeyState): AttemptKeyState {
  return { key: state.key, fingerprint: null };
}

/** What makes two taps "the same order": everything the server prices or stores. */
export function attemptFingerprintOf(form: {
  address: unknown;
  items: readonly CartItem[];
  couponCode: string;
  ownerDiscountInr: number;
  ownerDiscountReason: string;
  payment: unknown;
}): string {
  return JSON.stringify([
    form.address,
    [...form.items].map((i) => [i.product_id, i.quantity, i.grind ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2]))),
    form.couponCode.trim().toUpperCase(),
    form.ownerDiscountInr,
    form.ownerDiscountInr > 0 ? form.ownerDiscountReason.trim() : '',
    form.payment,
  ]);
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

/** The message the owner sends the customer with their payment link. */
export function paymentLinkMessage(o: { orderRef: string; totalInr: number; url: string }): string {
  return `Hi! Your HIOC. order ${o.orderRef} is ready. Total ${rupees(o.totalInr)}. Pay here: ${o.url} (the link is valid for 48 hours). Thank you!`;
}

/** Opens WhatsApp with the message filled in and nobody chosen. Nothing is sent by the site. */
export function whatsappShareUrl(o: { orderRef: string; totalInr: number; url: string }): string {
  return `https://wa.me/?text=${encodeURIComponent(paymentLinkMessage(o))}`;
}

// ---------------------------------------------------------------------------
// The bill, from the server's quote
// ---------------------------------------------------------------------------

/** The quote as POST /api/owner/shop/quote returns it. */
export interface OwnerQuote {
  subtotal_inr: number;
  offer_discount_inr: number;
  offer_name: string | null;
  coupon_discount_inr: number;
  coupon_code: string | null;
  owner_discount_inr: number;
  shipping_inr: number;
  total_inr: number;
  intro_offer_applied: boolean;
  notes: string[];
}

export interface BillRow {
  key: 'subtotal' | 'offer' | 'coupon' | 'owner' | 'shipping' | 'total';
  label: string;
  /** Formatted: "₹1,449", "−₹100" or "Free". */
  value: string;
}

/** The server's quote → the rows to show, in order. Discount rows appear only when above zero. */
export function quoteBillRows(q: OwnerQuote): BillRow[] {
  const rows: BillRow[] = [{ key: 'subtotal', label: 'Items', value: rupees(q.subtotal_inr) }];
  if (q.offer_discount_inr > 0) rows.push({ key: 'offer', label: q.offer_name || 'Introductory offer', value: `−${rupees(q.offer_discount_inr)}` });
  if (q.coupon_discount_inr > 0) rows.push({ key: 'coupon', label: `Coupon ${q.coupon_code ?? ''}`.trim(), value: `−${rupees(q.coupon_discount_inr)}` });
  if (q.owner_discount_inr > 0) rows.push({ key: 'owner', label: 'Owner discount', value: `−${rupees(q.owner_discount_inr)}` });
  rows.push({ key: 'shipping', label: 'Shipping', value: q.shipping_inr > 0 ? rupees(q.shipping_inr) : 'Free' });
  rows.push({ key: 'total', label: 'Total', value: rupees(q.total_inr) });
  return rows;
}

// ---------------------------------------------------------------------------
// Reading the server's answers
// ---------------------------------------------------------------------------

export type CreateFailure =
  | { kind: 'price_changed'; message: string; quote: OwnerQuote }
  | { kind: 'field'; message: string; field: string }
  | { kind: 'link_failed'; message: string }
  | { kind: 'setup_migration'; message: string }
  | { kind: 'setup_razorpay'; message: string }
  | { kind: 'key_burnt'; message: string; code: string }
  | { kind: 'other'; message: string; code?: string };

/**
 * POST /api/owner/shop/orders failed: what to tell the owner and what to do. The 503s are told
 * apart by their text: the route words the Razorpay one "Payment links aren't available...",
 * and the missing-database-file ones "...aren't set up yet" / "The shop isn't open yet".
 */
export function readCreateFailure(status: number, data: unknown): CreateFailure {
  const d = (typeof data === 'object' && data !== null ? data : {}) as { error?: unknown; code?: unknown; field?: unknown; quote?: unknown };
  const error = typeof d.error === 'string' ? d.error : '';
  const code = typeof d.code === 'string' ? d.code : undefined;
  if (status === 409 && (code === 'price_changed' || code === 'coupon') && d.quote && typeof d.quote === 'object') {
    return { kind: 'price_changed', message: code === 'coupon' ? error || "That coupon doesn't apply any more." : "The price changed: here's the new total.", quote: d.quote as OwnerQuote };
  }
  if (status === 409 && (code === 'idempotency_mismatch' || code === 'idempotency_expired')) {
    return { kind: 'key_burnt', code, message: 'That attempt can no longer be used. Check the details and tap Create order again.' };
  }
  if (status === 409 && code === 'idempotency_in_progress') {
    return { kind: 'other', code, message: 'This order is still being saved. Wait a moment and tap Create order again.' };
  }
  if (status === 400) {
    const field = typeof d.field === 'string' ? d.field : null;
    const message = error || 'Please check the details and try again.';
    return field ? { kind: 'field', field, message } : { kind: 'other', message };
  }
  if (status === 502) {
    return { kind: 'link_failed', message: "Couldn't create the payment link. Nothing was saved. Try again, or record it as already paid." };
  }
  if (status === 503) {
    if (/payment link/i.test(error) || /razorpay/i.test(error)) {
      return { kind: 'setup_razorpay', message: "Razorpay isn't set up, so payment links can't be sent. You can record it as already paid." };
    }
    return {
      kind: 'setup_migration',
      message: 'Setup not finished: the database file for owner orders (supabase/2026-11-shop-owner-orders.sql) needs to be run on Hioc India.',
    };
  }
  if (status === 429) return { kind: 'other', message: error || 'Too many tries. Wait a few minutes and try again.' };
  if (status === 401) return { kind: 'other', message: 'You have been signed out. Sign in again, then come back to this page.' };
  return { kind: 'other', message: error || `Something went wrong (HTTP ${status}). Nothing was lost; try again.` };
}

/** The route's field names → our form's field ids. */
export function formFieldFor(field: string): string {
  switch (field) {
    case 'customer_name':
    case 'address_line1':
    case 'address_line2':
    case 'landmark':
    case 'city':
    case 'state':
    case 'pincode':
    case 'phone':
    case 'email':
      return field;
    case 'owner_discount_inr':
      return 'owner-discount';
    case 'owner_discount_reason':
      return 'owner-discount-reason';
    case 'payment':
      return 'payment';
    case 'items':
      return 'items';
    default:
      return field;
  }
}

// ---------------------------------------------------------------------------
// Cancel (order card)
// ---------------------------------------------------------------------------

export interface CancelNotice {
  tone: 'ok' | 'warn' | 'error';
  text: string;
  /** The card should refresh the list (the order moved). */
  refresh: boolean;
}

/** Plain words for the answer to POST /api/owner/shop/orders/[id]/cancel. */
export function readCancelAnswer(status: number, data: unknown, totalInr: number): CancelNotice {
  const d = (typeof data === 'object' && data !== null ? data : {}) as { error?: string; refund_by_hand?: boolean; warning?: string; order?: { refunded_inr?: number | null } };
  if (status >= 200 && status < 300) {
    if (d.refund_by_hand) {
      const amount = d.order?.refunded_inr && d.order.refunded_inr > 0 ? d.order.refunded_inr : totalInr;
      return {
        tone: 'warn',
        refresh: false,
        text: `Cancelled. Send ${rupees(amount)} back to the customer yourself (UPI/cash/bank). The site never held this money.${d.warning ? ` ${d.warning}` : ''}`,
      };
    }
    return { tone: d.warning ? 'warn' : 'ok', refresh: false, text: d.warning ? d.warning : 'Cancelled.' };
  }
  if (status === 409) {
    return { tone: 'warn', refresh: true, text: d.error || 'This order has just changed, probably because the customer paid the link. The list is refreshed: look for it under To ship.' };
  }
  if (status === 502) {
    return { tone: 'error', refresh: false, text: "Couldn't reach Razorpay, so nothing was changed. Try again in a moment." };
  }
  return { tone: 'error', refresh: false, text: d.error || `Something went wrong (HTTP ${status}).` };
}

/** The payment line on an order card, or null for a website checkout (it shows the method already). */
export function paymentLineOf(o: { payment_channel: string | null | undefined; offline_method: string | null | undefined; payment_reference: string | null | undefined }): string | null {
  if (o.payment_channel === 'payment_link') return 'Payment link';
  if (o.payment_channel !== 'offline') return null;
  const how = o.offline_method === 'cash' ? 'Cash' : o.offline_method === 'bank_transfer' ? 'Bank transfer' : 'Paid by UPI to café';
  return o.payment_reference ? `${how} · ref ${o.payment_reference}` : how;
}

// ---------------------------------------------------------------------------
// Link not confirmed (202) and Retry link
// ---------------------------------------------------------------------------

/** An awaiting link order whose payment link was never confirmed: Retry link and Cancel only. */
export function needsLinkRetry(o: { status: string; payment_channel: string | null | undefined; payment_link_url: string | null | undefined }): boolean {
  return o.status === 'payment_pending' && o.payment_channel === 'payment_link' && !o.payment_link_url;
}

export interface LinkPending {
  order_id: string;
  order_number: number;
  message: string;
}

/** POST /api/owner/shop/orders answered 202: saved, but the link is not confirmed. Null for any other body. */
export function readLinkPending(status: number, data: unknown): LinkPending | null {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  if (status !== 202 || d.link_pending !== true || typeof d.order_id !== 'string') return null;
  return { order_id: d.order_id, order_number: Number(d.order_number), message: typeof d.message === 'string' ? d.message : '' };
}

export type RetryOutcome =
  | { kind: 'link'; url: string; expiresAt: string | null }
  | { kind: 'paid' }
  | { kind: 'unconfirmed'; message: string }
  | { kind: 'gone'; message: string }
  | { kind: 'error'; message: string };

/** The answer to POST …/payment-link {action:'retry'}. */
export function readRetryAnswer(status: number, data: unknown): RetryOutcome {
  const d = (typeof data === 'object' && data !== null ? data : {}) as { error?: string; payment_link_url?: unknown; payment_link_expires_at?: unknown; status?: unknown };
  if (status >= 200 && status < 300) {
    if (d.status === 'paid') return { kind: 'paid' };
    if (typeof d.payment_link_url === 'string' && d.payment_link_url) {
      return { kind: 'link', url: d.payment_link_url, expiresAt: typeof d.payment_link_expires_at === 'string' ? d.payment_link_expires_at : null };
    }
    return { kind: 'error', message: 'Razorpay did not give a link. Try again.' };
  }
  if (status === 502) return { kind: 'unconfirmed', message: "Couldn't reach Razorpay or it wouldn't confirm the link. Nothing was changed. Try again in a moment." };
  if (status === 409) return { kind: 'gone', message: d.error || 'This order is no longer waiting for a link. The list is refreshed.' };
  return { kind: 'error', message: d.error || `Something went wrong (HTTP ${status}).` };
}

export type ProductsAnswer = { kind: 'ok'; products: ShopProduct[] } | { kind: 'setup'; message: string } | { kind: 'error'; message: string };

/** GET /api/owner/shop/products. A 503 that names a missing database file is "setup"; any other failure can be retried. */
export function readProductsAnswer(status: number, data: unknown): ProductsAnswer {
  const d = (typeof data === 'object' && data !== null ? data : {}) as { products?: unknown; error?: string };
  if (status >= 200 && status < 300 && Array.isArray(d.products)) return { kind: 'ok', products: d.products as ShopProduct[] };
  if (status === 503 && /apply supabase|isn't set up|not set up/i.test(d.error ?? '')) {
    return { kind: 'setup', message: 'Setup not finished: the shop database file needs to be run on Hioc India.' };
  }
  if (status === 401) return { kind: 'error', message: 'You have been signed out. Sign in again, then come back to this page.' };
  return { kind: 'error', message: "Couldn't load the products. Check the connection and try again." };
}
