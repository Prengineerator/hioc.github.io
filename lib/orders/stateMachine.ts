// Order state machine (F1 / XC-041) — the single source of truth for which
// lifecycle transitions are legal, who may perform them, and what each one
// requires. Both the transition API (app/api/orders/[id]/status) and the UIs
// import from here so the rules can never drift between server and client.
//
// Spec: docs/PHASE-1-SPEC.md §F1.

import type { ActorRole, NotificationEvent, OrderStatus, OrderType, PaymentStatus } from '@/lib/types';

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  'completed',
  'rejected',
  'cancelled',
];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// The two terminal states in which the order never happened: nothing is owed
// on it, nothing on it can be settled, changed or counted as money received.
// Every "not a dead order" check (settle lists, balances, received money, the
// bill, the booking-ID clash, the payment machine) asks this one function.
export const DEAD_STATUSES: readonly OrderStatus[] = ['cancelled', 'rejected'];

export function isDeadOrder(status: OrderStatus | string | null | undefined): boolean {
  return DEAD_STATUSES.includes(status as OrderStatus);
}

// An OPEN order: accepted and not yet finished — still on the rail, so its bill
// can still be changed (a line voided or lowered, items added) and a dine-in
// one still holds its table. Not ACTIVE_LANES: a 'received' order hasn't been
// accepted yet (it is accepted or rejected, not amended), and a staff dine-in
// order is created 'accepted' and never enters 'received'. The amend route's
// own list is the same three; every screen that decides what to OFFER on an
// open order asks this, so they can't drift from each other.
export const OPEN_STATUSES: readonly OrderStatus[] = ['accepted', 'preparing', 'ready'];

export function isOpenOrder(status: OrderStatus | string | null | undefined): boolean {
  return OPEN_STATUSES.includes(status as OrderStatus);
}

/**
 * The payment states in which the money for an order has been COLLECTED —
 * whether or not some or all of it has since gone back. This is what the
 * ready → completed guard means by "settled": the risk it guards against is
 * an order handed over with the money never collected, and a refund is not
 * that. (Before, a part- or fully-refunded open order could never complete:
 * the only way out was a manager comp, which wiped the refund marker by
 * writing 'paid' over it.) lib/orders/paymentStateMachine.ts re-exports it.
 */
export const MONEY_COLLECTED_STATUSES: readonly PaymentStatus[] = ['paid', 'partially_refunded', 'refunded'];

// Actors permitted to drive an order. 'system' performs the implicit
// (create)→received transition; 'owner' inherits every staff permission
// (OWN-002) plus the manager cancel override.
type TransitionActor = ActorRole;

// Extra order facts a guard may consult to decide a transition (FND3-5). All
// optional so pure state-machine callers (the UIs, most tests) can omit it —
// only the settlement guard needs them.
export interface TransitionContext {
  /**
   * The operation asking, for a rule that only exists inside one (`onlyVia`).
   * The status route never sets it, so such a rule is never a standalone move.
   */
  via?: TransitionVia;
  orderType?: OrderType;
  paymentStatus?: PaymentStatus;
  isComp?: boolean;
  /**
   * What is still owed on a paid bill changed after it was paid
   * (orders.balance_due_inr, lib/orders/paidChange.ts). Absent / ≤ 0 = nothing
   * owed: a balance the café owes BACK never holds an order.
   */
  balanceDueInr?: number;
}

// Operations that move an order's status as a side effect of something else.
//   'add_items'  POST /api/orders/[id]/amend { op: 'add' } (lib/orders/amend.ts
//                statusAfterAdd): new items on a Ready order have to be made.
export type TransitionVia = 'add_items';

const VIA_LABEL: Record<TransitionVia, string> = { add_items: 'items are added to the order' };

