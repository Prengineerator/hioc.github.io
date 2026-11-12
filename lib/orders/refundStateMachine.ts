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
// transition at the time: the row stays 'pending', because the money may have
// moved. A pending refund counts against what is left to refund, and no other
// gateway refund starts on that payment while it is unresolved — the double
// refund this prevents is the expensive failure.
//
// It is resolved later from the gateway's OWN record (resolvePendingRefunds):
// Razorpay's Payment entity says how much has been refunded on it in total
// (amount_refunded, paise). Measured against what we know went back
// (processed) plus what is pending, that either proves the pending refunds
// went through, proves none did, or proves nothing — and then they stay
// pending. It is never guessed. The refund route asks whenever it meets a
// pending row (a new refund on the payment, or the same key retried), once
// the row is old enough that the request that claimed it is surely over.

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
  'A refund on this order is still waiting for the payment gateway’s answer. Try again in about 10 minutes — it is checked with Razorpay first and never made twice. Don’t refund it from the Razorpay dashboard meanwhile.';
export const REFUND_UNCONFIRMED_MESSAGE =
  'The payment gateway did not confirm the refund, so it is recorded as pending. Try again in about 10 minutes — it is checked with Razorpay first and never made twice. Don’t refund it from the Razorpay dashboard meanwhile.';

// --- Resolving a pending refund ----------------------------------------------

/**
 * How long a pending row is left alone before it is resolved from the
 * gateway's record: longer than the refund request that claimed it can run
 * (the platform stops a function well before this), so a row this old is
 * never one whose gateway call is still on its way back. Resolving a younger
 * one could mark it failed a moment before Razorpay processes it.
 */
export const RESOLVE_PENDING_AFTER_MS = 10 * 60_000;

export function isOldEnoughToResolve(createdAt: string | null | undefined, nowMs: number): boolean {
  const t = Date.parse(String(createdAt ?? ''));
  return Number.isFinite(t) && nowMs - t >= RESOLVE_PENDING_AFTER_MS;
}

/**
 * What the pending refunds on one gateway payment came to, from:
 *   processedInr       rupees our processed refunds on it total (P)
 *   pendingInr         the pending refunds' amounts
 *   amountRefundedPaise  Razorpay's amount_refunded on the payment (R), or
 *                      null/undefined when the field is missing or the
 *                      gateway could not be asked
 *
 *   'processed'  R ≥ P + all pending: the gateway refunded at least that much,
 *                so every pending refund went through
 *   'failed'     R = P: nothing beyond the processed ones was refunded, so
 *                none of the pending ones did
 *   'unknown'    anything else — no answer, no field, or a figure between the
 *                two (some but not all, or refunds made elsewhere): stay pending
 *
 * All pending rows move together: a figure that covers only some of them
 * can't say which, so it says nothing.
 */
export type PendingResolution = 'processed' | 'failed' | 'unknown';

export function resolvePendingRefunds(input: {
  processedInr: number;
  pendingInr: readonly number[];
  amountRefundedPaise: number | null | undefined;
}): PendingResolution {
  const r = input.amountRefundedPaise;
  if (input.pendingInr.length === 0) return 'unknown';
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0) return 'unknown';
  const processedPaise = Math.round(input.processedInr) * 100;
  const pendingPaise = input.pendingInr.reduce((sum, a) => sum + Math.round(a) * 100, 0);
  if (r >= processedPaise + pendingPaise) return 'processed';
  if (r === processedPaise) return 'failed';
  return 'unknown';
}
