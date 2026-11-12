// The customer order page's own state (app/order/[id]/page.tsx). Pure, so it
// is unit-tested without a renderer (a page.tsx may only export Next's route
// names, so this lives beside it).
//
// 1. The customer's action. One at a time:
//
//      idle ──Retry payment──▶ retrying ──intent──▶ paying ──window closed──▶ idle
//                                  └──refused / network error──────────────▶ idle
//      idle ──Switch to pay at counter──▶ switching ──▶ idle
//      idle ──Cancel order──▶ cancelling ──▶ idle
//
//    It was three booleans. Retry and "Switch to pay at counter" each guarded
//    only themselves, so both could run at once (a payment window open on an
//    order being moved to the counter), and `paying` was cleared the moment the
//    window opened, so Retry came back to life under it.
//
// 2. The payment poll. While an online payment is pending the page asks the
//    server to check with the gateway (the webhook can be late). It used to
//    stop for good after ~2 minutes while the page kept saying "this updates
//    automatically". Now it keeps going, slower, for half an hour, and after
//    that the page says to refresh.

export const ORDER_PAGE_ACTIONS = ['idle', 'retrying', 'paying', 'switching', 'cancelling'] as const;
export type OrderPageAction = (typeof ORDER_PAGE_ACTIONS)[number];

export const ORDER_PAGE_ACTION_TRANSITIONS: readonly { from: OrderPageAction; to: OrderPageAction }[] = [
  { from: 'idle', to: 'retrying' },
  { from: 'retrying', to: 'paying' },
  { from: 'retrying', to: 'idle' },
  { from: 'paying', to: 'idle' },
  { from: 'idle', to: 'switching' },
  { from: 'switching', to: 'idle' },
  { from: 'idle', to: 'cancelling' },
  { from: 'cancelling', to: 'idle' },
];

export interface ActionCheck {
  ok: boolean;
  code: 'ok' | 'action_in_flight' | 'illegal_transition';
  message: string;
}

export function canActionTransition(from: OrderPageAction, to: OrderPageAction): ActionCheck {
  if (ORDER_PAGE_ACTION_TRANSITIONS.some((t) => t.from === from && t.to === to)) {
    return { ok: true, code: 'ok', message: '' };
  }
  if (from !== 'idle' && to !== 'idle') {
    return { ok: false, code: 'action_in_flight', message: 'Another action on this order is still in progress.' };
  }
  return { ok: false, code: 'illegal_transition', message: `Cannot go from ${from} to ${to}.` };
}

/** The next action state, or `from` unchanged when the move is not allowed. */
export function nextAction(from: OrderPageAction, to: OrderPageAction): OrderPageAction {
  return canActionTransition(from, to).ok ? to : from;
}

/** Every action button is off while any action is running. */
export function actionsLocked(action: OrderPageAction): boolean {
  return action !== 'idle';
}

// ---------------------------------------------------------------------------
// Payment reconciliation poll
// ---------------------------------------------------------------------------

export const PAYMENT_POLL_FAST_MS = 4000;
/** ~2 minutes at the fast rate: when a just-made payment normally lands. */
export const PAYMENT_POLL_FAST_ATTEMPTS = 30;
export const PAYMENT_POLL_SLOW_MS = 30_000;
/** ~28 more minutes at the slow rate, so about half an hour in all. */
export const PAYMENT_POLL_SLOW_ATTEMPTS = 56;

/**
 * How long to wait before poll number `attempt + 1`, given `attempt` polls
 * already made; null once the budget is spent (the page then says to refresh).
 */
export function paymentPollDelay(attempt: number): number | null {
  if (attempt < PAYMENT_POLL_FAST_ATTEMPTS) return PAYMENT_POLL_FAST_MS;
  if (attempt < PAYMENT_POLL_FAST_ATTEMPTS + PAYMENT_POLL_SLOW_ATTEMPTS) return PAYMENT_POLL_SLOW_MS;
  return null;
}

/** The line under "Waiting on payment": only promise automatic updates while the poll is running. */
export function paymentWaitingHint(pollStopped: boolean): string {
  return pollStopped
    ? '— refresh this page to check again.'
    : '— this updates automatically, usually within a few seconds.';
}
