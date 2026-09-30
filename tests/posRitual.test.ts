import { describe, expect, it } from 'vitest';

// HIOC Ritual at the counter — the pure rules behind New order's Ritual row, the
// kitchen-board filter, and the Ritual passes screen (lib/pos/ritual.ts). No
// mocks: everything here is a function of its arguments, which is the reason it
// lives in lib/** and not inside a component.

import { passExpiresAt } from '@/lib/passes/rules';
import type { CompleteChoice } from '@/lib/passes/ritualDrinks';
import type { PassRedemptionEntry, PassSummary } from '@/lib/passes/types';
import type { QuotedPass } from '@/lib/pos/loyalty';
import {
  clampCups,
  cupDots,
  cupsLeftLabel,
  cupsOnOrder,
  extendedTillLabel,
  freeBillPaidAs,
  historyLine,
  initialPhoneFromQuery,
  isRitualSale,
  kitchenOrders,
  newSaleKey,
  orderConflictAction,
  parseCreditCups,
  parseExtendDays,
  passStateLabel,
  passValidityLabel,
  planSaveLabel,
  planSummaryLabel,
  ritualApproved,
  ritualBillLabel,
  ritualBillRow,
  ritualIdleHint,
  ritualStepperMax,
  ritualSummary,
  saleActiveMessage,
  saleAttemptKey,
  salePaidFallbackMessage,
  saleFingerprint,
  saleSummaryLine,
  sellBlockedReason,
  unpaidSaleFor,
  validTillLabel,
  validateCredit,
  validateExtend,
} from '@/lib/pos/ritual';

function pass(overrides: Partial<PassSummary> = {}): PassSummary {
  return {
    id: 'pass-1',
    plan_id: 'plan-1',
    plan_name: 'Weekly Ritual',
    drinks_total: 7,
    drinks_used: 2,
    drinks_credited: 0,
    drinks_remaining: 5,
    drink_value_inr: 150,
    max_per_day: null,
    used_today: 0,
    price_inr: 750,
    starts_at: '2026-09-28T04:30:00.000Z',
    expires_at: '2026-10-04T18:30:00.000Z',
    status: 'active',
    state: 'active',
    order_id: 'order-1',
    drink_menu_item_id: 'menu-cappuccino',
    drink_label: 'Cappuccino · Large',
    ...overrides,
  };
}

function quote(overrides: Partial<QuotedPass> = {}): QuotedPass {
  return {
    requested: 1,
    applied: 1,
    discount_inr: 120,
    eligible_units: 2,
    available: 5,
    max_usable: 2,
    shortfall: null,
    message: null,
    ...overrides,
  };
}

describe('isRitualSale / kitchenOrders — a pass sale is a payment, not food', () => {
  it.each([
    [{ order_kind: 'coffee_pass' }, true],
    [{ order_kind: 'menu' }, false],
    // Rows read before supabase/2026-10-coffee-pass.sql have no order_kind: a menu order.
    [{}, false],
    [{ order_kind: null }, false],
    [null, false],
    [undefined, false],
  ])('isRitualSale(%j) is %s', (order, expected) => {
    expect(isRitualSale(order)).toBe(expected);
  });

  it('keeps menu orders (and rows with no kind) on the kitchen board, drops the sale', () => {
    const rows = [
      { id: 'a', order_kind: 'menu' as const },
      { id: 'b', order_kind: 'coffee_pass' as const },
      { id: 'c' },
    ];
    expect(kitchenOrders(rows).map((o) => o.id)).toEqual(['a', 'c']);
  });

  it('does not mutate the list it is given', () => {
    const rows = [{ id: 'a', order_kind: 'coffee_pass' as const }];
    kitchenOrders(rows);
    expect(rows).toHaveLength(1);
  });
});

