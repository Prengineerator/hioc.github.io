// FND3-4 — shared server-side order-total recompute for corrections (voids).
//
// This is the single source of truth for "what does the bill become once a line
// is voided?". The amend route (app/api/orders/[id]/amend/route.ts) calls it, and
// it is unit-tested directly. It is deliberately dependency-light — it imports
// only computeBill + types, no DB / Supabase — so the money math is exercised
// with plain fixtures and no mocks (PHASE-3-SPRINT-PLAN §5.2: money-math ships
// with tests).
//
// Guardrails honored here (§5.2):
//  * Money is server-authoritative — the client renders whatever this returns.
//  * Snapshots are never mutated: a voided line is EXCLUDED from the subtotal,
//    never removed. Voiding is the caller's job; this only reads `voided`.
//
// v1 DISCOUNT SCOPE (decision D8 — coupons/points at the counter are deferred):
// a void does NOT re-qualify a coupon or re-run points math. We CLAMP the order's
// already-stored discount to the new (smaller) subtotal so the total can never go
// negative. Full coupon/points RE-QUALIFICATION on void (the spec's edge case:
// "if the coupon no longer qualifies, drop it") is a deferred follow-up.
//
// HIOC Ritual (docs/COFFEE-PASS-SPEC.md §6): a line a pass cup paid for carries
// the rupees it covered (`pass_covered_inr`), so the pass cover of the order is
// re-derived here from the lines that REMAIN, and the coupon/points discount is
// clamped to what is left after it (subtotal - pass cover), exactly as at
// creation. The database gives the cups themselves back when a redeemed line is
// voided (trg_coffee_pass_return_on_void), so this only has to get the bill
// right.
//
// Multi-buy offers (lib/orders/offers.ts) are different: they are PRICE, not a
// marketing discount, so they are worked out again from the lines that remain
// (each line carries the offer it was sold under). Voiding one jar of a "2 for
// ₹499" leaves one jar at the 1-jar price; adding one to a running tab makes it
// a pair. Only the coupon/points part of the stored discount is clamped (v1).

import type { BillBreakdown } from '@/lib/store/hours';
import { composePassBill } from '@/lib/passes/rules';
import { billOffers, type SpendOffer } from '@/lib/orders/offers';
import type { OrderStatus, OrderType, StoreSettings } from '@/lib/types';

// Only the fields the recompute needs from an order line — keeps this callable
// with plain fixtures (no full OrderItem required) and makes the money math the
// only thing under test.
export interface RecomputeLine {
  voided: boolean;
  line_total_inr: number;
  /** The line's GST-exempt snapshot (2026-09-gst-exempt); absent = taxable. */
  gst_exempt?: boolean;
  /** Rupees of this line a HIOC Ritual cup paid for (2026-10-coffee-pass.sql); absent = 0. */
  pass_covered_inr?: number;
  /** The multi-buy offer snapshot (2026-10-item-offers.sql); absent = the line has none.
   * menu_item_id, name_snapshot and quantity are read only on a line that has one. */
  offer_name?: string | null;
  offer_prices?: number[] | null;
  offer_unit_inr?: number | null;
  menu_item_id?: string;
  name_snapshot?: string;
  quantity?: number;
  /** One unit's price, add-ons included: a spend offer's minimum doesn't count the unit it prices. */
  price_inr_snapshot?: number;
}

export interface RecomputeInput {
  items: RecomputeLine[];
  settings: StoreSettings;
  orderType: OrderType;
  /** The order's stored discount_inr: coupon + points + offer. */
  discountInr: number;
  /** The part of discountInr that was the offer (orders.offer_discount_inr); absent = 0. */
  offerDiscountInr?: number;
  /** The spend offers kept on the order (orders.spend_offers), re-checked against what remains. */
  spendOffers?: readonly SpendOffer[];
  /** Spend offers this customer can't have here (once per customer), as billOffers takes them. */
  spendBlocked?: ReadonlyMap<string, string>;
}

/**
 * Recomputes an order's authoritative totals from its REMAINING (non-voided)
 * lines after a correction, returning the persisted bill shape
 * ({ subtotal_inr, tax_inr, packaging_inr, discount_inr, total_inr }) plus
 * `pass_discount_inr` (what HIOC Ritual cups still cover).
 *
 * - subtotal = Σ `line_total_inr` over non-voided items
 * - pass cover = Σ `pass_covered_inr` over non-voided items; the part of it on
 *   GST-liable lines leaves the taxable base (CP-D11)
 * - GST on the non-voided lines that aren't GST-exempt (their snapshot), less
 *   their share of the discount, plus packaging (computeBill)
 * - offer = the multi-buy offers on the remaining lines, worked out again
 * - discount = offer + min(stored coupon/points, new subtotal - pass cover - offer)  ← v1 clamp (D8)
 * - GST/packaging via composePassBill (= computeBill with no pass); dine-in
 *   forces packaging 0 (decision D5)
 *
 * The recompute always uses the current GST rules (computeBill), so amending an
 * order placed before GST_NET_OF_DISCOUNT_FROM (lib/store/hours.ts) re-taxes it
 * net of its discount, with packaging taxed.
 */
