import { describe, expect, it } from 'vitest';
import {
  basketValue,
  blendedFoodCost,
  blendedRate,
  breakEven,
  computeLift,
  guardrailFlags,
  learnedDeliverability,
  offerCost,
  project,
  rankFreeItems,
  resolveFreeItemOffer,
  splitHoldout,
  type FreeItemVariantInput,
  type GuardrailInput,
} from '@/lib/marketing/economics';
import type { FreeItemOffer, Offer, Projection } from '@/lib/marketing/types';

const PERCENT_10: Offer = { type: 'percent', percent: 10, cap_inr: 60, min_order_inr: 150, validity_days: 10 };

// The spec's worked example (§1.6): win-back stage 1, 200 eligible.
const WORKED = {
  eligible: 200,
  holdout_pct: 10,
  message_cost_inr: 1.02,
  deliverability: 0.9,
  conversion_rate: 0.12,
  basket_inr: 320,
  food_cost_ratio: 0.35,
  offer: PERCENT_10,
};

describe('project — the spec worked example', () => {
  const p = project(WORKED);

  it('splits 200 eligible into 20 holdout and 180 treated', () => {
    expect(p.eligible).toBe(200);
    expect(p.holdout).toBe(20);
    expect(p.treated).toBe(180);
  });

  it('message spend is 180 × ₹1.02 ≈ ₹184', () => {
    expect(p.message_spend_inr).toBeCloseTo(183.6, 6);
    expect(Math.round(p.message_spend_inr)).toBe(184);
  });

  it('expects 180 × 0.9 × 0.12 = 19.44 returning orders (≈ 19.4)', () => {
    expect(p.conversions).toBeCloseTo(19.44, 6);
  });

  it('10% off a ₹320 basket (cap ₹60) discounts ₹32; profit per order is 320 × 0.65 − 32 = ₹176', () => {
    expect(p.discount_inr).toBe(32);
    expect(p.offer_cost_inr).toBe(32);
    expect(p.profit_per_conv_inr).toBeCloseTo(176, 6);
    expect(p.margin_after_pct).toBeCloseTo(55, 6);
  });

  it('revenue ≈ ₹5,599, offer spend ≈ ₹622, expected profit ≈ ₹3,238', () => {
    expect(p.revenue_inr).toBeCloseTo(19.44 * 288, 4); // 5598.72
    expect(p.offer_spend_inr).toBeCloseTo(19.44 * 32, 4);
    expect(p.expected_profit_inr).toBeCloseTo(19.44 * 176 - 183.6, 4); // 3237.84
    expect(p.expected_profit_inr).toBeGreaterThan(3200);
    expect(p.expected_profit_inr).toBeLessThan(3300);
  });

  it('ROI = profit ÷ (message spend + offer spend)', () => {
    expect(p.roi).toBeCloseTo(3237.84 / (183.6 + 622.08), 4);
  });

  it('breaks even at ~0.64% conversion (the spec rounds the message spend to ₹184 and quotes 0.65%)', () => {
    expect(p.break_even_rate).toBeCloseTo(183.6 / (180 * 0.9 * 176), 8);
    expect(p.break_even_rate).toBeGreaterThan(0.0064);
    expect(p.break_even_rate).toBeLessThan(0.0065);
  });

  it('echoes the inputs it used', () => {
    expect(p).toMatchObject({ message_cost_inr: 1.02, deliverability: 0.9, conversion_rate: 0.12, basket_inr: 320, food_cost_ratio: 0.35 });
  });
});

describe('splitHoldout', () => {
  it('holdout = round(N × pct / 100), treated = the rest', () => {
    expect(splitHoldout(200, 10)).toEqual({ holdout: 20, treated: 180 });
    expect(splitHoldout(100, 25)).toEqual({ holdout: 25, treated: 75 });
  });

  it('rounds halves up: 5 people at 10% → 1 held out; 15 at 10% → 2', () => {
    expect(splitHoldout(5, 10)).toEqual({ holdout: 1, treated: 4 });
    expect(splitHoldout(15, 10)).toEqual({ holdout: 2, treated: 13 });
  });

  it('rounds below half down: 4 people at 10% → nobody held out', () => {
    expect(splitHoldout(4, 10)).toEqual({ holdout: 0, treated: 4 });
    expect(splitHoldout(1, 10)).toEqual({ holdout: 0, treated: 1 });
  });

  it('0% holds nobody out and 50% holds half', () => {
    expect(splitHoldout(37, 0)).toEqual({ holdout: 0, treated: 37 });
    expect(splitHoldout(40, 50)).toEqual({ holdout: 20, treated: 20 });
  });

  it('empty and nonsense inputs are zeros', () => {
    expect(splitHoldout(0, 10)).toEqual({ holdout: 0, treated: 0 });
    expect(splitHoldout(-5, 10)).toEqual({ holdout: 0, treated: 0 });
    expect(splitHoldout(Number.NaN, 10)).toEqual({ holdout: 0, treated: 0 });
  });

  it('never holds out more people than exist', () => {
    expect(splitHoldout(1, 100)).toEqual({ holdout: 1, treated: 0 });
    expect(splitHoldout(3, 500)).toEqual({ holdout: 3, treated: 0 });
  });

  it('project() uses the same split', () => {
    expect(project({ ...WORKED, eligible: 5 })).toMatchObject({ holdout: 1, treated: 4 });
  });
});

