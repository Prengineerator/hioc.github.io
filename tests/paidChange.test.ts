import { describe, expect, it } from 'vitest';
import {
  PAID_BILL_LOCKED,
  PAID_CHANGE_MIGRATION,
  appendSettleReason,
  balanceCompletionBlock,
  balanceOf,
  changedAfterPayment,
  describeBalance,
  hasOpenBalance,
  nextBalance,
  originalTenderRow,
  paidChangeBlockReason,
  settledInr,
} from '@/lib/orders/paidChange';
import { settleEditBlockReason } from '@/lib/orders/settleEdit';
import { canChangePayment, hasBalanceToSettle } from '@/lib/orders/settleList';
import type { OrderStatus, PaymentMethod, PaymentStatus } from '@/lib/types';

// Changing a dine-in order after it is paid — the pure rules
// (lib/orders/paidChange.ts, supabase/2026-11-paid-order-changes.sql).

type Fixture = {
  status: OrderStatus;
  order_type: string;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod | null;
  order_kind?: string;
  balance_due_inr?: number;
  paid_amended_at: string | null;
};
const paidDineIn = (extra: Partial<Fixture> = {}): Fixture => ({
  status: 'preparing',
  order_type: 'dine_in',
  payment_status: 'paid',
  payment_method: 'cash',
  balance_due_inr: 0,
  paid_amended_at: null,
  ...extra,
});

describe('paidChangeBlockReason', () => {
  it('allows a dine-in bill paid at the counter, by any counter tender', () => {
    for (const method of ['cash', 'upi', 'card', 'swiggy_dineout', 'zomato_district', null] as const) {
      expect(paidChangeBlockReason(paidDineIn({ payment_method: method }))).toBeNull();
    }
  });

  it('keeps every other order type locked once paid, with the old wording', () => {
    expect(paidChangeBlockReason(paidDineIn({ order_type: 'takeaway' }))).toBe(PAID_BILL_LOCKED);
    expect(paidChangeBlockReason(paidDineIn({ order_type: 'delivery' }))).toBe(PAID_BILL_LOCKED);
  });

  it('refuses a bill paid online — the gateway owns that payment', () => {
    expect(paidChangeBlockReason(paidDineIn({ payment_method: 'online' }))).toContain('paid online');
  });

  it('refuses a HIOC Ritual sale before anything else', () => {
    expect(paidChangeBlockReason(paidDineIn({ order_kind: 'coffee_pass' }))).toContain('cancel it instead');
  });

  it('names the migration when the database has no balance column yet', () => {
    const { balance_due_inr: _b, ...unmigrated } = paidDineIn();
    void _b;
    const reason = paidChangeBlockReason(unmigrated);
    expect(reason).toContain(PAID_BILL_LOCKED);
    expect(reason).toContain(PAID_CHANGE_MIGRATION);
  });
});

describe('settleEditBlockReason on a paid bill', () => {
  it('lets a paid dine-in bill be edited while it is open', () => {
    expect(settleEditBlockReason(paidDineIn())).toBeNull();
    expect(settleEditBlockReason(paidDineIn({ status: 'ready' }))).toBeNull();
  });

  it('still refuses a paid dine-in bill that is no longer open', () => {
    expect(settleEditBlockReason(paidDineIn({ status: 'completed' }))).toContain('stock');
    expect(settleEditBlockReason(paidDineIn({ status: 'received' }))).toContain('Accept this order');
  });

  it('still refuses a paid takeaway bill', () => {
    expect(settleEditBlockReason(paidDineIn({ order_type: 'takeaway' }))).toBe(PAID_BILL_LOCKED);
  });
});

describe('balance math', () => {
  it('adds the change in the total to whatever was outstanding', () => {
    // ₹500 paid in full, a ₹150 coffee added.
    expect(nextBalance(0, 500, 650)).toBe(150);
    // Then the ₹120 brownie taken off: ₹30 still to collect.
    expect(nextBalance(150, 650, 530)).toBe(30);
    // Then more off than was added: the café owes ₹90 back.
    expect(nextBalance(30, 530, 410)).toBe(-90);
  });

  it('reads a missing or odd balance as nothing outstanding', () => {
    expect(balanceOf({})).toBe(0);
    expect(balanceOf({ balance_due_inr: null })).toBe(0);
    expect(balanceOf({ balance_due_inr: Number.NaN })).toBe(0);
    expect(balanceOf({ balance_due_inr: -40 })).toBe(-40);
  });

  it('works out what has been settled from the total and the balance', () => {
    expect(settledInr({ total_inr: 650, subtotal_inr: 620, balance_due_inr: 150 })).toBe(500);
    expect(settledInr({ total_inr: 410, subtotal_inr: 390, balance_due_inr: -90 })).toBe(500);
    expect(settledInr({ total_inr: null, subtotal_inr: 300 })).toBe(300);
  });

  it('says which way the money goes', () => {
    expect(describeBalance(120)).toBe('₹120 to collect');
    expect(describeBalance(-40)).toBe('₹40 to give back');
    expect(describeBalance(0)).toBe('');
  });
});

describe('open balances and the Settle list', () => {
  it('is a paid, live bill with a balance either way', () => {
    expect(hasOpenBalance(paidDineIn({ balance_due_inr: 120 }))).toBe(true);
    expect(hasOpenBalance(paidDineIn({ balance_due_inr: -40 }))).toBe(true);
    expect(hasBalanceToSettle(paidDineIn({ status: 'completed', balance_due_inr: -40 }))).toBe(true);
  });

  it('is not an unpaid, settled-up or dead bill', () => {
    expect(hasOpenBalance(paidDineIn())).toBe(false);
    expect(hasOpenBalance(paidDineIn({ payment_status: 'unpaid', balance_due_inr: 120 }))).toBe(false);
    expect(hasOpenBalance(paidDineIn({ status: 'cancelled', balance_due_inr: 120 }))).toBe(false);
    expect(hasOpenBalance(paidDineIn({ status: 'rejected', balance_due_inr: -40 }))).toBe(false);
  });
});