export function recomputeOrderTotals({
  items,
  settings,
  orderType,
  discountInr,
  offerDiscountInr = 0,
  spendOffers = [],
  spendBlocked,
}: RecomputeInput): BillBreakdown & {
  pass_discount_inr: number;
  offer_discount_inr: number;
  offer_label: string;
  offer_kind: 'spend' | 'multi_buy' | 'none';
  /** The spend offer on the bill, when there is one: what its once-per-customer record names. */
  spend_offer_id: string | null;
} {
  const remaining = items.filter((item) => !item.voided);
  const subtotalInr = remaining.reduce((sum, item) => sum + item.line_total_inr, 0);
  // GST only on the lines that weren't GST-exempt when sold — the snapshot,
  // never the menu's current setting, so a later change can't rewrite a bill.
  const taxableSubtotalInr = remaining
    .filter((item) => item.gst_exempt !== true)
    .reduce((sum, item) => sum + item.line_total_inr, 0);

  // What the cups still cover: a voided line's cover goes with it (the database
  // has already returned its cups), a kept line's stays. Never more than the
  // line itself was worth, so a bad row can't push the bill below zero.
  const covered = (item: RecomputeLine) => Math.min(Math.max(0, item.pass_covered_inr ?? 0), item.line_total_inr);
  const passCoveredInr = remaining.reduce((sum, item) => sum + covered(item), 0);
  const passCoveredTaxableInr = remaining
    .filter((item) => item.gst_exempt !== true)
    .reduce((sum, item) => sum + covered(item), 0);

  // Clamp the stored discount to what is left after the pass so the total never
  // goes negative when lines are removed (v1: no coupon/points re-qualification,
  // D8). The coupon and Beanies were computed on subtotal - pass cover at
  // creation (CP-D12), so this is the same ceiling they were under then.
  //
  // The offer comes first (as at creation), re-derived from the remaining lines;
  // the coupon/points part (what the stored discount held besides the offer) is
  // clamped to what is left after it.
  //
  // A spend offer is re-checked too (lib/orders/offers.ts billOffers): a void
  // that takes everything else below its minimum puts that unit back at its
  // regular price. A coupon or Beanies on the order keeps it off, as at creation.
  const payable = Math.max(0, subtotalInr - passCoveredInr);
  const otherDiscount = Math.max(0, Math.max(0, discountInr) - Math.max(0, offerDiscountInr));
  const offers = billOffers({
    lines: remaining.map((item) => ({
      menu_item_id: item.menu_item_id ?? '',
      name_snapshot: item.name_snapshot ?? '',
      quantity: item.quantity ?? 0,
      offer_name: item.offer_name,
      offer_prices: item.offer_prices,
      offer_unit_inr: item.offer_unit_inr,
      line_total_inr: item.line_total_inr,
      price_inr_snapshot: item.price_inr_snapshot,
    })),
    spendOffers,
    passCoveredInr,
    otherDiscountApplied: otherDiscount > 0,
    spendBlocked,
  });
  const offer = Math.min(offers.discountInr, payable);
  const discount = offer + Math.min(otherDiscount, payable - offer);

  // Dine-in never carries a packaging charge (D5), whatever the store's
  // packaging setting: billed with none, so no GST is charged on it either.
  // Mirrors the create path (composeOrderBill in lib/orders/passPricing.ts).
  const bill = composePassBill(
    { subtotalInr, taxableSubtotalInr, discountInr: discount, passCoveredInr, passCoveredTaxableInr },
    orderType === 'dine_in' ? { ...settings, packaging_charge_inr: 0 } : settings,
  );
  return {
    ...bill,
    offer_discount_inr: offer,
    offer_label: offers.label,
    offer_kind: offers.kind,
    spend_offer_id: offers.kind === 'spend' ? (offers.offers[0]?.offer_id ?? null) : null,
  };
}

/**
 * Where an order goes when items are added to it (TAB-1): the new items have
 * to be made, so an order the kitchen had marked Ready is back to Preparing —
 * it can't be handed over or completed without them. Accepted/Preparing
 * orders are already with the kitchen and stay as they are.
 */
export function statusAfterAdd(status: OrderStatus): OrderStatus {
  return status === 'ready' ? 'preparing' : status;
}