export interface TransitionRule {
  // `null` = a create/entry transition (there is no prior status). FND3-3/5
  // moved order entry into the table so the machine — not the route — owns it.
  from: OrderStatus | null;
  to: OrderStatus;
  actors: readonly TransitionActor[];
  /**
   * Only legal as part of this operation, never as a status change on its own
   * (canTransition refuses it unless `context.via` matches, and the live
   * board's menu never offers it). Lets the table say truthfully what the
   * amend route already does without opening a "move it back" button.
   */
  onlyVia?: TransitionVia;
  requiresReason?: boolean;
  // Which customer notification (if any) fires on this transition (F4).
  notify?: NotificationEvent;
  // Optional business-rule guard evaluated AFTER the actor + reason checks
  // (FND3-5, e.g. dine-in must be settled before it completes). Returns
  // `{ ok: false, code, message }` to block with a specific reason.
  guard?: (ctx: TransitionContext) => { ok: boolean; code?: string; message?: string };
}

// The allowed-transitions table from docs/PHASE-1-SPEC.md §F1. Anything not
// listed here is a 409. Staff permissions are automatically granted to owner
// (see canTransition) so rules only ever name 'staff' where owner also applies.
export const TRANSITIONS: readonly TransitionRule[] = [
  // (create) → … — machine-owned entry points (FND3-3/5). `system` seeds the
  // web/online lifecycle; `accepted` is the staff/POS dine-in create that skips
  // 'received' (owner/manager inherit the staff rule via actorSatisfies).
  { from: null, to: 'received', actors: ['system'] },
  { from: null, to: 'placed', actors: ['system'] },
  { from: null, to: 'accepted', actors: ['staff'] },
  // received → …
  { from: 'received', to: 'accepted', actors: ['staff'], notify: 'accepted' },
  { from: 'received', to: 'rejected', actors: ['staff'], requiresReason: true, notify: 'rejected' },
  { from: 'received', to: 'cancelled', actors: ['customer', 'staff'], requiresReason: true, notify: 'cancelled' },
  // accepted → …
  { from: 'accepted', to: 'preparing', actors: ['staff'] },
  { from: 'accepted', to: 'cancelled', actors: ['staff'], requiresReason: true, notify: 'cancelled' },
  // preparing → …
  { from: 'preparing', to: 'ready', actors: ['staff'], notify: 'ready' },
  { from: 'preparing', to: 'cancelled', actors: ['owner'], requiresReason: true, notify: 'cancelled' },
  // ready → …
  {
    from: 'ready',
    to: 'completed',
    actors: ['staff'],
    // FND3-5 / POS-2: an order must be settled before it can complete —
    // payment_status 'paid', or an explicit manager comp (isComp). This used to
    // cover dine-in only, so an unpaid takeaway or pay-at-counter web order
    // could be completed with the money never collected. A context-free call
    // (how the UIs ask "is this a legal move?") has no payment facts and is
    // left to the server, which always passes them.
    //
    // A paid bill changed afterwards that still has money owed on it is held
    // the same way: completing it would let the table leave without paying the
    // difference. Collect it, or let it go with a reason, on Settle.
    //
    // "Settled" is MONEY_COLLECTED_STATUSES: paid, or paid and then part or
    // fully refunded — the money was collected, so nothing is left to collect.
    guard: (ctx) => {
      if (
        !(
          ctx.paymentStatus === undefined ||
          MONEY_COLLECTED_STATUSES.includes(ctx.paymentStatus) ||
          !!ctx.isComp
        )
      ) {
        return { ok: false, code: 'payment_required', message: 'Collect payment before completing this order' };
      }
      if ((ctx.balanceDueInr ?? 0) > 0 && !ctx.isComp) {
        return {
          ok: false,
          code: 'payment_required',
          message: `Collect the ₹${ctx.balanceDueInr} balance before completing this order`,
        };
      }
      return { ok: true };
    },
  },
  // A ready order nobody collects can be cancelled by a manager (H4) rather
  // than wrongly force-completed (which would earn loyalty on an uncollected order).
  { from: 'ready', to: 'cancelled', actors: ['owner'], requiresReason: true, notify: 'cancelled' },
  // Items added to a Ready order (TAB-1): they have to be made, so it goes back
  // to Preparing and can't be handed over without them. Only as part of the
  // add (onlyVia) — the amend route has always done this; the table now says so.
  { from: 'ready', to: 'preparing', actors: ['staff'], onlyVia: 'add_items' },
  // 'placed' = online-payment order not yet captured. System promotes it to
  // 'received' on capture (or when the gateway is unavailable at checkout); the
  // CUSTOMER moves it there by switching to pay at the counter (PAY-2) — the
  // event log has always attributed that one to them. The customer may abandon
  // it, and a manager (or the auto-expiry sweep) may cancel it (H4/H5).
  { from: 'placed', to: 'received', actors: ['system', 'customer'] },
  { from: 'placed', to: 'cancelled', actors: ['owner', 'customer', 'system'], requiresReason: true, notify: 'cancelled' },
];

