import { describe, expect, it } from 'vitest';

// Pure-logic unit tests for the customer order-status page's issue-1 guard
// (lib/orders/paymentStatusUI.ts, used by app/order/[id]/page.tsx): a web
// guest must never be offered — or told about — "pay at counter". A
// table-QR order (diner is physically at the table) is NOT gated by this
// rule, even though it still starts pay-online-first at placement.

import { canPayAtCounter, paymentFlagMessage } from '@/lib/orders/paymentStatusUI';

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
