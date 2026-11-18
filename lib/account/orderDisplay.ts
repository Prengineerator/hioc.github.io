// Shared, client-safe presentation helpers for a customer's own orders —
// status labels/pills, the order-type chip, and IST date formatting — used
// by both the account overview ("Recent orders" / "Active order" callout,
// app/account/page.tsx) and the account orders page (Active/Past tabs,
// app/account/orders/page.tsx), so the two can't drift on what a status
// looks like.
//
// Deliberately NOT lib/account/history.ts: that module is marked
// `import 'server-only'` (it also carries the account-ownership security
// rules) and can never be imported from a 'use client' file. `isTerminal`
// below is the same Supabase-free state-machine predicate history.ts's own
// isActiveOrderStatus wraps, so "Active" means the same thing in both
// places without the two files importing from each other.

import { isTerminal } from '@/lib/orders/stateMachine';
import type { Order, OrderStatus } from '@/lib/types';

export function isActiveOrderStatus(status: OrderStatus): boolean {
  return !isTerminal(status);
}

// "Ready" is worded for a pickup cafe: the customer's next step is to walk
// to the counter, so it reads "Ready to collect" (never "on its way").
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  placed: 'Placed',
  received: 'Received',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready to collect',
  completed: 'Collected',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

// Pill background + text (a status "pill", not just colored text) so state
// reads at a glance in a scannable list. Every pair is 4.5:1 or better: tan
// text is tan-darker on the soft surface (never plain tan on a tan tint),
// and Ready is the one solid-filled pill so it can't pass for Preparing.
export const ORDER_STATUS_BADGE_CLASS: Record<OrderStatus, string> = {
  placed: 'bg-surface text-charcoal',
  received: 'bg-surface text-tan-darker',
  accepted: 'bg-surface text-tan-darker',
  preparing: 'bg-surface text-tan-darker',
  ready: 'bg-tan-dark text-cream',
  completed: 'bg-green-100 text-green-800',
  rejected: 'bg-red-100 text-red-800',
  cancelled: 'bg-red-100 text-red-800',
};

/** Pill text for an order; a ready delivery order just reads "Ready". */
export function orderStatusLabel(order: Pick<Order, 'status' | 'order_type'>): string {
  if (order.status === 'ready' && order.order_type === 'delivery') return 'Ready';
  return ORDER_STATUS_LABEL[order.status];
}

/** Plain sentence for the "active order" callout: where the order is, not a guess at travel. */
export function activeOrderSentence(order: Pick<Order, 'status' | 'order_type'>): string {
  switch (order.status) {
    case 'ready':
      return order.order_type === 'delivery' ? 'is ready' : 'is ready to collect';
    case 'preparing':
      return 'is being prepared';
    case 'accepted':
      return 'has been accepted';
    default:
      return 'has been received';
  }
}

export function formatIstDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * "Pickup" / "Dine-in" / "Table" — a dine-in order seated at a table
 * (FND3-1's `table_id`, the table-QR channel) reads as "Table" rather than
 * plain "Dine-in", since that's the distinction a customer actually cares
 * about. Returns null for anything unrecognized rather than guessing.
 */
export function orderTypeLabel(order: Pick<Order, 'order_type' | 'table_id'>): string | null {
  switch (order.order_type) {
    case 'takeaway':
      return 'Pickup';
    case 'dine_in':
      return order.table_id ? 'Table' : 'Dine-in';
    case 'delivery':
      return 'Delivery';
    default:
      return null;
  }
}
