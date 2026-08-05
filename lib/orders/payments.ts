// POS4-1 — pure math and validation for counter settlement: cash change and
// split payments.
//
// Dependency-free on purpose (no DB, no Supabase) so the money rules are unit
// tested with plain fixtures. The route enforces them; the POS renders what
// these return. As everywhere else in this codebase, the client never decides
// an amount — it only displays one.

import type { PaymentMethod } from '@/lib/types';

export interface PaymentPart {
  method: PaymentMethod;
  amount_inr: number;
  /** Cash only: what the customer handed over. Ignored for other methods. */
  tendered_inr?: number | null;
}

export type PartsValidation =
  | { ok: true; parts: PaymentPart[]; changeInr: number }
  | { ok: false; error: string };

/**
 * Change due on a cash payment. Never negative: an under-tender is a validation
 * failure upstream, not a negative change figure shown to a customer.
 */
export function changeDueInr(tenderedInr: number, amountInr: number): number {
  return Math.max(0, tenderedInr - amountInr);
}

/**
 * Validates the parts of a settlement against the order's authoritative total.
 *
 * Rules:
 *  - at least one part, at most 4 (a counter splitting more than that is doing
 *    something the POS shouldn't be silently enabling)
 *  - every amount a positive integer ₹
 *  - the parts must sum EXACTLY to the total — no rounding slack, because the
 *    difference would silently become an unexplained drawer variance
 *  - cash tendered, when given, must cover its own part
 *  - `tendered_inr` is meaningless off cash and is dropped rather than stored
 */
export function validateParts(rawParts: unknown, totalInr: number): PartsValidation {
  if (!Array.isArray(rawParts) || rawParts.length === 0) {
    return { ok: false, error: 'parts must be a non-empty array' };
  }
  if (rawParts.length > 4) {
    return { ok: false, error: 'A payment can be split across at most 4 methods' };
  }

  const parts: PaymentPart[] = [];
  let sum = 0;
  let changeInr = 0;

  for (let i = 0; i < rawParts.length; i++) {
    const raw = rawParts[i];
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `parts[${i}] must be an object` };
    }
    const { method, amount_inr, tendered_inr } = raw as Record<string, unknown>;

    if (method !== 'cash' && method !== 'upi' && method !== 'card' && method !== 'online') {
      return { ok: false, error: `parts[${i}].method must be one of: cash, upi, card, online` };
    }
    if (typeof amount_inr !== 'number' || !Number.isInteger(amount_inr) || amount_inr <= 0) {
      return { ok: false, error: `parts[${i}].amount_inr must be a positive whole number of rupees` };
    }

    let tendered: number | null = null;
    if (method === 'cash' && tendered_inr !== undefined && tendered_inr !== null) {
      if (typeof tendered_inr !== 'number' || !Number.isInteger(tendered_inr)) {
        return { ok: false, error: `parts[${i}].tendered_inr must be a whole number of rupees` };
      }
      if (tendered_inr < amount_inr) {
        return { ok: false, error: `parts[${i}].tendered_inr cannot be less than the cash amount` };
      }
      tendered = tendered_inr;
      changeInr += changeDueInr(tendered_inr, amount_inr);
    }

    sum += amount_inr;
    parts.push({ method, amount_inr, tendered_inr: tendered });
  }

  if (sum !== totalInr) {
    // Deliberately exact. A ₹1 gap is not a rounding curiosity — it becomes an
    // unexplained over/short on the cash day that nobody can reconstruct.
    return {
      ok: false,
      error: `Payment parts total ₹${sum} but the bill is ₹${totalInr} — they must match exactly.`,
    };
  }

  return { ok: true, parts, changeInr };
}

/**
 * The single method to stamp on `orders.payment_method` for a split, so legacy
 * reads and the existing UI still show something true-ish: the largest part.
 * Ties resolve to the earlier part, keeping it deterministic.
 *
 * The parts table is the real record — anything that needs accuracy (the cash
 * drawer) must read that, not this.
 */
export function dominantMethod(parts: PaymentPart[]): PaymentMethod {
  let best = parts[0];
  for (const p of parts) {
    if (p.amount_inr > best.amount_inr) best = p;
  }
  return best.method;
}

/** Total cash across parts — what actually entered the drawer. */
export function cashPortionInr(parts: PaymentPart[]): number {
  return parts.filter((p) => p.method === 'cash').reduce((sum, p) => sum + p.amount_inr, 0);
}
