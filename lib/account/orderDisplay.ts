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

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  placed: 'Placed',
  received: 'Received',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Collected',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

// Pill background + text (a status "pill", not just colored text) so state
// reads at a glance in a scannable list.
export const ORDER_STATUS_BADGE_CLASS: Record<OrderStatus, string> = {
  placed: 'bg-[#f2efe9] text-muted',
  received: 'bg-tan/15 text-tan',
  accepted: 'bg-tan/15 text-tan',
  preparing: 'bg-tan/15 text-tan',
  ready: 'bg-tan/15 text-tan',
  completed: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  cancelled: 'bg-red-100 text-red-700',
};

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
