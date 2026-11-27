// The /shop page's step machine and checkout-attempt rules (docs/SHOP-V2-SPEC.md
// E3, E8). Pure and client-safe: no React, no storage, no network, so the
// rules can be tested without a browser. The page (components/shop) holds the
// state and the pixels; this file decides:
//
//   - which step comes next, and whether the customer may go there
//     (Choose -> Deliver to -> Pay). A signed-in customer with a saved address
//     selected skips "Deliver to": it shows as a summary card at the top of Pay.
//   - which step a visit opens on (a reorder hand-off, a cart restored after the
//     /login round trip, a default address)
//   - what the one primary button says on each step
//   - when a checkout attempt keeps its Idempotency-Key and when it takes a
//     new one (a plain retry reuses it, so two taps never make two orders)
//   - the cart's display lines, built without prices going through the quote, so
//     the cart drawer can always show (and remove) what is in the cart
//
// The server prices everything; nothing here is money logic except the label.

import { normalizeEmail } from '@/lib/email';
import { validateShopAddress, type AddressField } from './address';
import { checkoutFingerprintSource, type CheckoutFingerprintInput } from './checkoutKey';
import { GRINDS, lineSku } from './catalog';
import { cartItemKey, rupees, type CartItem } from './pricing';
import type { ShopCartStep } from './cart';
import type { ShopAddress, ShopLine, ShopProduct } from './types';

export type ShopStep = ShopCartStep;

export const SHOP_STEPS: readonly ShopStep[] = ['choose', 'deliver', 'pay'];

export const STEP_TITLES: Record<ShopStep, string> = {
  choose: 'Choose',
  deliver: 'Deliver to',
  pay: 'Pay',
};

/**
 * Where the parcel goes, as the customer has set it so far.
 *   saved  a saved address of the signed-in customer, plus the receipt email
 *          (a saved address holds no email)
 *   form   the address form's fields (email included)
 */
export interface DeliverySelection {
  mode: 'saved' | 'form';
  addressId: string | null;
  /** The receipt email, used in 'saved' mode. */
  email: string;
  /** The form's fields, used in 'form' mode. */
  form: Record<string, unknown>;
}

export interface FlowState {
  step: ShopStep;
  /** Units in the cart. */
  itemCount: number;
  delivery: DeliverySelection;
}

export type CanAdvance = { ok: true } | { ok: false; reason: string; focus?: string };

/** The delivery address, checked: a validated address for the form, or the saved one's id plus a good email. */
export type DeliveryCheck =
  | { ok: true; mode: 'form'; address: ShopAddress }
  | { ok: true; mode: 'saved'; addressId: string; email: string }
  | { ok: false; reason: string; focus?: string };

export function checkDelivery(d: DeliverySelection): DeliveryCheck {
  if (d.mode === 'saved') {
    if (!d.addressId) return { ok: false, reason: 'Choose where to deliver', focus: 'address' };
    const email = normalizeEmail(d.email.trim());
    if (!email) return { ok: false, reason: 'Enter an email for your receipt and tracking link', focus: 'email' };
    return { ok: true, mode: 'saved', addressId: d.addressId, email };
  }
  const checked = validateShopAddress(d.form);
  if (!checked.ok) return { ok: false, reason: checked.error, focus: checked.field };
  return { ok: true, mode: 'form', address: checked.address };
}

/** Whether the customer may leave `state.step` for the next one, and if not, why and which field to focus. */
export function canAdvance(state: FlowState): CanAdvance {
  if (state.step === 'choose') {
    return state.itemCount >= 1 ? { ok: true } : { ok: false, reason: 'Add something to your order to continue', focus: 'products' };
  }
  const delivery = checkDelivery(state.delivery);
  if (!delivery.ok) return { ok: false, reason: delivery.reason, focus: delivery.focus };
  if (state.step === 'pay' && state.itemCount < 1) {
    return { ok: false, reason: 'Add something to your order to continue', focus: 'products' };
  }
  return { ok: true };
}

