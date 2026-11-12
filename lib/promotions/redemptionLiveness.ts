// When a redemption still counts against a limit — a coupon's usage and
// per-customer limits (lib/promotions/coupons.ts) and a spend offer's once
// per customer (lib/orders/offersServer.ts). Pure, and the ONE copy in
// TypeScript of the rule; the database repeats it in try_redeem_coupon
// (supabase/phase2-hardening.sql), which re-checks the limits under a lock.
//
// A redemption's state is never stored: it is its order's. It is LIVE while
// the order is anything but cancelled or rejected — an order abandoned or
// turned away must not burn a limited coupon (H7) or a customer's one-time
// offer. Every other order counts, refunded ones included: whether a refund
// should give the redemption back is the owner's call, not made here.
//
//   live ──order cancelled / rejected──▶ released
//   live ──row deleted (a correction took the offer off; the order deleted)──▶ gone

import type { OrderStatus } from '@/lib/types';

/** Orders whose redemptions no longer count. */
export const RELEASING_ORDER_STATUSES = ['cancelled', 'rejected'] as const satisfies readonly OrderStatus[];

/**
 * True when a redemption on an order in `orderStatus` still counts. An order
 * that can't be read (null) counts: a limit is never lifted on a guess.
 */
export function isLiveRedemption(orderStatus: string | null | undefined): boolean {
  return !(RELEASING_ORDER_STATUSES as readonly string[]).includes(orderStatus ?? '');
}

/**
 * The same rule as a PostgREST list, for a count the database does:
 *   .not('orders.status', 'in', RELEASING_ORDER_STATUSES_FILTER)
 */
export const RELEASING_ORDER_STATUSES_FILTER = `(${RELEASING_ORDER_STATUSES.map((s) => `"${s}"`).join(',')})`;
