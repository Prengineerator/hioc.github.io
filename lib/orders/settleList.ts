// The Settle screen (/staff/settle) and "Change payment" — the pure rules, so
// every screen agrees on what can be settled or re-recorded.

import { changedAfterPayment, hasOpenBalance } from '@/lib/orders/paidChange';
import type { Order } from '@/lib/types';

export { describeOrderPayment, describePaymentMethod } from '@/lib/orders/paymentLabel';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST calendar date (YYYY-MM-DD) of an instant. */
export function istDateKey(iso: string | Date): string {
  const ms = (typeof iso === 'string' ? Date.parse(iso) : iso.getTime()) + IST_OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * An order still owed at the counter: unpaid, and not cancelled/rejected.
 * 'payment_pending' is excluded on purpose — that is an online order waiting
 * on the gateway, and settling it at the counter could charge twice.
 */
export function isSettleable(order: Pick<Order, 'status' | 'payment_status'>): boolean {
  if (order.status === 'cancelled' || order.status === 'rejected') return false;
  return order.payment_status === 'unpaid';
}

/**
 * A paid bill with a difference still to settle (lib/orders/paidChange.ts):
 * changed after it was paid, so more is owed, or some is owed back. It sits on
 * the Settle screen beside the unpaid bills until the balance is settled.
 */
export function hasBalanceToSettle(
  order: Pick<Order, 'status' | 'payment_status' | 'balance_due_inr'>,
): boolean {
  return hasOpenBalance(order);
}

/**
 * A paid bill whose tenders may be recorded again (cash → UPI…). Not an
 * online payment (the gateway owns it), not once anything was refunded
 * (the refund was taken off a specific tender), and not once the paid bill
 * was changed (its tenders were taken at different times — lib/orders/
 * paidChange.ts). Same rule as the server.
 */
export function canChangePayment(
  order: Pick<Order, 'status' | 'payment_status' | 'payment_method'> &
    Partial<Pick<Order, 'balance_due_inr' | 'paid_amended_at'>>,
): boolean {
  if (order.status === 'cancelled' || order.status === 'rejected') return false;
  if (changedAfterPayment(order)) return false;
  return order.payment_status === 'paid' && order.payment_method !== 'online';
}

export interface SettleGroups<T> {
  today: T[];
  earlier: T[];
}

/** Today's bills and older ones, each oldest first (the longest-owed on top). */
export function groupForSettle<T extends Pick<Order, 'created_at'>>(orders: T[], now: Date = new Date()): SettleGroups<T> {
  const todayKey = istDateKey(now);
  const sorted = [...orders].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    today: sorted.filter((o) => istDateKey(o.created_at) === todayKey),
    earlier: sorted.filter((o) => istDateKey(o.created_at) !== todayKey),
  };
}
