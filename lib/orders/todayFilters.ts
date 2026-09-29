// Filters for the staff Orders tab (components/staff/TodayOrdersList.tsx): the
// status groups, the payment-method filter and the free-text search. Pure so
// the rules are tested once.

import { isPaymentDue } from '@/lib/orders/staffPayment';
import { isReceived, orderMethods } from '@/lib/orders/paymentTotals';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, OrderStatus, PaymentMethod } from '@/lib/types';

export type StatusGroup = 'all' | 'running' | 'completed' | 'cancelled';
/** A payment method, or 'unpaid' (money still to collect), or no payment filter. */
export type PaymentFilter = 'all' | 'unpaid' | PaymentMethod;

const RUNNING: ReadonlySet<OrderStatus> = new Set(['placed', 'received', 'accepted', 'preparing', 'ready']);
export const CLOSED_UNSOLD: ReadonlySet<OrderStatus> = new Set(['cancelled', 'rejected']);

export function matchesStatusGroup(order: Pick<Order, 'status'>, group: StatusGroup): boolean {
  switch (group) {
    case 'running':
      return RUNNING.has(order.status);
    case 'completed':
      return order.status === 'completed';
    case 'cancelled':
      return CLOSED_UNSOLD.has(order.status);
    default:
      return true;
  }
}

/**
 * 'unpaid' is the still-to-collect set; a method matches every order that
 * received money in it, so a split "Cash + UPI" order shows under both — the
 * same set the Payment received strip counts.
 */
export function matchesPayment(
  order: Pick<Order, 'status' | 'payment_status' | 'payment_method' | 'payments'>,
  filter: PaymentFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'unpaid') return isPaymentDue(order);
  return isReceived(order) && orderMethods(order).includes(filter);
}

/**
 * Case-insensitive search over order number (as printed, "HIOC-001042", or just
 * "1042"), customer name, phone (digits only, so "98765 43210" matches), and
 * the table label / pickup token.
 */
export function matchesSearch(
  order: Pick<Order, 'order_number' | 'customer_name' | 'customer_phone' | 'table_label' | 'pickup_code'>,
  query: string,
): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  if (!q) return true;
  const text = [
    formatOrderNumber(order.order_number),
    String(order.order_number),
    order.customer_name,
    order.table_label,
    order.pickup_code ?? '',
  ]
    .join('\n')
    .toLowerCase();
  if (text.includes(q)) return true;
  const digits = q.replace(/\D/g, '');
  return digits.length >= 3 && (order.customer_phone ?? '').replace(/\D/g, '').includes(digits);
}
