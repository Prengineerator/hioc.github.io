import { describe, expect, it } from 'vitest';
import {
  PAYMENT_STATUSES,
  PAYMENT_TRANSITIONS,
  TERMINAL_PAYMENT_STATUSES,
  canPayOnline,
  canReSettle,
  canSettleAtCounter,
  canTransitionPayment,
  captureDisposition,
  checkCounterSettle,
  gatewayOwnsPayment,
  isRefundable,
  paymentStatusAfterRefund,
  type GatewayEvidence,
} from '@/lib/orders/paymentStateMachine';
import {
  REFUND_TRANSITIONS,
  RESOLVE_PENDING_AFTER_MS,
  canTransitionRefund,
  hasPendingRefund,
  isOldEnoughToResolve,
  processedInr,
  refundStatusForOutcome,
  refundedOrPendingInr,
  resolvePendingRefunds,
} from '@/lib/orders/refundStateMachine';
import {
  CAPTURABLE_ROW_STATUSES,
  ORPHAN_CAPTURE_NOTE,
  canTransitionPaymentRow,
  gatewayEvidenceFromRows,
  isOrphanCapture,
  paymentRowAfterRefund,
} from '@/lib/payments/paymentRowStateMachine';
import { canTransition, isDeadOrder } from '@/lib/orders/stateMachine';
import { canChangePayment, isSettleable } from '@/lib/orders/settleList';
import { paidChangeBlockReason, refundedChangeBlockReason, REFUNDED_BILL_LOCKED } from '@/lib/orders/paidChange';
import { settleEditBlockReason } from '@/lib/orders/settleEdit';
import { checkExpectedVersion, STALE_VERSION_CODE } from '@/lib/orders/concurrency';
import type { PaymentStatus } from '@/lib/types';

// The explicit money machines (money-orders findings §1–§6): orders.payment_status,
// refunds.status and the Razorpay payments row — their tables, and the bugs the
// old implicit rules let through.

const GATEWAY_PAID: GatewayEvidence = { gatewayPaid: true, gatewayLive: false, orphanCapture: false };
const NONE: GatewayEvidence = { gatewayPaid: false, gatewayLive: false, orphanCapture: false };
const LIVE: GatewayEvidence = { gatewayPaid: false, gatewayLive: true, orphanCapture: false };

describe('orders.payment_status — the table', () => {
  it('names every PaymentStatus, and nothing leaves a full refund', () => {
    expect([...PAYMENT_STATUSES].sort()).toEqual(['paid', 'partially_refunded', 'payment_pending', 'refunded', 'unpaid']);
    expect(TERMINAL_PAYMENT_STATUSES).toEqual(['refunded']);
    expect(PAYMENT_TRANSITIONS.filter((t) => t.from === 'refunded')).toHaveLength(0);
  });

  it('only the refund route produces a refund state, and it needs the refund permission', () => {
    for (const t of PAYMENT_TRANSITIONS.filter((r) => r.to === 'refunded' || r.to === 'partially_refunded')) {
      expect(t.via).toBe('refund');
      expect(t.permission).toBe('refund');
    }
  });

  it('a refund state is never moved back to unpaid or paid by anything', () => {
    for (const from of ['refunded', 'partially_refunded'] as const) {
      for (const via of ['settle', 're_settle', 'mark_unpaid', 'comp', 'capture'] as const) {
        expect(canTransitionPayment(from, 'paid', via, 'counter').ok).toBe(false);
        expect(canTransitionPayment(from, 'unpaid', via, 'counter').ok).toBe(false);
      }
    }
  });

  it('who: the gateway captures, the customer switches, the system expires', () => {
    expect(canTransitionPayment('payment_pending', 'paid', 'capture', 'gateway', { orderStatus: 'placed' }).ok).toBe(true);
    expect(canTransitionPayment('payment_pending', 'paid', 'capture', 'counter', { orderStatus: 'placed' }).code).toBe('forbidden_actor');
    expect(canTransitionPayment('payment_pending', 'unpaid', 'switch_to_counter', 'customer', { orderStatus: 'placed' }).ok).toBe(true);
    expect(canTransitionPayment('payment_pending', 'unpaid', 'switch_to_counter', 'system').ok).toBe(false);
    expect(canTransitionPayment('payment_pending', 'unpaid', 'expire', 'system', { orderStatus: 'placed' }).ok).toBe(true);
    expect(canTransitionPayment('payment_pending', 'unpaid', 'expire', 'system', { orderStatus: 'received' }).ok).toBe(false);
  });

  it('refund partial/full follows what has gone back', () => {
    expect(paymentStatusAfterRefund(500, 0)).toBe('paid');
    expect(paymentStatusAfterRefund(500, 120)).toBe('partially_refunded');
    expect(paymentStatusAfterRefund(500, 500)).toBe('refunded');
    expect(paymentStatusAfterRefund(500, 620)).toBe('refunded');
    expect(canTransitionPayment('paid', 'partially_refunded', 'refund', 'counter').ok).toBe(true);
    expect(canTransitionPayment('partially_refunded', 'refunded', 'refund', 'counter').ok).toBe(true);
    expect(isRefundable('partially_refunded')).toBe(true);
    expect(isRefundable('refunded')).toBe(false);
    expect(isRefundable('unpaid')).toBe(false);
  });
});