describe('offerCost', () => {
  const ctx = { basket_inr: 320 };

  it('none costs nothing', () => {
    expect(offerCost({ type: 'none' }, ctx)).toEqual({ discount_inr: 0, cost_inr: 0 });
  });

  it('percent: min(A × p/100, cap)', () => {
    expect(offerCost(PERCENT_10, ctx)).toEqual({ discount_inr: 32, cost_inr: 32 });
    expect(offerCost({ ...PERCENT_10, cap_inr: 20 }, ctx)).toEqual({ discount_inr: 20, cost_inr: 20 }); // capped
    expect(offerCost({ ...PERCENT_10, cap_inr: 0 }, ctx)).toEqual({ discount_inr: 32, cost_inr: 32 }); // 0 = no cap
    expect(offerCost({ ...PERCENT_10, percent: 50, cap_inr: 0 }, ctx)).toEqual({ discount_inr: 160, cost_inr: 160 });
  });

  it('flat: min(F, A)', () => {
    expect(offerCost({ type: 'flat', amount_inr: 50, min_order_inr: 0, validity_days: 7 }, ctx)).toEqual({ discount_inr: 50, cost_inr: 50 });
    expect(offerCost({ type: 'flat', amount_inr: 500, min_order_inr: 0, validity_days: 7 }, ctx)).toEqual({ discount_inr: 320, cost_inr: 320 });
  });

  it('points: min(points value, A × max_redeem_pct/100), defaulting to 50%', () => {
    expect(offerCost({ type: 'points', points_value_inr: 80 }, ctx)).toEqual({ discount_inr: 80, cost_inr: 80 });
    expect(offerCost({ type: 'points', points_value_inr: 400 }, ctx)).toEqual({ discount_inr: 160, cost_inr: 160 }); // half the bill
    expect(offerCost({ type: 'points', points_value_inr: 400 }, { ...ctx, max_redeem_pct: 25 })).toEqual({ discount_inr: 80, cost_inr: 80 });
  });

  it('a free item costs its PRODUCT COST, not its price, and takes nothing off the bill', () => {
    const free: FreeItemOffer = {
      type: 'free_item', item_id: 'i', variant_id: 'v', max_item_price: 250, min_order_inr: 200, validity_days: 10,
      item_name: 'Cold Coffee', variant_label: 'Regular', price_inr: 180, cost_inr: 45,
    };
    expect(offerCost(free, ctx)).toEqual({ discount_inr: 0, cost_inr: 45 });
  });

  it('an unresolved free item costs 0 (the no_free_item guardrail is what stops it)', () => {
    const free: FreeItemOffer = { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 };
    expect(offerCost(free, ctx)).toEqual({ discount_inr: 0, cost_inr: 0 });
  });

  it('a negative or non-finite basket is treated as 0', () => {
    expect(offerCost(PERCENT_10, { basket_inr: -50 })).toEqual({ discount_inr: 0, cost_inr: 0 });
    expect(offerCost(PERCENT_10, { basket_inr: Number.NaN })).toEqual({ discount_inr: 0, cost_inr: 0 });
  });
});

