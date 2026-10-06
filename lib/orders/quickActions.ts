// What the corner button and the "⋯" menu on a live-order card offer, per
// order. Pure, so the card, the workspace handler and the tests share one
// definition — and derived from the state machine's TRANSITIONS table, so a
// move the server would refuse is never put in front of staff.
//
// Corner button = the ONE obvious next step, done in a single tap. The menu
// holds everything else that is legal from the current status.

import { PRIMARY_NEXT, STATUS_LABELS, TRANSITIONS, type TransitionRule } from '@/lib/orders/stateMachine';
import { isSettleable } from '@/lib/orders/settleList';
import type { Order, OrderStatus } from '@/lib/types';

export type QuickActionKind =
  // Move the order to `to` right now (optimistic, no dialog).
  | 'transition'
  // Unpaid at Ready: open the payment dialog first; Complete appears once paid.
  | 'settle'
  // Needs more input than a tap (a reject reason, a pickup-code check): open the
  // detail view, straight into `detail` when set.
  | 'open_detail';

export interface QuickAction {
  key: string;
  label: string;
  kind: QuickActionKind;
  to?: OrderStatus;
  tone: 'primary' | 'complete' | 'neutral' | 'danger';
  // New → Accept: send the store's default prep time as promised_ready_at, the
  // same value the detail view's Confirm Accept sends.
  usesDefaultPrep?: boolean;
  // A destructive move asks "are you sure?" first (the menu sits next to the
  // corner button, so a slip must not cancel an order).
  confirm?: string;
  // Only a manager/owner may do this (the server enforces it; this only labels
  // it so staff are not surprised by a 403).
  managerOnly?: boolean;
  // open_detail only: which panel the detail view opens on.
  detail?: 'reject';
}

export interface QuickActions {
  corner: QuickAction | null;
  menu: QuickAction[];
}

type QuickActionOrder = Pick<Order, 'status' | 'payment_status'>;

const CORNER_LABEL: Partial<Record<OrderStatus, string>> = {
  received: 'Accept',
  accepted: 'Start',
  preparing: 'Ready',
  ready: 'Complete',
};

// Anyone at the counter may act as 'staff'; 'owner' inherits staff. A rule that
// names neither (customer/system-only) is not for the live board at all.
function staffMayDo(rule: TransitionRule): boolean {
  return rule.actors.includes('staff') || rule.actors.includes('owner');
}

function cornerFor(order: QuickActionOrder): QuickAction | null {
  const next = PRIMARY_NEXT[order.status];
  const label = CORNER_LABEL[order.status];
  if (!next || !label) return null;

  if (order.status === 'ready') {
    if (order.payment_status === 'paid') {
      return { key: 'complete', label, kind: 'transition', to: next, tone: 'complete' };
    }
    // The server refuses to complete an unpaid order, so a Complete tap would
    // only bounce. Unpaid → collect first; anything else (payment_pending,
    // refunded…) is not a counter settle, so hand it to the detail view.
    return isSettleable(order)
      ? { key: 'settle', label: 'Settle', kind: 'settle', tone: 'primary' }
      : { key: 'details', label: 'Details', kind: 'open_detail', tone: 'primary' };
  }

  return {
    key: order.status === 'received' ? 'accept' : `to-${next}`,
    label,
    kind: 'transition',
    to: next,
    tone: 'primary',
    usesDefaultPrep: order.status === 'received',
  };
}

/**
 * The corner action and the "⋯" menu for an order. `rules` is injectable so the
 * menu's derivation can be tested against a table with an extra transition.
 */
export function quickActionsFor(
  order: QuickActionOrder,
  rules: readonly TransitionRule[] = TRANSITIONS,
): QuickActions {
  const corner = cornerFor(order);
  if (!corner) return { corner: null, menu: [] };

  const menu: QuickAction[] = [];
  const out = rules.filter((r) => r.from === order.status && staffMayDo(r));

  // Every other legal forward move (e.g. skipping a step, if the state machine
  // ever allows it). Derived, not listed, so it can't drift from the server.
  for (const r of out) {
    if (r.to === 'rejected' || r.to === 'cancelled' || r.to === PRIMARY_NEXT[order.status]) continue;
    menu.push({
      key: `to-${r.to}`,
      label: `Mark ${STATUS_LABELS[r.to]}`,
      kind: 'transition',
      to: r.to,
      tone: 'neutral',
    });
  }

  if (order.status === 'ready') {
    // Handover with the pickup-code check — the corner Complete skips it.
    menu.push({ key: 'verify', label: 'Verify pickup code…', kind: 'open_detail', tone: 'neutral' });
  }

  if (out.some((r) => r.to === 'rejected')) {
    // A reject needs a reason, so it goes to the detail view's reject panel.
    menu.push({
      key: 'reject',
      label: 'Reject…',
      kind: 'open_detail',
      detail: 'reject',
      tone: 'danger',
    });
  } else {
    // A New order is rejected, not cancelled (same outcome, and Reject is what
    // the customer is told); every later status offers Cancel.
    const cancel = out.find((r) => r.to === 'cancelled');
    if (cancel) {
      const managerOnly = !cancel.actors.includes('staff');
      menu.push({
        key: 'cancel',
        label: managerOnly ? 'Cancel order (manager)' : 'Cancel order',
        kind: 'transition',
        to: 'cancelled',
        tone: 'danger',
        confirm: 'Cancel this order?',
        managerOnly,
      });
    }
  }

  return { corner, menu };
}

/**
 * The extra body fields a transition action sends with the status change:
 * the default-prep ETA for a one-tap Accept, the standard reason for a Cancel.
 */
export function transitionExtra(
  action: QuickAction,
  defaultPrepMin: number,
  nowMs: number,
): { reason?: string; promised_ready_at?: string } | undefined {
  if (action.usesDefaultPrep) {
    return { promised_ready_at: new Date(nowMs + defaultPrepMin * 60_000).toISOString() };
  }
  if (action.to === 'cancelled') return { reason: 'Cancelled by staff' };
  return undefined;
}

/**
 * Whether a "Send pickup reminder" makes sense for this order: a Ready pickup
 * order with a phone number to send to. (Dine-in at a table is served there;
 * the server refuses it too. A website dine-in has no table and is collected.)
 */
export function canRemind(
  order: Pick<Order, 'status' | 'customer_phone' | 'order_type' | 'table_id'>,
): boolean {
  const servedAtTable = order.order_type === 'dine_in' && Boolean(order.table_id);
  return order.status === 'ready' && !servedAtTable && Boolean(order.customer_phone?.trim());
}