describe('cupsOnOrder / ritualBillLabel / ritualBillRow', () => {
  it('sums the cups on lines that are not voided', () => {
    expect(
      cupsOnOrder([
        { pass_drinks: 2 },
        { pass_drinks: 1, voided: true },
        { pass_drinks: 0 },
        {},
        { pass_drinks: null },
      ]),
    ).toBe(2);
    expect(cupsOnOrder(undefined)).toBe(0);
    expect(cupsOnOrder([])).toBe(0);
  });

  it.each([
    [1, 'HIOC Ritual (1 cup)'],
    [2, 'HIOC Ritual (2 cups)'],
    // A count that is not known is just the programme's name.
    [0, 'HIOC Ritual'],
  ])('labels %s cups as "%s"', (cups, label) => {
    expect(ritualBillLabel(cups)).toBe(label);
  });

  it('gives a negative row for what the cups covered, and none when they covered nothing', () => {
    expect(ritualBillRow({ pass_discount_inr: 270 }, 2)).toEqual({ label: 'HIOC Ritual (2 cups)', value: -270 });
    expect(ritualBillRow({ pass_discount_inr: 0 }, 2)).toBeNull();
    expect(ritualBillRow({}, 2)).toBeNull();
    expect(ritualBillRow(null, 2)).toBeNull();
    expect(ritualBillRow({ pass_discount_inr: 120 }, 0)).toEqual({ label: 'HIOC Ritual', value: -120 });
  });
});

describe('validTillLabel — the LAST day a pass can be used, in IST', () => {
  it('names the day before the instant validity ends (spec CP-D5: Monday 10:00 + 7 days → Sunday)', () => {
    // Bought Monday 28 Sep 2026, 10:00 IST → expires Monday 5 Oct 00:00 IST → last day Sunday 4 Oct.
    const expires = passExpiresAt(new Date('2026-09-28T04:30:00.000Z'), 7).toISOString();
    expect(expires).toBe('2026-10-04T18:30:00.000Z');
    expect(validTillLabel(expires)).toBe('Sun 4 Oct');
  });

  it('adds the year when asked (the receipt)', () => {
    expect(validTillLabel('2026-10-04T18:30:00.000Z', { year: true })).toBe('Sun 4 Oct 2026');
  });

  it('a 30-day pass bought on the 31st crosses the month', () => {
    const expires = passExpiresAt(new Date('2026-10-31T10:00:00.000Z'), 30).toISOString();
    expect(validTillLabel(expires)).toBe('Sun 29 Nov');
  });

  it.each([[''], [null], [undefined], ['not a date']])('reads %j as nothing to say', (value) => {
    expect(validTillLabel(value as string | null | undefined)).toBe('');
  });

  it('shows where an extension would leave the pass', () => {
    expect(extendedTillLabel('2026-10-04T18:30:00.000Z', 3)).toBe('Wed 7 Oct');
    expect(extendedTillLabel('nope', 3)).toBe('');
  });
});

describe('ritualSummary — the row New order shows for the attached customer', () => {
  it('is null when there is nothing to offer', () => {
    expect(ritualSummary(undefined)).toBeNull();
    expect(ritualSummary([])).toBeNull();
    expect(ritualSummary([pass({ drinks_remaining: 0, state: 'used_up' })])).toBeNull();
    expect(ritualSummary([pass({ state: 'expired' })])).toBeNull();
  });

  it('reads "HIOC Ritual · 5 cups left · till Sun 4 Oct"', () => {
    const summary = ritualSummary([pass()]);
    expect(summary?.cupsLeft).toBe(5);
    expect(summary?.label).toBe('HIOC Ritual · 5 cups left · till Sun 4 Oct');
  });

  it('adds up the cups across passes and leads with the soonest expiry (that pass is used first)', () => {
    const summary = ritualSummary([
      pass({ id: 'later', drinks_remaining: 6, expires_at: '2026-11-03T18:30:00.000Z' }),
      pass({ id: 'sooner', drinks_remaining: 1, expires_at: '2026-10-04T18:30:00.000Z' }),
    ]);
    expect(summary?.cupsLeft).toBe(7);
    expect(summary?.tillIso).toBe('2026-10-04T18:30:00.000Z');
    expect(summary?.label).toBe('HIOC Ritual · 7 cups left · till Sun 4 Oct');
  });

  it('says "1 cup left" in the singular', () => {
    expect(ritualSummary([pass({ drinks_remaining: 1 })])?.label).toContain('1 cup left');
  });
});