// owner can do anything staff can (OWN-002) — expand actor sets accordingly.
function actorSatisfies(rule: TransitionRule, actorRole: TransitionActor): boolean {
  if (rule.actors.includes(actorRole)) return true;
  // owner inherits every 'staff' rule.
  if (actorRole === 'owner' && rule.actors.includes('staff')) return true;
  return false;
}

export function findTransition(
  from: OrderStatus | null,
  to: OrderStatus,
): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export interface TransitionCheck {
  ok: boolean;
  code?: 'not_allowed' | 'forbidden_actor' | 'reason_required' | 'payment_required';
  message?: string;
  rule?: TransitionRule;
}

/**
 * Validates a requested transition against the state machine. Returns
 * `{ ok: true, rule }` when legal, or `{ ok: false, code, message }`
 * describing exactly why it was rejected (used to pick 409 vs 403 vs 400).
 */
export function canTransition(
  from: OrderStatus | null,
  to: OrderStatus,
  actorRole: TransitionActor,
  reason?: string,
  context?: TransitionContext,
): TransitionCheck {
  const rule = findTransition(from, to);
  if (!rule) {
    return {
      ok: false,
      code: 'not_allowed',
      message: `Illegal transition ${from} → ${to}`,
    };
  }
  if (!actorSatisfies(rule, actorRole)) {
    return {
      ok: false,
      code: 'forbidden_actor',
      message: `A ${actorRole} may not perform ${from} → ${to}`,
      rule,
    };
  }
  if (rule.onlyVia && context?.via !== rule.onlyVia) {
    return {
      ok: false,
      code: 'not_allowed',
      message: `${from} → ${to} only happens when ${VIA_LABEL[rule.onlyVia]}`,
      rule,
    };
  }
  if (rule.requiresReason && (!reason || reason.trim().length === 0)) {
    return {
      ok: false,
      code: 'reason_required',
      message: `Transition ${from} → ${to} requires a reason`,
      rule,
    };
  }
  const g = rule.guard?.(context ?? {});
  if (g && !g.ok) {
    return { ok: false, code: g.code as TransitionCheck['code'], message: g.message, rule };
  }
  return { ok: true, rule };
}

// ---- UI helpers (safe to import into client components) --------------------

// The lanes the staff board groups active orders into (S1), in flow order.
export const ACTIVE_LANES: readonly OrderStatus[] = [
  'received',
  'accepted',
  'preparing',
  'ready',
];

// The primary forward action a staff member takes from each status, for the
// single-tap "advance" button on a card. Reject/cancel are separate actions.
export const PRIMARY_NEXT: Partial<Record<OrderStatus, OrderStatus>> = {
  received: 'accepted',
  accepted: 'preparing',
  preparing: 'ready',
  ready: 'completed',
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  placed: 'Placed',
  received: 'New',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

// The customer-facing progress track (C1). Terminal negative states are shown
// separately, not as a step on this track.
export const CUSTOMER_PROGRESS: readonly OrderStatus[] = [
  'received',
  'accepted',
  'preparing',
  'ready',
  'completed',
];
