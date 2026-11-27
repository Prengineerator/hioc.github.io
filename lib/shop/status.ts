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
// done: no money moved. A checkout left unpaid long enough becomes 'expired'
// (the customer reads "Payment not completed"); the Unpaid tab holds both.

import { beaniesLabel } from '@/lib/loyalty/brand';
import type { ShopDiscountLine, ShopHistoryOrder, ShopOrderPublicView, ShopOrderRow, ShopOrderStatus } from './types';

export const SHOP_ORDER_STATUSES: readonly ShopOrderStatus[] = [
  'payment_pending',
  'paid',
  'sent_to_shiprocket',
  'shipped',
  'delivered',
  'cancelled',
  'expired',
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
  expired: 'Payment not completed',
};

/** The owner's words for each step. */
export const OWNER_STATUS_LABEL: Record<ShopOrderStatus, string> = {
  payment_pending: 'Unpaid',
  paid: 'To ship',
  sent_to_shiprocket: 'In Shiprocket',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

/** Paid and not yet cancelled: money was taken, so the order needs seeing to. */
export const PAID_STATUSES: readonly ShopOrderStatus[] = ['paid', 'sent_to_shiprocket', 'shipped', 'delivered'];

export function isPaidStatus(status: ShopOrderStatus): boolean {
  return PAID_STATUSES.includes(status);
}

/** Money taken and the order still live (not delivered, not cancelled). */
export function isActiveShopStatus(s: ShopOrderStatus): boolean {
  return s === 'paid' || s === 'sent_to_shiprocket' || s === 'shipped';
}

/** The owner page's tabs, each a set of statuses. */
export const OWNER_TABS = [
  { key: 'to_ship', label: 'To ship', statuses: ['paid'] },
  // Owner-entered orders waiting for their payment link to be paid. Same status as an abandoned
  // website checkout, told apart by payment_channel (the Unpaid tab leaves these out).
  { key: 'awaiting_payment', label: 'Awaiting payment', statuses: ['payment_pending'], channel: 'payment_link' },
  { key: 'with_courier', label: 'With courier', statuses: ['sent_to_shiprocket', 'shipped'] },
  { key: 'delivered', label: 'Delivered', statuses: ['delivered'] },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
  { key: 'unpaid', label: 'Unpaid', statuses: ['payment_pending', 'expired'] },
] as const satisfies readonly { key: string; label: string; statuses: readonly ShopOrderStatus[]; channel?: 'payment_link' }[];

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
  | { state: 'differs'; shiprocket: number; paid: number }
  | { state: 'exception'; shiprocket: number; paid: number; note: string };

/**
 * Mismatches the owner has accepted, one by one: no warning, just a note.
 * Each names the exact Shiprocket order and the exact wrong amount, so the
 * exception ends by itself if Shiprocket's bill changes to anything else, and
 * every other order is still flagged. Add to this only on the owner's say-so.
 */
export const SHIPROCKET_BILL_EXCEPTIONS: readonly {
  order_number: number;
  shiprocket_order_id: string;
  shiprocket_total_inr: number;
  note: string;
}[] = [
  {
    // Owner, 16 Nov 2026: mark it as an exception; flag everything after it.
    order_number: 1004,
    shiprocket_order_id: '1733716182',
    shiprocket_total_inr: 301,
    note: 'Accepted: sent before the double-discount fix. The customer was charged the right amount.',
  },
];

type BillFields = Pick<ShopOrderRow, 'order_number' | 'shiprocket_order_id' | 'shiprocket_total_inr' | 'total_inr'>;

export function shiprocketBillCheck(order: BillFields): ShiprocketBillCheck | null {
  if (!order.shiprocket_order_id) return null;
  const shiprocket = order.shiprocket_total_inr;
  if (shiprocket === null || shiprocket === undefined || !Number.isFinite(shiprocket)) return { state: 'unchecked' };
  if (Math.abs(shiprocket - order.total_inr) < 1) return { state: 'matches', shiprocket };
  const exception = SHIPROCKET_BILL_EXCEPTIONS.find(
    (e) =>
      e.order_number === order.order_number &&
      e.shiprocket_order_id === order.shiprocket_order_id &&
      Math.abs(e.shiprocket_total_inr - shiprocket) < 1,
  );
  if (exception) return { state: 'exception', shiprocket, paid: order.total_inr, note: exception.note };
  return { state: 'differs', shiprocket, paid: order.total_inr };
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** The owner's warning for a bill that doesn't match, or null when it does, isn't read yet, or is an accepted exception. */
export function shiprocketBillWarning(order: BillFields): string | null {
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

type DiscountFields = Pick<
  ShopOrderRow,
  | 'discount_inr'
  | 'offer_name'
  | 'offer_discount_inr'
  | 'coupon_code'
  | 'coupon_discount_inr'
  | 'beanies_redeemed'
  | 'beanies_discount_inr'
> &
  Partial<Pick<ShopOrderRow, 'owner_discount_inr'>>;

/**
 * The receipt's discount lines: offer, coupon, Beanies, each only when above
 * zero. A legacy row (v1, before the split columns) has all three at 0 but a
 * discount_inr above 0: that was the offer, so it reads as one offer line.
 */
export function shopOrderDiscountBreakdown(o: DiscountFields): ShopDiscountLine[] {
  const offer = o.offer_discount_inr || 0;
  const coupon = o.coupon_discount_inr || 0;
  const beanies = o.beanies_discount_inr || 0;
  const owner = o.owner_discount_inr || 0;
  const offerLabel = o.offer_name ?? 'Introductory offer';
  if (offer === 0 && coupon === 0 && beanies === 0 && owner === 0) {
    return o.discount_inr > 0 ? [{ kind: 'offer', label: offerLabel, amount_inr: o.discount_inr }] : [];
  }
  const lines: ShopDiscountLine[] = [];
  if (offer > 0) lines.push({ kind: 'offer', label: offerLabel, amount_inr: offer });
  if (coupon > 0) lines.push({ kind: 'coupon', label: `Coupon ${o.coupon_code ?? ''}`.trim(), amount_inr: coupon });
  if (owner > 0) lines.push({ kind: 'owner', label: 'Special discount', amount_inr: owner });
  if (beanies > 0) lines.push({ kind: 'beanies', label: beaniesLabel(o.beanies_redeemed), amount_inr: beanies });
  return lines;
}

/** The customer's view of a row: no street, phone or email (see ShopOrderPublicView). */
export function toPublicView(o: ShopOrderRow, extras?: { beanies_to_earn?: number | null }): ShopOrderPublicView {
  return {
    id: o.id,
    order_number: o.order_number,
    status: o.status,
    lines: o.lines,
    jar_count: o.jar_count,
    unit_count: o.jar_count,
    subtotal_inr: o.subtotal_inr,
    discount_inr: o.discount_inr,
    offer_name: o.offer_name,
    offer_discount_inr: o.offer_discount_inr,
    coupon_code: o.coupon_code,
    coupon_discount_inr: o.coupon_discount_inr,
    beanies_redeemed: o.beanies_redeemed,
    beanies_discount_inr: o.beanies_discount_inr,
    intro_offer_applied: o.intro_offer_applied,
    discounts: shopOrderDiscountBreakdown(o),
    is_guest: o.user_id === null,
    beanies_to_earn: extras?.beanies_to_earn ?? null,
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

/** One row of the customer's shop order history: no address, phone or email. */
export function toShopHistoryOrder(o: ShopOrderRow): ShopHistoryOrder {
  return {
    id: o.id,
    order_number: o.order_number,
    status: o.status,
    lines: o.lines,
    unit_count: o.jar_count,
    total_inr: o.total_inr,
    city: o.city,
    awb_code: o.awb_code,
    tracking_url: trackingUrl(o.awb_code),
    created_at: o.created_at,
    paid_at: o.paid_at,
    shipped_at: o.shipped_at,
    delivered_at: o.delivered_at,
    cancelled_at: o.cancelled_at,
  };
}
