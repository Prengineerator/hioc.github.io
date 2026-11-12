// The order detail's own state machine (components/staff/OrderDetailModal.tsx),
// and what it offers, derived from the order and payment state machines.
//
// The modal used to hold a `mode` string beside four separate busy flags
// (refund, void, comp, the dining-app settle) — and the quick Cash / UPI / Card
// settle had none at all: it printed the receipt and opened the drawer BEFORE
// the payment was recorded, fire-and-forget, with its buttons live, so a double
// tap sent two PATCHes and printed two receipts, and a settle the server
// refused had already printed one. Now it is ONE state:
//
//   panel     which step is on screen: view | accept | reject | refund | void
//             | comp | appRef
//   inFlight  the ONE request out (transition | settle | app_settle | refund |
//             void | comp), or null
//
// A panel opens only from the plain view with nothing in flight; an action
// starts only from its own panel(s) with nothing in flight (ACTION_RULES); its
// answer — succeeded, failed, or stale (the order moved on: 409 stale_version)
// — clears inFlight and moves the panel as the table says. Pure, so the whole
// table is unit-tested; the modal keeps only wiring.
//
// What the modal OFFERS comes from the machines the server enforces, not local
// lists: the order's open-ness and Cancel from lib/orders/stateMachine.ts (for
// the signed-in role — staff can't cancel a Preparing order, a manager can),
// and settle / change payment / refund / comp from lib/orders/paymentStateMachine.ts.

import { canTransition } from '@/lib/orders/stateMachine';
import {
  canReSettle,
  canSettleAtCounter,
  canTransitionPayment,
  checkCounterSettle,
  isRefundable,
  type SettleOrder,
} from '@/lib/orders/paymentStateMachine';
import { balanceOf } from '@/lib/orders/paidChange';
import { quickActionsFor } from '@/lib/orders/quickActions';
import { RITUAL_SALE_LABEL, isRitualSale } from '@/lib/pos/ritual';
import type { Order, OrderStatus, PaymentMethod, PaymentStatus, UserRole } from '@/lib/types';

// --- Who is asking -----------------------------------------------------------

/** The order machine's actor for a counter role: a manager acts with the owner's order powers. */
export type CounterActor = 'staff' | 'owner';

/**
 * Same mapping as the status route (lib/api/auth.ts actorRoleFor, which is
 * server-only). Unknown (no shell, a preview) = plain staff: offer the least.
 */
export function counterActor(role: UserRole | null | undefined): CounterActor {
  return role === 'owner' || role === 'manager' ? 'owner' : 'staff';
}

// --- The machine ---------------------------------------------------------------

export const DETAIL_PANELS = ['view', 'accept', 'reject', 'refund', 'void', 'comp', 'appRef'] as const;
export type DetailPanel = (typeof DETAIL_PANELS)[number];

export const DETAIL_ACTIONS = ['transition', 'settle', 'app_settle', 'refund', 'void', 'comp'] as const;
export type DetailAction = (typeof DETAIL_ACTIONS)[number];

export interface ActionRule {
  /** The panels the action can be started from. */
  from: readonly DetailPanel[];
  /** Where the modal goes once the server has taken it. */
  onSuccess: DetailPanel;
}

/**
 * Each action, where it may start, and where it lands. A failure stays on the
 * panel it started from (the staffer reads the error and tries again or goes
 * Back); a stale answer goes back to the plain view — the order changed, so
 * look at it again rather than repeat the step.
 */
export const ACTION_RULES: Readonly<Record<DetailAction, ActionRule>> = {
  // Accept (with the ETA), Reject (with a reason), the forward step, Complete, Cancel.
  transition: { from: ['view', 'accept', 'reject'], onSuccess: 'view' },
  // A one-tap Cash / UPI / Card settle of the whole bill.
  settle: { from: ['view'], onSuccess: 'view' },
  // A dining-app settle, once its booking ID is typed.
  app_settle: { from: ['appRef'], onSuccess: 'view' },
  refund: { from: ['refund'], onSuccess: 'view' },
  void: { from: ['void'], onSuccess: 'view' },
  comp: { from: ['comp'], onSuccess: 'view' },
};

