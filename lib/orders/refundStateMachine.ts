// refunds.status state machine (FND-2 / REF-1 / REF-2) — 'pending' →
// 'processed' | 'failed' (phase2-migration.sql §3 CHECK). Pure: the refund and
// balance routes ask it, and its tests pin the lifecycle.
//
//   (create) → pending    a GATEWAY refund claims its row (and its
//                         Idempotency-Key) BEFORE Razorpay is asked to move
//                         money, so two taps with one key can't both reach the
//                         gateway: the second meets the unique index.
//   (create) → processed  a COUNTER refund / give-back: the money step is the
//                         staffer handing cash back or reversing on the
//                         terminal, so recording it is the whole event.
//   pending  → processed  the gateway accepted the refund.
//   pending  → failed     the gateway definitely refused it (no money moved).
//                         The key is released with it, so a retry is a fresh try.
//
// An UNKNOWN gateway answer (a timeout, a 5xx, a dropped connection) is no
// transition: the row stays 'pending', because the money may have moved. A
// pending refund counts against what is left to refund, and no other gateway
// refund starts on that payment until someone has checked the Razorpay
// dashboard — the double refund this prevents is the expensive failure.

import type { RefundStatus } from '@/lib/types';

export const REFUND_STATUSES = ['pending', 'processed', 'failed'] as const satisfies readonly RefundStatus[];

type MissingRefundStatus = Exclude<RefundStatus, (typeof REFUND_STATUSES)[number]>;
const _exhaustive: MissingRefundStatus extends never ? true : never = true;
void _exhaustive;

export const TERMINAL_REFUND_STATUSES: readonly RefundStatus[] = ['processed', 'failed'];

export type RefundVia = 'gateway' | 'counter';

export interface RefundRule {
  from: RefundStatus | null;
  to: RefundStatus;
  via: RefundVia;
  why: string;
}

export const REFUND_TRANSITIONS: readonly RefundRule[] = [
  { from: null, to: 'pending', via: 'gateway', why: 'Claim the refund (and its key) before the gateway moves money' },
  { from: 'pending', to: 'processed', via: 'gateway', why: 'The gateway accepted the refund' },
  { from: 'pending', to: 'failed', via: 'gateway', why: 'The gateway refused it: no money moved' },
  { from: null, to: 'processed', via: 'counter', why: 'Money handed back at the till: recording it is the event' },
];

export function canTransitionRefund(from: RefundStatus | string | null, to: RefundStatus, via: RefundVia): boolean {
  return REFUND_TRANSITIONS.some((r) => r.from === from && r.to === to && r.via === via);
}

/** Rows that may have moved money: they count against what is left to refund. */
export const MONEY_MAY_HAVE_MOVED: readonly RefundStatus[] = ['pending', 'processed'];

export function countsAgainstRefundable(status: RefundStatus | string): boolean {
  return (MONEY_MAY_HAVE_MOVED as readonly string[]).includes(status);
}

/** Whether these refund rows hold an unanswered gateway refund (no new one may start). */
export function hasPendingRefund(rows: readonly { status: string }[] | null | undefined): boolean {
  return (rows ?? []).some((r) => r.status === 'pending');
}

/** Rupees in these rows that may have left (pending + processed). */
export function refundedOrPendingInr(rows: readonly { status: string; amount_inr: number }[] | null | undefined): number {
  return (rows ?? []).filter((r) => countsAgainstRefundable(r.status)).reduce((sum, r) => sum + r.amount_inr, 0);
}

/** Rupees in these rows that definitely left (processed only). */
export function processedInr(rows: readonly { status: string; amount_inr: number }[] | null | undefined): number {
  return (rows ?? []).filter((r) => r.status === 'processed').reduce((sum, r) => sum + r.amount_inr, 0);
}

/** How the gateway answered a refund request (lib/payments/gateway.ts requestGatewayRefund). */
export type GatewayRefundOutcome =
  | { kind: 'processed'; refundId: string }
  | { kind: 'rejected'; httpStatus: number | null }
  | { kind: 'unknown' };

/** The row's next status for a gateway answer; null = stays pending (the money may have moved). */
export function refundStatusForOutcome(outcome: GatewayRefundOutcome): Extract<RefundStatus, 'processed' | 'failed'> | null {
  if (outcome.kind === 'processed') return 'processed';
  if (outcome.kind === 'rejected') return 'failed';
  return null;
}

export const REFUND_PENDING_MESSAGE =
  'A refund on this order is still waiting for the payment gateway’s answer. Check the Razorpay dashboard before refunding again.';
export const REFUND_UNCONFIRMED_MESSAGE =
  'The payment gateway did not confirm the refund. It is recorded as pending — check the Razorpay dashboard before trying again.';
