// POS4-1 — pure math and validation for counter settlement: cash change and
// split payments.
//
// Dependency-free on purpose (no DB, no Supabase) so the money rules are unit
// tested with plain fixtures. The route enforces them; the POS renders what
// these return. As everywhere else in this codebase, the client never decides
// an amount — it only displays one.

import { isPaymentMethod, PAYMENT_METHODS } from '@/lib/api/constants';
import type { PaymentMethod } from '@/lib/types';

/**
 * The tenders the counter offers, in button order. 'online' is absent: that is
 * the website's gateway payment, never something a staffer collects.
 */
export const COUNTER_PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'upi',
  'card',
  'swiggy_dineout',
  'zomato_district',
];

/**
 * Paid inside a dining app (Swiggy Dineout, Zomato District): the platform took
 * the money and settles it to the café later, so it is reversed in that app's
 * partner dashboard — never on the card terminal, never from the drawer.
 */
export const APP_PAYMENT_METHODS: readonly PaymentMethod[] = ['swiggy_dineout', 'zomato_district'];

export function isAppPaymentMethod(method: string | null | undefined): boolean {
  return (APP_PAYMENT_METHODS as readonly (string | null | undefined)[]).includes(method);
}

/** What the counter is asked for on a dining-app tender. */
export const PAYMENT_REFERENCE_LABEL = 'Booking / transaction ID';

// The label mid-sentence: "booking / transaction ID", not "…id".
const REFERENCE_IN_SENTENCE = 'booking / transaction ID';
const REFERENCE_MIN_LENGTH = 4;
const REFERENCE_MAX_LENGTH = 40;

export type ReferenceParse = { ok: true; reference: string } | { ok: false; error: string };

/**
 * The platform's booking / transaction ID for a dining-app tender, normalised
 * so the same booking always reads the same: spaces dropped (they come from
 * reading it off a phone in groups), upper-cased (the platforms' IDs are not
 * case-sensitive). 4–40 letters, digits, `-`, `_` or `/`.
 *
 * Required: without it the owner can't match the platform's payout, and the
 * same booking could be settled on two bills without anyone noticing. The
 * route also refuses an ID already used on another live order — that check
 * needs the database, so it isn't here.
 */
export function parsePaymentReference(raw: unknown): ReferenceParse {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!text) return { ok: false, error: `Enter the ${REFERENCE_IN_SENTENCE} from the app.` };
  if (text.length < REFERENCE_MIN_LENGTH || text.length > REFERENCE_MAX_LENGTH) {
    return {
      ok: false,
      error: `The ${REFERENCE_IN_SENTENCE} should be ${REFERENCE_MIN_LENGTH}–${REFERENCE_MAX_LENGTH} characters.`,
    };
  }
  if (!/^[A-Z0-9][A-Z0-9_\-/]*$/.test(text)) {
    return {
      ok: false,
      error: `The ${REFERENCE_IN_SENTENCE} can only have letters, digits, - _ or /.`,
    };
  }
  return { ok: true, reference: text };
}

export interface PaymentPart {
  method: PaymentMethod;
  amount_inr: number;
  /** Cash only: what the customer handed over. Ignored for other methods. */
  tendered_inr?: number | null;
  /**
   * Dining apps only (and required there): the platform's booking /
   * transaction ID. Dropped for every other method.
   */
  reference?: string | null;
}

/**
 * The most a counter staffer may knock off a bill at settlement on their own.
 * Anything above needs a manager or the owner — a rounding-off is routine, a
 * large write-off is a discount decision.
 */
export const STAFF_SETTLE_SHORT_LIMIT_INR = 50;

const MIN_SETTLE_REASON_LENGTH = 3;
const MAX_SETTLE_REASON_LENGTH = 200;

/**
 * A validated settlement adjustment: the customer paid `shortInr` LESS than the
 * bill (recorded as a settlement discount) or `tipInr` MORE (kept as a tip).
 * At most one of the two is non-zero.
 */
export interface SettleAdjustment {
  shortInr: number;
  tipInr: number;
  reason: string;
}

export type AdjustmentParse = ({ ok: true } & SettleAdjustment) | { ok: false; error: string };

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

/** What must actually be received for a bill once the adjustment is applied. */
export function expectedReceivedInr(
  totalInr: number,
  adj?: Pick<SettleAdjustment, 'shortInr' | 'tipInr'> | null,
): number {
  return totalInr - (adj?.shortInr ?? 0) + (adj?.tipInr ?? 0);
}

/**
 * Whether a shortfall is beyond what counter staff may approve alone. The
 * route enforces it against the actor's role; the UI uses it only to warn.
 */