describe('gateway ownership — ONE predicate, from the payments rows', () => {
  // A Razorpay capture stores 'upi' or 'card' as payment_method — the same
  // words as a counter settle. The old checks tested payment_method === 'online'
  // only, so a UPI/card gateway payment could be re-recorded at the counter,
  // its bill changed and the difference handed back from the drawer.
  it('a UPI or card capture is the gateway’s payment when its payments row says so', () => {
    for (const method of ['upi', 'card']) {
      const order = { payment_status: 'paid', payment_method: method };
      expect(gatewayOwnsPayment(order, GATEWAY_PAID)).toBe(true);
      expect(gatewayOwnsPayment(order, NONE)).toBe(false);
    }
  });

  it("payment_method 'online' still counts, and an unpaid order is never the gateway's", () => {
    expect(gatewayOwnsPayment({ payment_status: 'paid', payment_method: 'online' })).toBe(true);
    expect(gatewayOwnsPayment({ payment_status: 'refunded', payment_method: 'online' })).toBe(true);
    expect(gatewayOwnsPayment({ payment_status: 'unpaid', payment_method: 'online' }, GATEWAY_PAID)).toBe(false);
  });

  it('an orphan capture is not the order’s payment', () => {
    const ev = gatewayEvidenceFromRows([{ status: 'paid', error: `${ORPHAN_CAPTURE_NOTE} captured after the order was cancelled` }]);
    expect(ev).toEqual({ gatewayPaid: false, gatewayLive: false, orphanCapture: true });
    expect(gatewayEvidenceFromRows([{ status: 'partially_refunded', error: '' }]).gatewayPaid).toBe(true);
    expect(gatewayEvidenceFromRows([{ status: 'payment_pending' }, { status: 'unpaid' }])).toEqual({
      gatewayPaid: false,
      gatewayLive: true,
      orphanCapture: false,
    });
  });

  it('paidChange, the balance route and Change payment ask the same predicate', () => {
    const upiPaid = { status: 'accepted', order_type: 'dine_in', payment_status: 'paid', payment_method: 'upi', balance_due_inr: 0 };
    expect(paidChangeBlockReason(upiPaid, GATEWAY_PAID)).toMatch(/paid online/);
    expect(paidChangeBlockReason(upiPaid, NONE)).toBeNull();
    expect(canReSettle(upiPaid, GATEWAY_PAID)).toBe(false);
    expect(canReSettle(upiPaid, NONE)).toBe(true);
  });
});

