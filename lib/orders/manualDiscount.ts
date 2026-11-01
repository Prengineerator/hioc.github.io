// Manager discount — a manager (or the owner) types an amount and a reason at
// the POS, and that many rupees come off the bill (2026-11-manual-discount.sql).
//
// Pure (no server imports): POST /api/orders and the quote route validate the
// request with it, the POS uses the same rules to decide what to show, and
// every bill labels the row with it.
//
// Where it sits in the bill (lib/orders/billPricing.ts composeOrderBill): it
// comes off LAST — after HIOC Ritual cups, the offers, a coupon and Beanies —
// and never more than the bill has left, so it can't push a total below zero.
// It comes off before GST, like a coupon, so GST is charged on what the
// customer actually pays for. It doesn't keep a spend offer off the bill: the
// manager sees the bill with its offers and takes a further amount off that.

import type { UserRole } from '@/lib/types';

/** Longest reason a discount may carry (it is stored on the order and shown to staff). */
export const MAX_MANUAL_DISCOUNT_REASON_LENGTH = 200;

/** Largest amount one discount may name — far above any real bill, a bound on the request. */
export const MAX_MANUAL_DISCOUNT_INR = 100_000;

/** The bill row's label: what the customer sees on every bill and receipt. */
export const MANUAL_DISCOUNT_LABEL = 'Manager discount';

/** Who may give one: a manager or the owner. Staff may not. */
export const MANUAL_DISCOUNT_FORBIDDEN = 'Only a manager or the owner can give a manager discount.';

export function canGiveManualDiscount(role: UserRole | string | null | undefined): boolean {
  return role === 'manager' || role === 'owner';
}

/** A validated discount request. */
export interface ManualDiscountRequest {
  amountInr: number;
  reason: string;
}

export type ParsedManualDiscount =
  | { ok: true; value: ManualDiscountRequest | null }
  | { ok: false; error: string };

/**
 * The `manual_discount` field of an order or quote request:
 * `{ amount_inr, reason }`. Absent, null or an amount of 0 is "none" (null).
 * A positive amount must be whole rupees and must carry a reason.
 */
export function parseManualDiscount(raw: unknown): ParsedManualDiscount {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'manual_discount must be an object' };
  }
  const { amount_inr: amount, reason } = raw as { amount_inr?: unknown; reason?: unknown };
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
    return { ok: false, error: 'The discount must be a whole number of rupees.' };
  }
  if (amount === 0) return { ok: true, value: null };
  if (amount > MAX_MANUAL_DISCOUNT_INR) {
    return { ok: false, error: `The discount can be at most ₹${MAX_MANUAL_DISCOUNT_INR}.` };
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length === 0) return { ok: false, error: 'Give a reason for the discount.' };
  if (trimmed.length > MAX_MANUAL_DISCOUNT_REASON_LENGTH) {
    return { ok: false, error: `The reason can be at most ${MAX_MANUAL_DISCOUNT_REASON_LENGTH} characters.` };
  }
  return { ok: true, value: { amountInr: amount, reason: trimmed } };
}

/**
 * What the POS's amount box holds, as a discount amount: whole rupees above
 * zero, else null (empty, "abc", "-5", "12.5").
 */
export function parseManualDiscountInput(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= MAX_MANUAL_DISCOUNT_INR ? n : null;
}

/**
 * The row's label on a STAFF screen (the POS, Settle): the reason beside it, so
 * whoever settles the bill can see why. Customer bills use MANUAL_DISCOUNT_LABEL.
 */
export function manualDiscountStaffLabel(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  return r ? `${MANUAL_DISCOUNT_LABEL} — ${r}` : MANUAL_DISCOUNT_LABEL;
}