describe('project — a free item vs a discount (why product costs matter)', () => {
  it('a ₹180 item costing ₹45 is a cheaper give-away than 10% off ₹320', () => {
    const free: Offer = {
      type: 'free_item', item_id: 'i', variant_id: 'v', max_item_price: 250, min_order_inr: 200, validity_days: 10,
      item_name: 'Cold Coffee', variant_label: 'Regular', price_inr: 180, cost_inr: 45,
    };
    const pct = project(WORKED);
    const fre = project({ ...WORKED, offer: free });
    expect(fre.discount_inr).toBe(0);
    expect(fre.offer_cost_inr).toBe(45);
    expect(fre.revenue_inr).toBeCloseTo(19.44 * 320, 4); // the basket is not reduced
    // 32 → 45 per order costs more here, but it FEELS like ₹180 to the customer.
    expect(fre.profit_per_conv_inr).toBeCloseTo(320 * 0.65 - 45, 6);
    expect(pct.profit_per_conv_inr).toBeCloseTo(320 * 0.65 - 32, 6);
  });
});

describe('project — edge cases', () => {
  it('zero eligible is an all-zero forecast with null ROI and break-even', () => {
    const p = project({ ...WORKED, eligible: 0 });
    expect(p).toMatchObject({ eligible: 0, holdout: 0, treated: 0, conversions: 0, message_spend_inr: 0, offer_spend_inr: 0, revenue_inr: 0, expected_profit_inr: 0 });
    expect(p.roi).toBeNull();
    expect(p.break_even_rate).toBeNull();
  });

  it('zero message cost: spend is 0, break-even is 0, ROI is defined by the offer spend', () => {
    const p = project({ ...WORKED, message_cost_inr: 0 });
    expect(p.message_spend_inr).toBe(0);
    expect(p.break_even_rate).toBe(0);
    expect(p.roi).toBeCloseTo(p.expected_profit_inr / p.offer_spend_inr, 6);
  });

  it('zero message cost AND no offer: nothing is spent, so ROI is null', () => {
    const p = project({ ...WORKED, message_cost_inr: 0, offer: { type: 'none' } });
    expect(p.roi).toBeNull();
    expect(p.expected_profit_inr).toBeGreaterThan(0);
  });

  it('profit per conversion ≤ 0 → no break-even rate at all', () => {
    // A = 100, f = 0.9 → 10 gross, minus a ₹50 flat offer capped at the basket → −40.
    const p = project({ ...WORKED, basket_inr: 100, food_cost_ratio: 0.9, offer: { type: 'flat', amount_inr: 50, min_order_inr: 0, validity_days: 7 } });
    expect(p.profit_per_conv_inr).toBeLessThan(0);
    expect(p.break_even_rate).toBeNull();
    expect(p.expected_profit_inr).toBeLessThan(0);
  });

  it('profit per conversion of exactly 0 → null, not Infinity', () => {
    const p = project({ ...WORKED, basket_inr: 100, food_cost_ratio: 0.5, offer: { type: 'flat', amount_inr: 50, min_order_inr: 0, validity_days: 7 } });
    expect(p.profit_per_conv_inr).toBe(0);
    expect(p.break_even_rate).toBeNull();
  });

  it('nobody reachable (deliverability 0) → null break-even, all spend is wasted', () => {
    const p = project({ ...WORKED, deliverability: 0 });
    expect(p.conversions).toBe(0);
    expect(p.break_even_rate).toBeNull();
    expect(p.expected_profit_inr).toBeCloseTo(-183.6, 6);
  });

  it('zero holdout treats everyone', () => {
    const p = project({ ...WORKED, holdout_pct: 0 });
    expect(p).toMatchObject({ holdout: 0, treated: 200 });
    expect(p.message_spend_inr).toBeCloseTo(204, 6);
  });

  it('clamps out-of-range inputs instead of trusting them', () => {
    const p = project({ ...WORKED, conversion_rate: 5, deliverability: 2, food_cost_ratio: -1, basket_inr: -10, message_cost_inr: -3 });
    expect(p.conversion_rate).toBe(1);
    expect(p.deliverability).toBe(1);
    expect(p.food_cost_ratio).toBe(0);
    expect(p.basket_inr).toBe(0);
    expect(p.message_cost_inr).toBe(0);
    expect(p.margin_after_pct).toBe(0); // a zero basket has no margin, not NaN
  });

  it('a points reminder is priced with the implicit points offer', () => {
    const p = project({ ...WORKED, conversion_rate: 0.15, offer: { type: 'points', points_value_inr: 80 } });
    expect(p.discount_inr).toBe(80);
    expect(p.offer_cost_inr).toBe(80);
    expect(p.profit_per_conv_inr).toBeCloseTo(320 * 0.65 - 80, 6);
  });

  it('learned_at is never set by project()', () => {
    expect(project(WORKED).learned_at).toBeUndefined();
  });
});