describe('the counter settle — server and screens share it', () => {
  const order = (over: Partial<Record<string, unknown>> = {}) =>
    ({ status: 'ready', payment_status: 'unpaid', payment_method: null, ...over }) as Parameters<typeof checkCounterSettle>[0];

  it('refuses a cancelled or rejected order (the UI never offered it; the server used to settle it)', () => {
    for (const status of ['cancelled', 'rejected']) {
      const check = checkCounterSettle(order({ status }), 'paid', NONE);
      expect(check.ok).toBe(false);
      expect(check.code).toBe('dead_order');
      expect(isSettleable({ status, payment_status: 'unpaid' } as never)).toBe(false);
    }
  });

  it('refuses an order waiting on a live Razorpay order; allows it once none is open', () => {
    const pending = order({ status: 'received', payment_status: 'payment_pending', payment_method: 'online' });
    expect(checkCounterSettle(pending, 'paid', LIVE).code).toBe('gateway_live');
    expect(checkCounterSettle(pending, 'paid', NONE).ok).toBe(true);
    // A screen has no rows, so it treats every payment_pending as live.
    expect(canSettleAtCounter(pending)).toBe(false);
  });

  it('keeps the existing refusals and their order: gateway, pass sale, refund, changed after payment', () => {
    expect(checkCounterSettle(order({ payment_status: 'paid', payment_method: 'upi' }), 'paid', GATEWAY_PAID).code).toBe('gateway_owned');
    expect(checkCounterSettle(order({ payment_status: 'refunded', payment_method: 'online' }), 'paid', NONE).code).toBe('gateway_owned');
    expect(checkCounterSettle(order({ payment_status: 'refunded', payment_method: 'cash' }), 'paid', NONE).code).toBe('refunded');
    expect(checkCounterSettle(order({ payment_status: 'paid', order_kind: 'coffee_pass' }), 'unpaid', NONE).code).toBe('pass_issued');
    expect(checkCounterSettle(order({ payment_status: 'paid', order_kind: 'coffee_pass' }), 'paid', NONE).ok).toBe(true);
    expect(checkCounterSettle(order({ payment_status: 'paid', balance_due_inr: 150 }), 'paid', NONE).code).toBe(
      'changed_after_payment',
    );
  });

  it('never takes a completed order off paid (completion required it)', () => {
    expect(checkCounterSettle(order({ status: 'completed', payment_status: 'paid', payment_method: 'cash' }), 'unpaid', NONE).code).toBe(
      'completed',
    );
    // Re-recording how it was paid stays fine.
    expect(checkCounterSettle(order({ status: 'completed', payment_status: 'paid', payment_method: 'cash' }), 'paid', NONE).ok).toBe(true);
  });

  it('the screen helpers agree with the old rules for every ordinary order', () => {
    expect(isSettleable({ status: 'ready', payment_status: 'unpaid' } as never)).toBe(true);
    expect(isSettleable({ status: 'ready', payment_status: 'paid' } as never)).toBe(false);
    expect(canChangePayment({ status: 'completed', payment_status: 'paid', payment_method: 'cash' } as never)).toBe(true);
    expect(canChangePayment({ status: 'completed', payment_status: 'paid', payment_method: 'online' } as never)).toBe(false);
    expect(canChangePayment({ status: 'cancelled', payment_status: 'paid', payment_method: 'cash' } as never)).toBe(false);
  });
});

describe('comp — a manager write-off at completion', () => {
  it('comps an unpaid Ready order only', () => {
    expect(canTransitionPayment('unpaid', 'paid', 'comp', 'counter', { orderStatus: 'ready' }).ok).toBe(true);
    expect(canTransitionPayment('unpaid', 'paid', 'comp', 'counter', { orderStatus: 'preparing' }).code).toBe('not_ready');
  });

  it('never erases a refund marker (refunded / part-refunded are not "unpaid")', () => {
    for (const from of ['refunded', 'partially_refunded'] as const) {
      expect(canTransitionPayment(from, 'paid', 'comp', 'counter', { orderStatus: 'ready' }).ok).toBe(false);
    }
  });

  it('refuses while a Razorpay order is still open for it', () => {
    expect(canTransitionPayment('payment_pending', 'paid', 'comp', 'counter', { orderStatus: 'ready', gatewayLive: true }).code).toBe(
      'gateway_live',
    );
  });
});

