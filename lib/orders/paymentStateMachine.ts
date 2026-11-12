// orders.payment_status state machine — the single source of truth for which
// money states an order may move between, who moves it, through which
// operation, and what each move requires. The routes check here before they
// write (and then write with a compare-and-set on the state they read), and
// the staff screens ask the same predicates, so the till can never offer what
// the server refuses — or the server accept what the till forbids.
//
// House pattern: lib/orders/stateMachine.ts (order status), whose TRANSITIONS
// this mirrors. Pure (no DB, no server-only): safe in client components.
//
// Who:
//   system    order creation, the gateway-unavailable fallback, auto-expiry
//   gateway   a Razorpay capture (verify / webhook / reconcile poll / cron)
//   counter   staff, a manager or the owner at the till; comp and refund also
//             need their permission (`permission`), which the route checks
//   customer  the diner's own actions: switch to pay at the counter, cancel a
//             'placed' order
//
// The payment the GATEWAY took is owned by the gateway: it changes only through
// a refund. Whether the gateway took it is evidence from the order's `payments`
// rows (lib/payments/paymentRowStateMachine.ts gatewayEvidenceFromRows), never
// orders.payment_method alone — a capture stores 'upi' or 'card' there, the
// same words a counter settle uses.

import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import {
  NO_GATEWAY_EVIDENCE,
  type GatewayEvidence,
} from '@/lib/payments/paymentRowStateMachine';
import { isDeadOrder, MONEY_COLLECTED_STATUSES } from '@/lib/orders/stateMachine';
import type { OrderStatus, PaymentStatus } from '@/lib/types';

export { isDeadOrder, MONEY_COLLECTED_STATUSES } from '@/lib/orders/stateMachine';
export type { GatewayEvidence } from '@/lib/payments/paymentRowStateMachine';

export const PAYMENT_STATUSES = [
  'unpaid',
  'payment_pending',
  'paid',
  'refunded',
  'partially_refunded',
] as const satisfies readonly PaymentStatus[];

// Compile-time exhaustiveness: a new PaymentStatus that is not listed above
// fails here rather than silently having no transitions.
type MissingPaymentStatus = Exclude<PaymentStatus, (typeof PAYMENT_STATUSES)[number]>;
const _exhaustive: MissingPaymentStatus extends never ? true : never = true;
void _exhaustive;

/** Nothing leaves a fully refunded order's payment. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ['refunded'];

/** The refund states — produced only by the refund route. */
export const REFUND_PAYMENT_STATUSES: readonly PaymentStatus[] = ['refunded', 'partially_refunded'];

export type PaymentActor = 'system' | 'gateway' | 'counter' | 'customer';

export type PaymentVia =
  | 'create' // POST /api/orders (and the pass checkout): the order's first state
  | 'capture' // lib/payments/reconcile.ts captureGatewayPayment
  | 'switch_to_counter' // POST /api/payments/[orderId]/status
  | 'gateway_unavailable' // POST /api/orders when no payment intent could be made
  | 'expire' // /api/cron/expire-orders
  | 'cancel_placed' // a 'placed' order cancelled (customer, or a manager)
  | 'settle' // PATCH /api/orders/[id]/payment (and "Collect now")
  | 're_settle' // the same, on a paid bill: "Change payment"
  | 'mark_unpaid' // the same route with payment_status 'unpaid' (no screen sends it)
  | 'mark_pending' // the same route with payment_status 'payment_pending' (no screen sends it)
  | 'comp' // PATCH /api/orders/[id]/status { status: 'completed', comp }
  | 'refund'; // POST /api/orders/[id]/refund

/** What a guard may consult. All optional so a UI can ask with what it has. */
export interface PaymentFacts {
  orderStatus?: OrderStatus | string;
  /** 'coffee_pass' for the sale of a HIOC Ritual pass. */
  orderKind?: string | null;
  /** The gateway took this order's money (gatewayOwnsPayment). */
  gatewayOwned?: boolean;
  /** A Razorpay order for it is still open (the customer can still pay). */
  gatewayLive?: boolean;
  /** A paid bill changed afterwards (lib/orders/paidChange.ts changedAfterPayment). */
  changedAfterPayment?: boolean;
}

