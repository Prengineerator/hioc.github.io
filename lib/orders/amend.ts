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

import { computeBill, type BillBreakdown } from '@/lib/store/hours';
import type { OrderType, StoreSettings } from '@/lib/types';

// Only the fields the recompute needs from an order line — keeps this callable
// with plain fixtures (no full OrderItem required) and makes the money math the
// only thing under test.
export interface RecomputeLine {
  voided: boolean;
  line_total_inr: number;
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
 * ({ subtotal_inr, tax_inr, packaging_inr, discount_inr, total_inr }).
 *
 * - subtotal = Σ `line_total_inr` over non-voided items
 * - discount = min(stored discount, new subtotal)  ← v1 clamp (D8)
 * - GST/packaging via computeBill; dine-in forces packaging 0 (decision D5)
 */
export function recomputeOrderTotals({
  items,
  settings,
  orderType,
  discountInr,
}: RecomputeInput): BillBreakdown {
  const subtotalInr = items
    .filter((item) => !item.voided)
    .reduce((sum, item) => sum + item.line_total_inr, 0);

  // Clamp the stored discount to the new subtotal so the total never goes
  // negative when lines are removed (v1: no coupon/points re-qualification, D8).
  const discount = Math.min(Math.max(0, discountInr), subtotalInr);

  const bill = computeBill(subtotalInr, settings, discount);

  // Dine-in never carries a packaging charge (D5): drop it from the total and
  // zero the line, regardless of the store's packaging setting. Mirrors the
  // create path in app/api/orders/route.ts.
  if (orderType === 'dine_in' && bill.packaging_inr !== 0) {
    bill.total_inr -= bill.packaging_inr;
    bill.packaging_inr = 0;
  }

  return bill;
}
