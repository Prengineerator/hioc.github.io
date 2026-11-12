// The life of a shop order (docs/INSTANT-COFFEE-SHOP.md). Pure: safe to import
// from the owner's card as well as the routes, so the buttons and the server
// can never disagree about what may happen next.
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
//
// SHOP_TRANSITIONS below is that picture as data. Every writer asks it
// (canShopTransition) before it writes, then writes compare-and-set on the
// statuses the table allows (shopFromStatuses). Two in-flight markers sit on
// the row beside the status, and each action that starts something slow
// excludes the other's:
//   shiprocket_sending_at  a "Send to Shiprocket" is creating the shipment
//   refund_id = pending:…  a "Cancel & refund" is asking Razorpay for the money
// so a refunded order is never handed to a courier, and an order being handed
// to a courier is never refunded under it.

import type { ShopOrderPublicView, ShopOrderRow, ShopOrderStatus } from './types';

export const SHOP_ORDER_STATUSES = [
  'payment_pending',
  'paid',
  'sent_to_shiprocket',
  'shipped',
  'delivered',
  'cancelled',
] as const satisfies readonly ShopOrderStatus[];

// Every ShopOrderStatus is in the list above: a status added to the type but not here fails to compile.
const everyStatusListed: Exclude<ShopOrderStatus, (typeof SHOP_ORDER_STATUSES)[number]> extends never ? true : never = true;
void everyStatusListed;

/** Nothing leaves these. (A delivered order can still be cancelled and refunded, so it is not one.) */
export const SHOP_TERMINAL_STATUSES: readonly ShopOrderStatus[] = ['cancelled'];

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

// ---------------------------------------------------------------------------
// The in-flight markers
// ---------------------------------------------------------------------------

/**
 * How long a "Send to Shiprocket" holds its claim (shiprocket_sending_at):
 * after this a retry may go, and so may a cancel. Creating a Shiprocket order
 * is one API call; two minutes is far past a slow one.
 */
export const SHIPROCKET_SEND_CLAIM_MS = 2 * 60 * 1000;

/**
 * How long a "Cancel & refund" holds its claim (refund_id = pending:…). Past it
 * the request that took the claim is certainly gone (the longest maxDuration
 * in this app is 60 s, the platform's default ceiling 300 s), so the claim
 * reads 'unconfirmed' and pressing Cancel & refund again finishes the job:
 * the route asks Razorpay first whether the money already went back, so it is
 * never refunded twice.
 */
export const REFUND_CLAIM_MS = 5 * 60 * 1000;

/** refund_id while the Razorpay refund call is in flight. Rows written before the marker carried its time hold the bare word. */
const REFUND_PENDING = 'pending';

/** The refund_id a cancel writes while it asks Razorpay for the money: "pending:<ISO time>". */
export function refundPendingMarker(nowMs: number): string {
  return `${REFUND_PENDING}:${new Date(nowMs).toISOString()}`;
}

/** True for a refund_id that is a cancel's claim rather than a Razorpay refund id. */
export function isRefundPendingMarker(refundId: string | null | undefined): boolean {
  return refundId === REFUND_PENDING || (typeof refundId === 'string' && refundId.startsWith(`${REFUND_PENDING}:`));
}

/**
 * Where the order's refund stands:
 *   none         no refund started (refund_id null)
 *   in_flight    a cancel is asking Razorpay right now: leave it alone
 *   unconfirmed  a cancel started one and never said how it ended (it was
 *                killed, or could not save the result). Cancel & refund again
 *                resolves it with Razorpay. A bare 'pending' is always this.
 *   done         refund_id is Razorpay's refund id
 */
export type ShopRefundState = 'none' | 'in_flight' | 'unconfirmed' | 'done';

export function shopRefundState(order: Pick<ShopOrderRow, 'refund_id'>, nowMs: number = Date.now()): ShopRefundState {
  const id = order.refund_id;
  if (!id) return 'none';
  if (!isRefundPendingMarker(id)) return 'done';
  const since = Date.parse(id.slice(REFUND_PENDING.length + 1));
  if (Number.isNaN(since)) return 'unconfirmed';
  return nowMs - since < REFUND_CLAIM_MS ? 'in_flight' : 'unconfirmed';
}

