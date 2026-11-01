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
  /** Offers on the lines (billOffers, lib/orders/offers.ts); 0 = none. */
  offerDiscountInr?: number;
  /**
   * The share of the offer on GST-liable lines (offerTaxableShare). Given, the
   * offer comes out of its own item's value for GST (a GST-free jar's offer
   * leaves the café items' GST alone); omitted, it is spread over the bill
   * like a coupon (the rule before offers had their own GST treatment).
   */
  offerTaxableShare?: number;
  /** Computed on afterOffers(afterPass(subtotal, passCovered), offer). */
  couponDiscountInr: number;
  /** Computed on what is left after the pass AND the coupon. */
  pointsDiscountInr: number;
  /**
   * A manager discount (lib/orders/manualDiscount.ts): rupees off what is left
   * after everything above, capped there. 0 / absent = none.
   */
  manualDiscountInr?: number;
  passCoveredInr: number;
  /** The part of passCoveredInr that sat on GST-liable lines. */
  passCoveredTaxableInr: number;
  /** Dine-in never carries a packaging charge (D5). */
  isDineIn: boolean;
}

/**
 * The authoritative bill for an order (create and quote both call it): the pass
 * first, then the multi-buy offers, then coupon and points on what is left
 * (CP-D12), then a manager discount on what is left after all of that, GST
 * on the taxable value with the covered rupees and the discount taken out of it
 * and packaging in it (CP-D11, computeBill), and no packaging for dine-in (D5).
 *
 *   offer_discount_inr  = min(offers, subtotal - pass cover)
 *   manual_discount_inr = min(manager discount, what the offer, coupon and points leave)
 *   discount_inr        = offer + min(coupon + points, what is left after it) + manual
 *   pass_discount_inr   = the pass cover
 *   total_inr           = subtotal + tax + packaging - discount_inr - pass_discount_inr
 *
 * With no pass and no offer this is computeBill(subtotal, settings,
 * min(coupon + points, subtotal), taxable), with packaging 0 for dine-in.
 */
export function composeOrderBill(
  input: OrderBillInput,
): BillBreakdown & { pass_discount_inr: number; offer_discount_inr: number; manual_discount_inr: number } {
  const passCovered = Math.min(Math.max(0, input.passCoveredInr), Math.max(0, input.subtotalInr));
  const payable = afterPass(input.subtotalInr, passCovered);
  const offerInr = Math.min(Math.max(0, input.offerDiscountInr ?? 0), payable);
  const couponPointsInr = Math.min(
    Math.max(0, input.couponDiscountInr) + Math.max(0, input.pointsDiscountInr),
    payable - offerInr,
  );
  const manualInr = Math.min(Math.max(0, input.manualDiscountInr ?? 0), payable - offerInr - couponPointsInr);
  // The manager discount is a discount on the whole bill, like a coupon: it is
  // spread over what is left for GST, alongside the coupon/Beanies.
  const bill = billWithOffer(
    {
      subtotalInr: input.subtotalInr,
      taxableSubtotalInr: input.taxableSubtotalInr,
      passCoveredInr: passCovered,
      passCoveredTaxableInr: input.passCoveredTaxableInr,
      offerInr,
      offerTaxableShare: input.offerTaxableShare,
      otherDiscountInr: couponPointsInr + manualInr,
    },
    // Dine-in has no packaging charge (D5), whatever the store's packaging
    // setting: billed with none, so no GST is charged on it either.
    input.isDineIn ? { ...input.settings, packaging_charge_inr: 0 } : input.settings,
  );
  return { ...bill, manual_discount_inr: manualInr };
}

/**
 * The bill once the pass cover, the offer and the coupon/Beanies discount are
 * known (all already clamped): the ONE place their GST treatment lives, for
 * composeOrderBill (create, quote, the POS) and recomputeOrderTotals (every
 * correction).
 *
 *   - Ritual cover leaves the subtotal and, for what it covers on GST-liable
 *     lines, the taxable value (CP-D11).
 *   - The offer does the same: it is a discount on its own item, so its
 *     GST-liable share (offerTaxableShare) comes out of the taxable value and
 *     the rest out of the exempt value. Without a share it is spread like a
 *     coupon (the earlier rule).
 *   - The coupon/Beanies discount (and a manager discount) is spread over what
 *     is left (computeBill).
 *
 *   discount_inr      = offer + coupon/Beanies + manager discount
 *                       (offer_discount_inr says how much is the offer)
 *   pass_discount_inr = the pass cover
 *   total_inr         = subtotal + tax + packaging − discount_inr − pass_discount_inr
 */
export function billWithOffer(
  input: {
    subtotalInr: number;
    taxableSubtotalInr: number;
    passCoveredInr: number;
    passCoveredTaxableInr: number;
    offerInr: number;
    offerTaxableShare?: number;
    otherDiscountInr: number;
  },
  settings: StoreSettings,
): BillBreakdown & { pass_discount_inr: number; offer_discount_inr: number } {
  const pass = Math.min(Math.max(0, input.passCoveredInr), Math.max(0, input.subtotalInr));
  const offer = Math.max(0, input.offerInr);
  const other = Math.max(0, input.otherDiscountInr);
  if (input.offerTaxableShare === undefined || offer === 0) {
    const bill = composePassBill(
      {
        subtotalInr: input.subtotalInr,
        taxableSubtotalInr: input.taxableSubtotalInr,
        discountInr: offer + other,
        passCoveredInr: pass,
        passCoveredTaxableInr: input.passCoveredTaxableInr,
      },
      settings,
    );
    return { ...bill, offer_discount_inr: offer };
  }
  const passTaxable = Math.min(Math.max(0, input.passCoveredTaxableInr), pass);
  const taxableLeft = Math.max(0, Math.min(input.taxableSubtotalInr, input.subtotalInr) - passTaxable);
  // Not rounded: GST is, once, at the end (computeBill).
  const offerTaxable = Math.min(offer * Math.min(1, Math.max(0, input.offerTaxableShare)), taxableLeft);
  const bill = composePassBill(
    {
      subtotalInr: input.subtotalInr,
      taxableSubtotalInr: input.taxableSubtotalInr,
      discountInr: other,
      // The offer leaves the subtotal and the taxable value the way cover does…
      passCoveredInr: pass + offer,
      passCoveredTaxableInr: passTaxable + offerTaxable,
    },
    settings,
  );
  // …and is reported as the discount it is.
  return { ...bill, discount_inr: offer + other, pass_discount_inr: pass, offer_discount_inr: offer };
}