describe('captures that land late', () => {
  it('a capture on a live order waiting (or switched to the counter) takes it', () => {
    expect(captureDisposition({ status: 'placed', payment_status: 'payment_pending' })).toEqual({ kind: 'capture' });
    expect(captureDisposition({ status: 'received', payment_status: 'unpaid' })).toEqual({ kind: 'capture' });
  });

  it('is an orphan on a cancelled order, a bill paid another way, or a refunded one', () => {
    expect(captureDisposition({ status: 'cancelled', payment_status: 'unpaid' })).toEqual({ kind: 'orphan', reason: 'dead_order' });
    expect(captureDisposition({ status: 'cancelled', payment_status: 'payment_pending' })).toEqual({ kind: 'orphan', reason: 'dead_order' });
    expect(captureDisposition({ status: 'accepted', payment_status: 'paid' })).toEqual({ kind: 'orphan', reason: 'paid_elsewhere' });
    expect(captureDisposition({ status: 'ready', payment_status: 'partially_refunded' })).toEqual({ kind: 'orphan', reason: 'refunded' });
  });

  it('a dead or finished order is never handed a Razorpay order to pay', () => {
    expect(canPayOnline({ status: 'placed', payment_status: 'payment_pending' })).toBe(true);
    expect(canPayOnline({ status: 'received', payment_status: 'unpaid' })).toBe(true);
    for (const status of ['cancelled', 'rejected', 'completed']) {
      expect(canPayOnline({ status, payment_status: 'payment_pending' })).toBe(false);
    }
    expect(canPayOnline({ status: 'accepted', payment_status: 'refunded' })).toBe(false);
  });
});

describe('the Razorpay payments row', () => {
  it('pending → paid on capture, → unpaid when abandoned, and a late capture on an abandoned row is still recorded', () => {
    expect(canTransitionPaymentRow('payment_pending', 'paid', 'capture')).toBe(true);
    expect(canTransitionPaymentRow('payment_pending', 'unpaid', 'abandon')).toBe(true);
    expect(canTransitionPaymentRow('unpaid', 'paid', 'capture')).toBe(true);
    expect(canTransitionPaymentRow('paid', 'paid', 'capture')).toBe(false);
    expect([...CAPTURABLE_ROW_STATUSES].sort()).toEqual(['payment_pending', 'unpaid']);
  });

  it('refunds move it to partially_refunded / refunded, never back', () => {
    expect(paymentRowAfterRefund(788, 100)).toBe('partially_refunded');
    expect(paymentRowAfterRefund(788, 788)).toBe('refunded');
    expect(canTransitionPaymentRow('refunded', 'paid', 'capture')).toBe(false);
    expect(isOrphanCapture({ error: `${ORPHAN_CAPTURE_NOTE} x` })).toBe(true);
    expect(isOrphanCapture({ error: 'Payment failed' })).toBe(false);
  });
});

describe('refunds.status — pending → processed | failed', () => {
  it('the gateway claims first, the counter records the event', () => {
    expect(canTransitionRefund(null, 'pending', 'gateway')).toBe(true);
    expect(canTransitionRefund(null, 'processed', 'gateway')).toBe(false);
    expect(canTransitionRefund(null, 'processed', 'counter')).toBe(true);
    expect(canTransitionRefund('pending', 'processed', 'gateway')).toBe(true);
    expect(canTransitionRefund('pending', 'failed', 'gateway')).toBe(true);
    expect(canTransitionRefund('failed', 'processed', 'gateway')).toBe(false);
    expect(canTransitionRefund('processed', 'failed', 'gateway')).toBe(false);
    expect(REFUND_TRANSITIONS.every((t) => t.from !== 'processed' && t.from !== 'failed')).toBe(true);
  });

  it('an unknown gateway answer is no transition (the money may have moved)', () => {
    expect(refundStatusForOutcome({ kind: 'processed', refundId: 'rfnd_1' })).toBe('processed');
    expect(refundStatusForOutcome({ kind: 'rejected', httpStatus: 400 })).toBe('failed');
    expect(refundStatusForOutcome({ kind: 'unknown' })).toBeNull();
  });

  it('pending refunds count against what is left, and block a new one', () => {
    const rows = [
      { status: 'processed', amount_inr: 100 },
      { status: 'pending', amount_inr: 50 },
      { status: 'failed', amount_inr: 500 },
    ];
    expect(refundedOrPendingInr(rows)).toBe(150);
    expect(processedInr(rows)).toBe(100);
    expect(hasPendingRefund(rows)).toBe(true);
    expect(hasPendingRefund(rows.filter((r) => r.status !== 'pending'))).toBe(false);
  });
});

