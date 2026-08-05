// VAL-1 — the pure logic behind coupons and points at the till.
//
// It sits out here rather than inside PosOrderEntry.tsx for one reason: none of
// it can be tested where it was going to end up. What a staffer is told when a
// coupon is refused, and how many points a typed string actually means, are
// rules — and a rule buried in a component is a rule nobody can pin down.
//
// The hard line this file holds: it NEVER decides an amount. Every rupee in
// every string below is one the server already quoted. The client formats
// money; it does not compute it (POST /api/orders/quote is authoritative, and
// POST /api/orders re-derives it all again at submit).

/** What the customer lookup (GET /api/customers/lookup) says about a number. */
export type CustomerLookup =
  | { found: false }
  | { found: true; name: string; points_balance: number };

/**
 * A discount the server has judged — the `coupon` and `points` blocks of the
 * quote response. `reason` is the server's own wording for a refusal and is
 * shown verbatim; inventing a friendlier local message would eventually
 * contradict what the create route enforces.
 */
export interface QuotedDiscount {
  ok: boolean;
  points?: number;
  discountInr?: number;
  reason?: string;
}

export interface Feedback {
  ok: boolean;
  text: string;
}

/** "1 point" / "240 points" — the plural is the only decision here. */
export function formatPoints(points: number): string {
  const n = Number.isFinite(points) ? Math.max(0, Math.trunc(points)) : 0;
  return `${n} ${n === 1 ? 'point' : 'points'}`;
}

/**
 * The one line the POS shows about who is at the counter.
 *
 * The name leads because it is the confirmation step: a staffer who sees the
 * wrong name has caught a mistyped digit before it spends someone else's
 * balance. An account with no name saved still has to be confirmable, so it
 * falls back to a neutral label rather than an empty string.
 */
export function describeCustomer(lookup: CustomerLookup | null): Feedback | null {
  if (!lookup) return null;
  if (!lookup.found) {
    return { ok: false, text: 'No account for this number — the order still gets a bill.' };
  }
  const name = lookup.name.trim() || 'Account';
  return { ok: true, text: `${name} · ${formatPoints(lookup.points_balance)}` };
}

/** Whether the points control is worth showing at all. */
export function canRedeemPoints(lookup: CustomerLookup | null): boolean {
  return Boolean(lookup && lookup.found && lookup.points_balance > 0);
}

/**
 * Points meant by whatever was typed. Anything that isn't a whole, positive
 * number of points means "none" — a partial or nonsense entry must quote as no
 * redemption, not as a guess at one.
 */
export function parsePointsInput(raw: string): number {
  const digits = (raw ?? '').replace(/[^\d]/g, '');
  if (!digits) return 0;
  const n = Number.parseInt(digits, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** What to tell the staffer about the coupon the server just judged. */
export function couponFeedback(result: QuotedDiscount | null | undefined): Feedback | null {
  if (!result) return null;
  if (result.ok) return { ok: true, text: `Coupon applied — ₹${result.discountInr ?? 0} off` };
  return { ok: false, text: result.reason ?? 'This coupon is not valid for this order.' };
}

/** Same, for a points redemption. */
export function pointsFeedback(result: QuotedDiscount | null | undefined): Feedback | null {
  if (!result) return null;
  if (result.ok) {
    return { ok: true, text: `${formatPoints(result.points ?? 0)} — ₹${result.discountInr ?? 0} off` };
  }
  return { ok: false, text: result.reason ?? 'Those points could not be redeemed.' };
}