/** A "Send to Shiprocket" is creating the shipment right now (its claim is younger than SHIPROCKET_SEND_CLAIM_MS). */
export function isShiprocketSendInFlight(
  order: Pick<ShopOrderRow, 'shiprocket_sending_at'>,
  nowMs: number = Date.now(),
): boolean {
  if (!order.shiprocket_sending_at) return false;
  const since = Date.parse(order.shiprocket_sending_at);
  return !Number.isNaN(since) && nowMs - since < SHIPROCKET_SEND_CLAIM_MS;
}

// ---------------------------------------------------------------------------
// The transitions
// ---------------------------------------------------------------------------

/**
 * What moves an order. Two actions can make the same move (a paid order reaches
 * 'shipped' by a send that came back with an AWB, or by hand) and they are
 * guarded differently, so the table is keyed by action too.
 */
export type ShopAction =
  | 'capture' //        the payment was captured (verify, webhook or the order page's poll)
  | 'send' //           Send to Shiprocket: creates the shipment
  | 'mark_shipped' //   by hand, with an AWB from any courier
  | 'refresh' //        Refresh from Shiprocket: reads the AWB / delivery back
  | 'mark_delivered' // by hand
  | 'cancel'; //        Cancel & refund

/** 'gateway' is a Razorpay capture, whichever path saw it; everything else is the owner on /owner/shop. */
export type ShopActor = 'owner' | 'gateway';

/** The row facts a guard reads. */
export type ShopGuardFacts = Pick<ShopOrderRow, 'shiprocket_order_id' | 'shiprocket_sending_at' | 'refund_id'>;

export type ShopCheckCode = 'not_allowed' | 'forbidden_actor' | 'already_in_shiprocket' | 'refund_started' | 'sending';

export type ShopCheck = { ok: true } | { ok: false; code: ShopCheckCode; message: string };

export interface ShopTransitionRule {
  action: ShopAction;
  from: ShopOrderStatus;
  to: ShopOrderStatus;
  actor: ShopActor;
  guard?: (order: ShopGuardFacts, nowMs: number) => ShopCheck;
}

const OK: ShopCheck = { ok: true };

/**
 * Starting a shipment: only once, and never for an order whose refund has
 * started. That order is on its way to 'cancelled'; shipping it would send jars
 * the customer has been paid back for.
 */
function sendGuard(order: ShopGuardFacts): ShopCheck {
  if (order.shiprocket_order_id) return { ok: false, code: 'already_in_shiprocket', message: 'This order is already in Shiprocket.' };
  if (order.refund_id) return { ok: false, code: 'refund_started', message: 'A refund has been started for this order, so it cannot be shipped.' };
  return OK;
}

/**
 * Starting a refund: never while a shipment is being created (it could land in
 * Shiprocket after the cancel decided there was nothing there to call off),
 * and never twice at once. An unconfirmed earlier refund may be finished.
 */
function cancelGuard(order: ShopGuardFacts, nowMs: number): ShopCheck {
  if (isShiprocketSendInFlight(order, nowMs)) {
    return { ok: false, code: 'sending', message: 'This order is being sent to Shiprocket right now — give it a minute, then reload.' };
  }
  const refund = shopRefundState(order, nowMs);
  if (refund === 'in_flight') {
    return { ok: false, code: 'refund_started', message: 'A refund for this order is already under way — reload the page.' };
  }
  if (refund === 'done') {
    return { ok: false, code: 'refund_started', message: 'This order has already been refunded — reload the page.' };
  }
  return OK;
}

/** Every legal move. Anything not listed is refused. */
export const SHOP_TRANSITIONS: readonly ShopTransitionRule[] = [
  { action: 'capture', from: 'payment_pending', to: 'paid', actor: 'gateway' },

  // A send that comes back with an AWB already assigned goes straight to shipped.
  { action: 'send', from: 'paid', to: 'sent_to_shiprocket', actor: 'owner', guard: sendGuard },
  { action: 'send', from: 'paid', to: 'shipped', actor: 'owner', guard: sendGuard },

  { action: 'mark_shipped', from: 'paid', to: 'shipped', actor: 'owner' },
  { action: 'mark_shipped', from: 'sent_to_shiprocket', to: 'shipped', actor: 'owner' },

  // shopStatusFromShiprocket picks which, and only ever forward.
  { action: 'refresh', from: 'sent_to_shiprocket', to: 'shipped', actor: 'owner' },
  { action: 'refresh', from: 'sent_to_shiprocket', to: 'delivered', actor: 'owner' },
  { action: 'refresh', from: 'shipped', to: 'delivered', actor: 'owner' },

  { action: 'mark_delivered', from: 'shipped', to: 'delivered', actor: 'owner' },

  // Any paid order, refunded in full as it is.
  ...PAID_STATUSES.map((from): ShopTransitionRule => ({ action: 'cancel', from, to: 'cancelled', actor: 'owner', guard: cancelGuard })),
];

