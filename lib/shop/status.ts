// The life of a shop order (docs/INSTANT-COFFEE-SHOP.md). Pure.
//
//   payment_pending ──paid──▶ paid ──Send to Shiprocket──▶ sent_to_shiprocket
//                                │                                │
//                                │       (AWB assigned / picked up)▼
//                                └──────── Mark shipped ────────▶ shipped ──▶ delivered
//
//   Any paid state ──Cancel & refund──▶ cancelled
//
// 'payment_pending' orders are checkouts whose payment never completed. They
// stay out of the owner's lists (an "Unpaid" tab shows them) and need nothing
// done: no money moved.

import type { ShopOrderPublicView, ShopOrderRow, ShopOrderStatus } from './types';

export const SHOP_ORDER_STATUSES: readonly ShopOrderStatus[] = [
  'payment_pending',
  'paid',
  'sent_to_shiprocket',
  'shipped',
  'delivered',
  'cancelled',
];

export function isShopOrderStatus(v: unknown): v is ShopOrderStatus {
  return typeof v === 'string' && (SHOP_ORDER_STATUSES as readonly string[]).includes(v);
}

/** The customer's words for each step. */
export const CUSTOMER_STATUS_LABEL: Record<ShopOrderStatus, string> = {
  payment_pending: 'Waiting for payment',
  paid: 'Order confirmed',
  sent_to_shiprocket: 'Packing your parcel',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/** The owner's words for each step. */
export const OWNER_STATUS_LABEL: Record<ShopOrderStatus, string> = {
  payment_pending: 'Unpaid',
  paid: 'To ship',
  sent_to_shiprocket: 'In Shiprocket',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/** Paid and not yet cancelled: money was taken, so the order needs seeing to. */
export const PAID_STATUSES: readonly ShopOrderStatus[] = ['paid', 'sent_to_shiprocket', 'shipped', 'delivered'];

export function isPaidStatus(status: ShopOrderStatus): boolean {
  return PAID_STATUSES.includes(status);
}

/** The owner page's tabs, each a set of statuses. */
export const OWNER_TABS = [
  { key: 'to_ship', label: 'To ship', statuses: ['paid'] },
  { key: 'with_courier', label: 'With courier', statuses: ['sent_to_shiprocket', 'shipped'] },
  { key: 'delivered', label: 'Delivered', statuses: ['delivered'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
  { key: 'unpaid', label: 'Unpaid', statuses: ['payment_pending'] },
] as const satisfies readonly { key: string; label: string; statuses: readonly ShopOrderStatus[] }[];

export type OwnerTabKey = (typeof OWNER_TABS)[number]['key'];

export function ownerTab(key: string | null | undefined): (typeof OWNER_TABS)[number] {
  return OWNER_TABS.find((t) => t.key === key) ?? OWNER_TABS[0];
}

/** The owner may send to Shiprocket only a paid order not already sent. */
export function canSendToShiprocket(order: Pick<ShopOrderRow, 'status' | 'shiprocket_order_id'>): boolean {
  return order.status === 'paid' && !order.shiprocket_order_id;
}

/** Marking shipped by hand (an AWB from the Shiprocket panel or any courier). */
export function canMarkShipped(order: Pick<ShopOrderRow, 'status'>): boolean {
  return order.status === 'paid' || order.status === 'sent_to_shiprocket';
}

export function canMarkDelivered(order: Pick<ShopOrderRow, 'status'>): boolean {
  return order.status === 'shipped';
}

/** Any paid order can be cancelled; a paid one is refunded in full as it is. */
export function canCancel(order: Pick<ShopOrderRow, 'status'>): boolean {
  return isPaidStatus(order.status);
}

/** Shiprocket can still call off a shipment it hasn't handed to a courier. */
export function shouldCancelInShiprocket(order: Pick<ShopOrderRow, 'status' | 'shiprocket_order_id'>): boolean {
  return order.status === 'sent_to_shiprocket' && Boolean(order.shiprocket_order_id);
}

/**
 * What a Shiprocket order status (and AWB) means for ours. Returns the status
 * to move to, or null to stay put. Conservative:
 *   - 'DELIVERED' → delivered. Anything starting 'RTO' (return to origin,
 *     including 'RTO DELIVERED', which means it came BACK) never reads as
 *     delivered; it stays where it is and the owner sees the raw status.
 *   - a cancelled Shiprocket order changes nothing here: cancelling (and the
 *     refund) is the owner's call on /owner/shop.
 *   - an AWB, or a status past pickup, → shipped (the customer gets tracking).
 * Only ever moves forward from sent_to_shiprocket / shipped.
 */
export function shopStatusFromShiprocket(
  current: ShopOrderStatus,
  shiprocketStatus: string | null | undefined,
  awb: string | null | undefined,
): ShopOrderStatus | null {
  if (current !== 'sent_to_shiprocket' && current !== 'shipped') return null;
  const s = (shiprocketStatus ?? '').trim().toUpperCase().replace(/[_-]+/g, ' ');
  if (s.startsWith('RTO') || s.includes('CANCEL') || s.includes('LOST') || s.includes('DAMAGE')) return null;
  if (s === 'DELIVERED') return 'delivered';
  if (current === 'shipped') return null;
  const moving = ['PICKUP SCHEDULED', 'PICKED UP', 'SHIPPED', 'IN TRANSIT', 'OUT FOR DELIVERY', 'OUT FOR PICKUP', 'READY TO SHIP', 'AWB ASSIGNED', 'REACHED DESTINATION HUB'];
  if ((awb ?? '').trim() || moving.some((m) => s === m || s.startsWith(m))) return 'shipped';
  return null;
}

/**
 * Does Shiprocket's bill match what the customer paid? Shiprocket works out
 * its own order total from what we send it, and that total is what its
 * invoice, its emails to the customer and the parcel's declared value say.
 * HIOC-S1004 paid ₹749 and Shiprocket's bill said ₹301, so /owner/shop
 * checks every order it has read back. Null for an order not in Shiprocket.
 * Under ₹1 apart counts as the same (Shiprocket keeps paise).
 */
export type ShiprocketBillCheck =
  | { state: 'unchecked' }
  | { state: 'matches'; shiprocket: number }
  | { state: 'differs'; shiprocket: number; paid: number };

export function shiprocketBillCheck(
  order: Pick<ShopOrderRow, 'shiprocket_order_id' | 'shiprocket_total_inr' | 'total_inr'>,
): ShiprocketBillCheck | null {
  if (!order.shiprocket_order_id) return null;
  const shiprocket = order.shiprocket_total_inr;
  if (shiprocket === null || shiprocket === undefined || !Number.isFinite(shiprocket)) return { state: 'unchecked' };
  if (Math.abs(shiprocket - order.total_inr) < 1) return { state: 'matches', shiprocket };
  return { state: 'differs', shiprocket, paid: order.total_inr };
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** The owner's warning for a bill that doesn't match, or null when it does (or isn't read yet). */
export function shiprocketBillWarning(
  order: Pick<ShopOrderRow, 'shiprocket_order_id' | 'shiprocket_total_inr' | 'total_inr'>,
): string | null {
  const check = shiprocketBillCheck(order);
  if (check?.state !== 'differs') return null;
  return `Shiprocket's bill says ${inr(check.shiprocket)}, but the customer paid ${inr(check.paid)}. That wrong amount goes on Shiprocket's invoice, its emails to the customer and the parcel's declared value. Correct the order in the Shiprocket panel before a courier is booked.`;
}

/** The customer's tracking page for an AWB, on Shiprocket's tracking site. */
export function trackingUrl(awb: string | null | undefined): string | null {
  const code = (awb ?? '').trim();
  return code ? `https://shiprocket.co/tracking/${encodeURIComponent(code)}` : null;
}

/** "HIOC-S1001": the number on the order page, emails, and Shiprocket's order id. */
export function shopOrderRef(orderNumber: number): string {
  return `HIOC-S${orderNumber}`;
}

/** The customer's view of a row: no street, phone or email (see ShopOrderPublicView). */
export function toPublicView(o: ShopOrderRow): ShopOrderPublicView {
  return {
    id: o.id,
    order_number: o.order_number,
    status: o.status,
    lines: o.lines,
    jar_count: o.jar_count,
    subtotal_inr: o.subtotal_inr,
    discount_inr: o.discount_inr,
    offer_name: o.offer_name,
    shipping_inr: o.shipping_inr,
    total_inr: o.total_inr,
    ship_to: { name: o.customer_name, city: o.city, state: o.state, pincode: o.pincode },
    awb_code: o.awb_code,
    courier_name: o.courier_name,
    tracking_url: trackingUrl(o.awb_code),
    refunded_inr: o.refunded_inr,
    created_at: o.created_at,
    paid_at: o.paid_at,
    shipped_at: o.shipped_at,
    delivered_at: o.delivered_at,
    cancelled_at: o.cancelled_at,
  };
}
