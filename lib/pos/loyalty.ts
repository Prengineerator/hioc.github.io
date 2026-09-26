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

/**
 * What the customer lookup (GET /api/customers/lookup) says about a number.
 *
 * `source` says how much the name is worth trusting:
 *  - 'account'       — a VERIFIED phone-linked account; `points_balance` is
 *                       real spendable balance.
 *  - 'order_history'  — no account, but a past hioc order used this exact
 *                       phone; the name is recalled from that order, never
 *                       verified, and there is no balance to spend
 *                       (`points_balance` is omitted, not zero — zero would
 *                       claim a real, empty account).
 *  - 'petpooja'        — no account and no hioc order either, but the
 *                       imported Petpooja history has this phone: a regular
 *                       from before this app existed. Same "no balance"
 *                       rule as order_history — there is no account here to
 *                       hold one.
 */
export type CustomerLookup =
  | { found: false }
  | {
      found: true;
      source: 'account' | 'order_history' | 'petpooja';
      name: string;
      points_balance?: number;
      order_count: number;
      last_order_at: string | null;
    };

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
    // POS-ACC: placing the order opens the account (POST /api/orders), so the
    // staffer can tell the customer they are earning from this order on.
    return { ok: false, text: 'New customer — this order opens their HIOC account and earns points.' };
  }
  const name = lookup.name.trim() || 'Account';
  if (lookup.source === 'account') {
    return { ok: true, text: `${name} · ${formatPoints(lookup.points_balance ?? 0)}` };
  }
  // order_history / petpooja: a name recalled from a past order (this app's
  // or the old Petpooja POS's), not a verified account — still worth
  // confirming against the person at the counter, but there is no balance to
  // offer yet (canRedeemPoints below keeps that control hidden either way).
  // Placing the order opens their account (POS-ACC).
  return { ok: true, text: `${name} · HIOC account opens with this order` };
}

/** Whether the points control is worth showing at all — only a verified
 * account can hold a spendable balance. */
export function canRedeemPoints(lookup: CustomerLookup | null): boolean {
  return Boolean(lookup && lookup.found && lookup.source === 'account' && (lookup.points_balance ?? 0) > 0);
}

/** Whether the phone typed so far has ANY past order worth a "Last orders"
 * button for — true for both a verified account and the order-history
 * fallback, as long as at least one past order was found. */
export function hasOrderHistory(lookup: CustomerLookup | null): boolean {
  return Boolean(lookup && lookup.found && lookup.order_count > 0);
}

/**
 * The small chip shown right by the phone field (POS-5) — distinct from
 * `describeCustomer`'s fuller line further down the form, and shown the
 * moment a lookup resolves rather than only once the fuller line is visible.
 * Wording matches what the phone actually means: a real account carries
 * points, a bare order-history match doesn't, and a Petpooja-only match says
 * so plainly rather than implying a hioc history that doesn't exist.
 */
export function customerChip(lookup: CustomerLookup | null): string | null {
  if (!lookup || !lookup.found) return null;
  if (lookup.source === 'account') {
    return `HIOC account · ${formatPoints(lookup.points_balance ?? 0)}`;
  }
  if (lookup.order_count <= 0) return null;
  const orders = `${lookup.order_count} order${lookup.order_count === 1 ? '' : 's'}`;
  if (lookup.source === 'petpooja') return `Petpooja customer · ${orders}`;
  return `Returning customer · ${orders}`;
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
