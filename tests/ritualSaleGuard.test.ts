import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { afterEarlierSaleCheck, saleMayBePaid } from '@/components/passes/ritualSaleGuard';

// Buying a HIOC Ritual (components/passes/ritualSaleGuard.ts): Buy never starts
// a second sale while the first may already be paid.

describe('which sales are remembered as possibly paid', () => {
  it('a gateway success, verified or not', () => {
    expect(saleMayBePaid({ kind: 'paid' })).toBe(true);
    expect(saleMayBePaid({ kind: 'unverified', message: 'Network error while confirming your payment.' })).toBe(true);
  });

  it('not a closed window or one that never opened', () => {
    expect(saleMayBePaid({ kind: 'dismissed' })).toBe(false);
    expect(saleMayBePaid({ kind: 'dismissed', lastFailure: 'Card declined' })).toBe(false);
    expect(saleMayBePaid({ kind: 'unavailable', message: 'x' })).toBe(false);
  });
});

describe('what Buy does about the earlier sale', () => {
  it('paid → wait for that Ritual instead of selling another', () => {
    expect(afterEarlierSaleCheck('paid')).toBe('wait_for_pass');
    expect(afterEarlierSaleCheck('partially_refunded')).toBe('wait_for_pass');
  });

  it('nothing captured / refunded / gone → sell', () => {
    for (const s of ['payment_pending', 'unpaid', 'refunded', 'not_found']) expect(afterEarlierSaleCheck(s), s).toBe('sell');
  });

  it('no answer, or an answer this page does not know → do not sell', () => {
    expect(afterEarlierSaleCheck(null)).toBe('blocked');
    expect(afterEarlierSaleCheck('something_new')).toBe('blocked');
  });

  it("a 'payment_pending' the server could not confirm with Razorpay → do not sell", () => {
    expect(afterEarlierSaleCheck('payment_pending', false)).toBe('blocked');
    expect(afterEarlierSaleCheck('payment_pending', true)).toBe('sell');
    // An older server that sends no gateway_checked keeps the old reading.
    expect(afterEarlierSaleCheck('payment_pending', undefined)).toBe('sell');
    // gateway_checked only qualifies 'payment_pending'; a stored outcome stands.
    expect(afterEarlierSaleCheck('paid', false)).toBe('wait_for_pass');
    expect(afterEarlierSaleCheck('unpaid', false)).toBe('sell');
  });

  it('RitualExperience checks before starting a sale, and remembers a possibly-paid one', () => {
    const src = readFileSync('components/passes/RitualExperience.tsx', 'utf8');
    const checkAt = src.indexOf(
      'afterEarlierSaleCheck(earlierSale.paymentStatus, earlierSale.gatewayChecked)',
    );
    expect(src).toContain('const earlierSale = await readSalePaymentStatus(earlier.orderId);');
    const sellAt = src.indexOf("fetch('/api/passes/checkout'");
    expect(checkAt).toBeGreaterThan(-1);
    expect(sellAt).toBeGreaterThan(checkAt);
    expect(src).toContain('if (saleMayBePaid(outcome)) maybePaid.current = { orderId, planName: plan.name };');
  });
});