export interface DetailState {
  panel: DetailPanel;
  inFlight: DetailAction | null;
  /** The line the void panel is about. */
  voidItemId: string | null;
  /** The dining app the booking-ID panel settles with. */
  appMethod: PaymentMethod | null;
  /** Why the last dining-app settle was not recorded. */
  appError: string | null;
}

export type DetailEvent =
  | { type: 'open'; panel: Exclude<DetailPanel, 'view'>; itemId?: string; method?: PaymentMethod }
  | { type: 'back' }
  | { type: 'start'; action: DetailAction }
  | { type: 'succeeded' }
  | { type: 'failed'; error?: string }
  | { type: 'stale' }
  /** The booking ID is being retyped: the last refusal no longer applies. */
  | { type: 'edit' };

const VIEW: DetailState = { panel: 'view', inFlight: null, voidItemId: null, appMethod: null, appError: null };

/** Where the modal starts: straight on Reject when asked (a card's "Reject…") and the order can be. */
export function initialDetailState(initialMode: 'reject' | undefined, status: OrderStatus): DetailState {
  return initialMode === 'reject' && status === 'received' ? { ...VIEW, panel: 'reject' } : VIEW;
}

/** The next state, or the SAME object when the event is refused (that is the guard). */
export function detailReducer(state: DetailState, event: DetailEvent): DetailState {
  switch (event.type) {
    case 'open': {
      if (state.inFlight !== null || state.panel !== 'view') return state;
      if (event.panel === 'void' && !event.itemId) return state;
      if (event.panel === 'appRef' && !event.method) return state;
      return {
        ...VIEW,
        panel: event.panel,
        voidItemId: event.panel === 'void' ? (event.itemId ?? null) : null,
        appMethod: event.panel === 'appRef' ? (event.method ?? null) : null,
      };
    }
    case 'back':
      if (state.inFlight !== null || state.panel === 'view') return state;
      return VIEW;
    case 'start': {
      if (state.inFlight !== null) return state;
      if (!ACTION_RULES[event.action].from.includes(state.panel)) return state;
      return { ...state, inFlight: event.action, appError: null };
    }
    case 'succeeded': {
      if (state.inFlight === null) return state;
      const to = ACTION_RULES[state.inFlight].onSuccess;
      return to === 'view' ? VIEW : { ...state, panel: to, inFlight: null };
    }
    case 'failed': {
      if (state.inFlight === null) return state;
      return {
        ...state,
        inFlight: null,
        appError: state.inFlight === 'app_settle' ? (event.error ?? null) : state.appError,
      };
    }
    case 'stale':
      if (state.inFlight === null) return state;
      return VIEW;
    case 'edit':
      if (state.appError === null) return state;
      return { ...state, appError: null };
    default:
      return state;
  }
}

export function isDetailBusy(state: DetailState): boolean {
  return state.inFlight !== null;
}

/**
 * How a request the parent made for the modal ended. `void` (a parent that
 * doesn't say) reads as 'done' — what the modal always assumed.
 */
export type DetailOutcome = 'done' | 'failed' | 'stale';

export function outcomeEvent(outcome: DetailOutcome | boolean | void | undefined): DetailEvent {
  if (outcome === 'stale') return { type: 'stale' };
  if (outcome === 'failed' || outcome === false) return { type: 'failed' };
  return { type: 'succeeded' };
}

// --- What the detail offers ------------------------------------------------------

export type DetailOrder = SettleOrder &
  Pick<Order, 'status' | 'payment_status'> &
  Partial<Pick<Order, 'balance_due_inr' | 'paid_amended_at' | 'payment_method' | 'order_kind'>>;

/** The reason a staff Cancel sends (the same one the board's Cancel sends). */
export const CANCEL_REASON = 'Cancelled by staff';

export interface CancelOffer {
  label: string;
  /** Asked before the order is cancelled — the board's "⋯ → Cancel" asks the same. */
  confirm: string;
}