describe('orders.status — the table now says what the routes do', () => {
  it('Ready → Preparing exists only as part of adding items', () => {
    expect(canTransition('ready', 'preparing', 'staff', undefined, { via: 'add_items' }).ok).toBe(true);
    expect(canTransition('ready', 'preparing', 'staff').code).toBe('not_allowed');
  });

  it('the customer moves placed → received when switching to the counter', () => {
    expect(canTransition('placed', 'received', 'customer').ok).toBe(true);
    expect(canTransition('placed', 'received', 'system').ok).toBe(true);
    expect(canTransition('placed', 'received', 'staff').ok).toBe(false);
  });

  it('a refunded or part-refunded order may complete — it was settled, nothing is left to collect', () => {
    for (const paymentStatus of ['refunded', 'partially_refunded'] as PaymentStatus[]) {
      expect(canTransition('ready', 'completed', 'staff', undefined, { paymentStatus }).ok).toBe(true);
    }
    expect(canTransition('ready', 'completed', 'staff', undefined, { paymentStatus: 'payment_pending' }).ok).toBe(false);
  });

  it('dead orders: cancelled and rejected only', () => {
    expect(isDeadOrder('cancelled')).toBe(true);
    expect(isDeadOrder('rejected')).toBe(true);
    expect(isDeadOrder('completed')).toBe(false);
  });
});

describe('a refunded bill is not an unpaid one', () => {
  it('can’t be changed (its total used to move with no balance, and it then got stuck)', () => {
    expect(refundedChangeBlockReason({ payment_status: 'partially_refunded' })).toBe(REFUNDED_BILL_LOCKED);
    expect(refundedChangeBlockReason({ payment_status: 'unpaid' })).toBeNull();
    expect(
      settleEditBlockReason({ status: 'ready', order_type: 'dine_in', payment_status: 'refunded' } as never),
    ).toBe(REFUNDED_BILL_LOCKED);
  });
});

describe('expected_version — the optional retry token', () => {
  it('absent is the old behaviour; a match passes; a mismatch is a 409', () => {
    expect(checkExpectedVersion(undefined, 4)).toEqual({ ok: true, expected: null });
    expect(checkExpectedVersion(null, 4)).toEqual({ ok: true, expected: null });
    expect(checkExpectedVersion(4, 4)).toEqual({ ok: true, expected: 4 });
    expect(checkExpectedVersion(3, 4)).toMatchObject({ ok: false, status: 409, code: STALE_VERSION_CODE });
    expect(checkExpectedVersion('4', 4)).toMatchObject({ ok: false, status: 400 });
    expect(checkExpectedVersion(-1, 4)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('resolving a pending refund from the gateway’s record', () => {
  const resolve = (processed: number, pendingInr: number[], amountRefundedPaise: number | null | undefined) =>
    resolvePendingRefunds({ processedInr: processed, pendingInr, amountRefundedPaise });

  it('R ≥ P + pending → processed', () => {
    expect(resolve(0, [200], 20000)).toBe('processed');
    expect(resolve(100, [200], 30000)).toBe('processed');
    expect(resolve(100, [200, 50], 35000)).toBe('processed');
    expect(resolve(100, [200], 40000)).toBe('processed'); // more than we know of still covers ours
  });

  it('R = P → failed (none of the pending ones went through)', () => {
    expect(resolve(0, [200], 0)).toBe('failed');
    expect(resolve(100, [200], 10000)).toBe('failed');
  });

  it('anything else, a missing figure, or nothing pending → unknown (never guessed)', () => {
    expect(resolve(100, [200], 20000)).toBe('unknown'); // between P and P + pending
    expect(resolve(100, [200, 50], 30000)).toBe('unknown'); // covers one of two: can't say which
    expect(resolve(100, [200], 5000)).toBe('unknown'); // less than we know went back
    expect(resolve(0, [200], undefined)).toBe('unknown');
    expect(resolve(0, [200], null)).toBe('unknown');
    expect(resolve(0, [200], Number.NaN)).toBe('unknown');
    expect(resolve(0, [], 0)).toBe('unknown');
  });

  it('a row is resolved only once the request that claimed it is surely over', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    expect(isOldEnoughToResolve(new Date(now - RESOLVE_PENDING_AFTER_MS).toISOString(), now)).toBe(true);
    expect(isOldEnoughToResolve(new Date(now - RESOLVE_PENDING_AFTER_MS + 1000).toISOString(), now)).toBe(false);
    expect(isOldEnoughToResolve(undefined, now)).toBe(false);
  });
});