export type PaymentCheckCode =
  | 'not_allowed'
  | 'forbidden_actor'
  | 'dead_order'
  | 'gateway_owned'
  | 'gateway_live'
  | 'refunded'
  | 'pass_issued'
  | 'changed_after_payment'
  | 'completed'
  | 'not_ready';

export interface PaymentCheck {
  ok: boolean;
  code?: PaymentCheckCode;
  message?: string;
  rule?: PaymentTransitionRule;
}

export interface PaymentTransitionRule {
  from: PaymentStatus | null;
  to: PaymentStatus;
  via: PaymentVia;
  actors: readonly PaymentActor[];
  /** The route also checks this permission (lib/permissions.ts). */
  permission?: 'comp_order' | 'refund';
  /** Why this move exists — the table is the documentation. */
  why: string;
  guard?: (facts: PaymentFacts) => PaymentCheck;
}

// --- Messages (kept word for word where a route already said them) ----------

export const GATEWAY_OWNED_MESSAGE =
  'This order was paid online — its payment is managed by the gateway and can only change via a refund.';
export const REFUNDED_MESSAGE = 'This order has a refund, so how it was paid can no longer be changed.';
export const CHANGED_AFTER_PAYMENT_MESSAGE =
  'This bill was changed after it was paid, so how it was paid can no longer be changed. Settle any balance on the Settle screen.';
export const PASS_ISSUED_MESSAGE = `A ${PASS_PROGRAM_NAME} has been issued for this sale — refund it instead.`;
export const GATEWAY_LIVE_MESSAGE =
  'This order is waiting on an online payment — ask the customer to switch to pay at the counter first.';
export const COMPLETED_UNPAY_MESSAGE = 'A completed order stays paid — refund it instead.';

function deadOrderMessage(status: OrderStatus | string | undefined): string {
  return `This order was ${status === 'rejected' ? 'rejected' : 'cancelled'} — there is nothing to settle on it.`;
}

const OK: PaymentCheck = { ok: true };
const fail = (code: PaymentCheckCode, message: string): PaymentCheck => ({ ok: false, code, message });

// --- Guards ------------------------------------------------------------------

/** The order still happened: not cancelled or rejected. */
function alive(f: PaymentFacts): PaymentCheck {
  return isDeadOrder(f.orderStatus) ? fail('dead_order', deadOrderMessage(f.orderStatus)) : OK;
}

/** Leaving the gateway: only an order still gated at 'placed'. */
function stillPlaced(f: PaymentFacts): PaymentCheck {
  return f.orderStatus === undefined || f.orderStatus === 'placed'
    ? OK
    : fail('not_allowed', 'This order is no longer waiting on payment.');
}

/** A counter settle of an order that is waiting on the gateway would let the customer pay twice. */
function noLiveGateway(f: PaymentFacts): PaymentCheck {
  const a = alive(f);
  if (!a.ok) return a;
  return f.gatewayLive ? fail('gateway_live', GATEWAY_LIVE_MESSAGE) : OK;
}

/**
 * Re-recording a paid bill's tenders (or taking it off paid): the order is
 * live, the gateway did not take the money, it is not a HIOC Ritual sale being
 * moved off paid, and the bill was not changed after payment. Same order of
 * checks (and messages) as the payment route has always used.
 */
function counterOwnsPaidBill(toPaid: boolean) {
  return (f: PaymentFacts): PaymentCheck => {
    const a = alive(f);
    if (!a.ok) return a;
    if (f.gatewayOwned) return fail('gateway_owned', GATEWAY_OWNED_MESSAGE);
    if (!toPaid && f.orderKind === 'coffee_pass') return fail('pass_issued', PASS_ISSUED_MESSAGE);
    if (f.changedAfterPayment) return fail('changed_after_payment', CHANGED_AFTER_PAYMENT_MESSAGE);
    if (!toPaid && f.orderStatus === 'completed') return fail('completed', COMPLETED_UNPAY_MESSAGE);
    return OK;
  };
}

/** A comp is the completion of a Ready order, never a payment on its own. */
function compable(f: PaymentFacts): PaymentCheck {
  const a = noLiveGateway(f);
  if (!a.ok) return a;
  return f.orderStatus === undefined || f.orderStatus === 'ready'
    ? OK
    : fail('not_ready', 'Only a Ready order can be comped, as it is completed.');
}

// --- The table ---------------------------------------------------------------

