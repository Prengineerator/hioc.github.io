import { describe, it, expect } from 'vitest';
import {
  allocatePassDrinks,
  composePassBill,
  MAX_PASS_DRINKS_PER_ORDER,
  parsePassDrinks,
  passCapacity,
  passExpiresAt,
  passRedeemMessage,
  passShortfallMessage,
  passState,
  planDiscountPercent,
  validateAdjustInput,
  validatePlanInput,
} from '@/lib/passes/rules';
import { cupsLabel, PASS_PROGRAM_NAME, PASS_SHORT_NAME, PASS_UNIT } from '@/lib/passes/brand';
import type { PassLine, PassRedeemCode, UsablePass } from '@/lib/passes/types';
import { computeBill, FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

// The pure rules behind the prepaid coffee pass ("HIOC Ritual",
// docs/COFFEE-PASS-SPEC.md). A wrong number here is money: a pass that covers
// too much gives coffee away, one that covers too little short-changes a
// customer who already paid, so every branch is pinned, and the worked
// examples of spec §6 are asserted end to end (allocation + bill).

// GST 5% exclusive, no packaging — the store defaults the spec's examples use.
const EXCLUSIVE: StoreSettings = { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 0 };
const INCLUSIVE: StoreSettings = { ...EXCLUSIVE, gst_inclusive: true };

const NOW = new Date('2026-10-05T06:00:00Z'); // Monday 11:30 IST
const IN_A_WEEK = '2026-10-12T18:30:00.000Z';

function line(key: string, unit: number, quantity = 1, over: Partial<PassLine> = {}): PassLine {
  return { key, menu_item_id: `item-${key}`, unit_price_inr: unit, quantity, eligible: true, gst_exempt: false, ...over };
}

function pass(id: string, remaining: number, over: Partial<UsablePass> = {}): UsablePass {
  return { id, drinks_remaining: remaining, drink_value_inr: 150, expires_at: IN_A_WEEK, max_per_day: null, used_today: 0, ...over };
}

/** The whole path an order takes: allocate, then price the bill. */
function price(lines: PassLine[], passes: UsablePass[], requested: number, settings: StoreSettings, couponPercent = 0) {
  const a = allocatePassDrinks({ lines, passes, requested, now: NOW });
  const subtotal = lines.reduce((s, l) => s + l.unit_price_inr * l.quantity, 0);
  const taxable = lines.filter((l) => !l.gst_exempt).reduce((s, l) => s + l.unit_price_inr * l.quantity, 0);
  // CP-D12: the coupon is computed on subtotal - pass cover.
  const coupon = Math.round(((subtotal - a.covered_inr) * couponPercent) / 100);
  const bill = composePassBill(
    {
      subtotalInr: subtotal,
      taxableSubtotalInr: taxable,
      discountInr: coupon,
      passCoveredInr: a.covered_inr,
      passCoveredTaxableInr: a.covered_taxable_inr,
    },
    settings,
  );
  return { a, bill, coupon };
}

// ---------------------------------------------------------------------------
// Spec §6 worked examples
// ---------------------------------------------------------------------------

describe('spec §6 worked examples (GST 5% exclusive, drink value ₹150)', () => {
  it.each([
    {
      name: 'A. Cappuccino L ₹120, 1 pass drink',
      lines: [line('cap', 120)],
      requested: 1,
      covered: 120,
      taxable: 0,
      tax: 0,
      total: 0,
    },
    {
      name: 'B. Lotus Biscoff Latte XL ₹215 + Cappuccino L ₹120, 2 pass drinks',
      lines: [line('lotus', 215), line('cap', 120)],
      requested: 2,
      covered: 270, // 150 (capped at the drink value) + 120
      taxable: 65,
      tax: 3,
      total: 68,
    },
    {
      name: 'D. 3 Cappuccinos, 1 pass drink left',
      lines: [line('cap', 120, 3)],
      requested: 3, // asks for 3, holds 1
      passes: [pass('p1', 1)],
      covered: 120,
      taxable: 240,
      tax: 12,
      total: 252,
    },
  ])('$name', ({ lines, requested, passes, covered, taxable, tax, total }) => {
    const { a, bill } = price(lines, passes ?? [pass('p1', 7)], requested, EXCLUSIVE);
    expect(a.covered_inr).toBe(covered);
    expect(a.covered_taxable_inr).toBe(covered);
    expect(bill.subtotal_inr - a.covered_taxable_inr).toBe(taxable);
    expect(bill.tax_inr).toBe(tax);
    expect(bill.total_inr).toBe(total);
    expect(bill.pass_discount_inr).toBe(covered);
    expect(bill.discount_inr).toBe(0);
  });

  it('C. Latte L ₹140 + Sandwich ₹180 (not eligible), 1 pass drink, 10% coupon: ₹171', () => {
    const lines = [line('latte', 140), line('sandwich', 180, 1, { eligible: false })];
    const { a, bill, coupon } = price(lines, [pass('p1', 7)], 1, EXCLUSIVE, 10);
    expect(a.covered_inr).toBe(140);
    expect(a.allocations).toEqual([{ pass_id: 'p1', line_key: 'latte', drinks: 1, covered_inr: 140 }]);
    expect(coupon).toBe(18); // 10% of (320 - 140)
    expect(bill.subtotal_inr).toBe(320);
    expect(bill.tax_inr).toBe(9); // GST on 180
    expect(bill.discount_inr).toBe(18); // coupon only
    expect(bill.pass_discount_inr).toBe(140); // pass kept apart
    expect(bill.total_inr).toBe(171);
    // The identity every renderer relies on.
    expect(bill.total_inr).toBe(
      bill.subtotal_inr + bill.tax_inr + bill.packaging_inr - bill.discount_inr - bill.pass_discount_inr,
    );
  });

  it('selling a Weekly pass: ₹750 + GST ₹38 = ₹788 (no pass cover)', () => {
    const bill = composePassBill(
      { subtotalInr: 750, taxableSubtotalInr: 750, discountInr: 0, passCoveredInr: 0, passCoveredTaxableInr: 0 },
      EXCLUSIVE,
    );
    expect(bill.tax_inr).toBe(38);
    expect(bill.total_inr).toBe(788);
    expect(bill.pass_discount_inr).toBe(0);
  });

  it('GST-inclusive selling: the total stays ₹750 and ₹36 of it is GST', () => {
    const bill = composePassBill(
      { subtotalInr: 750, taxableSubtotalInr: 750, discountInr: 0, passCoveredInr: 0, passCoveredTaxableInr: 0 },
      INCLUSIVE,
    );
    expect(bill.tax_inr).toBe(36);
    expect(bill.total_inr).toBe(750);
  });
});

describe('GST-inclusive pricing (the same four orders)', () => {
  it.each([
    { name: 'A', lines: [line('cap', 120)], requested: 1, tax: 0, total: 0 },
    { name: 'B', lines: [line('lotus', 215), line('cap', 120)], requested: 2, tax: 3, total: 65 },
    { name: 'D', lines: [line('cap', 120, 3)], requested: 1, tax: 11, total: 240 },
  ])('$name: the pass still leaves the taxable base', ({ lines, requested, tax, total }) => {
    const { bill } = price(lines, [pass('p1', 7)], requested, INCLUSIVE);
    expect(bill.tax_inr).toBe(tax);
    expect(bill.total_inr).toBe(total);
  });

  it('C with a coupon: total = subtotal - coupon - pass', () => {
    const lines = [line('latte', 140), line('sandwich', 180, 1, { eligible: false })];
    const { bill } = price(lines, [pass('p1', 7)], 1, INCLUSIVE, 10);
    expect(bill.tax_inr).toBe(9 - 0); // 180 - 180/1.05, rounded
    expect(bill.total_inr).toBe(320 - 18 - 140);
  });
});

describe('composePassBill', () => {
  it('equals computeBill with discount + pass cover and the taxable base reduced by the covered taxable', () => {
    const input = { subtotalInr: 335, taxableSubtotalInr: 335, discountInr: 20, passCoveredInr: 270, passCoveredTaxableInr: 270 };
    const composed = composePassBill(input, EXCLUSIVE);
    const direct = computeBill(335, EXCLUSIVE, 20 + 270, 335 - 270);
    expect(composed.tax_inr).toBe(direct.tax_inr);
    expect(composed.total_inr).toBe(direct.total_inr);
    expect(composed.discount_inr).toBe(20);
    expect(composed.pass_discount_inr).toBe(270);
  });

  it('keeps packaging (the caller decides it) in the total', () => {
    const settings = { ...EXCLUSIVE, packaging_charge_inr: 10 };
    const bill = composePassBill(
      { subtotalInr: 120, taxableSubtotalInr: 120, discountInr: 0, passCoveredInr: 120, passCoveredTaxableInr: 120 },
      settings,
    );
    expect(bill.packaging_inr).toBe(10);
    expect(bill.total_inr).toBe(10);
  });

  it('a GST-exempt cup leaves the taxable base untouched', () => {
    // 120 exempt (covered by the pass) + 100 taxable: GST stays on the 100.
    const bill = composePassBill(
      { subtotalInr: 220, taxableSubtotalInr: 100, discountInr: 0, passCoveredInr: 120, passCoveredTaxableInr: 0 },
      EXCLUSIVE,
    );
    expect(bill.tax_inr).toBe(5);
    expect(bill.total_inr).toBe(220 + 5 - 120);
  });

  it('never lets the pass cover more than was sold, or more taxable than it covers', () => {
    const bill = composePassBill(
      { subtotalInr: 100, taxableSubtotalInr: 100, discountInr: 0, passCoveredInr: 500, passCoveredTaxableInr: 900 },
      EXCLUSIVE,
    );
    expect(bill.pass_discount_inr).toBe(100);
    expect(bill.total_inr).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

describe('passCapacity', () => {
  const at = (over: Partial<UsablePass>) => passCapacity(pass('p', 5, over), NOW);

  it.each([
    { name: 'the cups left, with no cap', over: {}, want: 5 },
    { name: 'a cap above the cups left does not bind', over: { max_per_day: 9 }, want: 5 },
    { name: 'the cap less today\'s use', over: { max_per_day: 2, used_today: 1 }, want: 1 },
    { name: 'a cap already used up today', over: { max_per_day: 1, used_today: 1 }, want: 0 },
    { name: 'use beyond the cap never goes negative', over: { max_per_day: 1, used_today: 3 }, want: 0 },
    { name: 'no cups left', over: { drinks_remaining: 0 }, want: 0 },
    { name: 'a negative balance reads as none', over: { drinks_remaining: -2 }, want: 0 },
    { name: 'expired the instant expires_at is reached', over: { expires_at: NOW.toISOString() }, want: 0 },
    { name: 'still good one millisecond before expires_at', over: { expires_at: new Date(NOW.getTime() + 1).toISOString() }, want: 5 },
    { name: 'an unreadable expiry counts as expired', over: { expires_at: 'not a date' }, want: 0 },
  ])('$name', ({ over, want }) => {
    expect(at(over)).toBe(want);
  });
});

describe('allocatePassDrinks', () => {
  it('covers the most expensive eligible units first', () => {
    const r = allocatePassDrinks({
      lines: [line('cheap', 80), line('dear', 200), line('mid', 150)],
      passes: [pass('p1', 7)],
      requested: 2,
      now: NOW,
    });
    expect(r.allocations).toEqual([
      { pass_id: 'p1', line_key: 'dear', drinks: 1, covered_inr: 150 }, // capped at the drink value
      { pass_id: 'p1', line_key: 'mid', drinks: 1, covered_inr: 150 },
    ]);
    expect(r.by_line).toEqual({ dear: { drinks: 1, covered_inr: 150 }, mid: { drinks: 1, covered_inr: 150 } });
    expect(r.covered_inr).toBe(300);
    expect(r.applied).toBe(2);
    expect(r.shortfall).toBeNull();
  });

  it('breaks price ties by line order, so the same cart always allocates the same way', () => {
    const r = allocatePassDrinks({
      lines: [line('first', 120), line('second', 120), line('third', 120)],
      passes: [pass('p1', 7)],
      requested: 2,
      now: NOW,
    });
    expect(Object.keys(r.by_line)).toEqual(['first', 'second']);
  });

  it('a cup covers the price when the drink is cheaper than the cup, the cup value when it is dearer', () => {
    const r = allocatePassDrinks({ lines: [line('a', 90), line('b', 400)], passes: [pass('p1', 7, { drink_value_inr: 200 })], requested: 2, now: NOW });
    expect(r.by_line).toEqual({ b: { drinks: 1, covered_inr: 200 }, a: { drinks: 1, covered_inr: 90 } });
  });

  it('uses the soonest-expiring pass first (FEFO), and spills to the next when it runs out', () => {
    const later = pass('later', 5, { expires_at: '2026-10-30T18:30:00.000Z' });
    const sooner = pass('sooner', 2, { expires_at: '2026-10-08T18:30:00.000Z' });
    const r = allocatePassDrinks({ lines: [line('cap', 120, 4)], passes: [later, sooner], requested: 4, now: NOW });
    // the same line, two passes: one allocation per (pass, line)
    expect(r.allocations).toEqual([
      { pass_id: 'sooner', line_key: 'cap', drinks: 2, covered_inr: 240 },
      { pass_id: 'later', line_key: 'cap', drinks: 2, covered_inr: 240 },
    ]);
    expect(r.by_line).toEqual({ cap: { drinks: 4, covered_inr: 480 } });
  });

  it('breaks an expiry tie by pass id', () => {
    const r = allocatePassDrinks({ lines: [line('cap', 120)], passes: [pass('b', 3), pass('a', 3)], requested: 1, now: NOW });
    expect(r.allocations[0].pass_id).toBe('a');
  });

  it('merges cups of one pass on one line into a single allocation', () => {
    const r = allocatePassDrinks({ lines: [line('cap', 120, 3)], passes: [pass('p1', 7)], requested: 3, now: NOW });
    expect(r.allocations).toEqual([{ pass_id: 'p1', line_key: 'cap', drinks: 3, covered_inr: 360 }]);
  });

  it('covers part of a line of quantity 3: 1 of 3 units', () => {
    const r = allocatePassDrinks({ lines: [line('cap', 120, 3)], passes: [pass('p1', 7)], requested: 1, now: NOW });
    expect(r.applied).toBe(1);
    expect(r.by_line.cap).toEqual({ drinks: 1, covered_inr: 120 });
    expect(r.eligible_units).toBe(3);
  });

  it('spreads across lines: dearest unit of a multi-quantity line before a cheaper line', () => {
    const r = allocatePassDrinks({ lines: [line('cheap', 100, 2), line('dear', 140, 2)], passes: [pass('p1', 7)], requested: 3, now: NOW });
    expect(r.by_line).toEqual({ dear: { drinks: 2, covered_inr: 280 }, cheap: { drinks: 1, covered_inr: 100 } });
  });

  it('stops at the cups the passes hold', () => {
    const r = allocatePassDrinks({ lines: [line('cap', 120, 5)], passes: [pass('p1', 2)], requested: 5, now: NOW });
    expect(r.applied).toBe(2);
    expect(r.available).toBe(2);
    expect(r.shortfall).toBe('not_enough_drinks');
  });

  it('stops at the eligible units in the cart', () => {
    const r = allocatePassDrinks({ lines: [line('cap', 120, 2)], passes: [pass('p1', 7)], requested: 5, now: NOW });
    expect(r.applied).toBe(2);
    expect(r.eligible_units).toBe(2);
    expect(r.shortfall).toBe('not_enough_drinks');
  });

  describe('the daily cap', () => {
    it('applies only what the cap allows, and says so', () => {
      const r = allocatePassDrinks({ lines: [line('cap', 120, 3)], passes: [pass('p1', 7, { max_per_day: 1 })], requested: 3, now: NOW });
      expect(r.applied).toBe(1);
      expect(r.available).toBe(7); // the cups are still there; today's cap holds them back
      expect(r.shortfall).toBe('daily_limit');
    });

    it('nothing today when the cap is already used', () => {
      const r = allocatePassDrinks({ lines: [line('cap', 120)], passes: [pass('p1', 7, { max_per_day: 1, used_today: 1 })], requested: 1, now: NOW });
      expect(r.applied).toBe(0);
      expect(r.allocations).toEqual([]);
      expect(r.shortfall).toBe('daily_limit');
    });

    it('a capped pass is skipped for the next one, which is then not a shortfall', () => {
      const capped = pass('capped', 5, { max_per_day: 1, used_today: 1, expires_at: '2026-10-08T18:30:00.000Z' });
      const free = pass('free', 5, { expires_at: '2026-10-30T18:30:00.000Z' });
      const r = allocatePassDrinks({ lines: [line('cap', 120, 2)], passes: [capped, free], requested: 2, now: NOW });
      expect(r.allocations).toEqual([{ pass_id: 'free', line_key: 'cap', drinks: 2, covered_inr: 240 }]);
      expect(r.shortfall).toBeNull();
    });
  });

  describe('expired passes', () => {
    it('are never spent and read as no pass', () => {
      const r = allocatePassDrinks({ lines: [line('cap', 120)], passes: [pass('old', 5, { expires_at: '2026-10-05T00:00:00.000Z' })], requested: 1, now: NOW });
      expect(r.applied).toBe(0);
      expect(r.available).toBe(0);
      expect(r.shortfall).toBe('no_pass');
    });

    it('are left out of `available` but the good pass is still used', () => {
      const old = pass('old', 5, { expires_at: '2026-10-05T00:00:00.000Z' });
      const good = pass('good', 2);
      const r = allocatePassDrinks({ lines: [line('cap', 120, 3)], passes: [old, good], requested: 3, now: NOW });
      expect(r.available).toBe(2);
      expect(r.applied).toBe(2);
      expect(r.allocations.every((a) => a.pass_id === 'good')).toBe(true);
    });
  });

  it('no passes at all is no_pass', () => {
    const r = allocatePassDrinks({ lines: [line('cap', 120)], passes: [], requested: 1, now: NOW });
    expect(r).toMatchObject({ applied: 0, available: 0, shortfall: 'no_pass' });
  });

  it('nothing eligible in the cart is no_eligible_items', () => {
    const r = allocatePassDrinks({
      lines: [line('sandwich', 180, 1, { eligible: false })],
      passes: [pass('p1', 7)],
      requested: 1,
      now: NOW,
    });
    expect(r).toMatchObject({ applied: 0, eligible_units: 0, available: 7, shortfall: 'no_eligible_items' });
  });

  it('a unit priced at ₹0 is never covered (it would spend a cup for nothing)', () => {
    const r = allocatePassDrinks({ lines: [line('free', 0, 2)], passes: [pass('p1', 7)], requested: 2, now: NOW });
    expect(r.eligible_units).toBe(0);
    expect(r.applied).toBe(0);
  });

  describe('requested', () => {
    it.each([0, -3, Number.NaN])('%s applies nothing and is not a shortfall', (requested) => {
      const r = allocatePassDrinks({ lines: [line('cap', 120)], passes: [pass('p1', 7)], requested, now: NOW });
      expect(r).toMatchObject({ requested: 0, applied: 0, covered_inr: 0, allocations: [], by_line: {}, shortfall: null });
    });

    it('a fraction is floored', () => {
      const r = allocatePassDrinks({ lines: [line('cap', 120, 5)], passes: [pass('p1', 7)], requested: 2.9, now: NOW });
      expect(r.requested).toBe(2);
      expect(r.applied).toBe(2);
    });
  });

  describe('GST-exempt lines', () => {
    it('leave the taxable cover out: covered_taxable_inr counts only lines that carry GST', () => {
      const r = allocatePassDrinks({
        lines: [line('exempt', 140, 1, { gst_exempt: true }), line('taxed', 120)],
        passes: [pass('p1', 7)],
        requested: 2,
        now: NOW,
      });
      expect(r.covered_inr).toBe(260);
      expect(r.covered_taxable_inr).toBe(120);
    });
  });

  it('does not mutate its inputs', () => {
    const lines = [line('a', 120, 2), line('b', 200)];
    const passes = [pass('p2', 3, { expires_at: '2026-10-30T18:30:00.000Z' }), pass('p1', 3)];
    const before = JSON.stringify({ lines, passes });
    allocatePassDrinks({ lines, passes, requested: 3, now: NOW });
    expect(JSON.stringify({ lines, passes })).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// IST validity (CP-D5)
// ---------------------------------------------------------------------------

describe('passExpiresAt', () => {
  it.each([
    // [label, bought at (UTC), days, expires (UTC)]
    ['Monday 10:00 IST, Weekly: good through Sunday 23:59, gone at Monday 00:00 IST', '2026-10-05T04:30:00Z', 7, '2026-10-11T18:30:00.000Z'],
    ['23:59 IST on the 5th is still the 5th', '2026-10-05T18:29:00Z', 7, '2026-10-11T18:30:00.000Z'],
    ['00:00 IST on the 6th is the 6th, a whole day later', '2026-10-05T18:30:00Z', 7, '2026-10-12T18:30:00.000Z'],
    ['00:01 IST on the 6th is the 6th', '2026-10-05T18:31:00Z', 7, '2026-10-12T18:30:00.000Z'],
    ['UTC midnight is 05:30 IST the same day', '2026-10-05T00:00:00Z', 7, '2026-10-11T18:30:00.000Z'],
    ['a 1-day pass ends at the next IST midnight', '2026-10-05T04:30:00Z', 1, '2026-10-05T18:30:00.000Z'],
    ['a 1-day pass bought at 23:59 IST still ends in a minute', '2026-10-05T18:29:00Z', 1, '2026-10-05T18:30:00.000Z'],
    ['a 30-day pass: Monday 5 Oct + 30 days = 4 Nov 00:00 IST', '2026-10-05T04:30:00Z', 30, '2026-11-03T18:30:00.000Z'],
    ['across a leap day', '2028-02-28T10:00:00Z', 2, '2028-02-29T18:30:00.000Z'],
    ['across a year end', '2026-12-28T10:00:00Z', 7, '2027-01-03T18:30:00.000Z'],
  ])('%s', (_label, boughtAt, days, expires) => {
    expect(passExpiresAt(new Date(boughtAt), days as number).toISOString()).toBe(expires);
  });

  it('always lands on an IST midnight', () => {
    for (const iso of ['2026-10-05T00:00:00Z', '2026-10-05T12:34:56Z', '2026-10-05T18:29:59Z', '2026-10-05T18:30:00Z']) {
      const ist = new Date(passExpiresAt(new Date(iso), 7).getTime() + 330 * 60_000);
      expect(ist.getUTCHours() * 60 + ist.getUTCMinutes()).toBe(0);
    }
  });
});

describe('passState', () => {
  const soon = new Date(NOW.getTime() + 3600_000).toISOString();
  it.each([
    { name: 'active', p: { status: 'active' as const, expires_at: soon, drinks_remaining: 3 }, want: 'active' },
    { name: 'used up', p: { status: 'active' as const, expires_at: soon, drinks_remaining: 0 }, want: 'used_up' },
    { name: 'expired', p: { status: 'active' as const, expires_at: '2026-10-01T00:00:00Z', drinks_remaining: 3 }, want: 'expired' },
    { name: 'expired beats used up', p: { status: 'active' as const, expires_at: '2026-10-01T00:00:00Z', drinks_remaining: 0 }, want: 'expired' },
    { name: 'expired at exactly expires_at', p: { status: 'active' as const, expires_at: NOW.toISOString(), drinks_remaining: 3 }, want: 'expired' },
    { name: 'refunded', p: { status: 'refunded' as const, expires_at: soon, drinks_remaining: 7 }, want: 'refunded' },
    { name: 'refunded beats expired', p: { status: 'refunded' as const, expires_at: '2026-10-01T00:00:00Z', drinks_remaining: 7 }, want: 'refunded' },
    { name: 'void', p: { status: 'void' as const, expires_at: soon, drinks_remaining: 7 }, want: 'void' },
    { name: 'an unreadable expiry is expired', p: { status: 'active' as const, expires_at: 'garbage', drinks_remaining: 3 }, want: 'expired' },
    { name: 'a Date expiry works too', p: { status: 'active' as const, expires_at: new Date(NOW.getTime() + 1000), drinks_remaining: 3 }, want: 'active' },
  ])('$name', ({ p, want }) => {
    expect(passState(p, NOW)).toBe(want);
  });
});

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

describe('parsePassDrinks', () => {
  it.each([
    [undefined, 0],
    [null, 0],
    [0, 0],
    [1, 1],
    [MAX_PASS_DRINKS_PER_ORDER, 20],
  ])('%s is accepted as %s', (raw, want) => {
    expect(parsePassDrinks(raw)).toEqual({ ok: true, value: want });
  });

  it.each([-1, 21, 1.5, Number.NaN, Infinity, '2', '', true, [], {}])('%s is refused', (raw) => {
    const r = parsePassDrinks(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/0 to 20/);
  });
});

const WEEKLY = {
  name: 'Weekly Ritual',
  description: '7 cups for the price of 5 — valid 7 days',
  drinks_total: 7,
  drinks_paid: 5,
  validity_days: 7,
  drink_value_inr: 150,
  price_inr: 750,
  max_per_day: null,
  gst_exempt: false,
  is_active: false,
  sort_order: 10,
};

describe('validatePlanInput (create)', () => {
  it('accepts the seeded Weekly plan unchanged', () => {
    expect(validatePlanInput({ ...WEEKLY }, { partial: false })).toEqual({ ok: true, value: WEEKLY });
  });

  it('fills the defaults: price = drinks paid × cup value, no cap, GST charged, inactive', () => {
    const r = validatePlanInput({ name: '  Monthly Ritual ', drinks_total: 7, drinks_paid: 6, validity_days: 30, drink_value_inr: 150 }, { partial: false });
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'Monthly Ritual',
        description: '',
        drinks_total: 7,
        drinks_paid: 6,
        validity_days: 30,
        drink_value_inr: 150,
        price_inr: 900,
        max_per_day: null,
        gst_exempt: false,
        is_active: false,
        sort_order: 0,
      },
    });
  });

  it('ignores keys it does not know (a client cannot smuggle in an id or created_at)', () => {
    const r = validatePlanInput({ ...WEEKLY, id: 'x', created_at: 'y', user_id: 'z' }, { partial: false });
    expect(r).toEqual({ ok: true, value: WEEKLY });
  });

  it.each(['name', 'drinks_total', 'drinks_paid', 'validity_days', 'drink_value_inr'])('needs %s', (key) => {
    const body: Record<string, unknown> = { ...WEEKLY };
    delete body[key];
    const r = validatePlanInput(body, { partial: false });
    expect(r).toEqual({ ok: false, error: `${key} is required.` });
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a blank name', { name: '   ' }],
    ['a 61-character name', { name: 'x'.repeat(61) }],
    ['a numeric name', { name: 7 }],
    ['a 501-character description', { description: 'x'.repeat(501) }],
    ['a non-text description', { description: 5 }],
    ['0 cups', { drinks_total: 0, drinks_paid: 0 }],
    ['51 cups', { drinks_total: 51 }],
    ['a fractional cup count', { drinks_total: 7.5 }],
    ['a string cup count', { drinks_total: '7' }],
    ['0 paid for', { drinks_paid: 0 }],
    ['more paid for than given', { drinks_total: 5, drinks_paid: 6 }],
    ['0 validity days', { validity_days: 0 }],
    ['366 validity days', { validity_days: 366 }],
    ['a cup value of 0', { drink_value_inr: 0 }],
    ['a cup value of 5001', { drink_value_inr: 5001 }],
    ['a price of 0', { price_inr: 0 }],
    ['a price of 100001', { price_inr: 100001 }],
    ['a daily cap of 0', { max_per_day: 0 }],
    ['a daily cap above the cups', { max_per_day: 8 }],
    ['a fractional daily cap', { max_per_day: 1.5 }],
    ['a string daily cap', { max_per_day: '1' }],
    ['a non-boolean gst_exempt', { gst_exempt: 'yes' }],
    ['a non-boolean is_active', { is_active: 1 }],
    ['a fractional sort order', { sort_order: 1.5 }],
  ])('refuses %s', (_label, patch) => {
    const r = validatePlanInput({ ...WEEKLY, ...patch }, { partial: false });
    expect(r.ok).toBe(false);
  });

  it('accepts the bounds: 1 and 50 cups, 1 and 365 days, ₹1 and ₹100000, a cap equal to the cups', () => {
    expect(validatePlanInput({ ...WEEKLY, drinks_total: 1, drinks_paid: 1, max_per_day: 1, validity_days: 1, drink_value_inr: 1, price_inr: 1 }, { partial: false }).ok).toBe(true);
    expect(validatePlanInput({ ...WEEKLY, drinks_total: 50, drinks_paid: 50, max_per_day: 50, validity_days: 365, drink_value_inr: 5000, price_inr: 100000 }, { partial: false }).ok).toBe(true);
  });

  it('refuses a defaulted price that comes out above the maximum', () => {
    const body: Record<string, unknown> = { ...WEEKLY, drinks_total: 50, drinks_paid: 50, drink_value_inr: 5000 };
    delete body.price_inr;
    expect(validatePlanInput(body, { partial: false }).ok).toBe(false);
  });

  it('refuses a body that is not an object', () => {
    for (const body of [null, [], 'plan', 5] as unknown as Record<string, unknown>[]) {
      expect(validatePlanInput(body, { partial: false }).ok).toBe(false);
    }
  });
});

describe('validatePlanInput (edit)', () => {
  it('validates only the keys present', () => {
    expect(validatePlanInput({ price_inr: 800 }, { partial: true })).toEqual({ ok: true, value: { price_inr: 800 } });
    expect(validatePlanInput({ is_active: true, name: ' Weekly ' }, { partial: true })).toEqual({
      ok: true,
      value: { is_active: true, name: 'Weekly' },
    });
  });

  it('can clear the daily cap with null', () => {
    expect(validatePlanInput({ max_per_day: null }, { partial: true })).toEqual({ ok: true, value: { max_per_day: null } });
  });

  it('still bounds every key it is given', () => {
    expect(validatePlanInput({ price_inr: 0 }, { partial: true }).ok).toBe(false);
    expect(validatePlanInput({ name: '' }, { partial: true }).ok).toBe(false);
    expect(validatePlanInput({ validity_days: 400 }, { partial: true }).ok).toBe(false);
  });

  it('checks drinks_paid <= drinks_total only when both are present', () => {
    expect(validatePlanInput({ drinks_paid: 40 }, { partial: true }).ok).toBe(true); // the route re-checks against the stored row
    expect(validatePlanInput({ drinks_total: 7, drinks_paid: 8 }, { partial: true }).ok).toBe(false);
    expect(validatePlanInput({ drinks_total: 7, drinks_paid: 7 }, { partial: true }).ok).toBe(true);
  });

  it('checks max_per_day <= drinks_total only when both are present', () => {
    expect(validatePlanInput({ max_per_day: 30 }, { partial: true }).ok).toBe(true);
    expect(validatePlanInput({ drinks_total: 7, max_per_day: 8 }, { partial: true }).ok).toBe(false);
    expect(validatePlanInput({ drinks_total: 7, max_per_day: 1 }, { partial: true }).ok).toBe(true);
  });

  it('refuses an edit that carries nothing it knows', () => {
    expect(validatePlanInput({}, { partial: true })).toEqual({ ok: false, error: 'Nothing to update.' });
    expect(validatePlanInput({ id: 'x' }, { partial: true }).ok).toBe(false);
  });
});

describe('validateAdjustInput', () => {
  it.each([
    [{ kind: 'extend', days: 3, reason: 'goodwill' }, { kind: 'extend', days: 3, reason: 'goodwill' }],
    [{ kind: 'extend', days: 1, reason: '  abc  ' }, { kind: 'extend', days: 1, reason: 'abc' }],
    [{ kind: 'extend', days: 60, reason: 'x'.repeat(200) }, { kind: 'extend', days: 60, reason: 'x'.repeat(200) }],
    [{ kind: 'credit', drinks: 1, reason: 'spilt coffee' }, { kind: 'credit', drinks: 1, reason: 'spilt coffee' }],
    [{ kind: 'credit', drinks: 50, reason: 'gift' }, { kind: 'credit', drinks: 50, reason: 'gift' }],
    // fields of the other kind are ignored, not carried over
    [{ kind: 'extend', days: 2, drinks: 9, reason: 'because' }, { kind: 'extend', days: 2, reason: 'because' }],
  ])('accepts %j', (body, want) => {
    expect(validateAdjustInput(body)).toEqual({ ok: true, value: want });
  });

  it.each([
    ['an unknown kind', { kind: 'shrink', days: 1, reason: 'because' }],
    ['no kind', { days: 1, reason: 'because' }],
    ['0 days', { kind: 'extend', days: 0, reason: 'because' }],
    ['61 days', { kind: 'extend', days: 61, reason: 'because' }],
    ['fractional days', { kind: 'extend', days: 1.5, reason: 'because' }],
    ['string days', { kind: 'extend', days: '3', reason: 'because' }],
    ['no days', { kind: 'extend', reason: 'because' }],
    ['0 cups', { kind: 'credit', drinks: 0, reason: 'because' }],
    ['51 cups', { kind: 'credit', drinks: 51, reason: 'because' }],
    ['no cups', { kind: 'credit', reason: 'because' }],
    ['no reason', { kind: 'extend', days: 1 }],
    ['a 2-character reason', { kind: 'extend', days: 1, reason: 'ab' }],
    ['a blank reason', { kind: 'extend', days: 1, reason: '     ' }],
    ['a 201-character reason', { kind: 'extend', days: 1, reason: 'x'.repeat(201) }],
    ['a non-text reason', { kind: 'extend', days: 1, reason: 12345 }],
  ])('refuses %s', (_label, body) => {
    expect(validateAdjustInput(body).ok).toBe(false);
  });

  it('refuses a body that is not an object', () => {
    expect(validateAdjustInput(null as unknown as Record<string, unknown>).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

describe('passRedeemMessage', () => {
  const codes: PassRedeemCode[] = ['ok', 'not_owner', 'inactive', 'expired', 'insufficient', 'daily_limit', 'bad_input'];

  it.each(codes)('%s reads as a sentence that names the program', (code) => {
    const m = passRedeemMessage(code);
    expect(m.length).toBeGreaterThan(10);
    expect(m).toContain(PASS_PROGRAM_NAME);
    expect(m).toMatch(/[.]$/);
  });

  it('never says "drink" or "Coffee Pass" to the customer', () => {
    for (const code of codes) expect(passRedeemMessage(code)).not.toMatch(/drink|coffee pass/i);
  });

  it('says why: cups, expiry, daily limit', () => {
    expect(passRedeemMessage('insufficient')).toMatch(/cups/);
    expect(passRedeemMessage('expired')).toMatch(/expired/);
    expect(passRedeemMessage('daily_limit')).toMatch(/limit/);
  });

  it('every code is distinct', () => {
    expect(new Set(codes.map(passRedeemMessage)).size).toBe(codes.length);
  });
});

describe('passShortfallMessage', () => {
  const base = { requested: 3, applied: 1, eligible_units: 3, available: 5 };
  it('says nothing when nothing fell short', () => {
    expect(passShortfallMessage({ ...base, applied: 3, shortfall: null })).toBeNull();
  });
  it.each([
    ['no_pass', /no HIOC Ritual cups/],
    ['no_eligible_items', /Nothing in this order/],
    ['daily_limit', /daily limit, so 1 cup can be used today/],
    ['not_enough_drinks', /5 cups left.*1 cup can be used/],
  ] as const)('%s', (shortfall, re) => {
    expect(passShortfallMessage({ ...base, shortfall })).toMatch(re);
  });
  it('a daily limit that is already used says so', () => {
    expect(passShortfallMessage({ ...base, applied: 0, shortfall: 'daily_limit' })).toMatch(/already used/);
  });
  it('fewer eligible units than asked for names the cart, not the pass', () => {
    expect(passShortfallMessage({ requested: 4, applied: 2, eligible_units: 2, available: 7, shortfall: 'not_enough_drinks' })).toMatch(/Only 2 cups in this order/);
  });
});

describe('planDiscountPercent', () => {
  it.each([
    [{ drinks_total: 7, drinks_paid: 5 }, 29], // Weekly: 2 of 7 free
    [{ drinks_total: 7, drinks_paid: 6 }, 14], // Monthly: 1 of 7 free
    [{ drinks_total: 10, drinks_paid: 10 }, 0],
    [{ drinks_total: 4, drinks_paid: 1 }, 75],
    [{ drinks_total: 0, drinks_paid: 0 }, 0],
  ])('%j is %s%%', (plan, want) => {
    expect(planDiscountPercent(plan)).toBe(want);
  });
});

describe('brand (HIOC Ritual wording)', () => {
  it('names the program and its unit', () => {
    expect(PASS_PROGRAM_NAME).toBe('HIOC Ritual');
    expect(PASS_SHORT_NAME).toBe('Ritual');
    expect(PASS_UNIT).toEqual({ one: 'cup', many: 'cups' });
  });

  it.each([
    [1, '1 cup'],
    [2, '2 cups'],
    [5, '5 cups'],
    [7, '7 cups'],
    [0, '0 cups'],
  ])('cupsLabel(%s) is "%s"', (n, want) => {
    expect(cupsLabel(n)).toBe(want);
  });
});