describe('breakEven', () => {
  it('message spend ÷ (treated × d × profit per conversion)', () => {
    expect(breakEven({ message_spend_inr: 100, treated: 100, deliverability: 1, profit_per_conv_inr: 100 })).toBeCloseTo(0.01, 10);
  });

  it('null when profit per conversion is ≤ 0', () => {
    expect(breakEven({ message_spend_inr: 100, treated: 100, deliverability: 1, profit_per_conv_inr: 0 })).toBeNull();
    expect(breakEven({ message_spend_inr: 100, treated: 100, deliverability: 1, profit_per_conv_inr: -5 })).toBeNull();
  });

  it('null when nobody can be reached', () => {
    expect(breakEven({ message_spend_inr: 0, treated: 0, deliverability: 0.9, profit_per_conv_inr: 100 })).toBeNull();
    expect(breakEven({ message_spend_inr: 5, treated: 10, deliverability: 0, profit_per_conv_inr: 100 })).toBeNull();
  });
});

describe('blendedRate (spec §1.6 Learning)', () => {
  it('is the prior with no observations', () => {
    expect(blendedRate(12, 0, 0)).toBeCloseTo(0.12, 10);
    expect(blendedRate(15, 0, 0)).toBeCloseTo(0.15, 10);
  });

  it('moves toward what the cafe achieves: (prior × 50 + conv) ÷ (50 + treated)', () => {
    // prior 12%, 50 delivered, 0 returned → (6 + 0) / 100 = 6%
    expect(blendedRate(12, 50, 0)).toBeCloseTo(0.06, 10);
    // prior 12%, 50 delivered, 20 returned → (6 + 20) / 100 = 26%
    expect(blendedRate(12, 50, 20)).toBeCloseTo(0.26, 10);
  });

  it('with lots of data the observation dominates the prior', () => {
    expect(blendedRate(12, 10_000, 2_000)).toBeCloseTo(0.2, 2);
  });

  it('is clamped to [0, 1] and tolerant of nonsense', () => {
    expect(blendedRate(12, 10, 500)).toBe(1);
    expect(blendedRate(-5, 0, 0)).toBe(0);
    expect(blendedRate(Number.NaN, 0, 0)).toBe(0);
  });
});

describe('learnedDeliverability', () => {
  it('is 0.9 while receipts are not flowing, however good the counts look', () => {
    expect(learnedDeliverability(500, 100, false)).toBe(0.9);
  });

  it('is 0.9 with too few sends to mean anything', () => {
    expect(learnedDeliverability(19, 19, true)).toBe(0.9);
    expect(learnedDeliverability(0, 0, true)).toBe(0.9);
  });

  it('is delivered ÷ sent once receipts flow with enough data', () => {
    expect(learnedDeliverability(200, 170, true)).toBeCloseTo(0.85, 10);
    expect(learnedDeliverability(20, 20, true)).toBe(1);
  });

  it('is floored at 0.05 so one bad batch cannot zero a forecast', () => {
    expect(learnedDeliverability(100, 0, true)).toBe(0.05);
  });
});

describe('basketValue', () => {
  it('is the median of the recipients’ own average order values', () => {
    expect(basketValue([200, 300, 400], 999)).toBe(300);
    expect(basketValue([200, 300, 400, 500], 999)).toBe(350);
  });

  it('ignores contacts with no basket (0) and non-numbers', () => {
    expect(basketValue([0, 0, 300], 999)).toBe(300);
    expect(basketValue([Number.NaN, 100], 999)).toBe(100);
  });

  it('falls back to the store 90-day AOV when nobody has one', () => {
    expect(basketValue([], 280)).toBe(280);
    expect(basketValue([0, 0], 280)).toBe(280);
    expect(basketValue([], Number.NaN)).toBe(0);
  });

  it('does not mutate its input', () => {
    const v = [300, 100, 200];
    basketValue(v, 0);
    expect(v).toEqual([300, 100, 200]);
  });
});