export const PAYMENT_TRANSITIONS: readonly PaymentTransitionRule[] = [
  // (create) → …
  { from: null, to: 'unpaid', via: 'create', actors: ['system', 'counter'], why: 'Pay at the counter (web), or a counter order not settled yet' },
  { from: null, to: 'payment_pending', via: 'create', actors: ['system'], why: 'Online payment first: web online checkout, table QR, a Ritual bought online' },
  { from: null, to: 'paid', via: 'create', actors: ['system', 'counter'], why: 'A ₹0 bill (coupon, points, Ritual cups): nothing to collect' },

  // The gateway takes the money.
  { from: 'payment_pending', to: 'paid', via: 'capture', actors: ['gateway'], why: 'Razorpay captured the payment', guard: alive },
  {
    from: 'unpaid',
    to: 'paid',
    via: 'capture',
    actors: ['gateway'],
    why: 'The customer paid online after switching to the counter (or after the checkout fallback), before the counter collected',
    guard: alive,
  },

  // Leaving the gateway (the open Razorpay order is abandoned with it).
  { from: 'payment_pending', to: 'unpaid', via: 'switch_to_counter', actors: ['customer'], why: 'The customer chose to pay at the counter instead', guard: stillPlaced },
  { from: 'payment_pending', to: 'unpaid', via: 'gateway_unavailable', actors: ['system'], why: 'No payment intent could be made at checkout: pay at the counter', guard: stillPlaced },
  { from: 'payment_pending', to: 'unpaid', via: 'expire', actors: ['system'], why: 'Never paid within the expiry window; the order is cancelled', guard: stillPlaced },
  {
    from: 'payment_pending',
    to: 'unpaid',
    via: 'cancel_placed',
    actors: ['customer', 'counter'],
    why: 'A placed order cancelled before it was paid: it is no longer waiting on the gateway',
    guard: stillPlaced,
  },

  // The counter takes the money.
  { from: 'unpaid', to: 'paid', via: 'settle', actors: ['counter'], why: 'Settled at the till', guard: alive },
  {
    from: 'payment_pending',
    to: 'paid',
    via: 'settle',
    actors: ['counter'],
    why: 'Settled at the till — only when no Razorpay order is still open for it',
    guard: noLiveGateway,
  },
  { from: 'paid', to: 'paid', via: 're_settle', actors: ['counter'], why: 'Change payment: how a counter bill was paid, recorded again', guard: counterOwnsPaidBill(true) },

  // The payment route's other accepted states. No screen sends them; kept
  // because the route's contract has always accepted them.
  { from: 'unpaid', to: 'unpaid', via: 'mark_unpaid', actors: ['counter'], why: 'Records a method on a bill still owed', guard: alive },
  { from: 'payment_pending', to: 'unpaid', via: 'mark_unpaid', actors: ['counter'], why: 'Takes an order off a gateway that has no open payment', guard: noLiveGateway },
  { from: 'paid', to: 'unpaid', via: 'mark_unpaid', actors: ['counter'], why: 'Undoes a counter settle recorded by mistake', guard: counterOwnsPaidBill(false) },
  { from: 'paid', to: 'payment_pending', via: 'mark_pending', actors: ['counter'], why: 'Legacy: takes a counter bill back off paid', guard: counterOwnsPaidBill(false) },
  { from: 'unpaid', to: 'payment_pending', via: 'mark_pending', actors: ['counter'], why: 'Legacy: marks a bill as awaiting payment', guard: alive },
  { from: 'payment_pending', to: 'payment_pending', via: 'mark_pending', actors: ['counter'], why: 'Legacy: no change', guard: alive },

  // Manager write-off at completion (FND3-5).
  { from: 'unpaid', to: 'paid', via: 'comp', actors: ['counter'], permission: 'comp_order', why: 'A manager completes an unpaid Ready order on the house', guard: compable },
  {
    from: 'payment_pending',
    to: 'paid',
    via: 'comp',
    actors: ['counter'],
    permission: 'comp_order',
    why: 'The same, when no Razorpay order is still open for it',
    guard: compable,
  },

  // Refunds (gateway or counter). A refund state is never "unpaid": nothing
  // above leaves one except a further refund.
  { from: 'paid', to: 'partially_refunded', via: 'refund', actors: ['counter'], permission: 'refund', why: 'Part of the money went back' },
  { from: 'paid', to: 'refunded', via: 'refund', actors: ['counter'], permission: 'refund', why: 'All of the money went back' },
  { from: 'partially_refunded', to: 'partially_refunded', via: 'refund', actors: ['counter'], permission: 'refund', why: 'More went back, not all of it' },
  { from: 'partially_refunded', to: 'refunded', via: 'refund', actors: ['counter'], permission: 'refund', why: 'The rest went back' },
];