describe('completing with a balance', () => {
  it('holds an order the customer still owes money on', () => {
    expect(balanceCompletionBlock({ balance_due_inr: 120 })).toBe('Collect the ₹120 balance before completing this order.');
  });

  it("doesn't hold one the café owes money back on, or one settled up", () => {
    expect(balanceCompletionBlock({ balance_due_inr: -40 })).toBeNull();
    expect(balanceCompletionBlock({ balance_due_inr: 0 })).toBeNull();
    expect(balanceCompletionBlock({})).toBeNull();
  });
});

describe('Change payment after a paid bill was changed', () => {
  it('is refused once the paid bill has been changed, settled up or not', () => {
    expect(changedAfterPayment({ paid_amended_at: '2026-11-07T10:00:00Z', balance_due_inr: 0 })).toBe(true);
    expect(changedAfterPayment({ balance_due_inr: 120 })).toBe(true);
    expect(canChangePayment(paidDineIn({ paid_amended_at: '2026-11-07T10:00:00Z' }))).toBe(false);
    expect(canChangePayment(paidDineIn({ balance_due_inr: -40 }))).toBe(false);
  });

  it('is still offered on a paid bill that was never changed', () => {
    expect(changedAfterPayment({})).toBe(false);
    expect(canChangePayment(paidDineIn())).toBe(true);
    expect(canChangePayment({ status: 'ready', payment_status: 'paid', payment_method: 'upi' })).toBe(true);
  });
});

describe('originalTenderRow — the payment that really happened, as a row', () => {
  const single = {
    payment_method: 'cash',
    total_inr: 500,
    subtotal_inr: 476,
    paid_at: '2026-11-07T08:30:00.123456+00:00',
    paid_amended_at: null,
  };

  it('writes a single counter tender with its method, its amount and the moment it was paid', () => {
    expect(originalTenderRow(single, false)).toEqual({
      method: 'cash',
      amount_inr: 500,
      created_at: '2026-11-07T08:30:00.123456+00:00',
    });
    expect(originalTenderRow({ ...single, payment_method: 'upi' }, false)?.method).toBe('upi');
    expect(originalTenderRow({ ...single, payment_method: 'card' }, false)?.method).toBe('card');
  });

  it('falls back to the subtotal on a row with no total, as every reader does', () => {
    expect(originalTenderRow({ ...single, total_inr: null }, false)?.amount_inr).toBe(476);
  });

  it('writes nothing when the bill already has tender rows', () => {
    expect(originalTenderRow(single, true)).toBeNull();
  });

  it('writes nothing on a second change (the first one wrote it)', () => {
    expect(originalTenderRow({ ...single, paid_amended_at: '2026-11-07T09:00:00Z' }, false)).toBeNull();
  });

  it('writes nothing when nothing was taken, or the method is not a single counter tender', () => {
    expect(originalTenderRow({ ...single, payment_method: null }, false)).toBeNull();
    expect(originalTenderRow({ ...single, payment_method: 'online' }, false)).toBeNull();
    expect(originalTenderRow({ ...single, payment_method: 'swiggy_dineout' }, false)).toBeNull();
    expect(originalTenderRow({ ...single, total_inr: 0 }, false)).toBeNull();
  });

  it('writes nothing when the moment of payment is unknown', () => {
    expect(originalTenderRow({ ...single, paid_at: null }, false)).toBeNull();
  });
});

describe('appendSettleReason', () => {
  it('keeps the bill’s own reason and adds the balance’s', () => {
    expect(appendSettleReason('No change', 'Rounded off')).toBe('No change; Balance: Rounded off');
    expect(appendSettleReason('', 'Customer left')).toBe('Balance: Customer left');
    expect(appendSettleReason(null, '  ')).toBe('');
    expect(appendSettleReason('No change', '')).toBe('No change');
  });

  it('never grows without bound', () => {
    expect(appendSettleReason('x'.repeat(390), 'y'.repeat(50)).length).toBe(400);
  });
});

describe('the ready → completed guard with a balance', () => {
  it('holds a paid bill with money still owed, and names the amount', async () => {
    const { canTransition } = await import('@/lib/orders/stateMachine');
    const check = canTransition('ready', 'completed', 'staff', undefined, { paymentStatus: 'paid', balanceDueInr: 130 });
    expect(check).toMatchObject({ ok: false, code: 'payment_required' });
    expect(check.message).toContain('₹130');
  });

  it('lets one through that the café owes money back on, or that is settled up', async () => {
    const { canTransition } = await import('@/lib/orders/stateMachine');
    expect(canTransition('ready', 'completed', 'staff', undefined, { paymentStatus: 'paid', balanceDueInr: -40 }).ok).toBe(true);
    expect(canTransition('ready', 'completed', 'staff', undefined, { paymentStatus: 'paid', balanceDueInr: 0 }).ok).toBe(true);
    expect(canTransition('ready', 'completed', 'staff', undefined, { paymentStatus: 'paid' }).ok).toBe(true);
  });

  it('still holds an unpaid bill as before', async () => {
    const { canTransition } = await import('@/lib/orders/stateMachine');
    expect(canTransition('ready', 'completed', 'staff', undefined, { paymentStatus: 'unpaid' }).message).toBe(
      'Collect payment before completing this order',
    );
  });
});
