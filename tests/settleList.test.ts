import { describe, expect, it } from 'vitest';
import {
  canChangePayment,
  describePaymentMethod,
  groupForSettle,
  isSettleable,
  istDateKey,
} from '@/lib/orders/settleList';

describe('isSettleable', () => {
  it('is an unpaid order that is still going ahead', () => {
    expect(isSettleable({ status: 'ready', payment_status: 'unpaid' })).toBe(true);
    expect(isSettleable({ status: 'completed', payment_status: 'unpaid' })).toBe(true);
  });

  it('never a cancelled/rejected one, a paid one, or one waiting on the gateway', () => {
    expect(isSettleable({ status: 'cancelled', payment_status: 'unpaid' })).toBe(false);
    expect(isSettleable({ status: 'rejected', payment_status: 'unpaid' })).toBe(false);
    expect(isSettleable({ status: 'ready', payment_status: 'paid' })).toBe(false);
    expect(isSettleable({ status: 'placed', payment_status: 'payment_pending' })).toBe(false);
  });
});

describe('canChangePayment', () => {
  it('allows re-recording a counter payment', () => {
    expect(canChangePayment({ status: 'completed', payment_status: 'paid', payment_method: 'cash' })).toBe(true);
    expect(canChangePayment({ status: 'ready', payment_status: 'paid', payment_method: 'upi' })).toBe(true);
  });

  it('refuses online payments, refunded bills and unpaid ones', () => {
    expect(canChangePayment({ status: 'completed', payment_status: 'paid', payment_method: 'online' })).toBe(false);
    expect(canChangePayment({ status: 'completed', payment_status: 'partially_refunded', payment_method: 'cash' })).toBe(false);
    expect(canChangePayment({ status: 'completed', payment_status: 'refunded', payment_method: 'cash' })).toBe(false);
    expect(canChangePayment({ status: 'ready', payment_status: 'unpaid', payment_method: null })).toBe(false);
  });
});

describe('groupForSettle', () => {
  // 2026-09-26 10:00 IST
  const now = new Date('2026-09-26T04:30:00Z');

  it('splits by the IST calendar day, oldest first', () => {
    const orders = [
      { id: 'b', created_at: '2026-09-26T03:00:00Z' }, // 08:30 IST today
      { id: 'a', created_at: '2026-09-25T18:40:00Z' }, // 00:10 IST today
      { id: 'y', created_at: '2026-09-25T17:00:00Z' }, // 22:30 IST yesterday
      { id: 'x', created_at: '2026-09-20T09:00:00Z' },
    ];
    const g = groupForSettle(orders, now);
    expect(g.today.map((o) => o.id)).toEqual(['a', 'b']);
    expect(g.earlier.map((o) => o.id)).toEqual(['x', 'y']);
  });

  it('keeps last evening’s bills under today until 3 am (the business day)', () => {
    const at1240am = new Date('2026-11-05T19:10:00Z'); // 12:40 am IST on the 6th
    const orders = [
      { id: 'late', created_at: '2026-11-05T17:30:00Z' }, // 11:00 pm IST on the 5th
      { id: 'small-hours', created_at: '2026-11-05T19:00:00Z' }, // 12:30 am IST on the 6th
      { id: 'lunch', created_at: '2026-11-05T07:30:00Z' }, // 1:00 pm IST on the 5th
      { id: 'night-before', created_at: '2026-11-04T20:30:00Z' }, // 2:00 am IST on the 5th
    ];
    const g = groupForSettle(orders, at1240am);
    expect(g.today.map((o) => o.id)).toEqual(['lunch', 'late', 'small-hours']);
    expect(g.earlier.map((o) => o.id)).toEqual(['night-before']);
  });

  it('istDateKey uses India time, not UTC', () => {
    expect(istDateKey('2026-09-25T18:40:00Z')).toBe('2026-09-26');
  });
});

describe('describePaymentMethod', () => {
  it('names each method', () => {
    expect(describePaymentMethod('upi')).toBe('UPI');
    expect(describePaymentMethod(null)).toBe('not recorded');
  });
});
