import { describe, expect, it } from 'vitest';
import {
  tenderBalances,
  totalRefundedInr,
  validateCounterRefund,
  type PriorRefund,
  type TenderPart,
} from '@/lib/orders/refunds';

// REF-1 — counter refunds. The gap being closed: the refund route required a
// gateway payment, so a cash/UPI/card order settled at the till could NEVER be
// refunded in-system (409 every time) while the staff UI offered the button.
//
// D4-2 is decided here: a refund targets a CHOSEN tender rather than being
// spread proportionally, because you cannot hand back more cash than the
// customer paid in cash.

const cashOnly: TenderPart[] = [{ method: 'cash', amount_inr: 480 }];
const split: TenderPart[] = [
  { method: 'cash', amount_inr: 200 },
  { method: 'upi', amount_inr: 280 },
];

describe('tenderBalances', () => {
  it('reports the full amount refundable when nothing has been refunded', () => {
    expect(tenderBalances(cashOnly, [])).toEqual([
      { method: 'cash', paid_inr: 480, refunded_inr: 0, refundable_inr: 480 },
    ]);
  });

  it('tracks each tender of a split independently', () => {
    const b = tenderBalances(split, [{ method: 'cash', amount_inr: 50 }]);
    expect(b).toEqual([
      { method: 'cash', paid_inr: 200, refunded_inr: 50, refundable_inr: 150 },
      { method: 'upi', paid_inr: 280, refunded_inr: 0, refundable_inr: 280 },
    ]);
  });

  it('merges repeated tenders of the same method', () => {
    const b = tenderBalances(
      [
        { method: 'cash', amount_inr: 100 },
        { method: 'cash', amount_inr: 150 },
      ],
      [],
    );
    expect(b).toHaveLength(1);
    expect(b[0].paid_inr).toBe(250);
  });

  it('charges a legacy method-less refund against the LARGEST tender', () => {
    // Ignoring it would let the same money be refunded twice; the largest
    // tender is the likely source and the conservative attribution.
    const b = tenderBalances(split, [{ method: null, amount_inr: 100 }]);
    expect(b.find((x) => x.method === 'upi')?.refundable_inr).toBe(180);
    expect(b.find((x) => x.method === 'cash')?.refundable_inr).toBe(200);
  });

  it('never reports a negative refundable balance', () => {
    const over: PriorRefund[] = [{ method: 'cash', amount_inr: 900 }];
    expect(tenderBalances(cashOnly, over)[0].refundable_inr).toBe(0);
  });
});

describe('validateCounterRefund', () => {
  const balances = (parts: TenderPart[], prior: PriorRefund[] = []) => tenderBalances(parts, prior);

  it('defaults to the only tender and the full remaining amount', () => {
    const r = validateCounterRefund(balances(cashOnly), undefined, undefined);
    expect(r).toEqual({ ok: true, method: 'cash', amountInr: 480 });
  });

  it('DEMANDS a tender choice on a split — it must not guess', () => {
    const r = validateCounterRefund(balances(split), undefined, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('choose which tender');
      expect(r.error).toContain('cash');
      expect(r.error).toContain('upi');
    }
  });

  it('honours an explicit tender and partial amount', () => {
    const r = validateCounterRefund(balances(split), 'upi', 100);
    expect(r).toEqual({ ok: true, method: 'upi', amountInr: 100 });
  });

  it('refuses more cash back than the customer paid in cash', () => {
    // The whole point of per-tender limits: ₹480 order, only ₹200 of it cash.
    const r = validateCounterRefund(balances(split), 'cash', 300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Only ₹200 is refundable on cash');
  });

  it('refuses a tender the order was never paid on', () => {
    const r = validateCounterRefund(balances(cashOnly), 'upi', 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Nothing left to refund on upi');
  });

  it('refuses an already fully-refunded order', () => {
    const r = validateCounterRefund(
      balances(cashOnly, [{ method: 'cash', amount_inr: 480 }]),
      undefined,
      undefined,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('already been fully refunded');
  });

  it('rejects a non-integer, zero or negative amount', () => {
    expect(validateCounterRefund(balances(cashOnly), 'cash', 10.5).ok).toBe(false);
    expect(validateCounterRefund(balances(cashOnly), 'cash', 0).ok).toBe(false);
    expect(validateCounterRefund(balances(cashOnly), 'cash', -100).ok).toBe(false);
  });

  it('rejects an unknown method', () => {
    expect(validateCounterRefund(balances(cashOnly), 'crypto', 100).ok).toBe(false);
  });

  it('auto-selects when a split has only one tender left with a balance', () => {
    // cash fully refunded already → no ambiguity remains, so no choice needed.
    const r = validateCounterRefund(balances(split, [{ method: 'cash', amount_inr: 200 }]), undefined, undefined);
    expect(r).toEqual({ ok: true, method: 'upi', amountInr: 280 });
  });
});

describe('totalRefundedInr', () => {
  it('sums across every tender', () => {
    expect(
      totalRefundedInr([
        { method: 'cash', amount_inr: 200 },
        { method: 'upi', amount_inr: 80 },
      ]),
    ).toBe(280);
  });

  it('is zero for no refunds', () => {
    expect(totalRefundedInr([])).toBe(0);
  });
});
