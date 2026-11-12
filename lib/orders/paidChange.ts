// Changing a dine-in order AFTER it is paid, with the difference settled later
// (owner request 2026-11, supabase/2026-11-paid-order-changes.sql).
//
// A table pays up front, then wants one more coffee, or to take the brownie
// off. The order takes Add items / Void / Edit exactly as an unpaid one does
// (app/api/orders/[id]/amend), its bill is recomputed as always, and the change
// in its total goes into `orders.balance_due_inr`:
//
//   > 0  the customer owes that much more — collected later as extra tenders
//   < 0  the café owes that much back     — given back later on a tender
//   = 0  nothing outstanding
//
// settled from the Settle screen (POST /api/orders/[id]/balance).
//
// The order stays payment_status 'paid' the whole time. The HIOC Ritual and
// paid_at triggers act on the move INTO 'paid', so sending a paid bill back to
// 'unpaid' and settling it again would redeem cups twice. Money keeps its own
// records instead: order_payments for what was taken (each at its own time),
// refunds for what went back — which is all the cash drawer and the reports
// read, so they stay exact.
//
// Pure (no DB, no server-only): the routes enforce these rules and the staff
// screens use the same ones to decide what to offer.

import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { gatewayOwnsPayment, isDeadOrder, REFUND_PAYMENT_STATUSES, type GatewayEvidence } from '@/lib/orders/paymentStateMachine';
import type { OrderStatus, PaymentMethod, PaymentStatus } from '@/lib/types';

/** The file that adds the columns this needs — named in the refusal before it is applied. */
export const PAID_CHANGE_MIGRATION = 'supabase/2026-11-paid-order-changes.sql';

/** What a paid bill that can't be changed is told (the pre-feature wording). */
export const PAID_BILL_LOCKED = 'This bill is already paid.';

/** What a bill money has gone back on is told: it is not an unpaid bill to change freely. */
export const REFUNDED_BILL_LOCKED = 'Money has been refunded on this order, so it can’t be changed — start a new order instead.';

/**
 * Why a bill with a refund on it can't be changed, or null. A part- or fully
 * refunded order used to be treated as unpaid here: its total moved with no
 * balance to settle, the payment route then refused it (it has a refund) and
 * completion waited forever. The balance machinery only knows a paid bill, so
 * a refunded one is changed by starting a new order.
 */
export function refundedChangeBlockReason(order: Pick<PaidChangeOrder, 'payment_status'>): string | null {
  return REFUND_PAYMENT_STATUSES.includes(order.payment_status as PaymentStatus) ? REFUNDED_BILL_LOCKED : null;
}

/** What the rules need from an order. Fields are optional where old rows lack them. */
export interface PaidChangeOrder {
  status?: OrderStatus | string;
  order_type?: string | null;
  payment_status: string;
  payment_method?: string | null;
  /** 'coffee_pass' for a HIOC Ritual sale; absent = a menu order. */
  order_kind?: string | null;
  /** Absent on a database without the migration (rows are read with `*`). */
  balance_due_inr?: number | null;
  paid_amended_at?: string | null;
}

/** The bill has been paid, so a change to it goes down the post-payment path. */
export function isPaidBill(order: Pick<PaidChangeOrder, 'payment_status'>): boolean {
  return order.payment_status === 'paid';
}

/**
 * Whether the database has this feature's columns. Orders are read with
 * select('*') everywhere a change is made, so a missing column is simply
 * absent from the row — never sent a value it can't store.
 */
export function hasBalanceColumns(order: object): boolean {
  return 'balance_due_inr' in order;
}

/**
 * Why this PAID order can't be changed, or null when it can. Only the order's
 * payment side: whether it is still open (accepted / preparing / ready) is the
 * caller's own check, as for an unpaid order.
 *
 *  - a HIOC Ritual sale is one line, one price, issued as a pass when paid —
 *    never changed, cancelled and sold again instead (as unpaid);
 *  - dine-in only: the table is still here to settle the difference;
 *  - not a bill paid online: the payment gateway owns that payment, so money
 *    can't be handed back at the counter against it;
 *  - not before the migration is applied (the balance has nowhere to live).
 */
