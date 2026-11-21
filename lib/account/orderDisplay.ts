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
import { lineItemLabel } from '@/lib/shop/catalog';
import type { ShopLine, ShopOrderStatus } from '@/lib/shop/types';
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

// ---------------------------------------------------------------------------
// Shop orders (docs/SHOP-V2-SPEC.md E4). Pure, client-safe: the account home,
// the orders page, the confirmation page and /account/rewards all word a shop order
// the same way.
// ---------------------------------------------------------------------------

/** The channel badge text on a shop row: "Shipped to Pune". A missing city drops the place. */
export function shopChannelBadgeText(city: string | null | undefined): string {
  const c = (city ?? '').trim();
  return c ? `Shipped to ${c}` : 'Shipped';
}

/**
 * "2× Signature Classic, 1× Home Blend 500 g · Filter" — at most `max` lines,
 * then "+N more". Each line is worded by lineItemLabel (so the grind shows).
 */
export function shopItemsSummary(lines: readonly ShopLine[], max = 3): string {
  const limit = Math.max(1, Math.floor(max));
  const labels = lines.map(lineItemLabel);
  if (labels.length <= limit) return labels.join(', ');
  return `${labels.slice(0, limit).join(', ')} +${labels.length - limit} more`;
}

export const SHOP_STEP_LABELS = ['Paid', 'Packed', 'Shipped', 'Delivered'] as const;

export type ShopStepState = 'done' | 'current' | 'upcoming';

export interface ShopStatusSteps {
  steps: { label: (typeof SHOP_STEP_LABELS)[number]; state: ShopStepState }[];
  /** Index of the step the order is on (0 to 3), or -1 before payment / after a cancel or expiry. */
  currentIndex: number;
  /** Set for an order that left the track: the words to show instead of the steps. */
  terminal: 'Cancelled' | 'Payment not completed' | null;
}

const STEP_INDEX: Partial<Record<ShopOrderStatus, number>> = {
  paid: 0,
  sent_to_shiprocket: 1,
  shipped: 2,
  delivered: 3,
};

/**
 * Paid → Packed → Shipped → Delivered with where the order is. `payment_pending`
 * has no current step (nothing is done yet); `cancelled` and `expired` have none
 * either and carry a `terminal` label, so a caller can say it in words instead
 * of drawing a progress bar that never finishes.
 */
export function shopStatusSteps(status: ShopOrderStatus): ShopStatusSteps {
  const currentIndex = STEP_INDEX[status] ?? -1;
  const terminal = status === 'cancelled' ? 'Cancelled' : status === 'expired' ? 'Payment not completed' : null;
  return {
    steps: SHOP_STEP_LABELS.map((label, i) => ({
      label,
      state: i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming',
    })),
    currentIndex,
    terminal,
  };
}

/** The "Active order" callout's sentence for a parcel that is not delivered yet. */
export function activeShopSentence(order: Pick<{ status: ShopOrderStatus }, 'status'>): string {
  return order.status === 'shipped' ? 'Your coffee is on its way' : 'Your coffee is being packed';
}

/** What a Beanies balance is worth at checkout: "₹39". Rounds down, like the ledger. */
export function beaniesWorth(balance: number, inrPerPoint: number): string {
  const b = Number.isFinite(balance) ? Math.max(0, balance) : 0;
  const r = Number.isFinite(inrPerPoint) ? Math.max(0, inrPerPoint) : 0;
  return `₹${Math.floor(b * r).toLocaleString('en-IN')}`;
}

/**
 * Finds the shop order number ("HIOC-S1004") inside a Beanies ledger note and
 * splits the note around it, so /account/rewards can show the number in mono as a link.
 * Null when the note has none.
 */
export function splitShopRefFromNote(note: string | null | undefined): { before: string; ref: string; after: string } | null {
  const m = /HIOC-S\d+/.exec(note ?? '');
  if (!m || !note) return null;
  return { before: note.slice(0, m.index), ref: m[0], after: note.slice(m.index + m[0].length) };
}
