import { describe, expect, it } from 'vitest';
import { matchesPayment, matchesSearch, matchesStatusGroup } from '@/lib/orders/todayFilters';

type PayOrder = Parameters<typeof matchesPayment>[0];

const paid = (over: Partial<PayOrder> = {}): PayOrder => ({
  status: 'completed',
  payment_status: 'paid',
  payment_method: 'cash',
  payments: undefined,
  ...over,
});

describe('matchesStatusGroup', () => {
  it('groups statuses', () => {
    expect(matchesStatusGroup({ status: 'preparing' }, 'running')).toBe(true);
    expect(matchesStatusGroup({ status: 'completed' }, 'running')).toBe(false);
    expect(matchesStatusGroup({ status: 'completed' }, 'completed')).toBe(true);
    expect(matchesStatusGroup({ status: 'rejected' }, 'cancelled')).toBe(true);
    expect(matchesStatusGroup({ status: 'rejected' }, 'all')).toBe(true);
  });
});

describe('matchesPayment', () => {
  it('a method matches paid orders in that method', () => {
    expect(matchesPayment(paid(), 'cash')).toBe(true);
    expect(matchesPayment(paid(), 'upi')).toBe(false);
  });

  it('a split order matches every method it contains', () => {
    const split = paid({
      payments: [
        { method: 'cash', amount_inr: 300 },
        { method: 'upi', amount_inr: 180 },
      ],
    });
    expect(matchesPayment(split, 'cash')).toBe(true);
    expect(matchesPayment(split, 'upi')).toBe(true);
    expect(matchesPayment(split, 'card')).toBe(false);
  });

  it('unpaid means still to collect; an unpaid order never matches a method', () => {
    const due = paid({ payment_status: 'unpaid', payment_method: null });
    expect(matchesPayment(due, 'unpaid')).toBe(true);
    expect(matchesPayment(due, 'cash')).toBe(false);
    expect(matchesPayment(paid(), 'unpaid')).toBe(false);
    expect(matchesPayment(paid({ status: 'cancelled', payment_status: 'unpaid', payment_method: null }), 'unpaid')).toBe(
      false,
    );
  });

  it('all matches everything', () => {
    expect(matchesPayment(paid({ status: 'cancelled' }), 'all')).toBe(true);
  });
});

describe('matchesSearch', () => {
  const o = {
    order_number: 1042,
    customer_name: 'Asha Rao',
    customer_phone: '+91 98765 43210',
    table_label: 'T5',
    pickup_code: 'A17',
  };

  it('matches everything on an empty query', () => {
    expect(matchesSearch(o, '   ')).toBe(true);
  });

  it('matches the order number as printed or bare, with or without #', () => {
    expect(matchesSearch(o, 'HIOC-001042')).toBe(true);
    expect(matchesSearch(o, '1042')).toBe(true);
    expect(matchesSearch(o, '#1042')).toBe(true);
    expect(matchesSearch(o, '9999')).toBe(false);
  });

  it('matches name, table and token case-insensitively', () => {
    expect(matchesSearch(o, 'asha')).toBe(true);
    expect(matchesSearch(o, 't5')).toBe(true);
    expect(matchesSearch(o, 'a17')).toBe(true);
    expect(matchesSearch(o, 'zzz')).toBe(false);
  });

  it('matches phone digits regardless of formatting, but not on a stray digit', () => {
    expect(matchesSearch(o, '98765 43210')).toBe(true);
    expect(matchesSearch(o, '43210')).toBe(true);
    expect(matchesSearch(o, '8')).toBe(false);
  });

  it('tolerates a null pickup code', () => {
    expect(matchesSearch({ ...o, pickup_code: null }, 'a17')).toBe(false);
  });
});
