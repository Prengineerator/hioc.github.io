// Types for the prepaid coffee pass ("HIOC Ritual", docs/COFFEE-PASS-SPEC.md).
//
// Pure declarations, no runtime and no server-only import, so the rules module,
// the API routes and the screens can all share one vocabulary.

/**
 * Where a pass stands right now. Derived, never stored (except refunded/void,
 * which are the stored `status`): the database view v_coffee_pass_balances
 * computes it, and passState() in rules.ts mirrors that exactly.
 */
export type PassState = 'active' | 'used_up' | 'expired' | 'refunded' | 'void';

/** A plan the owner sells (coffee_pass_plans). Edits never touch passes already sold. */
export interface CoffeePassPlan {
  id: string;
  name: string;
  description: string;
  /** Cups the customer GETS. */
  drinks_total: number;
  /** Cups the customer PAYS for. Display only: price_inr is what is charged. */
  drinks_paid: number;
  validity_days: number;
  /** One cup covers up to this much of ONE unit of an eligible drink. */
  drink_value_inr: number;
  price_inr: number;
  /** null = no daily limit. Counted per IST calendar day. */
  max_per_day: number | null;
  gst_exempt: boolean;
  is_active: boolean;
  sort_order: number;
}

/**
 * What a pass was SOLD with, frozen on the sale's one order line
 * (order_items.coffee_pass_terms). The issuing trigger reads this rather than the
 * live plan, so an owner's edit between the sale and the payment never changes
 * what the customer receives. The price is not here: it is the line's total.
 */
export interface CoffeePassTerms {
  plan_name: string;
  drinks_total: number;
  drink_value_inr: number;
  validity_days: number;
  /** null = no daily limit. Always present: the trigger requires all five keys. */
  max_per_day: number | null;
}

/** One pass with its derived balance, as the customer or the counter sees it. */
export interface PassSummary {
  id: string;
  plan_id: string;
  plan_name: string;
  drinks_total: number;
  drinks_used: number;
  drinks_credited: number;
  drinks_remaining: number;
  drink_value_inr: number;
  max_per_day: number | null;
  /** Cups already used on today's IST calendar day (what the daily cap counts). */
  used_today: number;
  price_inr: number;
  starts_at: string;
  expires_at: string;
  status: 'active' | 'refunded' | 'void';
  state: PassState;
  /** The sale order that issued the pass. */
  order_id: string;
}

/** One line of an order, as the allocator needs to see it. */
export interface PassLine {
  /** Stable key for the line within this pricing call (an index, or the order item id). */
  key: string;
  menu_item_id: string | null;
  /** What ONE unit costs, add-ons included (line total / quantity). */
  unit_price_inr: number;
  quantity: number;
  /** The menu item is marked pass_eligible. */
  eligible: boolean;
  gst_exempt: boolean;
}

/** A pass that can be spent right now (active, from loadUsablePasses). */
export interface UsablePass {
  id: string;
  drinks_remaining: number;
  drink_value_inr: number;
  expires_at: string;
  max_per_day: number | null;
  used_today: number;
}

/** Cups of one pass spent on one line. */
export interface PassAllocation {
  pass_id: string;
  line_key: string;
  drinks: number;
  covered_inr: number;
}

/**
 * Why fewer cups were applied than asked for (null when all were, or none were
 * asked for):
 *   no_pass           no pass with cups left that is still in date
 *   no_eligible_items nothing in the cart can be paid with a pass
 *   daily_limit       a pass's per-day cap is what stopped it
 *   not_enough_drinks anything else: the cups left, or fewer eligible units in
 *                     the cart than were asked for
 */
export type PassShortfall = 'no_pass' | 'no_eligible_items' | 'not_enough_drinks' | 'daily_limit' | null;

export interface AllocationResult {
  /** Cups asked for (after normalising: whole, never negative). */
  requested: number;
  /** Cups actually applied. */
  applied: number;
  /** Units in the cart a pass could pay for. */
  eligible_units: number;
  /** Cups left across the passes still in date (ignores the daily cap). */
  available: number;
  allocations: PassAllocation[];
  by_line: Record<string, { drinks: number; covered_inr: number }>;
  /** Total rupees the pass covers. */
  covered_inr: number;
  /** The part of covered_inr that sat on GST-liable lines (leaves the taxable base). */
  covered_taxable_inr: number;
  shortfall: PassShortfall;
}

/** What coffee_pass_redeem returns. */
export type PassRedeemCode =
  | 'ok'
  | 'not_owner'
  | 'inactive'
  | 'expired'
  | 'insufficient'
  | 'daily_limit'
  | 'bad_input';

/** What coffee_pass_void_for_refund returns. */
export type PassVoidCode = 'ok' | 'used' | 'not_found' | 'already';

/** What coffee_pass_restore_after_failed_refund returns. */
export type PassRestoreCode = 'ok' | 'not_found' | 'not_voided' | 'order_refunded';

/** What coffee_pass_adjust returns. */
export type PassAdjustCode = 'ok' | 'bad_input' | 'not_found' | 'inactive';

/** One use of a pass, for the history under it. */
export interface PassRedemptionEntry {
  order_id: string;
  order_number: number | null;
  /** Cups spent on that order (all lines). */
  drinks: number;
  covered_inr: number;
  created_at: string;
  /** The cups came back (order cancelled / refunded, or the line voided). */
  reversed: boolean;
}
