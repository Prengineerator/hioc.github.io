// HIOC Ritual pricing for an order that spends pass cups (docs/COFFEE-PASS-SPEC.md
// §6, §7): the ONE copy of "which cups pay for which lines" and "what is the bill
// once they have", shared by POST /api/orders (which charges it) and
// POST /api/orders/quote (which previews it), so the number on the checkout is
// the number the server charges. The same rule the rest of order pricing keeps
// (lib/orders/lines.ts): money math gets one copy, not two.
//
// Two halves:
//   allocateOrderPass   the database half (loads the passes and which drinks are
//                       eligible, then hands the pure allocator its lines)
//   composeOrderBill    the pure half (pass, then multi-buy offers, then coupon,
//                       then points: CP-D12)
//
// Neither creates or changes anything. redeemPassDrinks (lib/passes/server.ts)
// is what spends the cups, and only POST /api/orders calls it.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResolvedLine } from '@/lib/orders/lines';
import { allocatePassDrinks, composePassBill } from '@/lib/passes/rules';
import { loadEligibleMenuIds, loadUsablePassSummaries, toUsablePass } from '@/lib/passes/server';
import type { AllocationResult, PassLine, PassSummary } from '@/lib/passes/types';
import type { BillBreakdown } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

/**
 * The lines the allocator sees. `keys` runs parallel to `lines` and is how an
 * allocation names a line: the order-item id on the create path (the redemption
 * row points at it), an index on the quote path (nothing is written).
 *
 * A line's unit price is what ONE unit cost with add-ons included
 * (price_inr_snapshot), so a pass cup covers up to its drink value of the whole
 * drink as the customer will be charged for it, not of the bare size.
 *
 * A weighed line (a bag of beans, weight_grams) is never a drink, so a cup
 * never pays for it, whatever the item's pass setting says. Nor is a line on a
 * multi-buy offer: the offer is that line's discount.
 */
export function passLinesFor(lines: ResolvedLine[], keys: string[], eligibleIds: Set<string>): PassLine[] {
  return lines.map((line, i) => ({
    key: keys[i],
    menu_item_id: line.menu_item_id,
    unit_price_inr: line.price_inr_snapshot,
    quantity: line.quantity,
    // Nor does it pay for a line on a multi-buy offer (lib/orders/offers.ts):
    // the offer already prices those units, and a cup on top would discount
    // the same unit twice.
    eligible: eligibleIds.has(line.menu_item_id) && line.weight_grams == null && !line.offer_prices,
    gst_exempt: line.gst_exempt,
  }));
}

/** What allocateOrderPass found and chose. */
export interface OrderPassPricing {
  /** The allocation for the cups asked for (`requested` may be 0: then it only reports what could be used). */
  allocation: AllocationResult;
  /** The most cups this cart could use right now, whatever was asked (the checkout pre-fills it, CP-D10). */
  maxUsable: number;
  /** The customer's usable passes, soonest-expiring first: what the screen lists. */
  passes: PassSummary[];
}

/**
 * Loads `userId`'s usable passes and the eligible drinks in the cart, and
 * allocates `requested` cups (CP-D9: dearest eligible unit first, from the
 * soonest-expiring pass first). Never throws: the loaders in lib/passes/server.ts
 * degrade to "no pass" / "nothing eligible" on any failure, so a pass problem
 * shows up as a shortfall, never as a failed order.
 *
 * The eligible-drinks query is skipped when the customer has no usable pass at
 * all, since nothing could be allocated: that keeps the common case (a signed-in
 * customer with no Ritual) at one small query per quote.
 */