describe('blendedFoodCost', () => {
  const V1 = '00000000-0000-4000-8000-000000000001';
  const V2 = '00000000-0000-4000-8000-000000000002';
  const costs = new Map([[V1, 40], [V2, 100]]);

  it('uses each variant’s cost × quantity where known', () => {
    const r = blendedFoodCost(
      [
        { variant_id: V1, quantity: 2, line_total_inr: 300 }, // cost 80
        { variant_id: V2, quantity: 1, line_total_inr: 200 }, // cost 100
      ],
      costs,
      35,
    );
    expect(r.cost_inr).toBe(180);
    expect(r.revenue_inr).toBe(500);
    expect(r.ratio).toBeCloseTo(0.36, 10);
    expect(r.coverage_pct).toBe(100);
  });

  it('falls back to revenue × default % for a line with no cost row', () => {
    const r = blendedFoodCost([{ variant_id: 'unknown', quantity: 1, line_total_inr: 200 }], costs, 35);
    expect(r.cost_inr).toBeCloseTo(70, 10);
    expect(r.ratio).toBeCloseTo(0.35, 10);
    expect(r.coverage_pct).toBe(0);
  });

  it('a legacy line with no variant_id can never have a cost', () => {
    const r = blendedFoodCost([{ variant_id: null, quantity: 3, line_total_inr: 300 }], costs, 40);
    expect(r.ratio).toBeCloseTo(0.4, 10);
    expect(r.coverage_pct).toBe(0);
  });

  it('mixes known and default lines, and reports the share of revenue that is costed', () => {
    const r = blendedFoodCost(
      [
        { variant_id: V1, quantity: 1, line_total_inr: 100 }, // cost 40, costed
        { variant_id: 'x', quantity: 1, line_total_inr: 300 }, // 35% → 105, uncosted
      ],
      costs,
      35,
    );
    expect(r.cost_inr).toBeCloseTo(145, 10);
    expect(r.ratio).toBeCloseTo(145 / 400, 10);
    expect(r.coverage_pct).toBeCloseTo(25, 10);
    expect(r.costed_revenue_inr).toBe(100);
  });

  it('excludes voided lines entirely — from cost, revenue and coverage', () => {
    const r = blendedFoodCost(
      [
        { variant_id: V1, quantity: 1, line_total_inr: 100 },
        { variant_id: V2, quantity: 5, line_total_inr: 9999, voided: true },
      ],
      costs,
      35,
    );
    expect(r.revenue_inr).toBe(100);
    expect(r.cost_inr).toBe(40);
    expect(r.ratio).toBeCloseTo(0.4, 10);
  });

  it('no lines → the default ratio and 0 coverage', () => {
    const r = blendedFoodCost([], costs, 35);
    expect(r).toMatchObject({ ratio: 0.35, revenue_inr: 0, cost_inr: 0, coverage_pct: 0 });
  });

  it('only voided lines behave like no lines', () => {
    const r = blendedFoodCost([{ variant_id: V1, quantity: 1, line_total_inr: 100, voided: true }], costs, 35);
    expect(r.ratio).toBe(0.35);
    expect(r.revenue_inr).toBe(0);
  });

  it('a real cost of ₹0 counts as a real entry (cost 0, costed)', () => {
    const r = blendedFoodCost([{ variant_id: 'free', quantity: 1, line_total_inr: 100 }], new Map([['free', 0]]), 35);
    expect(r.cost_inr).toBe(0);
    expect(r.coverage_pct).toBe(100);
  });
});

