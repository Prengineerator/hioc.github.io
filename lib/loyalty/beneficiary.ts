// VAL-2 / D4-3 — the one rule that decides WHOSE loyalty account an order's
// points move in and out of.
//
// It lives alone, pure and dependency-free, because three ledger operations
// need it (earn, redeem, reverse) and a fourth will one day be added. When the
// rule was inlined, only earn read the order at all; the moment counter orders
// could carry a customer, three copies of "which user is this?" would have had
// three chances to disagree — and a disagreement here credits or debits the
// wrong person's balance, silently.
//
// user_id is the session that PLACED the order (null for a staff order — see
// supabase/2026-08-counter-loyalty.sql); customer_user_id is the account the
// order BELONGS to. When both are present they are the same person, so the
// order of preference only matters for the two one-sided cases: a web order
// (user_id only) and a counter order linked by phone (customer_user_id only).

export interface LoyaltyBeneficiary {
  user_id?: string | null;
  customer_user_id?: string | null;
}

/**
 * The account an order's points belong to, or null when the order has none
 * (an anonymous walk-in or an unclaimed guest checkout — both of which earn
 * nothing, which is the correct outcome, not a failure).
 *
 * Empty strings are treated as absent: a NOT NULL text column elsewhere in this
 * schema stores '' for "none", and one of those reaching a uuid column would be
 * a foreign-key error at best and a mis-credit at worst.
 */
export function loyaltyUserIdFor(order: LoyaltyBeneficiary | null | undefined): string | null {
  if (!order) return null;
  const linked = typeof order.customer_user_id === 'string' ? order.customer_user_id.trim() : '';
  if (linked) return linked;
  const session = typeof order.user_id === 'string' ? order.user_id.trim() : '';
  return session || null;
}
