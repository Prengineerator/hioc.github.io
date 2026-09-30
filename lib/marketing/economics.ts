// Campaign economics (spec §1.6, §1.8): every campaign is PRICED before it is
// approved — the WhatsApp message cost, the cost of the offer and the cost of the
// product against the profit it should bring back. Pure and client-safe; the
// dashboard shows exactly the numbers project() returns.
//
// The subtlety worth knowing is what an offer COSTS the cafe versus what it is
// WORTH to the customer:
//   * a percentage discount costs exactly what it looks like — 10% off a ₹320
//     basket is ₹32 of revenue given up;
//   * a FREE ITEM costs its product cost (COGS), not its price. A ₹180 cold coffee
//     that costs ₹45 to make is worth ₹180 to the customer and costs the cafe ₹45.
// That gap is why product costs matter and why rankFreeItems() exists: it finds
// the free item with the most perceived value per rupee of real cost.
//
// Money in and out of project() is plain numbers (decimals allowed): projections
// are forecasts, rounded only for display. Anything that becomes a coupon is
// integer rupees and lives in offers.ts.

import {
  BLEND_PRIOR_WEIGHT,
  DEFAULT_DELIVERABILITY,
  DEFAULT_MAX_REDEEM_PCT,
  MIN_COST_COVERAGE_PCT,
  MIN_DELIVERABILITY_SAMPLE,
  MIN_HOLDOUT_FOR_LIFT,
} from './types';
import type {
  EconomicOffer,
  FreeItemCandidate,
  FreeItemOffer,
  GuardrailFlag,
  Projection,
} from './types';
import { isFreeItemResolved } from './offers';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const finite = (n: number, fallback = 0) => (Number.isFinite(n) ? n : fallback);

// ---------------------------------------------------------------------------
// Offer cost
// ---------------------------------------------------------------------------

export interface OfferCostContext {
  /** A — the basket a returning customer is expected to spend, ₹. */
  basket_inr: number;
  /** loyalty max_redeem_pct, for a points offer. Defaults to 50. */
  max_redeem_pct?: number;
}

/**
 * What one returning order gives up to the offer.
 *   discount_inr — revenue lost to a discount (the basket shrinks by this);
 *   cost_inr     — what the offer costs the cafe (comes off profit).
 * They are equal for every offer except a free item, where nothing is taken off
 * the bill (`discount` 0) but the item itself costs its product cost.
 *
 *   none       0 / 0
 *   points     min(points_value, A × max_redeem_pct/100)   — a redemption is capped at a share of the bill
 *   percent    min(A × p/100, cap or ∞)                    — cap 0 means no cap
 *   flat       min(F, A)                                   — never more than the basket
 *   free_item  0 / cost of the chosen variant              — 0 until the offer is resolved
 */
