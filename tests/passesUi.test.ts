import { describe, it, expect } from 'vitest';
import { MAX_PASS_DRINKS_PER_ORDER, passExpiresAt } from '@/lib/passes/rules';
import type { PassRedemptionEntry, PassSummary } from '@/lib/passes/types';
import {
  clampCups,
  findPassForOrder,
  formatPassDay,
  groupEligibleByCategory,
  isPassSaleOrder,
  orderPassBill,
  passCupsLeftLabel,
  passCupsToRequest,
  passCupsToSend,
  passDailyLimitLabel,
  passDots,
  passDrinksOnOrder,
  passHelperLine,
  passHistoryRow,
  passHistorySummary,
  passLastDay,
  passReadyMessage,
  passRowMode,
  passSaleNote,
  passStateBadge,
  passValidTill,
  passValidityLine,
  paymentDismissedMessage,
  planBuyLabel,
  planCoverageLabel,
  planGstNote,
  planHeadline,
  planPerCupInr,
  planSaveLabel,
  planValidityLabel,
  purchaseError,
  ritualBillLabel,
  ritualOnSale,
  ritualTagLabel,
  stepPassCups,
  usablePasses,
  type PassQuote,
} from '@/lib/passes/ui';

// The customer-facing wording and decisions for HIOC Ritual (docs/COFFEE-PASS-SPEC.md
// §8), kept pure so they can be pinned here: the /ritual page, the checkout row and
// the bill rows only lay them out. A wrong number is money (the cups sent with an
// order), a wrong word is a wrong promise (a date, a refund rule), so the edges are
// asserted.

const WEEKLY = { drinks_total: 7, drinks_paid: 5, price_inr: 750, validity_days: 7, drink_value_inr: 150, gst_exempt: false, name: 'Weekly Ritual' };
const MONTHLY = { drinks_total: 7, drinks_paid: 6, price_inr: 900, validity_days: 30, drink_value_inr: 150, gst_exempt: false, name: 'Monthly Ritual' };

describe('IST dates', () => {
  it('names the IST calendar day: weekday, day, month', () => {
    expect(formatPassDay('2026-10-05T04:30:00Z')).toBe('Mon 5 Oct'); // 10:00 IST
    expect(formatPassDay(new Date('2026-09-30T00:00:00Z'))).toBe('Wed 30 Sep');
  });

  it('turns over at IST midnight, not UTC midnight', () => {
    expect(formatPassDay('2026-10-05T18:29:59Z')).toBe('Mon 5 Oct'); // 23:59:59 IST
    expect(formatPassDay('2026-10-05T18:30:00Z')).toBe('Tue 6 Oct'); // 00:00 IST
  });

  it('gives an empty string for a date it cannot read', () => {
    expect(formatPassDay('not a date')).toBe('');
    expect(passLastDay('not a date')).toBe('');
    expect(passValidTill('not a date')).toBe('');
  });

  it('reads expires_at as the START of the next day: the last valid day is the one before', () => {
    // Weekly bought Monday 5 Oct 10:00 IST: good through Sunday 11 Oct (CP-D5).
    const expires = passExpiresAt(new Date('2026-10-05T04:30:00Z'), 7);
    expect(passLastDay(expires)).toBe('Sun 11 Oct');
    expect(passValidTill(expires)).toBe('valid till Sun 11 Oct');
    expect(passValidTill(expires.toISOString())).toBe('valid till Sun 11 Oct');
  });

  it('handles the month boundary', () => {
    // Monthly bought Wed 30 Sep: 30 days, through Thu 29 Oct.
    const expires = passExpiresAt(new Date('2026-09-30T06:00:00Z'), 30);
    expect(passLastDay(expires)).toBe('Thu 29 Oct');
  });
});