export function findPaymentTransition(
  from: PaymentStatus | null,
  to: PaymentStatus,
  via: PaymentVia,
): PaymentTransitionRule | undefined {
  return PAYMENT_TRANSITIONS.find((t) => t.from === from && t.to === to && t.via === via);
}

/**
 * Validates a payment move. `{ ok: true, rule }` when legal; otherwise the
 * code and message explaining why (a route maps them to 400/403/409).
 */
export function canTransitionPayment(
  from: PaymentStatus | string | null,
  to: PaymentStatus,
  via: PaymentVia,
  actor: PaymentActor,
  facts: PaymentFacts = {},
): PaymentCheck {
  const rule = findPaymentTransition(from as PaymentStatus | null, to, via);
  if (!rule) {
    // The two refusals a counter most often meets, in the order the payment
    // route has always given them: the gateway's money first, then a refund.
    if (via !== 'refund' && via !== 'capture') {
      if (facts.gatewayOwned) return fail('gateway_owned', GATEWAY_OWNED_MESSAGE);
      if (from !== null && REFUND_PAYMENT_STATUSES.includes(from as PaymentStatus)) {
        return fail('refunded', REFUNDED_MESSAGE);
      }
    }
    return fail('not_allowed', `Illegal payment change ${from ?? '(create)'} → ${to} (${via})`);
  }
  if (!rule.actors.includes(actor)) {
    return { ok: false, code: 'forbidden_actor', message: `A ${actor} may not ${via.replace('_', ' ')} a payment`, rule };
  }
  const g = rule.guard?.(facts);
  if (g && !g.ok) return { ...g, rule };
  return { ok: true, rule };
}

// --- Gateway ownership: ONE predicate ----------------------------------------

/**
 * Whether the payment gateway took this order's money, so the counter must not
 * re-record it, change the bill against it, or hand money back from the drawer
 * against it — it changes only through a refund (M6).
 *
 * The evidence is the order's `payments` rows (lib/payments/evidence.ts loads
 * them on the server). orders.payment_method === 'online' still counts — an
 * older capture, or a netbanking/wallet one, stores exactly that — but it is
 * no longer the ONLY sign: a UPI or card capture stores 'upi' / 'card', which a
 * counter settle also uses, and those bills used to slip through every check.
 *
 * A screen without the rows (it only has the order) passes no evidence and
 * gets the old answer; the server always passes it, so it is the control.
 */
export function gatewayOwnsPayment(
  order: { payment_status: PaymentStatus | string; payment_method?: string | null },
  evidence?: Pick<GatewayEvidence, 'gatewayPaid'> | null,
): boolean {
  if (!MONEY_COLLECTED_STATUSES.includes(order.payment_status as PaymentStatus)) return false;
  return Boolean(evidence?.gatewayPaid) || order.payment_method === 'online';
}

// --- The counter settle (server + screens) ------------------------------------

/** The PATCH /api/orders/[id]/payment operation for a requested target state. */
export function counterSettleVia(from: PaymentStatus | string, to: PaymentStatus): PaymentVia {
  if (to === 'paid') return from === 'paid' ? 're_settle' : 'settle';
  return to === 'unpaid' ? 'mark_unpaid' : 'mark_pending';
}

export interface SettleOrder {
  status: OrderStatus | string;
  payment_status: PaymentStatus | string;
  payment_method?: string | null;
  order_kind?: string | null;
  balance_due_inr?: number | null;
  paid_amended_at?: string | null;
}

function paidChangedAfterPayment(order: SettleOrder): boolean {
  const balance = order.balance_due_inr ?? 0;
  return Boolean(order.paid_amended_at) || (Number.isFinite(balance) && Math.trunc(balance) !== 0);
}