describe('the stepper — starts at 0 (CP-D10) and never passes what the cart can use', () => {
  it('is bounded by the quote’s max_usable, the cups held and one order’s limit', () => {
    expect(ritualStepperMax(quote({ max_usable: 2 }), 5)).toBe(2);
    expect(ritualStepperMax(quote({ max_usable: 9 }), 5)).toBe(5);
    expect(ritualStepperMax(quote({ max_usable: 40 }), 40)).toBe(20);
    expect(ritualStepperMax(quote({ max_usable: 0 }), 5)).toBe(0);
  });

  it('before the first quote lands the customer’s own count stands in', () => {
    expect(ritualStepperMax(null, 5)).toBe(5);
    expect(ritualStepperMax(undefined, 0)).toBe(0);
    expect(ritualStepperMax(null, Number.NaN)).toBe(0);
  });

  it('a nonsense max_usable never opens the stepper', () => {
    expect(ritualStepperMax(quote({ max_usable: Number.NaN }), 5)).toBe(0);
    expect(ritualStepperMax(quote({ max_usable: -3 }), 5)).toBe(0);
  });

  it.each([
    [3, 2, 2],
    [-1, 2, 0],
    [1.9, 5, 1],
    [Number.NaN, 5, 0],
    [4, 0, 0],
  ])('clampCups(%s, %s) is %s', (value, max, expected) => {
    expect(clampCups(value, max)).toBe(expected);
  });
});

describe('ritualApproved — pass_drinks goes with the order only when the latest quote approved exactly it', () => {
  it('is true only for a quote that applied every cup asked for', () => {
    expect(ritualApproved(quote({ requested: 2, applied: 2 }), 2)).toBe(true);
  });

  it.each([
    ['fewer applied than asked', quote({ requested: 2, applied: 1 }), 2],
    ['the quote answered a different count', quote({ requested: 1, applied: 1 }), 2],
    ['nothing asked', quote({ requested: 0, applied: 0 }), 0],
    ['no quote yet', null, 1],
  ])('is false when %s', (_label, q, requested) => {
    expect(ritualApproved(q, requested)).toBe(false);
  });
});

describe('ritualIdleHint — why "+" does nothing', () => {
  it('says nothing can use a cup when no drink in the order is eligible', () => {
    expect(ritualIdleHint(quote({ requested: 0, applied: 0, max_usable: 0, eligible_units: 0 }), 0)).toBe(
      'Nothing in this order can be paid with a HIOC Ritual cup.',
    );
  });

  it('says today’s limit is used when cups remain but none can be used today', () => {
    expect(ritualIdleHint(quote({ requested: 0, applied: 0, max_usable: 0, eligible_units: 2, available: 3 }), 0)).toBe(
      "Today's limit on this HIOC Ritual has been used.",
    );
  });

  it('is quiet while cups are asked for, when the cart can use them, and before any quote', () => {
    expect(ritualIdleHint(quote({ max_usable: 0, eligible_units: 0 }), 1)).toBeNull();
    expect(ritualIdleHint(quote({ requested: 0, applied: 0, max_usable: 2 }), 0)).toBeNull();
    expect(ritualIdleHint(null, 0)).toBeNull();
  });
});

describe('orderConflictAction — what to do when POST /api/orders refuses', () => {
  it.each([
    // The order was created then rolled back (a cup spent elsewhere, a coupon's last use):
    // price the cart again and start the next attempt on a fresh key.
    [409, 'Your HIOC Ritual pass does not have enough cups left. Please review your bill and try again.', true, { requote: true, rotateKey: true }],
    [409, 'This coupon just reached its usage limit — please try again.', false, { requote: true, rotateKey: true }],
    // The first attempt is still running: a second key would make a second order.
    [409, 'This order is already being placed — please wait a moment.', true, { requote: false, rotateKey: false }],
    // "Fewer cups could be applied": the key was never claimed, so it stays.
    [400, 'You have 1 cup left. Please review your bill and try again.', true, { requote: true, rotateKey: false }],
    [400, 'Something else was wrong.', false, { requote: false, rotateKey: false }],
    [500, 'boom', true, { requote: false, rotateKey: false }],
    [503, 'HIOC Ritual is temporarily unavailable', true, { requote: false, rotateKey: false }],
  ])('%s %j (cups sent: %s)', (status, message, sentCups, expected) => {
    expect(orderConflictAction(status, message, sentCups)).toEqual(expected);
  });

  it('copes with no message', () => {
    expect(orderConflictAction(409, undefined, false)).toEqual({ requote: true, rotateKey: true });
  });
});