describe('plan cards', () => {
  it('derives the headline from the cups, so an owner edit changes the copy', () => {
    expect(planHeadline(WEEKLY)).toBe('7 cups for the price of 5');
    expect(planHeadline(MONTHLY)).toBe('Pay for 6, get 7');
    expect(planHeadline({ drinks_total: 10, drinks_paid: 8 })).toBe('10 cups for the price of 8');
    expect(planHeadline({ drinks_total: 10, drinks_paid: 9 })).toBe('Pay for 9, get 10');
    expect(planHeadline({ drinks_total: 7, drinks_paid: 7 })).toBe('7 cups, prepaid');
  });

  it('works out what a cup costs and how much you save', () => {
    expect(planPerCupInr(WEEKLY)).toBe(107); // 750 / 7 = 107.14
    expect(planPerCupInr(MONTHLY)).toBe(129); // 900 / 7 = 128.57
    expect(planPerCupInr({ price_inr: 500, drinks_total: 0 })).toBe(500);
    expect(planSaveLabel(WEEKLY)).toBe('Save 29%');
    expect(planSaveLabel(MONTHLY)).toBe('Save 14%');
    expect(planSaveLabel({ drinks_total: 7, drinks_paid: 7 })).toBeNull();
  });

  it('says "+ GST" only when GST is added on top of the price', () => {
    const exclusive = { percent: 5, inclusive: false };
    expect(planGstNote(WEEKLY, exclusive)).toBe('+ GST');
    expect(planGstNote(WEEKLY, { percent: 5, inclusive: true })).toBeNull();
    expect(planGstNote({ gst_exempt: true }, exclusive)).toBeNull();
    expect(planGstNote(WEEKLY, { percent: 0, inclusive: false })).toBeNull();
    expect(planGstNote(WEEKLY, null)).toBeNull();
  });

  it('words the validity, the coverage and the buy button', () => {
    expect(planValidityLabel(WEEKLY)).toBe('Valid 7 days');
    expect(planValidityLabel({ validity_days: 1 })).toBe('Valid 1 day');
    expect(planCoverageLabel(WEEKLY)).toBe(
      'Covers any Ritual drink up to ₹150 — pricier drinks just pay the difference.',
    );
    expect(planBuyLabel(WEEKLY)).toBe('Buy Weekly Ritual');
  });

  it('is on sale only when at least one plan is', () => {
    expect(ritualOnSale(null)).toBe(false);
    expect(ritualOnSale(undefined)).toBe(false);
    expect(ritualOnSale({ plans: [] })).toBe(false);
    expect(ritualOnSale({ plans: [{ ...WEEKLY, id: 'p1', description: '', max_per_day: null, is_active: true, sort_order: 0 }] })).toBe(true);
  });
});

describe('eligible drinks', () => {
  const drinks = [
    { id: '1', name: 'Latte', category: 'Coffee' },
    { id: '2', name: 'Cold Brew', category: 'Cold Brews' },
    { id: '3', name: 'Cappuccino', category: 'Coffee' },
    { id: '4', name: 'Mocha', category: 'Zebra Coffee' },
    { id: '5', name: 'Frappe', category: 'Alpha Coffee' },
  ];

  it('groups by category in the menu order, then alphabetically for unknown ones', () => {
    const groups = groupEligibleByCategory(drinks, ['Coffee', 'Creme Coffee', 'Cold Brews'], (c) => c.toUpperCase());
    expect(groups.map((g) => g.category)).toEqual(['Coffee', 'Cold Brews', 'Alpha Coffee', 'Zebra Coffee']);
    expect(groups[0].label).toBe('COFFEE');
    expect(groups[0].drinks.map((d) => d.name)).toEqual(['Latte', 'Cappuccino']); // received order kept
  });

  it('is empty for no drinks', () => {
    expect(groupEligibleByCategory([], ['Coffee'])).toEqual([]);
  });
});

function pass(over: Partial<PassSummary> = {}): PassSummary {
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
    starts_at: '2026-10-05T04:30:00.000Z',
    expires_at: '2026-10-11T18:30:00.000Z',
    status: 'active',
    state: 'active',
    order_id: 'order-1',
    ...over,
  };
}