export async function allocateOrderPass(
  admin: SupabaseClient,
  input: { userId: string; lines: ResolvedLine[]; keys: string[]; requested: number; now?: Date },
): Promise<OrderPassPricing> {
  const now = input.now ?? new Date();
  const passes = await loadUsablePassSummaries(admin, input.userId, now);
  const menuIds = [...new Set(input.lines.map((l) => l.menu_item_id))];
  const eligible = passes.length > 0 ? await loadEligibleMenuIds(admin, menuIds) : new Set<string>();
  const lines = passLinesFor(input.lines, input.keys, eligible);
  const usable = passes.map(toUsablePass);

  const allocation = allocatePassDrinks({ lines, passes: usable, requested: input.requested, now });
  // The most this cart could use: the same allocator, asked for more than any
  // order may carry. Cheap (pure) and it reflects the daily cap exactly.
  const maxUsable =
    input.requested >= allocation.eligible_units
      ? allocation.applied
      : allocatePassDrinks({ lines, passes: usable, requested: Number.MAX_SAFE_INTEGER, now }).applied;
  return { allocation, maxUsable, passes };
}

/**
 * What coupons and points are computed on once the pass has been applied
 * (CP-D12): the subtotal less what the pass covers, never below zero.
 */
export function afterPass(subtotalInr: number, passCoveredInr: number): number {
  return Math.max(0, subtotalInr - passCoveredInr);
}

/**
 * What a coupon and Beanies are computed on once the pass AND the multi-buy
 * offers (lib/orders/offers.ts) are off: the offer is part of the price the
 * customer is quoted, so a coupon's minimum and its percentage apply to what
 * is left after it.
 */
export function afterOffers(payableAfterPassInr: number, offerDiscountInr: number): number {
  return Math.max(0, payableAfterPassInr - Math.max(0, offerDiscountInr));
}

export interface OrderBillInput {
  settings: StoreSettings;
  subtotalInr: number;
  /** The part of the subtotal GST applies to (every line but GST-exempt ones). */
  taxableSubtotalInr: number;
  /** Multi-buy offers on the lines (computeOffers, lib/orders/offers.ts); 0 = none. */
  offerDiscountInr?: number;
  /** Computed on afterOffers(afterPass(subtotal, passCovered), offer). */
  couponDiscountInr: number;
  /** Computed on what is left after the pass AND the coupon. */
  pointsDiscountInr: number;
  passCoveredInr: number;
  /** The part of passCoveredInr that sat on GST-liable lines. */
  passCoveredTaxableInr: number;
  /** Dine-in never carries a packaging charge (D5). */
  isDineIn: boolean;
}

/**
 * The authoritative bill for an order (create and quote both call it): the pass
 * first, then the multi-buy offers, then coupon and points on what is left
 * (CP-D12), GST on the taxable value with the covered rupees and the discount
 * taken out of it and packaging in it (CP-D11, computeBill), and no packaging
 * for dine-in (D5).
 *
 *   offer_discount_inr = min(offers, subtotal - pass cover)
 *   discount_inr       = offer + min(coupon + points, what is left after it)
 *   pass_discount_inr  = the pass cover
 *   total_inr          = subtotal + tax + packaging - discount_inr - pass_discount_inr
 *
 * With no pass and no offer this is computeBill(subtotal, settings,
 * min(coupon + points, subtotal), taxable), with packaging 0 for dine-in.
 */
export function composeOrderBill(
  input: OrderBillInput,
): BillBreakdown & { pass_discount_inr: number; offer_discount_inr: number } {
  const passCovered = Math.min(Math.max(0, input.passCoveredInr), Math.max(0, input.subtotalInr));
  const payable = afterPass(input.subtotalInr, passCovered);
  const offerInr = Math.min(Math.max(0, input.offerDiscountInr ?? 0), payable);
  const discountInr =
    offerInr +
    Math.min(Math.max(0, input.couponDiscountInr) + Math.max(0, input.pointsDiscountInr), payable - offerInr);
  // Dine-in has no packaging charge (D5), whatever the store's packaging
  // setting: billed with none, so no GST is charged on it either.
  const bill = composePassBill(
    {
      subtotalInr: input.subtotalInr,
      taxableSubtotalInr: input.taxableSubtotalInr,
      discountInr,
      passCoveredInr: passCovered,
      passCoveredTaxableInr: input.passCoveredTaxableInr,
    },
    input.isDineIn ? { ...input.settings, packaging_charge_inr: 0 } : input.settings,
  );
  return { ...bill, offer_discount_inr: offerInr };
}