describe('a ₹0 bill', () => {
  it('reads as covered in full by the Ritual, or plain "nothing due"', () => {
    expect(freeBillPaidAs(1)).toBe('in full by HIOC Ritual');
    expect(freeBillPaidAs(0)).toBe('nothing due');
  });
});

describe('plan cards', () => {
  // A plan has no price (CP-D24): what a cup costs depends on the drink picked, so the card
  // has only the cups, the validity and the saving. The price is ritualPriceQuote's
  // (tests/ritualDrinks.test.ts, with the spec §13 worked examples).
  const weekly = { drinks_total: 7, drinks_paid: 5, validity_days: 7 };
  const monthly = { drinks_total: 7, drinks_paid: 6, validity_days: 30 };

  it('reads "7 cups · 7 days" and "1 day"', () => {
    expect(planSummaryLabel(weekly)).toBe('7 cups · 7 days');
    expect(planSummaryLabel({ drinks_total: 1, validity_days: 1 })).toBe('1 cup · 1 day');
  });

  it('says how much is saved (29% weekly, 14% monthly), or nothing when nothing is', () => {
    expect(planSaveLabel(weekly)).toBe('Save 29%');
    expect(planSaveLabel(monthly)).toBe('Save 14%');
    expect(planSaveLabel({ drinks_total: 5, drinks_paid: 5 })).toBeNull();
  });
});

describe('sellBlockedReason — why Sell is off', () => {
  it('names the first thing missing: permission, then phone, then name', () => {
    expect(sellBlockedReason({ canSell: false, blockedMessage: 'Ask a manager.', phoneValid: true, name: 'Asha' })).toBe(
      'Ask a manager.',
    );
    expect(sellBlockedReason({ canSell: false, phoneValid: true, name: 'Asha' })).toContain('HIOC Ritual');
    expect(sellBlockedReason({ canSell: true, phoneValid: false, name: 'Asha' })).toMatch(/10-digit mobile/);
    expect(sellBlockedReason({ canSell: true, phoneValid: true, name: '   ' })).toMatch(/name/);
  });

  it('is null when a valid phone and a name are there', () => {
    expect(sellBlockedReason({ canSell: true, phoneValid: true, name: 'Asha' })).toBeNull();
  });
});

describe('the sale’s idempotency key — one per attempt, reused on retry', () => {
  it('makes a key the API accepts (8 to 200 characters), different each time', () => {
    const a = newSaleKey();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(newSaleKey()).not.toBe(a);
  });

  it('keeps the key for a retry of the same sale and replaces it for any other', () => {
    let n = 0;
    const make = () => `key-${++n}`;
    const first = saleAttemptKey(null, '9876543210|Asha|plan-1', make);
    expect(first).toEqual({ fingerprint: '9876543210|Asha|plan-1', key: 'key-1' });
    // The retry (a lost response): same customer, same plan → same key.
    expect(saleAttemptKey(first, '9876543210|Asha|plan-1', make).key).toBe('key-1');
    // A different plan, name or number is a different sale.
    expect(saleAttemptKey(first, '9876543210|Asha|plan-2', make).key).toBe('key-2');
    expect(saleAttemptKey(first, '9000000000|Asha|plan-1', make).key).toBe('key-3');
  });
});