export function shortNeedsManager(shortInr: number): boolean {
  return shortInr > STAFF_SETTLE_SHORT_LIMIT_INR;
}

/**
 * Parses the optional `adjustment` on a settle request:
 * `{ short_inr?, tip_inr?, reason }`. Absent (or all zero) is a plain settle.
 *
 * Rules:
 *  - amounts are whole, non-negative rupees
 *  - a bill is either short or tipped, never both
 *  - a shortfall can't exceed the bill total
 *  - a reason (>= 3 characters) is ALWAYS required when there is a difference:
 *    a silent write-off is exactly what the drawer variance can't explain
 *
 * The role check for large shortfalls is the route's job (it knows the actor);
 * this stays pure.
 */
export function parseSettleAdjustment(raw: unknown, totalInr: number): AdjustmentParse {
  const none: AdjustmentParse = { ok: true, shortInr: 0, tipInr: 0, reason: '' };
  if (raw === undefined || raw === null) return none;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'adjustment must be an object' };
  }
  const { short_inr, tip_inr, reason } = raw as Record<string, unknown>;

  const amount = (v: unknown, name: string): number | string => {
    if (v === undefined || v === null) return 0;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return `adjustment.${name} must be a whole number of rupees, zero or more`;
    }
    return v;
  };
  const shortInr = amount(short_inr, 'short_inr');
  if (typeof shortInr === 'string') return { ok: false, error: shortInr };
  const tipInr = amount(tip_inr, 'tip_inr');
  if (typeof tipInr === 'string') return { ok: false, error: tipInr };

  if (shortInr === 0 && tipInr === 0) return none;

  if (shortInr > 0 && tipInr > 0) {
    return { ok: false, error: 'A bill can be settled short or with a tip, not both.' };
  }
  if (shortInr > totalInr) {
    return { ok: false, error: `The shortfall of ₹${shortInr} is more than the bill of ₹${totalInr}.` };
  }

  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < MIN_SETTLE_REASON_LENGTH) {
    return {
      ok: false,
      error: `A reason (at least ${MIN_SETTLE_REASON_LENGTH} characters) is required when the amount received differs from the bill.`,
    };
  }
  if (text.length > MAX_SETTLE_REASON_LENGTH) {
    return { ok: false, error: `The reason must be ${MAX_SETTLE_REASON_LENGTH} characters or fewer.` };
  }

  return { ok: true, shortInr, tipInr, reason: text };
}

/**
 * Validates the parts of a settlement against the order's authoritative total.
 *
 * Rules:
 *  - at least one part, at most 4 (a counter splitting more than that is doing
 *    something the POS shouldn't be silently enabling)
 *  - every amount a positive integer ₹
 *  - the parts must sum EXACTLY to the total — no rounding slack, because the
 *    difference would silently become an unexplained drawer variance. With a
 *    settle adjustment the target is `total - short + tip`: the parts are what
 *    actually entered the till, so a shortfall is excluded and a tip included
 *  - cash tendered, when given, must cover its own part
 *  - `tendered_inr` is meaningless off cash and is dropped rather than stored
 *  - a dining-app part must carry its booking / transaction ID
 *    (parsePaymentReference); off the apps, `reference` is dropped
 */
export function validateParts(
  rawParts: unknown,
  totalInr: number,
  adjustment?: Pick<SettleAdjustment, 'shortInr' | 'tipInr'> | null,
): PartsValidation {
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
    const { method, amount_inr, tendered_inr, reference } = raw as Record<string, unknown>;

    if (!isPaymentMethod(method)) {
      return { ok: false, error: `parts[${i}].method must be one of: ${PAYMENT_METHODS.join(', ')}` };
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

    let ref: string | null = null;
    if (isAppPaymentMethod(method)) {
      const parsed = parsePaymentReference(reference);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      ref = parsed.reference;
    }

    sum += amount_inr;
    parts.push(ref ? { method, amount_inr, tendered_inr: tendered, reference: ref } : { method, amount_inr, tendered_inr: tendered });
  }

  const expected = expectedReceivedInr(totalInr, adjustment);
  if (sum !== expected) {
    // Deliberately exact. A ₹1 gap is not a rounding curiosity — it becomes an
    // unexplained over/short on the cash day that nobody can reconstruct.
    if (expected === totalInr) {
      return {
        ok: false,
        error: `Payment parts total ₹${sum} but the bill is ₹${totalInr} — they must match exactly.`,
      };
    }
    const why = adjustment?.shortInr ? `− ₹${adjustment.shortInr} short` : `+ ₹${adjustment?.tipInr ?? 0} tip`;
    return {
      ok: false,
      error: `Payment parts total ₹${sum} but ₹${expected} should be received (bill ₹${totalInr} ${why}) — they must match exactly.`,
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
