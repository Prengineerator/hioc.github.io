// Order state machine (F1 / XC-041) — the single source of truth for which
// lifecycle transitions are legal, who may perform them, and what each one
// requires. Both the transition API (app/api/orders/[id]/status) and the UIs
// import from here so the rules can never drift between server and client.
//
// Spec: docs/PHASE-1-SPEC.md §F1.

import type { ActorRole, NotificationEvent, OrderStatus } from '@/lib/types';

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  'completed',
  'rejected',
  'cancelled',
];

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// Actors permitted to drive an order. 'system' performs the implicit
// (create)→received transition; 'owner' inherits every staff permission
// (OWN-002) plus the manager cancel override.
type TransitionActor = ActorRole;

export interface TransitionRule {
  from: OrderStatus;
  to: OrderStatus;
  actors: readonly TransitionActor[];
  requiresReason?: boolean;
  // Which customer notification (if any) fires on this transition (F4).
  notify?: NotificationEvent;
}

// The allowed-transitions table from docs/PHASE-1-SPEC.md §F1. Anything not
// listed here is a 409. Staff permissions are automatically granted to owner
// (see canTransition) so rules only ever name 'staff' where owner also applies.
export const TRANSITIONS: readonly TransitionRule[] = [
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
  { from: 'ready', to: 'completed', actors: ['staff'] },
  // 'placed' is reserved for Phase-2 online payment; wire the gate here later.
  { from: 'placed', to: 'received', actors: ['system'] },
];

// owner can do anything staff can (OWN-002) — expand actor sets accordingly.
function actorSatisfies(rule: TransitionRule, actorRole: TransitionActor): boolean {
  if (rule.actors.includes(actorRole)) return true;
  // owner inherits every 'staff' rule.
  if (actorRole === 'owner' && rule.actors.includes('staff')) return true;
  return false;
}

export function findTransition(
  from: OrderStatus,
  to: OrderStatus,
): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export interface TransitionCheck {
  ok: boolean;
  code?: 'not_allowed' | 'forbidden_actor' | 'reason_required';
  message?: string;
  rule?: TransitionRule;
}

/**
 * Validates a requested transition against the state machine. Returns
 * `{ ok: true, rule }` when legal, or `{ ok: false, code, message }`
 * describing exactly why it was rejected (used to pick 409 vs 403 vs 400).
 */
export function canTransition(
  from: OrderStatus,
  to: OrderStatus,
  actorRole: TransitionActor,
  reason?: string,
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
  if (rule.requiresReason && (!reason || reason.trim().length === 0)) {
    return {
      ok: false,
      code: 'reason_required',
      message: `Transition ${from} → ${to} requires a reason`,
      rule,
    };
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
