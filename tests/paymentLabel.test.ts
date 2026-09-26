import { describe, expect, it } from 'vitest';
import { describeOrderPayment, describePaymentMethod } from '@/lib/orders/paymentLabel';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';

describe('describeOrderPayment', () => {
  it('names every part of a split, in the order taken', () => {
    expect(
      describeOrderPayment({
        payment_method: 'cash',
        payments: [
          { method: 'cash', amount_inr: 300 },
          { method: 'upi', amount_inr: 180 },
        ],
      }),
    ).toBe('Cash ₹300 + UPI ₹180');
    expect(
      describeOrderPayment({
        payment_method: 'card',
        payments: [
          { method: 'cash', amount_inr: 100 },
          { method: 'card', amount_inr: 400 },
        ],
      }),
    ).toBe('Cash ₹100 + Card ₹400');
  });

  it('names a single method plainly', () => {
    expect(describeOrderPayment({ payment_method: 'upi', payments: [] })).toBe('UPI');
    expect(describeOrderPayment({ payment_method: 'cash' })).toBe('Cash');
    expect(describeOrderPayment({ payment_method: 'cash', payments: [{ method: 'upi', amount_inr: 480 }] })).toBe('UPI');
    expect(describePaymentMethod(null)).toBe('not recorded');
  });
});

describe('toOrderResponse payments', () => {
  const base = { id: 'o1', order_items: [] } as unknown as OrderRowWithItems;

  it('maps embedded order_payments to payments, oldest first', () => {
    const res = toOrderResponse({
      ...base,
      order_payments: [
        { method: 'upi', amount_inr: 180, created_at: '2026-09-26T10:00:01Z' },
        { method: 'cash', amount_inr: 300, created_at: '2026-09-26T10:00:00Z' },
      ],
    });
    expect(res.payments).toEqual([
      { method: 'cash', amount_inr: 300 },
      { method: 'upi', amount_inr: 180 },
    ]);
    expect(res).not.toHaveProperty('order_payments');
  });

  it('adds nothing when the query did not embed payments', () => {
    expect(toOrderResponse(base)).not.toHaveProperty('payments');
  });
});
