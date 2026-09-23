// REF-1 — what may be refunded, on which tender, for a counter-settled order.
//
// Pure and dependency-free so the rules are tested with plain fixtures. The
// route enforces them; the staff UI only renders what these return.
//
// D4-2 (spec §6) is decided here: a refund is issued against a CHOSEN tender,
// not spread proportionally across a split. Handing ₹200 back from the drawer
// and reversing ₹280 on UPI are different physical acts with different limits —
// you cannot return more cash than the customer actually paid in cash — so the
// staffer names the tender and the balance is enforced per tender.

import type { PaymentMethod } from '@/lib/types';

export interface TenderPart {
  method: PaymentMethod;
  amount_inr: number;
}

export interface PriorRefund {
  /** Null on legacy rows written before REF-1. */
  method: PaymentMethod | null;
  amount_inr: number;
}

export interface TenderBalance {
  method: PaymentMethod;
  paid_inr: number;
  refunded_inr: number;
  refundable_inr: number;
}

/**
 * Per-tender refundable balances.
 *
 * `parts` is the order's order_payments rows; for an order settled before
 * POS4-1 the caller passes a single synthetic part (its method + total).
 *
 * Legacy refunds carry no method. Attributing them to nothing would let the same
 * money be refunded twice, so they are charged against the LARGEST tender —
 * the most likely source, and the conservative choice because it shrinks what
 * can still be returned rather than inflating it.
 */
export function tenderBalances(parts: TenderPart[], priorRefunds: PriorRefund[]): TenderBalance[] {
  const paid = new Map<PaymentMethod, number>();
  for (const p of parts) {
    paid.set(p.method, (paid.get(p.method) ?? 0) + p.amount_inr);
  }

  const refunded = new Map<PaymentMethod, number>();
  let unattributed = 0;
  for (const r of priorRefunds) {
    if (r.method) refunded.set(r.method, (refunded.get(r.method) ?? 0) + r.amount_inr);
    else unattributed += r.amount_inr;
  }

  if (unattributed > 0 && paid.size > 0) {
    let largest: PaymentMethod = parts[0].method;
    for (const [method, amount] of paid) {
      if (amount > (paid.get(largest) ?? 0)) largest = method;
    }
    refunded.set(largest, (refunded.get(largest) ?? 0) + unattributed);
  }

  return [...paid.entries()].map(([method, paidInr]) => {
    const refundedInr = refunded.get(method) ?? 0;
    return {
      method,
      paid_inr: paidInr,
      refunded_inr: refundedInr,
      // Clamped: an over-attributed legacy refund must not produce a negative
      // balance that reads as "we owe them money".
      refundable_inr: Math.max(0, paidInr - refundedInr),
    };
  });
}

export type RefundValidation =
  | { ok: true; method: PaymentMethod; amountInr: number }
  | { ok: false; error: string };

/**
 * Validates a requested counter refund against the per-tender balances.
 * `requestedMethod` may be omitted when the order has exactly one tender.
 * `requestedAmount` may be omitted to mean "everything still refundable on that
 * tender".
 */
export function validateCounterRefund(
  balances: TenderBalance[],
  requestedMethod: unknown,
  requestedAmount: unknown,
): RefundValidation {
  const withBalance = balances.filter((b) => b.refundable_inr > 0);
  if (withBalance.length === 0) {
    return { ok: false, error: 'This order has already been fully refunded.' };
  }

  let method: PaymentMethod;
  if (requestedMethod === undefined || requestedMethod === null) {
    if (withBalance.length > 1) {
      return {
        ok: false,
        error: `This order was split — choose which tender to refund: ${withBalance
          .map((b) => `${b.method} (₹${b.refundable_inr} left)`)
          .join(', ')}`,
      };
    }
    method = withBalance[0].method;
  } else {
    if (
      requestedMethod !== 'cash' &&
      requestedMethod !== 'upi' &&
      requestedMethod !== 'card' &&
      requestedMethod !== 'online'
    ) {
      return { ok: false, error: 'method must be one of: cash, upi, card, online' };
    }
    method = requestedMethod;
  }

  const balance = balances.find((b) => b.method === method);
  if (!balance || balance.refundable_inr <= 0) {
    return {
      ok: false,
      error: `Nothing left to refund on ${method} for this order.`,
    };
  }

  let amountInr = balance.refundable_inr;
  if (requestedAmount !== undefined && requestedAmount !== null) {
    if (
      typeof requestedAmount !== 'number' ||
      !Number.isInteger(requestedAmount) ||
      requestedAmount <= 0
    ) {
      return { ok: false, error: 'amount_inr must be a positive whole number of rupees' };
    }
    amountInr = requestedAmount;
  }

  if (amountInr > balance.refundable_inr) {
    // The hard rule: you cannot hand back more cash than came in as cash.
    return {
      ok: false,
      error: `Only ₹${balance.refundable_inr} is refundable on ${method} for this order.`,
    };
  }

  return { ok: true, method, amountInr };
}

/** Total refunded across every tender, for deciding refunded vs partially_refunded. */
export function totalRefundedInr(priorRefunds: PriorRefund[]): number {
  return priorRefunds.reduce((sum, r) => sum + r.amount_inr, 0);
}
