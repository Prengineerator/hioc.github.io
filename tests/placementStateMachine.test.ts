import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_FINGERPRINT_FIELDS,
  PLACEMENT_PHASES,
  PLACEMENT_TERMINAL,
  PLACEMENT_TRANSITIONS,
  QR_FINGERPRINT_FIELDS,
  canPlacementTransition,
  isAlreadyBeingPlaced,
  isPlacementBusy,
  keyAfterResponse,
  keyForAttempt,
  newPlacementKey,
  placementFingerprint,
  placementReducer,
  type PlacementPhase,
  type PlacementState,
} from '@/components/checkout/placement';

// Customer order placement (components/checkout/placement.ts), used by the web
// checkout (CheckoutForm) and the table-QR pad (QrCheckout).

const allowed: [PlacementPhase, PlacementPhase][] = [
  ['idle', 'placing'],
  ['error', 'placing'],
  ['placing', 'awaiting_payment'],
  ['placing', 'done'],
  ['placing', 'error'],
  ['awaiting_payment', 'done'],
];

describe('placement transitions', () => {
  it('the table is exactly the documented picture', () => {
    expect(PLACEMENT_TRANSITIONS.map((t) => [t.from, t.to])).toEqual(allowed);
  });

  it('every pair outside the table is refused with a code', () => {
    for (const from of PLACEMENT_PHASES) {
      for (const to of PLACEMENT_PHASES) {
        const expected = allowed.some(([f, t]) => f === from && t === to);
        const check = canPlacementTransition(from, to);
        expect(check.ok, `${from} → ${to}`).toBe(expected);
        expect(check.code).toBe(expected ? 'ok' : 'illegal_transition');
      }
    }
  });

  it('done is terminal: nothing leaves it', () => {
    expect(PLACEMENT_TERMINAL).toEqual(['done']);
    for (const to of PLACEMENT_PHASES) expect(canPlacementTransition('done', to).ok).toBe(false);
  });
});

describe('placementReducer', () => {
  const idle: PlacementState = { phase: 'idle' };

  it('a pay-online placement stays busy until the payment window closes, then is done', () => {
    const placing = placementReducer(idle, { type: 'submit' });
    expect(placing).toEqual({ phase: 'placing' });
    const paying = placementReducer(placing, { type: 'created', orderId: 'o1', payOnline: true });
    expect(paying).toEqual({ phase: 'awaiting_payment', orderId: 'o1' });
    // The bug: `finally` cleared `submitting` the moment the window OPENED.
    expect(isPlacementBusy(paying)).toBe(true);
    const done = placementReducer(paying, { type: 'payment_closed' });
    expect(done).toEqual({ phase: 'done', orderId: 'o1' });
    expect(isPlacementBusy(done)).toBe(true);
  });

  it('pay at counter goes straight to done', () => {
    const placing = placementReducer(idle, { type: 'submit' });
    expect(placementReducer(placing, { type: 'created', orderId: 'o1', payOnline: false })).toEqual({ phase: 'done', orderId: 'o1' });
  });

  it('a refusal or network error is retryable', () => {
    const failed = placementReducer(placementReducer(idle, { type: 'submit' }), { type: 'failed', message: 'Network error' });
    expect(failed).toEqual({ phase: 'error', message: 'Network error' });
    expect(isPlacementBusy(failed)).toBe(false);
    expect(placementReducer(failed, { type: 'submit' })).toEqual({ phase: 'placing' });
  });

  it('a second submit while placing, or a late event, changes nothing (same object)', () => {
    const placing: PlacementState = { phase: 'placing' };
    expect(placementReducer(placing, { type: 'submit' })).toBe(placing);
    const done: PlacementState = { phase: 'done', orderId: 'o1' };
    expect(placementReducer(done, { type: 'submit' })).toBe(done);
    expect(placementReducer(done, { type: 'failed', message: 'x' })).toBe(done);
    expect(placementReducer(idle, { type: 'payment_closed' })).toBe(idle);
    expect(placementReducer(idle, { type: 'created', orderId: 'o1', payOnline: false })).toBe(idle);
  });

  it('only idle and error accept a submit', () => {
    expect(PLACEMENT_PHASES.filter((p) => !isPlacementBusy({ phase: p } as PlacementState))).toEqual(['idle', 'error']);
  });
});