/**
 * Whether the counter may record `to` on this order now — the rule the payment
 * route enforces and every Settle / Change payment button asks.
 *
 * Without evidence (a screen) an order waiting on the gateway is assumed to
 * have a live Razorpay order, and only payment_method 'online' marks a gateway
 * payment; the server passes the real evidence.
 */
export function checkCounterSettle(
  order: SettleOrder,
  to: PaymentStatus,
  evidence?: GatewayEvidence | null,
): PaymentCheck {
  const ev = evidence ?? {
    ...NO_GATEWAY_EVIDENCE,
    gatewayLive: order.payment_status === 'payment_pending',
  };
  return canTransitionPayment(order.payment_status, to, counterSettleVia(order.payment_status, to), 'counter', {
    orderStatus: order.status,
    orderKind: order.order_kind,
    gatewayOwned: gatewayOwnsPayment(order, ev),
    gatewayLive: ev.gatewayLive,
    changedAfterPayment: order.payment_status === 'paid' && paidChangedAfterPayment(order),
  });
}

/**
 * An order still owed at the counter: unpaid and live. An order waiting on the
 * gateway is not — settling it at the counter could charge twice (the server
 * allows it only once no Razorpay order is open for it).
 */
export function canSettleAtCounter(order: SettleOrder, evidence?: GatewayEvidence | null): boolean {
  if (order.payment_status !== 'unpaid' && order.payment_status !== 'payment_pending') return false;
  return checkCounterSettle(order, 'paid', evidence).ok;
}

/** A paid counter bill whose tenders may be recorded again (cash → UPI…). */
export function canReSettle(order: SettleOrder, evidence?: GatewayEvidence | null): boolean {
  return order.payment_status === 'paid' && checkCounterSettle(order, 'paid', evidence).ok;
}

// --- Capture -----------------------------------------------------------------

export type CaptureDisposition =
  | { kind: 'capture' }
  | { kind: 'orphan'; reason: 'dead_order' | 'paid_elsewhere' | 'refunded' | 'not_allowed' };

/**
 * What a gateway capture may do to the café order it was minted for. Normally
 * mark it paid. But the money can land after the order stopped waiting for it
 * — cancelled (by the customer, a manager or the expiry sweep), paid at the
 * counter after switching, or refunded — and then marking it paid would issue
 * a pass on a cancelled sale, or overwrite the counter's cash with 'upi' (the
 * drawer would lose it). Such a capture is an ORPHAN: the payments row records
 * the money (lib/payments/paymentRowStateMachine.ts ORPHAN_CAPTURE_NOTE), the
 * order is left alone, and the refund route can give it back.
 */
export function captureDisposition(order: { status: OrderStatus | string; payment_status: PaymentStatus | string }): CaptureDisposition {
  const check = canTransitionPayment(order.payment_status, 'paid', 'capture', 'gateway', { orderStatus: order.status });
  if (check.ok) return { kind: 'capture' };
  if (check.code === 'dead_order') return { kind: 'orphan', reason: 'dead_order' };
  if (order.payment_status === 'paid') return { kind: 'orphan', reason: 'paid_elsewhere' };
  if (REFUND_PAYMENT_STATUSES.includes(order.payment_status as PaymentStatus)) return { kind: 'orphan', reason: 'refunded' };
  return { kind: 'orphan', reason: 'not_allowed' };
}

// --- Refunds -----------------------------------------------------------------

/** The order's payment status once `refundedInr` of the `takenInr` collected has gone back. */
export function paymentStatusAfterRefund(takenInr: number, refundedInr: number): PaymentStatus {
  if (refundedInr >= takenInr) return 'refunded';
  return refundedInr > 0 ? 'partially_refunded' : 'paid';
}

/** An order the refund route can take money back from: collected, not all of it back yet. */
export function isRefundable(paymentStatus: PaymentStatus | string): boolean {
  return paymentStatus === 'paid' || paymentStatus === 'partially_refunded';
}

// --- Online payment (the customer's order page) ------------------------------

/**
 * Whether the customer may (re)try paying this order online: it is live and
 * not paid. A cancelled order must never be handed a Razorpay order to pay —
 * the money would land on nothing.
 */
export function canPayOnline(order: { status: OrderStatus | string; payment_status: PaymentStatus | string }): boolean {
  if (isDeadOrder(order.status) || order.status === 'completed') return false;
  return order.payment_status === 'payment_pending' || order.payment_status === 'unpaid';
}
