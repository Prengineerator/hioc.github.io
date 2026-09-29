import { describe, expect, it } from 'vitest';
import { orderMethods, receivedByMethod, totalReceived } from '@/lib/orders/paymentTotals';
import type { Order } from '@/lib/types';

type O = Parameters<typeof receivedByMethod>[0][number];

const order = (over: Partial<O>): O => ({
  status: 'completed',
  payment_status: 'paid',
  payment_method: 'cash',
  payments: undefined,
  total_inr: 100,
  subtotal_inr: 90,
  ...over,
});

describe('receivedByMethod', () => {
  it('is all zero for no orders', () => {
    const r = receivedByMethod([]);
    expect(totalReceived(r)).toBe(0);
    expect(r.cash).toEqual({ amount_inr: 0, orders: 0 });
  });

  it('uses payment_method + total for a single-method order', () => {
    const r = receivedByMethod([
      order({ payment_method: 'upi', total_inr: 250 }),
      order({ payment_method: 'upi', total_inr: 50 }),
      order({ payment_method: 'cash', total_inr: 120 }),
    ]);
    expect(r.upi).toEqual({ amount_inr: 300, orders: 2 });
    expect(r.cash).toEqual({ amount_inr: 120, orders: 1 });
  });

  it('falls back to subtotal when total is null', () => {
    const r = receivedByMethod([order({ payment_method: 'card', total_inr: null, subtotal_inr: 80 })]);
    expect(r.card.amount_inr).toBe(80);
  });

  it('splits an order across its parts, counting the order once per method', () => {
    const r = receivedByMethod([
      order({
        payment_method: 'cash',
        total_inr: 480,
        payments: [
          { method: 'cash', amount_inr: 300 },
          { method: 'upi', amount_inr: 180 },
        ],
      }),
    ]);
    expect(r.cash).toEqual({ amount_inr: 300, orders: 1 });
    expect(r.upi).toEqual({ amount_inr: 180, orders: 1 });
    expect(totalReceived(r)).toBe(480);
  });

  it('merges repeated parts of the same method into one order count', () => {
    const r = receivedByMethod([
      order({
        payments: [
          { method: 'cash', amount_inr: 100 },
          { method: 'cash', amount_inr: 50 },
        ],
      }),
    ]);
    expect(r.cash).toEqual({ amount_inr: 150, orders: 1 });
  });

  it('counts partially refunded orders but not refunded, unpaid or pending ones', () => {
    const r = receivedByMethod([
      order({ payment_status: 'partially_refunded', total_inr: 100 }),
      order({ payment_status: 'refunded' }),
      order({ payment_status: 'unpaid', payment_method: null }),
      order({ payment_status: 'payment_pending', payment_method: 'online' }),
    ]);
    expect(r.cash).toEqual({ amount_inr: 100, orders: 1 });
    expect(totalReceived(r)).toBe(100);
  });

  it('ignores cancelled and rejected orders', () => {
    const r = receivedByMethod([order({ status: 'cancelled' }), order({ status: 'rejected' })]);
    expect(totalReceived(r)).toBe(0);
  });

  it('ignores a paid order with no recorded method', () => {
    expect(totalReceived(receivedByMethod([order({ payment_method: null })]))).toBe(0);
  });
});

describe('orderMethods', () => {
  it('lists every method of a split, or the single method', () => {
    const base = { payment_method: 'cash', payments: undefined } as Pick<Order, 'payment_method' | 'payments'>;
    expect(orderMethods(base)).toEqual(['cash']);
    expect(
      orderMethods({
        ...base,
        payments: [
          { method: 'cash', amount_inr: 1 },
          { method: 'upi', amount_inr: 2 },
          { method: 'cash', amount_inr: 3 },
        ],
      }),
    ).toEqual(['cash', 'upi']);
    expect(orderMethods({ payment_method: null, payments: [] })).toEqual([]);
  });
});