describe('the sale\u2019s idempotency key rotates when the drink or size changes (CP-D22)', () => {
  const base = { phone: '9876543210', name: 'Asha', planId: 'plan-1', menuItemId: 'cap', variantId: 'cap-l' };

  it('fingerprints the customer, the plan, the drink and the size', () => {
    expect(saleFingerprint(base)).toBe('9876543210|Asha|plan-1|cap|cap-l');
    // The name is trimmed, like the one sent.
    expect(saleFingerprint({ ...base, name: '  Asha ' })).toBe(saleFingerprint(base));
  });

  it('keeps the key for a retry of the same drink and size, and makes a NEW one for any change', () => {
    let n = 0;
    const make = () => `key-${++n}`;
    const first = saleAttemptKey(null, saleFingerprint(base), make);
    expect(first.key).toBe('key-1');
    // A lost response, retried or reopened with the same choice: the same key returns the first sale, not a second.
    expect(saleAttemptKey(first, saleFingerprint({ ...base }), make).key).toBe('key-1');
    // A different drink, a different size of the same drink, a different plan: each is a different sale.
    expect(saleAttemptKey(first, saleFingerprint({ ...base, menuItemId: 'lat', variantId: 'lat-l' }), make).key).toBe('key-2');
    expect(saleAttemptKey(first, saleFingerprint({ ...base, variantId: 'cap-s' }), make).key).toBe('key-3');
    expect(saleAttemptKey(first, saleFingerprint({ ...base, planId: 'plan-2' }), make).key).toBe('key-4');
  });

  it('going back and choosing the same drink again reuses the key; choosing another and back does not', () => {
    let n = 0;
    const make = () => `key-${++n}`;
    const first = saleAttemptKey(null, saleFingerprint(base), make);
    const other = saleAttemptKey(first, saleFingerprint({ ...base, variantId: 'cap-s' }), make);
    expect(other.key).not.toBe(first.key);
    // The key is held for the LATEST choice only: returning to the first drink is a new attempt.
    expect(saleAttemptKey(other, saleFingerprint(base), make).key).not.toBe(first.key);
  });
});

describe('the confirm sheet\u2019s words', () => {
  const plan = { name: 'Weekly Ritual', drinks_total: 7 };
  const cappuccino: CompleteChoice = {
    drink: { id: 'cap', name: 'Cappuccino', category: 'Coffee', is_available: true, sizes: [] },
    size: { variant_id: 'cap-l', label: 'Large', price_inr: 120 },
  };

  it('reads "Weekly Ritual — Cappuccino (Large) · 7 cups · ₹630"', () => {
    expect(saleSummaryLine(plan, cappuccino, 630)).toBe('Weekly Ritual — Cappuccino (Large) · 7 cups · ₹630');
    expect(saleSummaryLine({ name: 'Monthly Ritual', drinks_total: 1 }, { ...cappuccino, size: { ...cappuccino.size, label: '' } }, 120)).toBe(
      'Monthly Ritual — Cappuccino · 1 cup · ₹120',
    );
  });

  it('finds the unpaid sale of the same plan AND drink, not another drink\u2019s', () => {
    const unpaid = [
      { plan_name: 'Weekly Ritual — Latte (Large)', order_id: 'o1' },
      { plan_name: 'Weekly Ritual — Cappuccino (Large)', order_id: 'o2' },
      { plan_name: 'Monthly Ritual — Cappuccino (Large)', order_id: 'o3' },
    ];
    expect(unpaidSaleFor(unpaid, plan, cappuccino)?.order_id).toBe('o2');
    expect(unpaidSaleFor(unpaid, { name: 'Monthly Ritual' }, cappuccino)?.order_id).toBe('o3');
    expect(unpaidSaleFor(unpaid, plan, { ...cappuccino, size: { ...cappuccino.size, label: 'Small' } })).toBeNull();
    expect(unpaidSaleFor([], plan, cappuccino)).toBeNull();
  });
});

describe('the paid-sale messages', () => {
  it('reads "Weekly Ritual · Cappuccino · Large active — 7 cups, valid till Sun 4 Oct"', () => {
    expect(saleActiveMessage(pass({ drinks_remaining: 7 }))).toBe(
      'Weekly Ritual · Cappuccino · Large active — 7 cups, valid till Sun 4 Oct',
    );
    // A pass with no drink on it reads as its plan.
    expect(saleActiveMessage(pass({ drinks_remaining: 7, drink_label: '' }))).toBe('Weekly Ritual active — 7 cups, valid till Sun 4 Oct');
  });

  it('does not claim a pass it could not read back', () => {
    expect(salePaidFallbackMessage('Weekly Ritual')).toMatch(/^Payment recorded for Weekly Ritual/);
  });
});