//
// `evidence` is the order's gateway payments (lib/payments/evidence.ts): the
// routes always pass it, because a UPI or card capture stores 'upi' / 'card'
// as payment_method, the same as the counter. A screen without it falls back to
// payment_method 'online' (lib/orders/paymentStateMachine.ts gatewayOwnsPayment).
export function paidChangeBlockReason(
  order: PaidChangeOrder,
  evidence?: Pick<GatewayEvidence, 'gatewayPaid'> | null,
): string | null {
  if (order.order_kind === 'coffee_pass') return `A ${PASS_PROGRAM_NAME} sale can't be changed — cancel it instead.`;
  if (order.order_type !== 'dine_in') return PAID_BILL_LOCKED;
  if (gatewayOwnsPayment(order, evidence)) {
    return 'This bill was paid online, so it can’t be changed here — start a new order for anything more.';
  }
  if (!hasBalanceColumns(order)) {
    return `${PAID_BILL_LOCKED} Changing a paid bill needs the database update ${PAID_CHANGE_MIGRATION}.`;
  }
  return null;
}

/** The difference still to settle on a bill (0 when none, or before the migration). */
export function balanceOf(order: Pick<PaidChangeOrder, 'balance_due_inr'>): number {
  const b = order.balance_due_inr ?? 0;
  return Number.isFinite(b) ? Math.trunc(b) : 0;
}

/**
 * The balance after a change moved a paid bill's total from `oldTotal` to
 * `newTotal`: whatever was outstanding, plus the change. Adding a ₹150 coffee
 * to a ₹500 bill paid in full leaves ₹150 to collect; taking a ₹120 brownie off
 * it then leaves ₹30 to collect.
 */
export function nextBalance(currentBalance: number, oldTotal: number, newTotal: number): number {
  return currentBalance + (newTotal - oldTotal);
}

/** How much of the bill has been settled: the total less what is still owed (or plus what is owed back). */
export function settledInr(order: { total_inr: number | null; subtotal_inr: number } & Pick<PaidChangeOrder, 'balance_due_inr'>): number {
  return (order.total_inr ?? order.subtotal_inr) - balanceOf(order);
}

/** A bill with a difference still to settle: paid, a balance either way, and not a dead order. */
export function hasOpenBalance(order: PaidChangeOrder): boolean {
  if (isDeadOrder(order.status)) return false;
  return isPaidBill(order) && balanceOf(order) !== 0;
}

/**
 * Whether the paid bill has ever been changed. From then on "Change payment"
 * (recording again how the bill was paid) is refused: it would replace tenders
 * taken at different times with one set summing to the new total, and the
 * drawer would lose the original payment (or a give-back would count twice).
 */
export function changedAfterPayment(order: Pick<PaidChangeOrder, 'paid_amended_at' | 'balance_due_inr'>): boolean {
  return Boolean(order.paid_amended_at) || balanceOf(order) !== 0;
}

/** "₹120 to collect" / "₹40 to give back" / "" — how a balance reads on screen. */
export function describeBalance(balanceInr: number): string {
  if (balanceInr > 0) return `₹${balanceInr.toLocaleString('en-IN')} to collect`;
  if (balanceInr < 0) return `₹${Math.abs(balanceInr).toLocaleString('en-IN')} to give back`;
  return '';
}

/**
 * Completing an order the customer still owes money on would let them leave
 * without paying the difference — the same rule as an unpaid bill (FND3-5). A
 * balance owed BACK doesn't hold the order: the café can return it any time.
 */
export function balanceCompletionBlock(order: Pick<PaidChangeOrder, 'balance_due_inr'>): string | null {
  const balance = balanceOf(order);
  return balance > 0 ? `Collect the ₹${balance} balance before completing this order.` : null;
}

/** The original tender, recorded as a row so later tenders can sit beside it. */
export interface OriginalTender {
  method: PaymentMethod;
  amount_inr: number;
  /** When it was taken: orders.paid_at, so the drawer counts it in the same window as before. */
  created_at: string;
}

const COUNTER_SINGLE_TENDERS: readonly string[] = ['cash', 'upi', 'card'];