describe('your Ritual: dots and labels', () => {
  it('has one dot per cup, filled from the left for the cups still to spend', () => {
    const dots = passDots(pass());
    expect(dots).toHaveLength(7);
    expect(dots.filter((d) => d.filled)).toHaveLength(5);
    expect(dots.map((d) => d.filled)).toEqual([true, true, true, true, true, false, false]);
    expect(dots.some((d) => d.extra)).toBe(false);
  });

  it('shows cups given back as extra dots after the plan cups', () => {
    const dots = passDots(pass({ drinks_credited: 1, drinks_remaining: 6 }));
    expect(dots).toHaveLength(8);
    expect(dots.map((d) => d.extra)).toEqual([false, false, false, false, false, false, false, true]);
    expect(dots.filter((d) => d.filled)).toHaveLength(6);
  });

  it('is all filled when unused, all empty when used up', () => {
    expect(passDots(pass({ drinks_remaining: 7 })).every((d) => d.filled)).toBe(true);
    expect(passDots(pass({ drinks_remaining: 0 })).every((d) => !d.filled)).toBe(true);
  });

  it('never fills more dots than there are cups, and copes with nonsense', () => {
    expect(passDots(pass({ drinks_remaining: 99 })).filter((d) => d.filled)).toHaveLength(7);
    expect(passDots(pass({ drinks_remaining: -3 })).filter((d) => d.filled)).toHaveLength(0);
    expect(passDots(pass({ drinks_total: 0, drinks_credited: 0, drinks_remaining: 0 }))).toEqual([]);
  });

  it('says the same in words', () => {
    expect(passCupsLeftLabel(pass())).toBe('5 of 7 cups left');
    expect(passCupsLeftLabel(pass({ drinks_credited: 1, drinks_remaining: 6 }))).toBe('6 of 8 cups left');
    expect(passCupsLeftLabel(pass({ drinks_total: 1, drinks_remaining: 0 }))).toBe('0 of 1 cup left');
  });

  it('badges every state', () => {
    expect(passStateBadge('active')).toEqual({ label: 'Active', tone: 'success' });
    expect(passStateBadge('used_up')).toEqual({ label: 'Used up', tone: 'neutral' });
    expect(passStateBadge('expired')).toEqual({ label: 'Expired', tone: 'outline' });
    expect(passStateBadge('refunded')).toEqual({ label: 'Refunded', tone: 'outline' });
    expect(passStateBadge('void')).toEqual({ label: 'Cancelled', tone: 'outline' });
  });

  it('writes the date line by state', () => {
    expect(passValidityLine(pass())).toBe('valid till Sun 11 Oct');
    expect(passValidityLine(pass({ state: 'used_up' }))).toBe('valid till Sun 11 Oct');
    expect(passValidityLine(pass({ state: 'expired' }))).toBe('expired Sun 11 Oct');
    expect(passValidityLine(pass({ state: 'refunded' }))).toBe('');
    expect(passValidityLine(pass({ state: 'void' }))).toBe('');
  });

  it('mentions a daily limit only when there is one', () => {
    expect(passDailyLimitLabel(null)).toBeNull();
    expect(passDailyLimitLabel(undefined)).toBeNull();
    expect(passDailyLimitLabel(1)).toBe('Up to 1 cup a day');
    expect(passDailyLimitLabel(2)).toBe('Up to 2 cups a day');
  });

  it('lists only passes that can be spent from as usable', () => {
    const list = [
      pass({ id: 'a' }),
      pass({ id: 'b', state: 'used_up', drinks_remaining: 0 }),
      pass({ id: 'c', state: 'expired' }),
      pass({ id: 'd', state: 'refunded' }),
    ];
    expect(usablePasses(list).map((p) => p.id)).toEqual(['a']);
  });
});

describe('pass history', () => {
  const entry: PassRedemptionEntry = {
    order_id: 'o-1',
    order_number: 1042,
    drinks: 2,
    covered_inr: 270,
    created_at: '2026-10-06T05:00:00.000Z',
    reversed: false,
  };

  it('reads as order, cups, day', () => {
    expect(passHistoryRow(entry)).toEqual({
      orderId: 'o-1',
      orderLabel: 'HIOC-001042',
      cups: '2 cups',
      when: 'Tue 6 Oct',
      returned: false,
    });
  });

  it('marks cups that came back, and copes with an unknown order number', () => {
    const row = passHistoryRow({ ...entry, drinks: 1, order_number: null, reversed: true });
    expect(row.returned).toBe(true);
    expect(row.cups).toBe('1 cup');
    expect(row.orderLabel).toBe('Order');
  });

  it('summarises the collapsed list', () => {
    expect(passHistorySummary(3)).toBe('History (3)');
  });
});