/**
 * Whether `action` may move an order from `from` to `to`. `order` is the row
 * the guards read (the routes pass the row they just loaded); without it only
 * the table is consulted.
 */
export function canShopTransition(
  action: ShopAction,
  from: ShopOrderStatus,
  to: ShopOrderStatus,
  ctx: { actor?: ShopActor; order?: ShopGuardFacts; nowMs?: number } = {},
): ShopCheck {
  const rule = SHOP_TRANSITIONS.find((t) => t.action === action && t.from === from && t.to === to);
  if (!rule) return { ok: false, code: 'not_allowed', message: `A shop order can't go from ${from} to ${to} by ${action}.` };
  if (ctx.actor && ctx.actor !== rule.actor) {
    return { ok: false, code: 'forbidden_actor', message: `Only the ${rule.actor} can ${action} a shop order.` };
  }
  if (rule.guard && ctx.order) return rule.guard(ctx.order, ctx.nowMs ?? Date.now());
  return OK;
}

/** The statuses `action` moves an order out of (towards `to`, when given): the compare-and-set set for its write. */
export function shopFromStatuses(action: ShopAction, to?: ShopOrderStatus): ShopOrderStatus[] {
  const out: ShopOrderStatus[] = [];
  for (const t of SHOP_TRANSITIONS) {
    if (t.action === action && (to === undefined || t.to === to) && !out.includes(t.from)) out.push(t.from);
  }
  return out;
}

/** The first move `action` can make from this order's status, guards included, or the reason none can. */
export function checkShopAction(
  action: ShopAction,
  order: Pick<ShopOrderRow, 'status'> & Partial<ShopGuardFacts>,
  nowMs: number = Date.now(),
): ShopCheck {
  const facts: ShopGuardFacts = {
    shiprocket_order_id: order.shiprocket_order_id ?? null,
    shiprocket_sending_at: order.shiprocket_sending_at ?? null,
    refund_id: order.refund_id ?? null,
  };
  let refusal: ShopCheck | null = null;
  for (const t of SHOP_TRANSITIONS) {
    if (t.action !== action || t.from !== order.status) continue;
    const check = canShopTransition(action, t.from, t.to, { order: facts, nowMs });
    if (check.ok) return check;
    refusal ??= check;
  }
  return refusal ?? { ok: false, code: 'not_allowed', message: `A ${order.status} shop order can't be moved by ${action}.` };
}

/** The owner may send to Shiprocket only a paid order not already sent, and not one being refunded. */
export function canSendToShiprocket(order: Pick<ShopOrderRow, 'status' | 'shiprocket_order_id'> & Partial<ShopGuardFacts>): boolean {
  return checkShopAction('send', order).ok;
}

/** Marking shipped by hand (an AWB from the Shiprocket panel or any courier). */
export function canMarkShipped(order: Pick<ShopOrderRow, 'status'>): boolean {
  return checkShopAction('mark_shipped', order).ok;
}

export function canMarkDelivered(order: Pick<ShopOrderRow, 'status'>): boolean {
  return checkShopAction('mark_delivered', order).ok;
}

/** Reading the AWB / delivery back: an order Shiprocket has, still on its way. */
export function canRefreshFromShiprocket(order: Pick<ShopOrderRow, 'status' | 'shiprocket_order_id'>): boolean {
  return Boolean(order.shiprocket_order_id) && checkShopAction('refresh', order).ok;
}

/**
 * Any paid order can be cancelled; a paid one is refunded in full as it is.
 * Not while it is being sent to Shiprocket, nor while a refund is in flight;
 * an unconfirmed refund is finished this way.
 */
export function canCancel(order: Pick<ShopOrderRow, 'status'> & Partial<ShopGuardFacts>, nowMs: number = Date.now()): boolean {
  return checkShopAction('cancel', order, nowMs).ok;
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