describe('rankFreeItems (spec §1.6: one row per VARIANT, real costs only)', () => {
  const v = (over: Partial<FreeItemVariantInput> & { variant_id: string }): FreeItemVariantInput => ({
    item_id: `item-${over.variant_id}`,
    item_name: `Item ${over.variant_id}`,
    variant_label: 'Regular',
    price_inr: 100,
    cost_inr: 25,
    is_available: true,
    ...over,
  });

  it('ranks by price ÷ cost, best value first', () => {
    const ranked = rankFreeItems([
      v({ variant_id: 'a', price_inr: 180, cost_inr: 45 }), // 4.0
      v({ variant_id: 'b', price_inr: 200, cost_inr: 40 }), // 5.0
      v({ variant_id: 'c', price_inr: 120, cost_inr: 60 }), // 2.0
    ]);
    expect(ranked.map((r) => r.variant_id)).toEqual(['b', 'a', 'c']);
    expect(ranked[0].value_per_rupee).toBe(5);
  });

  it('breaks ties by the LOWER cost', () => {
    const ranked = rankFreeItems([
      v({ variant_id: 'pricey', price_inr: 180, cost_inr: 60 }), // 3.0
      v({ variant_id: 'cheap', price_inr: 90, cost_inr: 30 }), // 3.0
      v({ variant_id: 'cheapest', price_inr: 60, cost_inr: 20 }), // 3.0
    ]);
    expect(ranked.map((r) => r.variant_id)).toEqual(['cheapest', 'cheap', 'pricey']);
  });

  it('compares ratios exactly (100/30 and 10/3 tie, then the cost decides)', () => {
    const ranked = rankFreeItems([
      v({ variant_id: 'big', price_inr: 100, cost_inr: 30 }),
      v({ variant_id: 'small', price_inr: 10, cost_inr: 3 }),
    ]);
    expect(ranked.map((r) => r.variant_id)).toEqual(['small', 'big']);
  });

  it('only variants with a REAL cost row qualify — a missing cost ranks nothing', () => {
    const ranked = rankFreeItems([
      v({ variant_id: 'a', cost_inr: null }),
      v({ variant_id: 'b', cost_inr: 40 }),
    ]);
    expect(ranked.map((r) => r.variant_id)).toEqual(['b']);
  });

  it('a cost of 0 is excluded (price ÷ 0 is meaningless and it usually means "not filled in")', () => {
    expect(rankFreeItems([v({ variant_id: 'a', cost_inr: 0 })])).toEqual([]);
  });

  it('a zero price is excluded', () => {
    expect(rankFreeItems([v({ variant_id: 'a', price_inr: 0, cost_inr: 10 })])).toEqual([]);
  });

  it('skips unavailable items', () => {
    expect(rankFreeItems([v({ variant_id: 'a', is_available: false })])).toEqual([]);
  });

  it('is one row per variant: two sizes of one item are two candidates', () => {
    const ranked = rankFreeItems([
      v({ variant_id: 'reg', item_id: 'coffee', item_name: 'Cold Coffee', variant_label: 'Regular', price_inr: 160, cost_inr: 40 }),
      v({ variant_id: 'lrg', item_id: 'coffee', item_name: 'Cold Coffee', variant_label: 'Large', price_inr: 220, cost_inr: 50 }),
    ]);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((r) => r.variant_label)).toEqual(['Large', 'Regular']); // 4.4 vs 4.0
    expect(ranked.every((r) => r.item_id === 'coffee')).toBe(true);
  });

  it('respects the max price (inclusive)', () => {
    const list = [
      v({ variant_id: 'a', price_inr: 300, cost_inr: 30 }), // best value but over the limit
      v({ variant_id: 'b', price_inr: 250, cost_inr: 50 }),
      v({ variant_id: 'c', price_inr: 100, cost_inr: 40 }),
    ];
    expect(rankFreeItems(list, { max_price: 250 }).map((r) => r.variant_id)).toEqual(['b', 'c']);
    expect(rankFreeItems(list, { max_price: 249 }).map((r) => r.variant_id)).toEqual(['c']);
    expect(rankFreeItems(list, { max_price: 50 })).toEqual([]);
    expect(rankFreeItems(list).map((r) => r.variant_id)).toEqual(['a', 'b', 'c']);
  });

  it('empty input is an empty ranking, and the input is not mutated', () => {
    expect(rankFreeItems([])).toEqual([]);
    const list = [v({ variant_id: 'a', price_inr: 100, cost_inr: 50 }), v({ variant_id: 'b', price_inr: 100, cost_inr: 10 })];
    rankFreeItems(list);
    expect(list.map((x) => x.variant_id)).toEqual(['a', 'b']);
  });

  it('is stable for full ties (by item name, then variant id)', () => {
    const ranked = rankFreeItems([
      v({ variant_id: 'z', item_name: 'Zeta' }),
      v({ variant_id: 'a', item_name: 'Alpha' }),
    ]);
    expect(ranked.map((r) => r.item_name)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('resolveFreeItemOffer', () => {
  const auto: FreeItemOffer = { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 };
  const variants: FreeItemVariantInput[] = [
    { item_id: 'i1', item_name: 'Cold Coffee', variant_id: 'v1', variant_label: 'Regular', price_inr: 180, cost_inr: 45, is_available: true },
    { item_id: 'i2', item_name: 'Waffle', variant_id: 'v2', variant_label: 'Large', price_inr: 200, cost_inr: 40, is_available: true },
    { item_id: 'i3', item_name: 'Truffle Shake', variant_id: 'v3', variant_label: 'Regular', price_inr: 400, cost_inr: 40, is_available: true },
    { item_id: 'i4', item_name: 'Mystery', variant_id: 'v4', variant_label: 'Regular', price_inr: 150, cost_inr: null, is_available: true },
  ];

  it('auto-picks the best-value variant under the price cap and freezes its details', () => {
    const r = resolveFreeItemOffer(auto, variants, 35);
    expect(r).toMatchObject({
      type: 'free_item', item_id: 'i2', variant_id: 'v2', item_name: 'Waffle', variant_label: 'Large', price_inr: 200, cost_inr: 40,
      max_item_price: 250, min_order_inr: 200, validity_days: 10,
    });
  });

  it('auto-pick ignores variants over max_item_price', () => {
    const r = resolveFreeItemOffer({ ...auto, max_item_price: 190 }, variants, 35);
    expect(r?.variant_id).toBe('v1');
  });

  it('auto-pick is null when nothing has a cost or fits (→ the no_free_item flag)', () => {
    expect(resolveFreeItemOffer(auto, [variants[3]], 35)).toBeNull();
    expect(resolveFreeItemOffer({ ...auto, max_item_price: 10 }, variants, 35)).toBeNull();
    expect(resolveFreeItemOffer(auto, [], 35)).toBeNull();
  });

  it('honours the owner’s pinned variant, even above the auto-pick cap', () => {
    const r = resolveFreeItemOffer({ ...auto, item_id: 'i3', variant_id: 'v3', max_item_price: 100 }, variants, 35);
    expect(r).toMatchObject({ variant_id: 'v3', price_inr: 400, cost_inr: 40, item_name: 'Truffle Shake' });
  });

  it('a pinned variant with no entered cost is estimated at default_food_cost_pct of its price', () => {
    const r = resolveFreeItemOffer({ ...auto, item_id: 'i4', variant_id: 'v4' }, variants, 35);
    expect(r?.cost_inr).toBeCloseTo(52.5, 10);
  });

  it('a pinned variant that is gone, unavailable or unpriced resolves to null', () => {
    expect(resolveFreeItemOffer({ ...auto, item_id: 'x', variant_id: 'missing' }, variants, 35)).toBeNull();
    const off = [{ ...variants[0], is_available: false }];
    expect(resolveFreeItemOffer({ ...auto, item_id: 'i1', variant_id: 'v1' }, off, 35)).toBeNull();
    const free = [{ ...variants[0], price_inr: 0 }];
    expect(resolveFreeItemOffer({ ...auto, item_id: 'i1', variant_id: 'v1' }, free, 35)).toBeNull();
  });

  it('does not mutate the offer it was given', () => {
    const copy = { ...auto };
    resolveFreeItemOffer(auto, variants, 35);
    expect(auto).toEqual(copy);
  });
});

describe('guardrailFlags (spec §1.6)', () => {
  const healthy = (): Projection => project(WORKED);
  const base = (over: Partial<GuardrailInput> = {}): GuardrailInput => ({
    projection: healthy(),
    min_margin_pct: 30,
    budget_remaining_inr: 1000,
    cost_coverage_pct: 80,
    template_name: 'hioc_winback_1',
    offer: PERCENT_10,
    ...over,
  });

  it('a healthy campaign has no flags', () => {
    expect(guardrailFlags(base())).toEqual([]);
  });

  it('negative_profit when expected profit is ≤ 0 (including exactly 0)', () => {
    expect(guardrailFlags(base({ projection: project({ ...WORKED, eligible: 0 }) }))).toContain('negative_profit');
    const losing = project({ ...WORKED, conversion_rate: 0.0001 });
    expect(losing.expected_profit_inr).toBeLessThan(0);
    expect(guardrailFlags(base({ projection: losing }))).toContain('negative_profit');
  });

  it('low_margin when margin after offer is below the minimum (strictly)', () => {
    // margin_after_pct = 55 for the worked example
    expect(guardrailFlags(base({ min_margin_pct: 56 }))).toContain('low_margin');
    expect(guardrailFlags(base({ min_margin_pct: 55 }))).not.toContain('low_margin');
    expect(guardrailFlags(base({ min_margin_pct: 0 }))).not.toContain('low_margin');
  });

  it('over_budget when message spend exceeds what is left this month', () => {
    // message spend 183.6
    expect(guardrailFlags(base({ budget_remaining_inr: 183 }))).toContain('over_budget');
    expect(guardrailFlags(base({ budget_remaining_inr: 183.6 }))).not.toContain('over_budget');
    expect(guardrailFlags(base({ budget_remaining_inr: 0 }))).toContain('over_budget');
    expect(guardrailFlags(base({ budget_remaining_inr: -50 }))).toContain('over_budget');
  });

  it('an overspent budget does not flag a campaign that costs nothing to message', () => {
    const free = project({ ...WORKED, message_cost_inr: 0 });
    expect(guardrailFlags(base({ projection: free, budget_remaining_inr: -50 }))).not.toContain('over_budget');
  });

  it('missing_costs when under 50% of revenue has a real cost', () => {
    expect(guardrailFlags(base({ cost_coverage_pct: 49.9 }))).toContain('missing_costs');
    expect(guardrailFlags(base({ cost_coverage_pct: 50 }))).not.toContain('missing_costs');
    expect(guardrailFlags(base({ cost_coverage_pct: 0 }))).toContain('missing_costs');
  });

  it('no_template when the template name is empty or blank', () => {
    expect(guardrailFlags(base({ template_name: '' }))).toContain('no_template');
    expect(guardrailFlags(base({ template_name: '   ' }))).toContain('no_template');
  });

  it('no_free_item for a free-item offer that is not pinned to a real variant', () => {
    const unresolved: FreeItemOffer = { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 };
    expect(guardrailFlags(base({ offer: unresolved }))).toContain('no_free_item');
    const resolved: FreeItemOffer = { ...unresolved, item_id: 'i', variant_id: 'v', price_inr: 180, cost_inr: 45, item_name: 'Cold Coffee', variant_label: 'Regular' };
    expect(guardrailFlags(base({ offer: resolved }))).not.toContain('no_free_item');
    // Pinned ids but the price/cost were never frozen: still not usable.
    expect(guardrailFlags(base({ offer: { ...unresolved, item_id: 'i', variant_id: 'v' } }))).toContain('no_free_item');
  });

  it('never raises no_free_item for other offer types', () => {
    expect(guardrailFlags(base({ offer: { type: 'none' } }))).not.toContain('no_free_item');
  });

  it('reports every broken rule, in a fixed order', () => {
    const flags = guardrailFlags(
      base({
        projection: project({ ...WORKED, eligible: 0 }),
        min_margin_pct: 90,
        budget_remaining_inr: -1,
        cost_coverage_pct: 0,
        template_name: '',
        offer: { type: 'free_item', item_id: null, variant_id: null, max_item_price: 250, min_order_inr: 200, validity_days: 10 },
      }),
    );
    expect(flags).toEqual(['negative_profit', 'low_margin', 'missing_costs', 'no_template', 'no_free_item']);
    // (over_budget is absent: eligible 0 means no message spend to exceed the budget.)
  });
});

describe('computeLift (spec §1.8)', () => {
  it('lift = 100 × (treated rate − holdout rate), incremental = lift × delivered', () => {
    const r = computeLift({ treated_delivered: 180, treated_converted: 36, holdout_n: 20, holdout_converted: 2 });
    expect(r.treated_rate).toBeCloseTo(0.2, 10);
    expect(r.holdout_rate).toBeCloseTo(0.1, 10);
    expect(r.lift_pp).toBeCloseTo(10, 8);
    expect(r.incremental_orders).toBeCloseTo(18, 8);
    expect(r.holdout_big_enough).toBe(true);
  });

  it('withholds lift below 20 holdout people ("not enough data yet")', () => {
    const r = computeLift({ treated_delivered: 100, treated_converted: 30, holdout_n: 19, holdout_converted: 1 });
    expect(r.lift_pp).toBeNull();
    expect(r.incremental_orders).toBeNull();
    expect(r.holdout_big_enough).toBe(false);
    expect(r.treated_rate).toBeCloseTo(0.3, 10); // the raw rates are still reported
  });

  it('exactly 20 in the holdout is enough', () => {
    expect(computeLift({ treated_delivered: 100, treated_converted: 20, holdout_n: 20, holdout_converted: 4 }).holdout_big_enough).toBe(true);
  });

  it('negative lift is reported, but incremental orders floor at 0', () => {
    const r = computeLift({ treated_delivered: 100, treated_converted: 5, holdout_n: 40, holdout_converted: 10 });
    expect(r.lift_pp).toBeCloseTo(-20, 8);
    expect(r.incremental_orders).toBe(0);
  });

  it('nothing delivered yet → no treated rate and no lift', () => {
    const r = computeLift({ treated_delivered: 0, treated_converted: 0, holdout_n: 50, holdout_converted: 5 });
    expect(r.treated_rate).toBeNull();
    expect(r.lift_pp).toBeNull();
  });

  it('an empty holdout has no rate', () => {
    const r = computeLift({ treated_delivered: 100, treated_converted: 10, holdout_n: 0, holdout_converted: 0 });
    expect(r.holdout_rate).toBeNull();
    expect(r.lift_pp).toBeNull();
    expect(r.holdout_big_enough).toBe(false);
  });
});