describe('buying', () => {
  it('finds the pass its sale order issued, and only that one', () => {
    const list = [pass({ id: 'a', order_id: 'o-a' }), pass({ id: 'b', order_id: 'o-b' })];
    expect(findPassForOrder(list, 'o-b')?.id).toBe('b');
    expect(findPassForOrder(list, 'o-z')).toBeNull();
    expect(findPassForOrder([], 'o-a')).toBeNull();
  });

  it('announces a new pass with its cups and last day', () => {
    expect(passReadyMessage(pass())).toBe('Your Weekly Ritual is ready — 7 cups, valid till Sun 11 Oct');
    expect(passReadyMessage(pass({ expires_at: 'garbage' }))).toBe('Your Weekly Ritual is ready — 7 cups');
  });

  it('turns each refusal into words and a next step', () => {
    expect(purchaseError(401)).toEqual({ message: 'Log in to buy your HIOC Ritual.', action: 'login' });
    expect(purchaseError(400, 'Add your mobile number in your profile first')).toEqual({
      message: 'Add your mobile number in your profile first.',
      action: 'profile',
    });
    expect(purchaseError(400, 'plan_id must be a plan id').action).toBe('retry');
    expect(purchaseError(404, "That HIOC Ritual plan isn't available.").message).toBe(
      "That HIOC Ritual plan isn't available.",
    );
    expect(purchaseError(429).action).toBe('retry');
    expect(purchaseError(429).message).toMatch(/Too many attempts/);
    const unavailable = purchaseError(503);
    expect(unavailable.action).toBe('counter');
    expect(unavailable.message).toMatch(/at the counter/);
    expect(purchaseError(500).action).toBe('retry');
    expect(purchaseError(500, 'boom').message).toBe('boom');
  });

  it('says what happened when the payment window is closed', () => {
    expect(paymentDismissedMessage()).toMatch(/no charge was made/);
    expect(paymentDismissedMessage('Card declined')).toBe("Payment didn't go through: Card declined");
  });
});

describe('checkout: cups to ask for, show and send', () => {
  const quote = (over: Partial<PassQuote> = {}): PassQuote => ({
    requested: 20,
    applied: 2,
    discount_inr: 270,
    eligible_units: 2,
    available: 5,
    max_usable: 2,
    shortfall: 'not_enough_drinks',
    message: 'You have 5 cups left on your HIOC Ritual, so 2 cups can be used.',
    ...over,
  });

  it('opens at the maximum, then follows the customer', () => {
    expect(passCupsToRequest(false, 0)).toBe(MAX_PASS_DRINKS_PER_ORDER);
    expect(passCupsToRequest(false, 3)).toBe(MAX_PASS_DRINKS_PER_ORDER);
    expect(passCupsToRequest(true, 1)).toBe(1);
    expect(passCupsToRequest(true, 0)).toBe(0); // "none" is a choice too
    expect(passCupsToRequest(true, 99)).toBe(MAX_PASS_DRINKS_PER_ORDER);
  });

  it('holds the stepper to 0..max', () => {
    expect(stepPassCups(1, 1, 2)).toBe(2);
    expect(stepPassCups(2, 1, 2)).toBe(2);
    expect(stepPassCups(1, -1, 2)).toBe(0);
    expect(stepPassCups(0, -1, 2)).toBe(0);
    expect(stepPassCups(0, 1, 0)).toBe(0);
    expect(clampCups(NaN, 5)).toBe(0);
    expect(clampCups(3.9, 5)).toBe(3);
    expect(clampCups(-2, 5)).toBe(0);
  });

  it('sends cups only when the latest quote applied them and that is what the stepper shows', () => {
    expect(passCupsToSend(quote({ applied: 2 }), 2)).toBe(2);
    expect(passCupsToSend(quote({ applied: 2 }), 1)).toBeUndefined(); // stepper moved, quote not back yet
    expect(passCupsToSend(quote({ applied: 0 }), 0)).toBeUndefined(); // nothing applied: send nothing
    expect(passCupsToSend(null, 2)).toBeUndefined();
    expect(passCupsToSend(undefined, 2)).toBeUndefined();
  });

  it('decides what the row is', () => {
    expect(passRowMode(null)).toBe('hidden');
    expect(passRowMode(quote({ available: 0, max_usable: 0, shortfall: 'no_pass' }))).toBe('hidden');
    expect(passRowMode(quote())).toBe('stepper');
    expect(passRowMode(quote({ applied: 0, max_usable: 0, shortfall: 'no_eligible_items' }))).toBe('unusable');
  });

  it('shows the server line only for reasons the customer needs to hear', () => {
    const daily = quote({ shortfall: 'daily_limit', message: 'Your HIOC Ritual has a daily limit, so 1 cup can be used today.' });
    expect(passHelperLine(daily, false)).toBe(daily.message);
    const nothing = quote({ shortfall: 'no_eligible_items', message: 'Nothing in this order can be paid with HIOC Ritual cups.' });
    expect(passHelperLine(nothing, false)).toBe(nothing.message);
    // The maximum the checkout asks for before a choice is made would only read as a caveat.
    expect(passHelperLine(quote(), false)).toBeNull();
    expect(passHelperLine(quote(), true)).toBe(quote().message);
    expect(passHelperLine(quote({ message: null, shortfall: null }), true)).toBeNull();
    expect(passHelperLine(null, true)).toBeNull();
  });
});