/**
 * The Cancel button, or null. Offered only when the order machine allows THIS
 * actor the move (a Preparing order: owner/manager only — staff used to be
 * offered it and always met a 403). A New order is rejected (with a reason),
 * not cancelled, and a Ready one is completed or comped here, so neither gets
 * it; a HIOC Ritual sale may be cancelled only while nothing is paid on it.
 */
export function cancelOffer(order: DetailOrder, actor: CounterActor): CancelOffer | null {
  if (!canTransition(order.status, 'cancelled', actor, CANCEL_REASON).ok) return null;
  if (isRitualSale(order)) {
    if (!canSettleAtCounter(order)) return null;
    return { label: 'Cancel sale', confirm: `Cancel this ${RITUAL_SALE_LABEL}? The customer hasn’t paid for it yet.` };
  }
  if (order.status === 'received' || order.status === 'ready') return null;
  const cancel = quickActionsFor(order).menu.find((a) => a.to === 'cancelled');
  if (!cancel?.confirm) return null;
  return { label: 'Cancel order', confirm: cancel.confirm };
}

export interface PaymentOffers {
  /** The one-tap method buttons (the whole bill). */
  quickSettle: boolean;
  /** "Split or cash with change…" — the full payment step. */
  split: boolean;
  /** "Change payment" — a paid counter bill's tenders recorded again. */
  changePayment: boolean;
  refund: boolean;
  /** "Comp (₹0, manager)" on a Ready order not yet paid. */
  comp: boolean;
  /** Why a bill that still reads unpaid can't be settled here (waiting on the gateway). */
  settleRefusal: string | null;
}

/**
 * The payment buttons, from the payment state machine's own rules — the ones
 * PATCH /api/orders/[id]/payment, the refund route and the comp enforce — so
 * the detail never offers what the server refuses: no settle on a cancelled
 * order, on one waiting on an online payment, or on a refunded one (each used
 * to show the Cash / UPI / Card row).
 */
export function paymentOffers(order: DetailOrder): PaymentOffers {
  const settle = canSettleAtCounter(order);
  const owed = order.payment_status === 'unpaid' || order.payment_status === 'payment_pending';
  const refusal = !settle && owed ? checkCounterSettle(order, 'paid') : null;
  return {
    quickSettle: settle,
    split: settle,
    changePayment: canReSettle(order),
    refund: isRefundable(order.payment_status),
    comp:
      order.status === 'ready' &&
      canTransitionPayment(order.payment_status, 'paid', 'comp', 'counter', {
        orderStatus: order.status,
        // A screen has only the order: one waiting on the gateway is assumed to
        // have a live Razorpay order (the server knows for sure).
        gatewayLive: order.payment_status === 'payment_pending',
      }).ok,
    settleRefusal: refusal && !refusal.ok && refusal.code === 'gateway_live' ? (refusal.message ?? null) : null,
  };
}

/** What a Ready order's handover panel asks for next. */
export type ReadyStep =
  /** Settled (paid, or paid then refunded) with nothing owed: complete it. */
  | 'complete'
  /** A paid bill changed afterwards with more owed: collect (or let go of) the balance first. */
  | 'collect_balance'
  /** Unpaid: collect the money first. */
  | 'settle'
  /** Waiting on an online payment the counter can't take over. */
  | 'waiting';

/**
 * The ready → completed guard of the order machine, asked with the facts this
 * screen has — the same question the board's corner button asks — instead of
 * "is payment_status 'paid'?" (which put the Cash / UPI / Card row on a
 * refunded order the server would complete as it is).
 */
export function readyStep(order: DetailOrder, actor: CounterActor): ReadyStep {
  const balance = order.payment_status === 'paid' ? balanceOf(order) : 0;
  const complete = canTransition('ready', 'completed', actor, undefined, {
    paymentStatus: order.payment_status as PaymentStatus,
    balanceDueInr: balance,
  });
  if (complete.ok) return 'complete';
  if (order.payment_status === 'paid' && balance > 0) return 'collect_balance';
  return canSettleAtCounter(order) ? 'settle' : 'waiting';
}
