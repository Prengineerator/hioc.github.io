// Placing a customer order — the web checkout (CheckoutForm) and the table-QR
// pad (QrCheckout). Pure: no React, no fetch, so it is unit-tested directly.
//
// The life of one placement, as the screen sees it:
//
//   idle ──submit──▶ placing ──201, online intent──▶ awaiting_payment ──window closed, any way──▶ done
//    ▲                  │    ──201, nothing to pay online───────────────────────────────────────▶ done
//    │                  └──refused / network error──▶ error ──submit──▶ placing
//    └───────────────────────────────────────────────────────────────────(error is idle with a message)
//
// It used to be one `submitting` boolean, reset in a `finally` — which ran the
// moment the Razorpay window OPENED (the launch was not awaited), so "Place
// Order" came back to life with the payment window still up. 'done' is
// terminal: the order exists and the cart is gone, so the screen only ever
// navigates away from it.
//
// The idempotency key (POST /api/orders honours `Idempotency-Key`, see
// lib/orders/idempotency.ts). The failure it prevents: the order is created
// but the 201 never arrives (café wifi, a phone switching networks). The
// screen says "Network error" with the cart intact, the customer taps again —
// and a pay-at-counter order goes to the kitchen twice. With the same key the
// server answers the retry with the order it already made. So:
//   * one key per placement attempt, minted before the first request;
//   * the SAME key on a retry of the same cart/bill (that is what makes the
//     retry recognisable);
//   * a fresh key once an order was placed, or when the cart or the bill
//     (order type, coupon, Beanies, Ritual cups, payment choice) changed —
//     that is a different order, not a retry of the first;
//   * a fresh key after a 409 that rolled an order back (a cup or a coupon
//     changed underneath it): the old key points at an order that no longer
//     exists. Never after "already being placed": the first attempt is still
//     running, and a new key would make a second order.
// Copied from the POS (components/staff/PosOrderEntry.tsx newIdempotencyKey,
// lib/pos/ritual.ts orderConflictAction). The checkout keeps no draft of its
// own (only the cart persists), so the key lives in memory: a reload starts a
// new attempt, as it did before.

export const PLACEMENT_PHASES = ['idle', 'placing', 'awaiting_payment', 'done', 'error'] as const;
export type PlacementPhase = (typeof PLACEMENT_PHASES)[number];

export type PlacementState =
  | { phase: 'idle' }
  | { phase: 'placing' }
  | { phase: 'awaiting_payment'; orderId: string }
  | { phase: 'done'; orderId: string }
  | { phase: 'error'; message: string };

export const PLACEMENT_TERMINAL: readonly PlacementPhase[] = ['done'];

export type PlacementEvent =
  | { type: 'submit' }
  | { type: 'created'; orderId: string; payOnline: boolean }
  | { type: 'failed'; message: string }
  | { type: 'payment_closed' };

export const PLACEMENT_TRANSITIONS: readonly { on: PlacementEvent['type']; from: PlacementPhase; to: PlacementPhase }[] = [
  { on: 'submit', from: 'idle', to: 'placing' },
  { on: 'submit', from: 'error', to: 'placing' },
  { on: 'created', from: 'placing', to: 'awaiting_payment' }, // an online intent came back
  { on: 'created', from: 'placing', to: 'done' }, // pay at counter, ₹0, or the gateway was down
  { on: 'failed', from: 'placing', to: 'error' },
  { on: 'payment_closed', from: 'awaiting_payment', to: 'done' }, // every outcome lands on the order page
];

export interface PlacementCheck {
  ok: boolean;
  code: 'ok' | 'illegal_transition';
  message: string;
}

export function canPlacementTransition(from: PlacementPhase, to: PlacementPhase): PlacementCheck {
  const ok = PLACEMENT_TRANSITIONS.some((t) => t.from === from && t.to === to);
  return ok
    ? { ok, code: 'ok', message: '' }
    : { ok, code: 'illegal_transition', message: `A placement cannot go from ${from} to ${to}.` };
}

/**
 * The next state, or the same object when the event does not apply (a second
 * tap while placing, a late answer after the screen moved on): the caller can
 * compare by identity to know nothing happened.
 */
export function placementReducer(state: PlacementState, event: PlacementEvent): PlacementState {
  let next: PlacementState;
  switch (event.type) {
    case 'submit':
      next = { phase: 'placing' };
      break;
    case 'created':
      next = event.payOnline ? { phase: 'awaiting_payment', orderId: event.orderId } : { phase: 'done', orderId: event.orderId };
      break;
    case 'failed':
      next = { phase: 'error', message: event.message };
      break;
    case 'payment_closed':
      if (state.phase !== 'awaiting_payment') return state;
      next = { phase: 'done', orderId: state.orderId };
      break;
  }
  return canPlacementTransition(state.phase, next.phase).ok ? next : state;
}

/**
 * Placing, paying, or leaving for the order page: Place Order (and anything
 * that would change what it sends) stays off. Only idle and error accept a submit.
 */
export function isPlacementBusy(state: PlacementState): boolean {
  return !canPlacementTransition(state.phase, 'placing').ok;
}

// ---------------------------------------------------------------------------
// Idempotency key
// ---------------------------------------------------------------------------

/**
 * A fresh key. crypto.randomUUID is in every browser this runs on; the
 * timestamp+random fallback keeps an old phone working rather than silently
 * dropping replay protection (same as the POS).
 */
export function newPlacementKey(prefix: 'web' | 'qr'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The fields of the POST /api/orders body that make it "the same order" for a retry: the cart and the bill. */
export const CHECKOUT_FINGERPRINT_FIELDS = [
  'items',
  'order_type',
  'coupon_code',
  'redeem_points',
  'pass_drinks',
  'payment_mode',
  'require_online',
] as const;
export const QR_FINGERPRINT_FIELDS = ['qr_token', 'items'] as const;

/**
 * What a retry must match to reuse the key. Only the cart and the bill: a name,
 * note or pickup slot edited after a lost answer is still a retry of the same
 * order (the server answers with the order it made), never a second order.
 */
export function placementFingerprint(body: Record<string, unknown>, fields: readonly string[]): string {
  return JSON.stringify(fields.map((f) => [f, body[f] ?? null]));
}

export interface AttemptKey {
  key: string;
  fingerprint: string;
}

/** The key to send: the last attempt's while the cart/bill is unchanged, else a fresh one. */
export function keyForAttempt(prev: AttemptKey | null, fingerprint: string, mint: () => string): AttemptKey {
  if (prev && prev.fingerprint === fingerprint) return prev;
  return { key: mint(), fingerprint };
}

/** "This order is already being placed": the first attempt with this key is still running. */
export function isAlreadyBeingPlaced(status: number, body: { error?: unknown; code?: unknown } | null | undefined): boolean {
  if (status !== 409) return false;
  const code = typeof body?.code === 'string' ? body.code : '';
  if (/in_flight|being_placed/i.test(code)) return true;
  return /already being placed/i.test(typeof body?.error === 'string' ? body.error : '');
}

/**
 * After an answer (or none: `status` null for a network error), keep the key
 * for the next attempt or start a new one.
 */
export function keyAfterResponse(
  status: number | null,
  body?: { error?: unknown; code?: unknown } | null,
): 'keep' | 'rotate' {
  if (status === null) return 'keep'; // the order may exist: the retry must replay it
  if (status === 201) return 'rotate'; // placed: the next order is a new one
  if (status === 409) return isAlreadyBeingPlaced(status, body) ? 'keep' : 'rotate';
  // A 4xx refused before claiming the key; a 5xx released it. Same cart, same key.
  return 'keep';
}
