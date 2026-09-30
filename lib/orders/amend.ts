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

import type { BillBreakdown } from '@/lib/store/hours';
import { composePassBill } from '@/lib/passes/rules';
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
}

export interface RecomputeInput {
  items: RecomputeLine[];
  settings: StoreSettings;
  orderType: OrderType;
  discountInr: number;
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
 * - GST on the non-voided lines that aren't GST-exempt (their snapshot)
 * - discount = min(stored discount, new subtotal - pass cover)  ← v1 clamp (D8)
 * - GST/packaging via composePassBill (= computeBill with no pass); dine-in
 *   forces packaging 0 (decision D5)
 *
 * With no pass cover anywhere this is byte-for-byte the recompute it always was.
 */
export function recomputeOrderTotals({
  items,
  settings,
  orderType,
  discountInr,
}: RecomputeInput): BillBreakdown & { pass_discount_inr: number } {
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
  const discount = Math.min(Math.max(0, discountInr), Math.max(0, subtotalInr - passCoveredInr));

  const bill = composePassBill(
    { subtotalInr, taxableSubtotalInr, discountInr: discount, passCoveredInr, passCoveredTaxableInr },
    settings,
  );

  // Dine-in never carries a packaging charge (D5): drop it from the total and
  // zero the line, regardless of the store's packaging setting. Mirrors the
  // create path in app/api/orders/route.ts.
  if (orderType === 'dine_in' && bill.packaging_inr !== 0) {
    bill.total_inr -= bill.packaging_inr;
    bill.packaging_inr = 0;
  }

  return bill;
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