/** A saved address is selected and nothing else is missing (the receipt email), so Deliver to has nothing left to ask. */
function deliveryComplete(delivery: DeliverySelection): boolean {
  return delivery.mode === 'saved' && checkDelivery(delivery).ok;
}

/**
 * The step after this one. From Choose, a complete saved address goes straight
 * to Pay (Deliver to shows there as a summary card); anything else, including a
 * saved address that still needs a receipt email, goes to Deliver to. Pay is
 * the last step.
 */
export function nextStep(state: Pick<FlowState, 'step' | 'delivery'>): ShopStep {
  if (state.step === 'choose') return deliveryComplete(state.delivery) ? 'pay' : 'deliver';
  return 'pay';
}

/** The step the Back button goes to (Pay goes back past a skipped Deliver to). */
export function prevStep(state: Pick<FlowState, 'step' | 'delivery'>): ShopStep {
  if (state.step === 'pay') return deliveryComplete(state.delivery) ? 'choose' : 'deliver';
  return 'choose';
}

export interface InitialStepInput {
  /** The cart as stored (lib/shop/cart.ts readShopCart), or null. */
  stored: { items: readonly unknown[]; step: ShopStep } | null;
  /** The `step` query parameter of the page URL. */
  query: string | null | undefined;
  /** A signed-in customer with at least one saved address. */
  hasDefaultAddress: boolean;
}

/**
 * The step a visit opens on.
 *   - no stored cart (or an empty one): Choose
 *   - `?step=pay` with a stored cart (the Order again hand-off): Pay
 *   - a stored cart left on Deliver to or Pay (a reload, or the /login round
 *     trip): back to Deliver to, which a customer with a saved address skips
 *     straight to Pay
 *   - otherwise Choose, with the cart restored
 */
export function initialStep({ stored, query, hasDefaultAddress }: InitialStepInput): ShopStep {
  if (!stored || stored.items.length === 0) return 'choose';
  if (query === 'pay') return 'pay';
  if (stored.step === 'deliver' || stored.step === 'pay') return hasDefaultAddress ? 'pay' : 'deliver';
  return 'choose';
}

/** The one primary button's label: 'Continue', 'Continue to pay', 'Pay ₹1,197'. */
export function primaryActionLabel(step: ShopStep, totalInr: number | null | undefined): string {
  if (step === 'choose') return 'Continue';
  if (step === 'deliver') return 'Continue to pay';
  return typeof totalInr === 'number' && Number.isFinite(totalInr) && totalInr > 0 ? `Pay ${rupees(totalInr)}` : 'Pay';
}

// ---------------------------------------------------------------------------
// Idempotency-Key policy (docs/SHOP-V2-SPEC.md E8)
// ---------------------------------------------------------------------------

/** What identifies a checkout attempt on the client: the server's own fingerprint source, plus the delivery pin. */
export function attemptFingerprint(
  input: Omit<CheckoutFingerprintInput, 'address'> & {
    /** The validated address, or (for a saved address) just what the customer typed, such as { email }. */
    address: unknown;
  },
  pin: unknown = null,
): string {
  return `${checkoutFingerprintSource(input as CheckoutFingerprintInput)}|${JSON.stringify(pin ?? null)}`;
}

/** The server answers that mean the old key can't be used again. */
const KEY_BURNT_CODES: ReadonlySet<string> = new Set(['idempotency_mismatch', 'idempotency_expired']);

/**
 * Should the next Pay tap take a new Idempotency-Key?
 *   - yes when there is no earlier attempt, or the cart / address / code /
 *     Beanies choice changed since it (a different order is a different key)
 *   - yes after idempotency_mismatch or idempotency_expired (the server
 *     refuses that key now)
 *   - no for a plain retry (network error, dismissed payment window, a 5xx, a
 *     409 that only asked the customer to look at the new total), so the same
 *     order is found again and never doubled
 */
export function shouldRotateKey(
  prevFingerprint: string | null | undefined,
  nextFingerprint: string,
  lastResultCode: string | null | undefined,
): boolean {
  if (!prevFingerprint) return true;
  if (prevFingerprint !== nextFingerprint) return true;
  return lastResultCode ? KEY_BURNT_CODES.has(lastResultCode) : false;
}

