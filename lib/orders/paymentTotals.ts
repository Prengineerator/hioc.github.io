// "Payment received" per method for the Orders tab. Pure so the staff Orders
// strip and its tests share one definition of what counts as received money.
//
// A split bill's parts are the source of truth when present; otherwise the
// order's single payment_method carries its whole total. Only money actually
// taken counts: paid, or partially refunded (the order lists what was
// received; we have no per-order refund figure here, so it stays at what was
// paid). Fully refunded, unpaid/pending, cancelled and rejected orders add
// nothing.

import type { Order, PaymentMethod } from '@/lib/types';

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  'cash',
  'upi',
  'card',
  'online',
  'swiggy_dineout',
  'zomato_district',
];

export interface MethodReceived {
  amount_inr: number;
  orders: number;
}

export type ReceivedByMethod = Record<PaymentMethod, MethodReceived>;

type ReceivedOrder = Pick<
  Order,
  'status' | 'payment_status' | 'payment_method' | 'payments' | 'total_inr' | 'subtotal_inr'
>;

/** Money actually taken on this order: paid (or part-refunded), and not a dead order. */
export function isReceived(o: Pick<Order, 'status' | 'payment_status'>): boolean {
  if (o.status === 'cancelled' || o.status === 'rejected') return false;
  return o.payment_status === 'paid' || o.payment_status === 'partially_refunded';
}

/** Each method's tender on one order, as [method, rupees] (empty if none recorded). */
export function orderTenders(
  o: Pick<Order, 'payment_method' | 'payments' | 'total_inr' | 'subtotal_inr'>,
): [PaymentMethod, number][] {
  const parts = o.payments ?? [];
  if (parts.length > 0) {
    const byMethod = new Map<PaymentMethod, number>();
    for (const p of parts) byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount_inr);
    return [...byMethod.entries()];
  }
  return o.payment_method ? [[o.payment_method, o.total_inr ?? o.subtotal_inr]] : [];
}

/** Every method an order was paid with — what the payment filter matches on. */
export function orderMethods(o: Pick<Order, 'payment_method' | 'payments'>): PaymentMethod[] {
  const parts = o.payments ?? [];
  if (parts.length > 0) return [...new Set(parts.map((p) => p.method))];
  return o.payment_method ? [o.payment_method] : [];
}

export function receivedByMethod(orders: ReceivedOrder[]): ReceivedByMethod {
  const out = {} as ReceivedByMethod;
  for (const m of PAYMENT_METHODS) out[m] = { amount_inr: 0, orders: 0 };
  for (const o of orders) {
    if (!isReceived(o)) continue;
    for (const [method, amount] of orderTenders(o)) {
      const slot = out[method];
      if (!slot) continue;
      slot.amount_inr += amount;
      slot.orders += 1;
    }
  }
  return out;
}

/** Total rupees received across all methods. */
export function totalReceived(received: ReceivedByMethod): number {
  return PAYMENT_METHODS.reduce((sum, m) => sum + received[m].amount_inr, 0);
}
