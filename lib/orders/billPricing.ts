// The order bill — the pure half, with no server imports, so the server (POST
// /api/orders charges it, POST /api/orders/quote previews it) and the POS
// (lib/pos/localQuote.ts, pricing a cart on its own screen) run the SAME
// function. Money math gets one copy, not two (lib/orders/lines.ts).
//
// Moved out of lib/orders/passPricing.ts, which re-exports it: that file also
// loads passes from the database and so can only run on the server.

import { composePassBill } from '@/lib/passes/rules';
import type { BillBreakdown } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

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