export function offerCost(offer: EconomicOffer, ctx: OfferCostContext): { discount_inr: number; cost_inr: number } {
  const basket = Math.max(0, finite(ctx.basket_inr));
  switch (offer.type) {
    case 'none':
      return { discount_inr: 0, cost_inr: 0 };
    case 'points': {
      const cap = (basket * (ctx.max_redeem_pct ?? DEFAULT_MAX_REDEEM_PCT)) / 100;
      const d = Math.max(0, Math.min(finite(offer.points_value_inr), cap));
      return { discount_inr: d, cost_inr: d };
    }
    case 'percent': {
      const raw = (basket * offer.percent) / 100;
      const d = offer.cap_inr > 0 ? Math.min(raw, offer.cap_inr) : raw;
      return { discount_inr: d, cost_inr: d };
    }
    case 'flat': {
      const d = Math.min(offer.amount_inr, basket);
      return { discount_inr: d, cost_inr: d };
    }
    case 'free_item':
      return { discount_inr: 0, cost_inr: Math.max(0, finite(offer.cost_inr ?? 0)) };
  }
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * How `eligible` contacts split into a holdout (kept back to measure lift) and
 * the treated group that actually gets the message: holdout = round(N × h/100),
 * treated = N − holdout. Math.round rounds halves up (5 people at 10% → 1 held
 * out), so the projection and the real arm assignment agree exactly as long as
 * the planner uses THIS function for the count.
 */
export function splitHoldout(eligible: number, holdoutPct: number): { holdout: number; treated: number } {
  const n = Math.max(0, Math.floor(finite(eligible)));
  const holdout = Math.min(n, Math.round((n * clamp(finite(holdoutPct), 0, 100)) / 100));
  return { holdout, treated: n - holdout };
}

export interface ProjectionInput {
  /** N: contacts that passed eligibility. */
  eligible: number;
  /** h: settings.holdout_pct. */
  holdout_pct: number;
  /** c: settings.message_cost_inr. */
  message_cost_inr: number;
  /** d: delivered ÷ sent, 0–1 (see learnedDeliverability). */
  deliverability: number;
  /** r: the blended conversion rate, 0–1 (see blendedRate). */
  conversion_rate: number;
  /** A: basket value, ₹ (see basketValue). */
  basket_inr: number;
  /** f: blended food-cost ratio, 0–1 (see blendedFoodCost). */
  food_cost_ratio: number;
  offer: EconomicOffer;
  /** Loyalty max_redeem_pct, used only by a points offer. Defaults to 50. */
  max_redeem_pct?: number;
}

/**
 * The forecast for a campaign — every formula of spec §1.6:
 *
 *   conversions      = treated × d × r
 *   profit_per_conv  = A × (1 − f) − offer_cost
 *   revenue          = conversions × (A − discount)
 *   offer_spend      = conversions × offer_cost
 *   message_spend    = treated × c
 *   expected_profit  = conversions × profit_per_conv − message_spend
 *   roi              = expected_profit ÷ (message_spend + offer_spend)      null if that is 0
 *   margin_after_pct = 100 × profit_per_conv ÷ A
 *   break_even_rate  = message_spend ÷ (treated × d × profit_per_conv)      null if profit_per_conv ≤ 0
 *
 * Inputs outside their range (a rate above 1, a negative basket) are clamped
 * rather than trusted — a forecast should never be more wrong than its inputs.
 */
export function project(input: ProjectionInput): Projection {
  const { holdout, treated } = splitHoldout(input.eligible, input.holdout_pct);
  const eligible = holdout + treated;

  const c = Math.max(0, finite(input.message_cost_inr));
  const d = clamp(finite(input.deliverability, DEFAULT_DELIVERABILITY), 0, 1);
  const r = clamp(finite(input.conversion_rate), 0, 1);
  const A = Math.max(0, finite(input.basket_inr));
  const f = clamp(finite(input.food_cost_ratio), 0, 1);

  const { discount_inr, cost_inr } = offerCost(input.offer, { basket_inr: A, max_redeem_pct: input.max_redeem_pct });

  const conversions = treated * d * r;
  const profitPerConv = A * (1 - f) - cost_inr;
  const messageSpend = treated * c;
  const offerSpend = conversions * cost_inr;
  const expectedProfit = conversions * profitPerConv - messageSpend;
  const spend = messageSpend + offerSpend;

  return {
    eligible,
    holdout,
    treated,
    message_cost_inr: c,
    deliverability: d,
    conversion_rate: r,
    basket_inr: A,
    food_cost_ratio: f,
    discount_inr,
    offer_cost_inr: cost_inr,
    conversions,
    profit_per_conv_inr: profitPerConv,
    revenue_inr: conversions * (A - discount_inr),
    offer_spend_inr: offerSpend,
    message_spend_inr: messageSpend,
    expected_profit_inr: expectedProfit,
    roi: spend > 0 ? expectedProfit / spend : null,
    margin_after_pct: A > 0 ? (100 * profitPerConv) / A : 0,
    break_even_rate: breakEven({
      message_spend_inr: messageSpend,
      treated,
      deliverability: d,
      profit_per_conv_inr: profitPerConv,
    }),
  };
}

/**
 * The conversion rate at which a campaign exactly pays for its messages:
 *   message_spend ÷ (treated × d × profit_per_conv), a 0–1 ratio.
 * null when profit_per_conv ≤ 0 (each return loses money, so no rate ever breaks
 * even) or when nobody can be reached (treated × d = 0). The offer's cost is
 * already inside profit_per_conv, so this is the rate needed to cover MESSAGES.
 */
export function breakEven(i: {
  message_spend_inr: number;
  treated: number;
  deliverability: number;
  profit_per_conv_inr: number;
}): number | null {
  const reach = i.treated * i.deliverability;
  if (!(i.profit_per_conv_inr > 0) || !(reach > 0)) return null;
  return i.message_spend_inr / (reach * i.profit_per_conv_inr);
}

// ---------------------------------------------------------------------------
// Learned rates
// ---------------------------------------------------------------------------

/**
 * The conversion rate projections use: a Bayesian blend that starts at the
 * research prior and moves toward what this cafe actually achieves.
 *
 *   r = (prior_pct/100 × 50 + observed_conversions) ÷ (50 + observed_treated)
 *
 * The prior counts as 50 "virtual recipients", so 50 real deliveries weigh as
 * much as the research does. Returns a 0–1 rate.
 */
export function blendedRate(priorPct: number, observedTreated: number, observedConversions: number): number {
  const prior = clamp(finite(priorPct), 0, 100) / 100;
  const treated = Math.max(0, finite(observedTreated));
  const conv = Math.max(0, finite(observedConversions));
  return clamp((prior * BLEND_PRIOR_WEIGHT + conv) / (BLEND_PRIOR_WEIGHT + treated), 0, 1);
}

/**
 * Deliverability (delivered ÷ sent) for projections. Learned from history only
 * when receipts are actually flowing AND there are enough sends for the ratio to
 * mean something (a single delivered message would otherwise read as 100%);
 * otherwise 0.9. Clamped to [0.05, 1] so one bad batch can't zero a forecast.
 */
export function learnedDeliverability(sent: number, delivered: number, receiptsConnected: boolean): number {
  if (!receiptsConnected || !(sent >= MIN_DELIVERABILITY_SAMPLE)) return DEFAULT_DELIVERABILITY;
  return clamp(delivered / sent, 0.05, 1);
}

/**
 * A — the basket value for a campaign: the median of the recipients' own average
 * order values (zeros ignored — a contact with no orders has no basket), falling
 * back to the store's 90-day average when none of them has one.
 */
export function basketValue(recipientAovs: readonly number[], storeAov: number): number {
  const values = recipientAovs.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (values.length === 0) return Math.max(0, finite(storeAov));
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Food cost
// ---------------------------------------------------------------------------

/** One order line, for the blended food-cost ratio. */
export interface FoodCostLine {
  /** null on a legacy line — it can never have a real cost. */
  variant_id: string | null;
  quantity: number;
  line_total_inr: number;
  /** Voided lines were never sold; they are ignored. */
  voided?: boolean;
}

export interface FoodCostResult {
  /** f: Σ line cost ÷ Σ line revenue, 0–1 (the default % when there is no revenue). */
  ratio: number;
  revenue_inr: number;
  cost_inr: number;
  /** Revenue of the lines that had a real entered cost. */
  costed_revenue_inr: number;
  /** 100 × costed_revenue ÷ revenue — how much of the projection rests on real costs. 0 with no revenue. */
  coverage_pct: number;
}

/**
 * The blended food-cost ratio over a set of order lines (the caller passes the
 * last 90 days of non-voided lines on valid orders). A line's cost is its
 * variant's entered cost × quantity where there is one; otherwise its revenue ×
 * default_food_cost_pct/100. `coverage_pct` is what the missing_costs guardrail
 * reads.
 */
export function blendedFoodCost(
  lines: readonly FoodCostLine[],
  costs: ReadonlyMap<string, number>,
  defaultFoodCostPct: number,
): FoodCostResult {
  const fallback = clamp(finite(defaultFoodCostPct), 0, 100) / 100;
  let revenue = 0;
  let cost = 0;
  let costed = 0;
  for (const line of lines) {
    if (line.voided) continue;
    const total = Math.max(0, finite(line.line_total_inr));
    const qty = Math.max(0, finite(line.quantity));
    const known = line.variant_id !== null ? costs.get(line.variant_id) : undefined;
    revenue += total;
    if (known !== undefined) {
      cost += known * qty;
      costed += total;
    } else {
      cost += total * fallback;
    }
  }
  return {
    ratio: revenue > 0 ? cost / revenue : fallback,
    revenue_inr: revenue,
    cost_inr: cost,
    costed_revenue_inr: costed,
    coverage_pct: revenue > 0 ? (100 * costed) / revenue : 0,
  };
}

// ---------------------------------------------------------------------------
// Free-item ranking
// ---------------------------------------------------------------------------

/** One variant of a menu item, with its entered cost (null = none entered). */
export interface FreeItemVariantInput {
  item_id: string;
  item_name: string;
  variant_id: string;
  variant_label: string;
  price_inr: number;
  cost_inr: number | null;
  /** The parent item's is_available. */
  is_available: boolean;
}

/**
 * Ranks the variants worth giving away, best first, ONE ROW PER VARIANT.
 *
 * Only variants that are available, priced, and have a REAL cost row qualify:
 * a default-% cost would make every item rank the same, and a cost of 0 would
 * make price ÷ cost infinite (it almost always means "not filled in yet").
 * Order: price ÷ cost descending (perceived value per rupee of cost); ties go to
 * the LOWER cost (the cheaper give-away); remaining ties to the item name and
 * variant id so the order is stable. Ratios are compared by cross-multiplication,
 * so ₹90/₹30 and ₹60/₹20 really tie instead of differing in the last float bit.
 *
 * `max_price` drops variants priced above it (the owner's "nothing over ₹250").
 */
export function rankFreeItems(
  variants: readonly FreeItemVariantInput[],
  opts: { max_price?: number } = {},
): FreeItemCandidate[] {
  const maxPrice = opts.max_price;
  const candidates: FreeItemCandidate[] = [];
  for (const v of variants) {
    if (!v.is_available) continue;
    if (v.cost_inr === null || !(v.cost_inr > 0) || !(v.price_inr > 0)) continue;
    if (maxPrice !== undefined && v.price_inr > maxPrice) continue;
    candidates.push({
      item_id: v.item_id,
      item_name: v.item_name,
      variant_id: v.variant_id,
      variant_label: v.variant_label,
      price_inr: v.price_inr,
      cost_inr: v.cost_inr,
      value_per_rupee: v.price_inr / v.cost_inr,
    });
  }
  return candidates.sort((a, b) => {
    const byValue = b.price_inr * a.cost_inr - a.price_inr * b.cost_inr; // b.value − a.value, cross-multiplied
    if (byValue !== 0) return byValue;
    if (a.cost_inr !== b.cost_inr) return a.cost_inr - b.cost_inr;
    return a.item_name.localeCompare(b.item_name) || a.variant_id.localeCompare(b.variant_id);
  });
}

/**
 * Freezes a free-item offer onto a real variant, or null when nothing can be
 * given (the no_free_item guardrail).
 *
 *   variant_id null   auto-pick: the top rankFreeItems() candidate at or under
 *                     max_item_price;
 *   variant_id set    the owner's pick: honoured as long as the variant exists, is
 *                     available and priced — even above max_item_price, because the
 *                     owner chose it. With no cost entered its cost is ESTIMATED at
 *                     default_food_cost_pct of its price (the same fallback every
 *                     uncosted order line gets).
 *
 * The frozen item_name / variant_label / price_inr / cost_inr make the campaign
 * repeatable even if the menu changes before the send.
 */
export function resolveFreeItemOffer(
  offer: FreeItemOffer,
  variants: readonly FreeItemVariantInput[],
  defaultFoodCostPct: number,
): FreeItemOffer | null {
  if (offer.variant_id === null) {
    const top = rankFreeItems(variants, { max_price: offer.max_item_price })[0];
    if (!top) return null;
    return {
      ...offer,
      item_id: top.item_id,
      variant_id: top.variant_id,
      item_name: top.item_name,
      variant_label: top.variant_label,
      price_inr: top.price_inr,
      cost_inr: top.cost_inr,
    };
  }

  const pinned = variants.find((v) => v.variant_id === offer.variant_id);
  if (!pinned || !pinned.is_available || !(pinned.price_inr > 0)) return null;
  const cost =
    pinned.cost_inr !== null
      ? pinned.cost_inr
      : Math.round(pinned.price_inr * clamp(finite(defaultFoodCostPct), 0, 100)) / 100;
  return {
    ...offer,
    item_id: pinned.item_id,
    variant_id: pinned.variant_id,
    item_name: pinned.item_name,
    variant_label: pinned.variant_label,
    price_inr: pinned.price_inr,
    cost_inr: cost,
  };
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export interface GuardrailInput {
  projection: Projection;
  /** settings.min_margin_pct. */
  min_margin_pct: number;
  /** monthly_budget_inr − this month's spend, ₹ (may be ≤ 0). */
  budget_remaining_inr: number;
  /** FoodCostResult.coverage_pct over the last 90 days, 0–100. */
  cost_coverage_pct: number;
  /** The template's `name` (empty = not mapped). */
  template_name: string;
  /** The (resolved) offer being sent. */
  offer: EconomicOffer;
}

/**
 * Every rule a campaign breaks, in a fixed order. Auto mode never sends a
 * flagged campaign — it falls back to Approvals for the owner to decide.
 *
 *   negative_profit  expected_profit ≤ 0
 *   low_margin       margin_after_pct < min_margin_pct
 *   over_budget      message_spend > what is left of this month's budget
 *   missing_costs    fewer than 50% of 90-day item revenue has a real cost entered
 *   no_template      the template name is empty
 *   no_free_item     a free-item offer with no pickable variant
 */
export function guardrailFlags(i: GuardrailInput): GuardrailFlag[] {
  const flags: GuardrailFlag[] = [];
  const p = i.projection;
  if (p.expected_profit_inr <= 0) flags.push('negative_profit');
  if (p.margin_after_pct < i.min_margin_pct) flags.push('low_margin');
  if (p.message_spend_inr > Math.max(0, i.budget_remaining_inr)) flags.push('over_budget');
  if (i.cost_coverage_pct < MIN_COST_COVERAGE_PCT) flags.push('missing_costs');
  if (i.template_name.trim() === '') flags.push('no_template');
  if (i.offer.type === 'free_item' && !isFreeItemResolved(i.offer)) flags.push('no_free_item');
  return flags;
}

// ---------------------------------------------------------------------------
// Measured lift (spec §1.8)
// ---------------------------------------------------------------------------

export interface LiftInput {
  /** Treated recipients that were sent/delivered/read. */
  treated_delivered: number;
  treated_converted: number;
  /** Everyone in the holdout. */
  holdout_n: number;
  holdout_converted: number;
}

export interface LiftResult {
  /** treated_converted ÷ treated_delivered (0–1), null when nothing was delivered. */
  treated_rate: number | null;
  /** holdout_converted ÷ holdout_n (0–1), null for an empty holdout. */
  holdout_rate: number | null;
  /** 100 × (treated_rate − holdout_rate) — percentage points. null until the holdout has 20 people. */
  lift_pp: number | null;
  /** max(0, lift) × treated_delivered — the returns the campaign actually caused. null when lift_pp is. */
  incremental_orders: number | null;
  holdout_big_enough: boolean;
}

/**
 * Raw returns overstate a campaign's effect: some of those customers would have
 * come back anyway. The holdout — people who qualified but were deliberately not
 * messaged — shows how many. Lift is the difference between the two groups'
 * return rates; below 20 holdout people it is noise, so it is withheld.
 */
export function computeLift(i: LiftInput): LiftResult {
  const holdoutBigEnough = i.holdout_n >= MIN_HOLDOUT_FOR_LIFT;
  const treatedRate = i.treated_delivered > 0 ? i.treated_converted / i.treated_delivered : null;
  const holdoutRate = i.holdout_n > 0 ? i.holdout_converted / i.holdout_n : null;
  if (!holdoutBigEnough || treatedRate === null || holdoutRate === null) {
    return { treated_rate: treatedRate, holdout_rate: holdoutRate, lift_pp: null, incremental_orders: null, holdout_big_enough: holdoutBigEnough };
  }
  const liftPp = 100 * (treatedRate - holdoutRate);
  return {
    treated_rate: treatedRate,
    holdout_rate: holdoutRate,
    lift_pp: liftPp,
    incremental_orders: Math.max(0, liftPp / 100) * i.treated_delivered,
    holdout_big_enough: true,
  };
}