// ---------------------------------------------------------------------------
// Cart display lines
// ---------------------------------------------------------------------------

/**
 * The cart as display lines, priced from the products as they are on the page.
 * Used by the cart drawer, so it always shows (and can remove) every line even
 * when the quote refuses the cart (an item went out of stock). Items whose
 * product is unknown are left out. This is a display aid, not a price: the
 * server prices the order.
 */
export function buildCartLines(products: readonly ShopProduct[], items: readonly CartItem[]): ShopLine[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: ShopLine[] = [];
  for (const item of items) {
    const p = byId.get(item.product_id);
    if (!p || !(item.quantity > 0)) continue;
    const grind = item.grind ?? null;
    const g = grind ? GRINDS.find((x) => x.code === grind) : undefined;
    out.push({
      product_id: p.id,
      name: p.display_name || p.name,
      sku: lineSku(p.sku, grind),
      unit_price_inr: p.price_inr,
      quantity: item.quantity,
      line_total_inr: p.price_inr * item.quantity,
      line: p.line,
      base_sku: p.sku,
      pack_grams: p.pack_grams,
      grind,
      grind_label: g ? g.label : null,
      ship_weight_kg: p.ship_weight_kg,
    });
  }
  return out;
}

/** The cart key of a display line (product + grind), as lib/shop/pricing.ts cartItemKey builds it. */
export function lineKey(l: Pick<ShopLine, 'product_id' | 'grind'>): string {
  return cartItemKey({ product_id: l.product_id, quantity: 0, grind: l.grind ?? null });
}

/** Address form fields the server can name in a 400 { field }. */
export const FORM_FIELDS: readonly AddressField[] = [
  'customer_name', 'phone', 'email', 'address_line1', 'address_line2', 'landmark', 'city', 'state', 'pincode',
];

export function isAddressField(v: unknown): v is AddressField {
  return typeof v === 'string' && (FORM_FIELDS as readonly string[]).includes(v);
}

// ---- Pay step: what stays on screen while the server re-prices (SV2-11) ----

/**
 * The quote the Pay step and the sticky bar show.
 * Rule: once a server figure has arrived, a refresh in flight (a Beanies tap, a
 * code, a cart change) keeps showing the LAST server quote, marked "updating",
 * instead of dropping to the local one. The local quote is built without
 * Beanies or a coupon, so falling back to it would unmount the Beanies row the
 * customer just tapped (losing keyboard focus), hide the coupon row and the
 * "You'll earn" line, and make the aria-live total announce a higher figure
 * before the real one. Pay is disabled while loading, so a stale
 * expected_total_inr is never sent. On Choose, and before any server figure
 * exists, the local figure is the instant one.
 */
export function pickDisplayQuote<Q>(args: {
  step: ShopStep;
  /** The quote the hook resolved (server's when current, else local). */
  quote: Q | null;
  fromServer: boolean;
  /** The last server quote, whatever inputs it was for (null before the first). */
  lastServerQuote: Q | null;
  loading: boolean;
}): Q | null {
  if (args.step === 'pay' && !args.fromServer && args.loading && args.lastServerQuote) return args.lastServerQuote;
  return args.quote;
}

/**
 * The applied code is one the server refused (couponError on a server quote).
 * Paying would only get a 409 'coupon' back every time, so Pay is held until the
 * customer removes the code. The code is never dropped silently.
 */
export function isCouponBlocked(args: { appliedCode: string | null; couponError: string | null; fromServer: boolean }): boolean {
  return Boolean(args.appliedCode && args.couponError && args.fromServer);
}

/** "This code can't be used: <reason>. Remove it to pay ₹X". */
export function couponBlockedMessage(reason: string, totalInr: number): string {
  const r = reason.trim().replace(/[.\s]+$/, '');
  return `This code can't be used: ${r}. Remove it to pay ${rupees(totalInr)}`;
}
