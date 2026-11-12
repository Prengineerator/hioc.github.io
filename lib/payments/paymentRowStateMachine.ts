// The Razorpay `payments` row state machine (FND-1) — one row per gateway order
// minted for a café order (phase2-migration.sql §3). The row reuses the
// payment_status enum, but only these moves are legal, each made by one
// writer with a compare-and-set on the status it read:
//
//   (create)        → payment_pending  createPaymentIntent: a Razorpay order the
//                                      customer can pay (lib/payments/gateway.ts)
//   payment_pending → paid             capture (verify / webhook / poll / cron),
//                                      lib/payments/reconcile.ts
//   payment_pending → unpaid           ABANDONED: the café order stopped waiting
//                                      for it — switch to pay at the counter,
//                                      auto-expiry, a cancelled 'placed' order.
//                                      Retry never hands an abandoned row out
//                                      again (it looks for payment_pending only).
//   unpaid          → paid             a capture that lands on an abandoned row:
//                                      the money DID move at Razorpay, so it is
//                                      recorded — as an orphan when the café
//                                      order is no longer waiting for it
//                                      (see ORPHAN_CAPTURE_NOTE)
//   paid / partially_refunded → partially_refunded | refunded
//                                      the refund route, from a fresh sum of the
//                                      processed refunds against the row
//
// 'refunded' is terminal. Pure (no DB, no server-only) so the order-level
// payment machine (lib/orders/paymentStateMachine.ts) and its tests can use it.

import type { PaymentStatus } from '@/lib/types';

export type PaymentRowStatus = Extract<PaymentStatus, 'payment_pending' | 'unpaid' | 'paid' | 'partially_refunded' | 'refunded'>;

export type PaymentRowVia = 'create' | 'capture' | 'abandon' | 'refund';

export interface PaymentRowRule {
  from: PaymentRowStatus | null;
  to: PaymentRowStatus;
  via: PaymentRowVia;
}

export const PAYMENT_ROW_TRANSITIONS: readonly PaymentRowRule[] = [
  { from: null, to: 'payment_pending', via: 'create' },
  { from: 'payment_pending', to: 'paid', via: 'capture' },
  { from: 'unpaid', to: 'paid', via: 'capture' },
  { from: 'payment_pending', to: 'unpaid', via: 'abandon' },
  { from: 'paid', to: 'partially_refunded', via: 'refund' },
  { from: 'paid', to: 'refunded', via: 'refund' },
  { from: 'partially_refunded', to: 'partially_refunded', via: 'refund' },
  { from: 'partially_refunded', to: 'refunded', via: 'refund' },
];

export const TERMINAL_PAYMENT_ROW_STATUSES: readonly PaymentRowStatus[] = ['refunded'];

export function canTransitionPaymentRow(
  from: PaymentRowStatus | string | null,
  to: PaymentRowStatus,
  via: PaymentRowVia,
): boolean {
  return PAYMENT_ROW_TRANSITIONS.some((r) => r.from === from && r.to === to && r.via === via);
}

/** The row states a capture may still claim (anything else was already recorded). */
export const CAPTURABLE_ROW_STATUSES: readonly PaymentRowStatus[] = PAYMENT_ROW_TRANSITIONS.filter(
  (r) => r.via === 'capture',
).map((r) => r.from as PaymentRowStatus);

/** The row states the refund route may refund against: money taken, not all of it back. */
export const REFUNDABLE_ROW_STATUSES: readonly PaymentRowStatus[] = ['paid', 'partially_refunded'];

/** Gateway money that was taken (whatever has since gone back). */
export const GATEWAY_TAKEN_ROW_STATUSES: readonly PaymentRowStatus[] = ['paid', 'partially_refunded', 'refunded'];

/**
 * Written to payments.error when a capture lands on a café order that is no
 * longer waiting for it — cancelled/rejected, already paid another way (cash
 * after switching to the counter, a second gateway order) or refunded. The
 * money moved at Razorpay, so the row says 'paid'; the café order is NOT
 * touched (that would issue a pass on a cancelled sale, or overwrite the
 * counter's cash with 'upi' and lose it from the drawer). The marker is what
 * keeps such a row from counting as "the gateway owns this order's payment",
 * and it is how the refund route finds money it must give back.
 *
 * A prefix, so the reason can follow it.
 */
export const ORPHAN_CAPTURE_NOTE = 'ORPHAN CAPTURE — refund this payment:';

export function isOrphanCapture(row: { error?: string | null }): boolean {
  return (row.error ?? '').startsWith(ORPHAN_CAPTURE_NOTE);
}

/** The row's status after a refund, from what it captured and what has gone back in total. */
export function paymentRowAfterRefund(capturedInr: number, refundedInr: number): PaymentRowStatus {
  if (refundedInr >= capturedInr) return 'refunded';
  return refundedInr > 0 ? 'partially_refunded' : 'paid';
}

/** What a café order's payment rows say about the gateway's part in it. */
export interface GatewayEvidence {
  /** A non-orphan capture took this order's money: the gateway owns the payment. */
  gatewayPaid: boolean;
  /** A Razorpay order for it is still open: the customer can still pay it. */
  gatewayLive: boolean;
  /** A capture landed after the order stopped waiting for it: money to give back. */
  orphanCapture: boolean;
}

export const NO_GATEWAY_EVIDENCE: GatewayEvidence = { gatewayPaid: false, gatewayLive: false, orphanCapture: false };

export function gatewayEvidenceFromRows(
  rows: readonly { status: string; error?: string | null }[] | null | undefined,
): GatewayEvidence {
  const list = rows ?? [];
  const taken = list.filter((r) => (GATEWAY_TAKEN_ROW_STATUSES as readonly string[]).includes(r.status));
  return {
    gatewayPaid: taken.some((r) => !isOrphanCapture(r)),
    gatewayLive: list.some((r) => r.status === 'payment_pending'),
    orphanCapture: taken.some((r) => isOrphanCapture(r)),
  };
}
