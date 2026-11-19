// Owner-entered shop orders (docs/SHOP-OWNER-ORDERS-SPEC.md): the pure parts. The
// request body → checked values, and the fingerprint that makes a repeat of the
// same attempt (same Idempotency key) recognisable. No database here.

import { validateShopAddress } from './address';
import { isIdempotencyKey, checkoutFingerprintSource } from './checkoutKey';
import { parseCartItems, type CartItem } from './pricing';
import type { ShopAddress, ShopOfflineMethod } from './types';

export const OFFLINE_METHODS: readonly ShopOfflineMethod[] = ['upi_direct', 'cash', 'bank_transfer'];
export const OFFLINE_METHOD_LABELS: Record<ShopOfflineMethod, string> = {
  upi_direct: 'UPI to café',
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
};

/** A payment link is good for this long. */
export const PAYMENT_LINK_VALID_HOURS = 48;

export type OwnerPayment =
  | { kind: 'link' }
  | { kind: 'offline'; method: ShopOfflineMethod; reference: string };

export interface OwnerOrderInput {
  idempotency_key: string;
  address: ShopAddress;
  items: CartItem[];
  coupon_code: string | null;
  owner_discount_inr: number;
  /** null when there is no discount. */
  owner_discount_reason: string | null;
  payment: OwnerPayment;
  expected_total_inr: number | null;
}

export type OwnerOrderParse = { ok: true; input: OwnerOrderInput } | { ok: false; error: string; field?: string };

const squash = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** The owner discount as typed: whole rupees, 0 when absent. Null when it is not a whole non-negative number. */
export function parseOwnerDiscountAmount(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 0;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/** POST /api/owner/shop/orders's body → checked values (the price is NOT decided here). */
export function parseOwnerOrderBody(body: Record<string, unknown>): OwnerOrderParse {
  if (!isIdempotencyKey(typeof body.idempotency_key === 'string' ? body.idempotency_key.trim() : body.idempotency_key)) {
    return { ok: false, error: 'idempotency_key must be a uuid', field: 'idempotency_key' };
  }
  const idempotency_key = (body.idempotency_key as string).trim().toLowerCase();

  const cart = parseCartItems(body.items);
  if (!cart.ok) return { ok: false, error: cart.error, field: 'items' };

  const address = validateShopAddress(body.address, { emailOptional: true });
  if (!address.ok) return { ok: false, error: address.error, field: address.field };

  const owner_discount_inr = parseOwnerDiscountAmount(body.owner_discount_inr);
  if (owner_discount_inr === null) return { ok: false, error: 'The owner discount must be a whole rupee amount', field: 'owner_discount_inr' };
  let owner_discount_reason: string | null = null;
  if (owner_discount_inr > 0) {
    const reason = squash(body.owner_discount_reason);
    if (reason.length < 3) return { ok: false, error: 'Give a reason for the discount (3 to 80 characters)', field: 'owner_discount_reason' };
    if (reason.length > 80) return { ok: false, error: 'The reason is too long (80 characters at most)', field: 'owner_discount_reason' };
    owner_discount_reason = reason;
  }

  const p = typeof body.payment === 'object' && body.payment !== null ? (body.payment as Record<string, unknown>) : {};
  let payment: OwnerPayment;
  if (p.kind === 'link') payment = { kind: 'link' };
  else if (p.kind === 'offline') {
    if (!OFFLINE_METHODS.includes(p.method as ShopOfflineMethod)) {
      return { ok: false, error: 'Choose how it was paid: UPI to café, cash or bank transfer', field: 'payment' };
    }
    const reference = squash(p.reference);
    if (reference.length < 3 || reference.length > 60) {
      return { ok: false, error: 'Add a payment reference (3 to 60 characters)', field: 'payment' };
    }
    payment = { kind: 'offline', method: p.method as ShopOfflineMethod, reference };
  } else {
    return { ok: false, error: 'Choose how the customer pays', field: 'payment' };
  }

  const expected = body.expected_total_inr;
  if (expected !== undefined && expected !== null && (typeof expected !== 'number' || !Number.isInteger(expected))) {
    return { ok: false, error: 'expected_total_inr must be a whole number', field: 'expected_total_inr' };
  }

  const couponCode = typeof body.coupon_code === 'string' && body.coupon_code.trim() ? body.coupon_code.trim().slice(0, 40) : null;
  return {
    ok: true,
    input: {
      idempotency_key,
      address: address.address,
      items: cart.items,
      coupon_code: couponCode,
      owner_discount_inr,
      owner_discount_reason,
      payment,
      expected_total_inr: typeof expected === 'number' ? expected : null,
    },
  };
}

/** What makes two attempts "the same": the website's fingerprint inputs plus the owner discount and the way it is paid. */
export function ownerOrderFingerprintSource(input: OwnerOrderInput): string {
  const base = checkoutFingerprintSource({
    items: input.items,
    address: input.address,
    address_id: null,
    coupon_code: input.coupon_code,
    use_beanies: false,
    save_address_label: null,
  });
  return JSON.stringify([
    'owner-order',
    base,
    input.owner_discount_inr,
    input.owner_discount_reason,
    input.payment.kind,
    input.payment.kind === 'offline' ? [input.payment.method, input.payment.reference] : null,
  ]);
}