describe('idempotency key', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    customer_name: 'Asha',
    notes: '',
    pickup_slot_label: 'ASAP',
    items: [{ menu_item_id: 'm1', variant_id: 'v1', quantity: 1, addon_option_ids: [] }],
    order_type: 'takeaway',
    payment_mode: 'counter',
    require_online: false,
    ...over,
  });
  const fp = (b: Record<string, unknown>) => placementFingerprint(b, CHECKOUT_FINGERPRINT_FIELDS);
  let n = 0;
  const mint = () => `key-${++n}`;

  it('a retry of the same cart and bill reuses the key (that is what makes the replay recognisable)', () => {
    const first = keyForAttempt(null, fp(body()), mint);
    expect(keyForAttempt(first, fp(body()), mint)).toBe(first);
  });

  it('a name, note or pickup-slot edit is still a retry of the same order', () => {
    const first = keyForAttempt(null, fp(body()), mint);
    expect(keyForAttempt(first, fp(body({ customer_name: 'Asha K', notes: 'less ice', pickup_slot_label: '10:30' })), mint)).toBe(first);
  });

  it('a changed cart or bill is a different order: a fresh key', () => {
    const first = keyForAttempt(null, fp(body()), mint);
    for (const change of [
      { items: [{ menu_item_id: 'm1', variant_id: 'v1', quantity: 2, addon_option_ids: [] }] },
      { order_type: 'dine_in' },
      { coupon_code: 'WELCOME10' },
      { redeem_points: 50 },
      { pass_drinks: 1 },
      { payment_mode: 'online' },
    ]) {
      const next = keyForAttempt(first, fp(body(change)), mint);
      expect(next.key, JSON.stringify(change)).not.toBe(first.key);
    }
  });

  it('the QR pad keys on its table and cart', () => {
    const a = placementFingerprint({ qr_token: 't1', items: [1], customer_name: 'A' }, QR_FINGERPRINT_FIELDS);
    expect(placementFingerprint({ qr_token: 't1', items: [1], customer_name: 'B' }, QR_FINGERPRINT_FIELDS)).toBe(a);
    expect(placementFingerprint({ qr_token: 't2', items: [1] }, QR_FINGERPRINT_FIELDS)).not.toBe(a);
  });

  it('after an answer: keep on no answer / refusals / "already being placed", rotate on success or a rolled-back 409', () => {
    expect(keyAfterResponse(null)).toBe('keep'); // the lost-201 case: the retry must replay
    expect(keyAfterResponse(201)).toBe('rotate');
    expect(keyAfterResponse(400, { error: 'Item unavailable' })).toBe('keep');
    expect(keyAfterResponse(500, { error: 'Failed to create order' })).toBe('keep');
    expect(keyAfterResponse(409, { error: 'This order is already being placed — please wait a moment.' })).toBe('keep');
    expect(keyAfterResponse(409, { error: 'x', code: 'idempotency_in_flight' })).toBe('keep');
    expect(keyAfterResponse(409, { error: 'Your Ritual changed — check the bill.' })).toBe('rotate');
  });

  it('isAlreadyBeingPlaced only matches the in-flight 409', () => {
    expect(isAlreadyBeingPlaced(409, { error: 'This order is already being placed' })).toBe(true);
    expect(isAlreadyBeingPlaced(400, { error: 'This order is already being placed' })).toBe(false);
    expect(isAlreadyBeingPlaced(409, null)).toBe(false);
  });

  it('keys are long enough for the server to accept (8..200 chars) and prefixed by surface', () => {
    for (const prefix of ['web', 'qr'] as const) {
      const key = newPlacementKey(prefix);
      expect(key.startsWith(`${prefix}-`)).toBe(true);
      expect(key.length).toBeGreaterThanOrEqual(8);
      expect(key.length).toBeLessThanOrEqual(200);
      expect(newPlacementKey(prefix)).not.toBe(key);
    }
  });
});

describe('the checkout surfaces use it', () => {
  const checkout = readFileSync('components/checkout/CheckoutForm.tsx', 'utf8');
  const qr = readFileSync('components/qr/QrCheckout.tsx', 'utf8');

  it('both send the Idempotency-Key and keep it on a network error', () => {
    for (const src of [checkout, qr]) {
      expect(src).toContain("'Idempotency-Key': attempt.key");
      expect(src).toContain('keyForAttempt(');
      expect(src).not.toMatch(/finally\s*\{\s*setSubmitting\(false\)/);
    }
  });

  it('both await the payment window instead of firing and forgetting it', () => {
    for (const src of [checkout, qr]) expect(src).toMatch(/await openRazorpayCheckout\(/);
  });

  it('Place Order waits for a coupon / Beanies Apply as well as the Ritual stepper', () => {
    expect(checkout).toContain('const offersBusy = couponBusy || pointsBusy || passBusy;');
    expect(checkout).toMatch(/\(passEnabled && !passSettled\) \|\|\s*offersBusy/);
    expect(checkout).toContain('if (submitting || offersBusy) return;');
  });

  it('an Apply never acts on a superseded quote', () => {
    expect(checkout).toContain("if (result.status === 'superseded')");
    expect(checkout).not.toContain('if (seq !== quoteSeq.current) return data;');
  });
});
