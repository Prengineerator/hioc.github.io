import { describe, expect, it } from 'vitest';

// Pure-logic unit tests for the customer order-status page's issue-1 guard
// (lib/orders/paymentStatusUI.ts, used by app/order/[id]/page.tsx): a web
// guest must never be offered — or told about — "pay at counter". A
// table-QR order (diner is physically at the table) is NOT gated by this
// rule, even though it still starts pay-online-first at placement.

import { canPayAtCounter, hasBill, paymentFlagMessage } from '@/lib/orders/paymentStatusUI';
import type { OrderStatus, PaymentStatus } from '@/lib/types';

describe('canPayAtCounter (issue-1)', () => {
  it('is false for a web guest order (customer_web, no user_id)', () => {
    expect(canPayAtCounter({ channel: 'customer_web', user_id: null })).toBe(false);
  });

  it('is true for a table-QR order, whether or not it has a logged-in user_id', () => {
    expect(canPayAtCounter({ channel: 'table_qr', user_id: null })).toBe(true);
    expect(canPayAtCounter({ channel: 'table_qr', user_id: 'cust-1' })).toBe(true);
  });

  it('is true for a logged-in web customer', () => {
    expect(canPayAtCounter({ channel: 'customer_web', user_id: 'cust-1' })).toBe(true);
  });

  it('is true for a staff_pos order (not gated by this rule)', () => {
    expect(canPayAtCounter({ channel: 'staff_pos', user_id: null })).toBe(true);
  });
});

describe('paymentFlagMessage (issue-1 wording)', () => {
  it('mentions the counter for a customer who can pay there', () => {
    expect(paymentFlagMessage('failed', true)).toMatch(/pay at the counter/i);
    expect(paymentFlagMessage('cancelled', true)).toMatch(/pay at the counter/i);
  });

  it('never mentions the counter for a guest order', () => {
    expect(paymentFlagMessage('failed', false)).not.toMatch(/counter/i);
    expect(paymentFlagMessage('cancelled', false)).not.toMatch(/counter/i);
    expect(paymentFlagMessage('failed', false)).toMatch(/retry the payment/i);
  });

  it('returns empty for no flag', () => {
    expect(paymentFlagMessage(null, true)).toBe('');
  });
});

// hasBill — "why am I still seeing View bill on a cancelled/unpaid order?"
// A bill exists only once a payment is recorded (sendBillNotification's rule),
// so the "View / print bill" link (order-status page, account orders list,
// and the receipt page itself) must track payment_status === 'paid', not
// order status alone — with cancelled/rejected carved out even if the order
// happened to be paid before it was cancelled (a refund would already have
// moved payment_status off 'paid', but this keeps the guard explicit/defensive).
describe('hasBill (bill only after payment, PR #20 follow-up)', () => {
  const ACTIVE_STATUSES: OrderStatus[] = ['placed', 'received', 'accepted', 'preparing', 'ready'];
  const NON_CANCEL_TERMINAL: OrderStatus[] = ['completed'];
  const CANCEL_LIKE: OrderStatus[] = ['cancelled', 'rejected'];
  const ALL_STATUSES = [...ACTIVE_STATUSES, ...NON_CANCEL_TERMINAL, ...CANCEL_LIKE];
  const NON_PAID_STATUSES: PaymentStatus[] = [
    'unpaid',
    'payment_pending',
    'refunded',
    'partially_refunded',
  ];

  it('is true for a paid order in any active or completed status', () => {
    for (const status of [...ACTIVE_STATUSES, ...NON_CANCEL_TERMINAL]) {
      expect(hasBill({ status, payment_status: 'paid' })).toBe(true);
    }
  });

  it('is false for a paid order that was cancelled or rejected', () => {
    for (const status of CANCEL_LIKE) {
      expect(hasBill({ status, payment_status: 'paid' })).toBe(false);
    }
  });

  it('is false for every non-paid payment_status, across every order status', () => {
    for (const status of ALL_STATUSES) {
      for (const payment_status of NON_PAID_STATUSES) {
        expect(hasBill({ status, payment_status })).toBe(false);
      }
    }
  });

  it('is false for refunded/partially_refunded even though money was once collected', () => {
    expect(hasBill({ status: 'completed', payment_status: 'refunded' })).toBe(false);
    expect(hasBill({ status: 'completed', payment_status: 'partially_refunded' })).toBe(false);
  });

  it('is false for a completed-but-unpaid order (e.g. collect-later, never settled)', () => {
    expect(hasBill({ status: 'completed', payment_status: 'unpaid' })).toBe(false);
  });

  it('is true for a paid, still-active order (e.g. gateway-captured but not yet completed)', () => {
    expect(hasBill({ status: 'preparing', payment_status: 'paid' })).toBe(true);
  });
});