describe('bills', () => {
  it('labels the Ritual row and the covered-line tag', () => {
    expect(ritualBillLabel(1)).toBe('HIOC Ritual (1 cup)');
    expect(ritualBillLabel(2)).toBe('HIOC Ritual (2 cups)');
    expect(ritualTagLabel(2)).toBe('Ritual ×2');
  });

  it('counts the cups on an order from its lines', () => {
    expect(passDrinksOnOrder([{ pass_drinks: 1 }, { pass_drinks: 2 }, { pass_drinks: 0 }, {}])).toBe(3);
    expect(passDrinksOnOrder([])).toBe(0);
    expect(passDrinksOnOrder(undefined)).toBe(0);
    expect(passDrinksOnOrder(null)).toBe(0);
  });

  it('does not count a voided line: its cups went back to the pass', () => {
    expect(passDrinksOnOrder([{ pass_drinks: 2, voided: true }, { pass_drinks: 1, voided: false }])).toBe(1);
  });

  it('ignores a line with an unreadable count', () => {
    expect(passDrinksOnOrder([{ pass_drinks: NaN }, { pass_drinks: -1 }, { pass_drinks: 2 }])).toBe(2);
  });

  it('builds the bill row from pass_discount_inr and the lines', () => {
    expect(orderPassBill({ pass_discount_inr: 270, items: [{ pass_drinks: 2 }] })).toEqual({
      label: 'HIOC Ritual (2 cups)',
      discountInr: 270,
      cups: 2,
    });
  });

  it('has no row when no Ritual paid for anything, including orders from before the feature', () => {
    expect(orderPassBill({ pass_discount_inr: 0, items: [{ pass_drinks: 0 }] })).toBeNull();
    expect(orderPassBill({ items: [] })).toBeNull(); // column absent
    expect(orderPassBill({ pass_discount_inr: null })).toBeNull();
    expect(orderPassBill({ pass_discount_inr: NaN })).toBeNull();
  });

  it('still shows the amount, under the program name, if the cups cannot be counted', () => {
    expect(orderPassBill({ pass_discount_inr: 120, items: [] })).toEqual({ label: 'HIOC Ritual', discountInr: 120, cups: 0 });
  });

  it('recognises the sale of a Ritual, and treats a missing order_kind as a menu order', () => {
    expect(isPassSaleOrder({ order_kind: 'coffee_pass' })).toBe(true);
    expect(isPassSaleOrder({ order_kind: 'menu' })).toBe(false);
    expect(isPassSaleOrder({})).toBe(false);
    expect(isPassSaleOrder({ order_kind: null })).toBe(false);
  });

  it('tells the buyer where things stand', () => {
    expect(passSaleNote('paid')).toEqual({
      text: 'Your HIOC Ritual is active — see it in Account → HIOC Ritual.',
      link: true,
    });
    expect(passSaleNote('payment_pending').link).toBe(false);
    expect(passSaleNote('payment_pending').text).toMatch(/as soon as your payment is confirmed/);
    expect(passSaleNote('refunded')).toEqual({ text: 'This HIOC Ritual was refunded and is no longer active.', link: false });
    expect(passSaleNote('partially_refunded').link).toBe(false);
  });
});

describe('wording', () => {
  it('never says "Coffee Pass" or "points" to a customer', () => {
    const said = [
      planHeadline(WEEKLY),
      planCoverageLabel(WEEKLY),
      passReadyMessage(pass()),
      purchaseError(401).message,
      purchaseError(503).message,
      paymentDismissedMessage(),
      passSaleNote('paid').text,
      passSaleNote('payment_pending').text,
      passSaleNote('refunded').text,
      ritualBillLabel(2),
      ritualTagLabel(2),
      passCupsLeftLabel(pass()),
    ].join(' ');
    expect(said).not.toMatch(/coffee pass/i);
    expect(said).not.toMatch(/\bpoints?\b/i);
  });
});
