// How staff screens and the printed bill name the way an order was paid. A
// split bill reads "Cash ₹300 + UPI ₹180" — not just its largest part, which
// is all orders.payment_method can hold.

import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import type { Order, PaymentMethod } from '@/lib/types';

export function describePaymentMethod(method: PaymentMethod | null | undefined): string {
  return method ? (PAYMENT_METHOD_LABEL[method] ?? method) : 'not recorded';
}

/** "Cash ₹300 + UPI ₹180" for a split, else the single method's name. */
export function describeOrderPayment(order: Pick<Order, 'payment_method' | 'payments'>): string {
  const parts = order.payments ?? [];
  if (parts.length > 1) {
    return parts.map((p) => `${describePaymentMethod(p.method)} ₹${p.amount_inr}`).join(' + ');
  }
  return describePaymentMethod(parts[0]?.method ?? order.payment_method);
}
