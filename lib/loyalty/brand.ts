// The loyalty currency's customer-facing name. The rewards programme's unit is
// "Beanie" (plural "Beanies"); everything a customer, staffer or owner reads
// goes through here so the wording, and the singular/plural rule, live in one
// place. Identifiers, API fields and DB columns (`points`, `points_balance`,
// `loyalty_transactions`, ...) deliberately keep their old names — only copy
// changes.
//
// Pure on purpose (no 'server-only'): imported by server components, client
// components, print models and API routes alike.

export const LOYALTY_UNIT = { one: 'Beanie', many: 'Beanies' } as const;

/** Just the unit word for a count: "Beanie" for exactly ±1, "Beanies" otherwise.
 * For layouts that style the number separately from the word. */
export function beaniesUnit(n: number): string {
  return Math.abs(n) === 1 ? LOYALTY_UNIT.one : LOYALTY_UNIT.many;
}

/**
 * A count with its unit: "1 Beanie", "0 Beanies", "24 Beanies", "-5 Beanies".
 * Whole numbers only — a fractional or non-finite input is truncated / read as
 * 0, the same way the ledger floors what it earns.
 */
export function beaniesLabel(n: number): string {
  const whole = Number.isFinite(n) ? Math.trunc(n) : 0;
  return `${whole} ${beaniesUnit(whole)}`;
}

/**
 * One-line strapline for the Rewards page. The ₹ value of a Beanie is passed in
 * (from `loyalty_config.inr_per_point`) rather than baked in, so changing the
 * rate in the config changes the copy with it.
 */
export function beaniesTagline(inrPerBeanie: number): string {
  return `${LOYALTY_UNIT.many} — HIOC rewards. 1 ${LOYALTY_UNIT.one} = ₹${inrPerBeanie} off.`;
}