describe('the pass card', () => {
  it('counts dots from what the pass can give (bought + given back) and what is left', () => {
    expect(cupDots(pass())).toEqual({ total: 7, filled: 5 });
    expect(cupDots(pass({ drinks_credited: 1, drinks_remaining: 6 }))).toEqual({ total: 8, filled: 6 });
    // Never more filled than the pass can give.
    expect(cupDots(pass({ drinks_remaining: 99 }))).toEqual({ total: 7, filled: 7 });
    expect(cupDots(pass({ drinks_remaining: 0 }))).toEqual({ total: 7, filled: 0 });
  });

  it('says the same in words', () => {
    expect(cupsLeftLabel(pass())).toBe('5 of 7 cups left');
    expect(cupsLeftLabel(pass({ drinks_total: 1, drinks_remaining: 1 }))).toBe('1 of 1 cup left');
  });

  it('says valid till for a live pass and expired once it has lapsed', () => {
    expect(passValidityLabel(pass())).toBe('Valid till Sun 4 Oct');
    expect(passValidityLabel(pass({ state: 'expired' }))).toBe('Expired Sun 4 Oct');
    expect(passValidityLabel(pass({ expires_at: 'garbage' }))).toBe('');
  });

  it.each([
    ['active', 'Active'],
    ['used_up', 'Used up'],
    ['expired', 'Expired'],
    ['refunded', 'Refunded'],
    ['void', 'Void'],
  ] as const)('labels state %s as %s', (state, label) => {
    expect(passStateLabel(state)).toBe(label);
  });

  it('describes a history line, and says when the cups came back', () => {
    const entry: PassRedemptionEntry = {
      order_id: 'o1',
      order_number: 1042,
      drinks: 2,
      covered_inr: 270,
      created_at: '2026-09-29T10:00:00.000Z',
      reversed: false,
    };
    expect(historyLine(entry)).toBe('#1042 · 2 cups · ₹270 covered');
    expect(historyLine({ ...entry, reversed: true })).toBe('#1042 · 2 cups · ₹270 covered · cups returned');
    expect(historyLine({ ...entry, order_number: null, drinks: 1 })).toBe('Order · 1 cup · ₹270 covered');
  });
});

describe('manager actions — the bounds POST /api/passes/[id]/adjust checks (CP-D16)', () => {
  it.each([
    ['1', 1],
    ['60', 60],
    ['0', null],
    ['61', null],
    ['', null],
    ['2.5', null],
    ['-3', null],
    ['abc', null],
  ])('parseExtendDays(%j) is %s', (raw, expected) => {
    expect(parseExtendDays(raw)).toBe(expected);
  });

  it.each([
    ['1', 7, 1],
    ['7', 7, 7],
    ['8', 7, null],
    ['0', 7, null],
    ['', 7, null],
  ])('parseCreditCups(%j, %s) is %s', (raw, max, expected) => {
    expect(parseCreditCups(raw, max)).toBe(expected);
  });

  it('builds the extend body once days and a reason are right', () => {
    expect(validateExtend('3', '  Closed for Diwali ')).toEqual({
      ok: true,
      value: { kind: 'extend', days: 3, reason: 'Closed for Diwali' },
    });
  });

  it('builds the credit body once cups and a reason are right', () => {
    expect(validateCredit('1', 'Spilt drink', 7)).toEqual({
      ok: true,
      value: { kind: 'credit', drinks: 1, reason: 'Spilt drink' },
    });
  });

  it.each([
    ['days out of range', () => validateExtend('90', 'Goodwill'), /1 to 60/],
    ['days missing', () => validateExtend('', 'Goodwill'), /1 to 60/],
    ['no reason', () => validateExtend('2', ''), /reason of 3 to 200/],
    ['a reason that is too short', () => validateExtend('2', 'ab'), /reason of 3 to 200/],
    ['a reason that is too long', () => validateExtend('2', 'x'.repeat(201)), /reason of 3 to 200/],
    ['more cups than the plan gives', () => validateCredit('9', 'Spilt drink', 7), /1 to 7/],
    ['no cups', () => validateCredit('0', 'Spilt drink', 7), /1 to 7/],
    ['no reason on a credit', () => validateCredit('1', '  ', 7), /reason of 3 to 200/],
  ])('refuses %s', (_label, run, message) => {
    const result = run();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });
});

describe('initialPhoneFromQuery — the ?phone= New order links with', () => {
  it.each([
    ['9876543210', '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['09876543210', '9876543210'],
    [['9876543210', '1234567890'], '9876543210'],
    ['98765', ''],
    ['', ''],
    [undefined, ''],
    [null, ''],
  ])('reads %j as %j', (raw, expected) => {
    expect(initialPhoneFromQuery(raw as string | string[] | undefined | null)).toBe(expected);
  });
});
