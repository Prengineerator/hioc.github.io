// How staff screens show whether an order's money has been collected — the
// order cards, the day's Orders list and its "still to collect" total. Pure
// so the rules are tested once and every staff screen agrees.

import type { Order, PaymentStatus } from '@/lib/types';

export type PaymentTone = 'paid' | 'due' | 'pending' | 'refunded';

export const PAYMENT_BADGE: Record<PaymentStatus, { label: string; tone: PaymentTone }> = {
  paid: { label: 'Paid', tone: 'paid' },
  unpaid: { label: 'Unpaid', tone: 'due' },
  payment_pending: { label: 'Awaiting payment', tone: 'pending' },
  refunded: { label: 'Refunded', tone: 'refunded' },
  partially_refunded: { label: 'Part refunded', tone: 'refunded' },
};

/**
 * An order whose money is still to be collected: not paid, and not an order
 * that will never be paid (rejected/cancelled). Highlighted on the Orders
 * page, and — since completing now requires payment — the reason a "ready"
 * order can't be completed yet.
 */
export function isPaymentDue(order: Pick<Order, 'status' | 'payment_status'>): boolean {
  if (order.status === 'cancelled' || order.status === 'rejected') return false;
  return order.payment_status === 'unpaid' || order.payment_status === 'payment_pending';
}

/** Rupees still to collect across these orders. */
export function amountDueInr(orders: Pick<Order, 'status' | 'payment_status' | 'total_inr' | 'subtotal_inr'>[]): number {
  return orders.filter(isPaymentDue).reduce((sum, o) => sum + (o.total_inr ?? o.subtotal_inr), 0);
}