/**
 * The tender row to write before a paid bill is first changed, or null when
 * none is needed.
 *
 * A bill paid with ONE method at the counter has no order_payments row: the
 * cash drawer, the reports and the refund cap all read such an order as
 * "orders.total_inr, taken by payment_method at paid_at". Once the total
 * changes, that would quietly rewrite the past — ₹620 "taken" at 2 pm when only
 * ₹500 was. So the first change writes the payment that really happened as a
 * row of its own (same method, same amount, same moment), which every one of
 * those readers already prefers over the fallback. The figures they show don't
 * move by a rupee; the later balance tenders then sit beside it.
 *
 * Not needed when the bill already has rows (a split, a dining app, a round-off
 * or tip), when it was changed before (written then), when nothing was taken
 * (a ₹0 bill has no method), or when the moment of payment is unknown (a row
 * stamped "now" would put old money in today's drawer).
 */
export function originalTenderRow(
  order: {
    payment_method?: string | null;
    total_inr: number | null;
    subtotal_inr: number;
    paid_at?: string | null;
    paid_amended_at?: string | null;
  },
  hasTenderRows: boolean,
): OriginalTender | null {
  if (hasTenderRows || order.paid_amended_at) return null;
  const method = order.payment_method ?? '';
  if (!COUNTER_SINGLE_TENDERS.includes(method)) return null;
  const amount = order.total_inr ?? order.subtotal_inr;
  if (!Number.isInteger(amount) || amount <= 0) return null;
  if (!order.paid_at) return null;
  return { method: method as PaymentMethod, amount_inr: amount, created_at: order.paid_at };
}

/** Longest settle_reason kept once balance reasons are added to a bill's own. */
const MAX_COMBINED_REASON_LENGTH = 400;

/** The bill's settle reason with a balance settlement's appended ("No change; Balance: Rounded off"). */
export function appendSettleReason(existing: string | null | undefined, added: string): string {
  const next = added.trim();
  if (!next) return (existing ?? '').trim();
  const prior = (existing ?? '').trim();
  const joined = prior ? `${prior}; Balance: ${next}` : `Balance: ${next}`;
  return joined.slice(0, MAX_COMBINED_REASON_LENGTH);
}

/** What the audit row of a change to a paid bill adds to its payload. */
export function paidChangeAudit(oldTotal: number, newTotal: number, balanceAfter: number) {
  return { paid_bill: true, from_total_inr: oldTotal, to_total_inr: newTotal, balance_due_inr: balanceAfter };
}

// --- Settling the balance (POST /api/orders/[id]/balance) --------------------

/**
 * How a balance is settled:
 *   'collect'    the customer pays what they owe — extra tenders, split, cash
 *                with change, the ±₹5 round-off, as at any settle
 *   'give_back'  the café returns what it owes on one of the bill's tenders —
 *                recorded as a counter refund, so the drawer expects less cash
 *   'write_off'  the café lets an owed balance go (the customer left) — a
 *                settlement discount, under the same ₹50 manager rule as a
 *                short settle
 */
export type BalanceAction = 'collect' | 'give_back' | 'write_off';

export const BALANCE_ACTIONS: readonly BalanceAction[] = ['collect', 'give_back', 'write_off'];

/** Why `action` doesn't fit this balance, or null when it does. */
export function balanceActionError(action: unknown, balanceInr: number): string | null {
  if (!(BALANCE_ACTIONS as readonly unknown[]).includes(action)) {
    return `action must be one of: ${BALANCE_ACTIONS.join(', ')}`;
  }
  if (balanceInr === 0) return 'Nothing to settle — this bill is settled up.';
  if (action === 'give_back' && balanceInr > 0) {
    return `The customer owes ₹${balanceInr} on this bill — there is nothing to give back.`;
  }
  if (action !== 'give_back' && balanceInr < 0) {
    return `The café owes ₹${Math.abs(balanceInr)} back on this bill — give it back instead.`;
  }
  return null;
}

/** Why a give-back or write-off goes into the audit and onto the refund. */
export const GIVE_BACK_REASON = 'Bill lowered after payment';
