import { describe, expect, it } from 'vitest';
import {
  buildPlanPayload,
  categorySelection,
  checkCustomRange,
  countSelected,
  cupsLeftLabel,
  dailyCapLabel,
  eligibleSaveWarning,
  emptyPlanForm,
  exampleDrinks,
  examplePrices,
  formatCount,
  formatIstDay,
  formatRupees,
  formatValidTill,
  groupMenuByCategory,
  GST_RULE,
  nextSortOrder,
  parseWholeNumber,
  passStateLabel,
  passStateTone,
  passValidTillIso,
  perCupPriceInr,
  planExamples,
  planPreview,
  planRow,
  planSaveConfirmation,
  planToForm,
  presetRange,
  priceRuleLabel,
  quickCategories,
  reportPassRows,
  sameSelection,
  setCategorySelected,
  setupChecklist,
  sortPlans,
  summaryCards,
  summaryQuery,
  validityLabel,
  withSelection,
  type CategoryGroup,
  type PickerItem,
  type PlanForm,
} from '@/lib/passes/ownerUi';
import { PLAN_NO_PRICE_MESSAGE, validatePlanInput } from '@/lib/passes/rules';
import type { PassProgramSummary } from '@/lib/passes/summary';
import type { CoffeePassPlan, PassState, RitualDrink } from '@/lib/passes/types';

// lib/passes/ownerUi.ts: the rules behind Owner → HIOC Ritual, as pure functions. The
// screens (components/owner/passes) only hold state and draw, so what the owner is
// TOLD (a discount, worked examples, what to confirm, what is left to do) is pinned
// here. The seeded plans (spec §5.6) are the running example. Since per-drink pricing
// (spec §13) a plan has no price or cup value: the price is cups paid × the price of
// the drink and size the customer picks, so the form shows the saving and examples.

const WEEKLY: CoffeePassPlan = {
  id: 'plan-weekly',
  name: 'Weekly Ritual',
  description: '7 cups for the price of 5',
  drinks_total: 7,
  drinks_paid: 5,
  validity_days: 7,
  drink_value_inr: null,
  price_inr: null,
  max_per_day: null,
  gst_exempt: false,
  is_active: false,
  sort_order: 10,
};
const MONTHLY: CoffeePassPlan = {
  ...WEEKLY,
  id: 'plan-monthly',
  name: 'Monthly Ritual',
  description: 'Pay for 6, get 7',
  drinks_paid: 6,
  validity_days: 30,
  sort_order: 20,
};

// What GET /api/passes/plans lists as `eligible`: drinks with the sizes on sale.
const CAPPUCCINO: RitualDrink = {
  id: 'cappuccino',
  name: 'Cappuccino',
  category: 'Coffee',
  is_available: true,
  sizes: [
    { variant_id: 'cap-s', label: 'Small', price_inr: 90 },
    { variant_id: 'cap-l', label: 'Large', price_inr: 120 },
  ],
};
const LATTE: RitualDrink = {
  id: 'latte',
  name: 'Latte',
  category: 'Coffee',
  is_available: true,
  sizes: [{ variant_id: 'lat-l', label: 'Large', price_inr: 140 }],
};
const COLD_BREW: RitualDrink = {
  id: 'cold',
  name: 'Cold Brew',
  category: 'Cold Brews',
  is_available: true,
  sizes: [{ variant_id: 'cold-r', label: 'Regular', price_inr: 150 }],
};

describe('formatting', () => {
  it.each([
    [750, '₹750'],
    [1050, '₹1,050'],
    [123456, '₹1,23,456'],
    [107.14, '₹107.14'],
    [107.142857, '₹107.14'],
    [0, '₹0'],
    [Number.NaN, '—'],
    [null, '—'],
    [undefined, '—'],
  ])('formatRupees(%s) = %s', (n, expected) => {
    expect(formatRupees(n as number)).toBe(expected);
  });

  it('formats counts with Indian grouping', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(Number.NaN)).toBe('—');
  });

  it('shows an IST day, with the year only when it is not this year', () => {
    const now = new Date('2026-10-15T04:30:00Z');
    expect(formatIstDay('2026-10-05T06:30:00.000Z', now)).toBe('5 Oct');
    expect(formatIstDay('2025-12-31T06:30:00.000Z', now)).toBe('31 Dec 2025');
    // 23:00 UTC on the 4th is already the 5th in IST.
    expect(formatIstDay('2026-10-04T23:00:00.000Z', now)).toBe('5 Oct');
    // The year is the IST year: 19:00 UTC on 31 Dec 2025 is 1 Jan 2026 in IST.
    expect(formatIstDay('2025-12-31T19:00:00.000Z', now)).toBe('1 Jan');
    expect(formatIstDay('not a date', now)).toBe('—');
  });

  it('shows the LAST valid day, not the instant the pass expires', () => {
    // A Weekly bought Mon 5 Oct 10:00 IST expires 00:00 IST Mon 12 Oct (= 18:30Z Sun 11 Oct).
    const expires = '2026-10-11T18:30:00.000Z';
    expect(passValidTillIso(expires)).toBe('2026-10-11T18:29:59.999Z');
    expect(formatValidTill(expires, new Date('2026-10-06T04:30:00Z'))).toBe('11 Oct');
    expect(passValidTillIso('garbage')).toBe('garbage');
  });

  it('words cups, caps and validity', () => {
    expect(cupsLeftLabel(3, 7)).toBe('3 of 7');
    expect(dailyCapLabel(null)).toBe('No limit');
    expect(dailyCapLabel(1)).toBe('1 a day');
    expect(validityLabel(1)).toBe('1 day');
    expect(validityLabel(30)).toBe('30 days');
  });

  it.each<[PassState, string, string]>([
    ['active', 'Active', 'success'],
    ['used_up', 'Used up', 'neutral'],
    ['expired', 'Expired', 'outline'],
    ['refunded', 'Refunded', 'danger'],
    ['void', 'Void', 'danger'],
  ])('a %s pass reads "%s" (%s)', (state, label, tone) => {
    expect(passStateLabel(state)).toBe(label);
    expect(passStateTone(state)).toBe(tone);
  });
});

describe('price maths', () => {
  it.each([
    [750, 7, 107.14],
    [900, 7, 128.57],
    [700, 7, 100],
    [1, 3, 0.33],
    [0, 7, null],
    [750, 0, null],
    [Number.NaN, 7, null],
  ])('₹%s over %s cups is %s a cup', (price, total, expected) => {
    expect(perCupPriceInr(price, total)).toBe(expected);
  });

  it('describes a plan row without further arithmetic: the saving, not a price', () => {
    expect(planRow(WEEKLY)).toEqual({ freeCups: 2, discountPercent: 29, validity: '7 days', cap: 'No limit' });
    expect(planRow({ ...MONTHLY, max_per_day: 1 })).toEqual({ freeCups: 1, discountPercent: 14, validity: '30 days', cap: '1 a day' });
    // paying for every cup saves nothing
    expect(planRow({ ...WEEKLY, drinks_paid: 7 })).toMatchObject({ freeCups: 0, discountPercent: 0 });
  });
});

describe('examplePrices (what customers would pay, for real drinks)', () => {
  it('shows the dearest size of each drink: "Cappuccino Large ₹120 → ₹600" for a Weekly', () => {
    expect(examplePrices(WEEKLY, [CAPPUCCINO])).toEqual([
      {
        drink: 'Cappuccino',
        size: 'Large',
        cup_price_inr: 120,
        price_inr: 600,
        per_cup_inr: 85.71, // 600 / 7
        text: 'Cappuccino Large ₹120 → ₹600',
      },
    ]);
  });

  it('prices a Monthly at 6 ×: Latte Large ₹140 → ₹840', () => {
    expect(examplePrices(MONTHLY, [LATTE])[0]).toMatchObject({ cup_price_inr: 140, price_inr: 840, text: 'Latte Large ₹140 → ₹840' });
  });

  it('gives the first three drinks by default, in the order given, or as many as asked', () => {
    const many = [CAPPUCCINO, LATTE, COLD_BREW, { ...LATTE, id: 'mocha', name: 'Mocha' }];
    expect(examplePrices(WEEKLY, many).map((e) => e.drink)).toEqual(['Cappuccino', 'Latte', 'Cold Brew']);
    expect(examplePrices(WEEKLY, many, 1).map((e) => e.drink)).toEqual(['Cappuccino']);
    expect(examplePrices(WEEKLY, many, 0)).toEqual([]);
  });

  it('uses the same price the server charges: ritualPriceFor, whole rupees', () => {
    for (const plan of [WEEKLY, MONTHLY]) {
      for (const e of examplePrices(plan, [CAPPUCCINO, LATTE, COLD_BREW])) {
        expect(e.price_inr).toBe(plan.drinks_paid * e.cup_price_inr);
        expect(Number.isInteger(e.price_inr)).toBe(true);
      }
    }
  });

  it('follows a half-typed form: it needs only the cups paid for and given', () => {
    expect(examplePrices({ drinks_paid: 3, drinks_total: 4 }, [COLD_BREW])[0]).toMatchObject({ price_inr: 450, per_cup_inr: 112.5 });
  });

  it('a size with no name reads without it', () => {
    const plain: RitualDrink = { ...COLD_BREW, sizes: [{ variant_id: 'x', label: '  ', price_inr: 150 }] };
    expect(examplePrices(WEEKLY, [plain])[0]).toMatchObject({ size: '', text: 'Cold Brew ₹150 → ₹750' });
  });

  it('skips a drink that is off the menu today, unless nothing else is left', () => {
    const off = { ...CAPPUCCINO, is_available: false };
    expect(examplePrices(WEEKLY, [off, LATTE]).map((e) => e.drink)).toEqual(['Latte']);
    expect(examplePrices(WEEKLY, [off]).map((e) => e.drink)).toEqual(['Cappuccino']);
  });

  it('ignores a ₹0 size and a drink with no usable size', () => {
    const free: RitualDrink = { ...CAPPUCCINO, sizes: [{ variant_id: 'a', label: 'Taster', price_inr: 0 }, { variant_id: 'b', label: 'Large', price_inr: 120 }] };
    expect(examplePrices(WEEKLY, [free])[0]).toMatchObject({ size: 'Large', cup_price_inr: 120 });
    expect(examplePrices(WEEKLY, [{ ...CAPPUCCINO, sizes: [] }, { ...LATTE, sizes: [{ variant_id: 'c', label: 'Free', price_inr: 0 }] }])).toEqual([]);
  });

  it('is empty when nothing is ticked yet, or the cups paid for are unusable', () => {
    expect(examplePrices(WEEKLY, [])).toEqual([]);
    expect(examplePrices({ drinks_paid: 0, drinks_total: 7 }, [CAPPUCCINO])).toEqual([]);
    expect(examplePrices({ drinks_paid: Number.NaN, drinks_total: 7 }, [CAPPUCCINO])).toEqual([]);
  });

  it('does not reorder or change its input', () => {
    const drinks = [LATTE, CAPPUCCINO];
    examplePrices(WEEKLY, drinks);
    expect(drinks).toEqual([LATTE, CAPPUCCINO]);
    expect(CAPPUCCINO.sizes.map((z) => z.label)).toEqual(['Small', 'Large']);
  });
});

describe('priceRuleLabel and planExamples (the plans table and the plan form)', () => {
  const cheap = (id: string, name: string, price: number, over: Partial<RitualDrink> = {}): RitualDrink => ({
    id,
    name,
    category: 'Coffee',
    is_available: true,
    sizes: [{ variant_id: `${id}-v`, label: 'Regular', price_inr: price }],
    ...over,
  });

  it('says the pricing rule in a line: "Price: 5 × the drink"', () => {
    expect(priceRuleLabel(WEEKLY)).toBe('Price: 5 × the drink');
    expect(priceRuleLabel(MONTHLY)).toBe('Price: 6 × the drink');
  });

  it('prefers Cappuccino and Latte when the menu has both, whatever the order or case', () => {
    const menu = [cheap('a', 'Americano', 80), COLD_BREW, { ...LATTE, name: 'LATTE' }, CAPPUCCINO];
    expect(exampleDrinks(menu).map((d) => d.id)).toEqual(['cappuccino', 'latte']);
    expect(planExamples(WEEKLY, menu).map((e) => e.text)).toEqual([
      'Cappuccino Large ₹120 → ₹600',
      'LATTE Large ₹140 → ₹700',
    ]);
    expect(planExamples(MONTHLY, menu)[1].text).toBe('LATTE Large ₹140 → ₹840');
  });

  it('with only one of them, adds the cheapest others so there are still up to three', () => {
    const menu = [COLD_BREW, cheap('a', 'Americano', 80), CAPPUCCINO, cheap('m', 'Mocha', 110)];
    expect(exampleDrinks(menu).map((d) => d.name)).toEqual(['Cappuccino', 'Americano', 'Mocha']);
  });

  it('with neither, takes the first few by price, cheapest first (by the size the example quotes)', () => {
    const menu = [COLD_BREW, cheap('a', 'Americano', 80), cheap('m', 'Mocha', 110), cheap('f', 'Flat White', 95)];
    expect(exampleDrinks(menu).map((d) => d.name)).toEqual(['Americano', 'Flat White', 'Mocha']);
    expect(exampleDrinks(menu, 2).map((d) => d.name)).toEqual(['Americano', 'Flat White']);
    expect(exampleDrinks(menu, 0)).toEqual([]);
  });

  it('passes over a drink that is off the menu today (unless nothing else is left) and one with no usable size', () => {
    const off = { ...CAPPUCCINO, is_available: false };
    expect(exampleDrinks([off, LATTE, COLD_BREW]).map((d) => d.name)).toEqual(['Latte', 'Cold Brew']);
    expect(exampleDrinks([off]).map((d) => d.name)).toEqual(['Cappuccino']);
    expect(exampleDrinks([{ ...CAPPUCCINO, sizes: [{ variant_id: 'z', label: 'Free', price_inr: 0 }] }, LATTE]).map((d) => d.name)).toEqual(['Latte']);
  });

  it('is empty until a drink is ticked, and follows a half-typed form', () => {
    expect(planExamples(WEEKLY, [])).toEqual([]);
    expect(planExamples({ drinks_paid: 4, drinks_total: 0 }, [CAPPUCCINO])[0]).toMatchObject({ price_inr: 480, per_cup_inr: null });
  });

  it('does not change its input', () => {
    const menu = [COLD_BREW, LATTE, CAPPUCCINO];
    exampleDrinks(menu);
    expect(menu.map((d) => d.id)).toEqual(['cold', 'latte', 'cappuccino']);
  });
});

describe('parseWholeNumber', () => {
  it.each([
    ['7', 7],
    [' 150 ', 150],
    ['1,050', 1050],
    ['₹750', 750],
    ['', null],
    ['  ', null],
    ['7.5', null],
    ['-3', null],
    ['abc', null],
    ['1e3', null],
    ['99999999999999999999', null],
  ])('%j is %s', (raw, expected) => {
    expect(parseWholeNumber(raw)).toBe(expected);
  });
});

describe('the plan form', () => {
  it('starts a new plan Weekly-shaped, switched off, with no price or cup value', () => {
    const form = emptyPlanForm();
    expect(form).toEqual({
      name: '',
      description: '',
      drinks_total: '7',
      drinks_paid: '5',
      validity_days: '7',
      max_per_day: '',
      gst_exempt: false,
      is_active: false,
    });
    expect(form).not.toHaveProperty('price_inr');
    expect(form).not.toHaveProperty('drink_value_inr');
  });

  it('edits a stored plan', () => {
    expect(planToForm(WEEKLY)).toEqual({
      name: 'Weekly Ritual',
      description: '7 cups for the price of 5',
      drinks_total: '7',
      drinks_paid: '5',
      validity_days: '7',
      max_per_day: '',
      gst_exempt: false,
      is_active: false,
    });
    expect(planToForm({ ...WEEKLY, max_per_day: 1, is_active: true })).toMatchObject({ max_per_day: '1', is_active: true });
  });

  it('shows the live preview: the free cups and the saving, which do not depend on the drink', () => {
    expect(planPreview(emptyPlanForm())).toEqual({ freeCups: 2, discountPercent: 29, drinksPaid: 5, drinksTotal: 7 });
    expect(planPreview({ ...emptyPlanForm(), drinks_paid: '6' })).toMatchObject({ freeCups: 1, discountPercent: 14 });
    expect(planPreview({ ...emptyPlanForm(), drinks_paid: '7' })).toMatchObject({ freeCups: 0, discountPercent: 0 });
  });

  it('cannot preview while the boxes are unreadable or the cups paid exceed the cups given', () => {
    expect(planPreview({ ...emptyPlanForm(), drinks_paid: '' })).toEqual({ freeCups: null, discountPercent: null, drinksPaid: null, drinksTotal: 7 });
    expect(planPreview({ ...emptyPlanForm(), drinks_total: 'x' })).toMatchObject({ freeCups: null, discountPercent: null, drinksTotal: null, drinksPaid: 5 });
    expect(planPreview({ ...emptyPlanForm(), drinks_paid: '8' })).toMatchObject({ freeCups: null, discountPercent: null, drinksPaid: 8, drinksTotal: 7 });
  });

  it('feeds examplePrices from the typed cups', () => {
    const pv = planPreview({ ...emptyPlanForm(), drinks_paid: '6' });
    expect(examplePrices({ drinks_paid: pv.drinksPaid as number, drinks_total: pv.drinksTotal as number }, [CAPPUCCINO])[0].price_inr).toBe(720);
  });
});

describe('buildPlanPayload', () => {
  const create = (patch: Partial<PlanForm> = {}) => buildPlanPayload({ ...emptyPlanForm(), name: 'Weekly Ritual', ...patch }, null, 30);

  it('creates: the whole recipe (no price, no cup value) and a sort order after the others', () => {
    expect(create()).toEqual({
      ok: true,
      changed: true,
      body: {
        name: 'Weekly Ritual',
        description: '',
        drinks_total: 7,
        drinks_paid: 5,
        validity_days: 7,
        max_per_day: null,
        gst_exempt: false,
        is_active: false,
        sort_order: 30,
      },
    });
  });

  it("what it builds for a create passes the server's own validator (which refuses a price)", () => {
    const built = create({ description: '  7 for 5  ', max_per_day: '1', gst_exempt: true, is_active: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validatePlanInput(built.body as Record<string, unknown>, { partial: false }).ok).toBe(true);
    expect(built.body).toMatchObject({ description: '7 for 5', max_per_day: 1, gst_exempt: true, is_active: true });
    // sanity: the server would refuse the old body
    expect(validatePlanInput({ ...built.body, price_inr: 750 } as Record<string, unknown>, { partial: false })).toEqual({ ok: false, error: PLAN_NO_PRICE_MESSAGE });
  });

  it('never sends a price or a cup value, create or edit', () => {
    const built = create();
    expect(built.ok && Object.keys(built.body)).not.toContain('price_inr');
    expect(built.ok && Object.keys(built.body)).not.toContain('drink_value_inr');
    const edit = buildPlanPayload({ ...planToForm(WEEKLY), drinks_paid: '6' }, WEEKLY);
    expect(edit.ok && Object.keys(edit.body)).toEqual(['drinks_paid']);
  });

  it('sends a trimmed name, and no sort order when none is given (the server defaults it)', () => {
    const built = create({ name: '  Sunday Ritual ' });
    expect(built.ok && built.body.name).toBe('Sunday Ritual');
    const none = buildPlanPayload({ ...emptyPlanForm(), name: 'X' }, null);
    expect(none.ok && 'sort_order' in none.body).toBe(false);
  });

  // The message is the server's own wording (validatePlanInput), so the form and the API say the same thing.
  it.each<[string, Partial<PlanForm>, string]>([
    ['no name', { name: '   ' }, 'Name must be 1 to 60 characters.'],
    ['a name over 60', { name: 'x'.repeat(61) }, 'Name must be 1 to 60 characters.'],
    ['blank cups given', { drinks_total: '' }, 'Cups in the pass must be a whole number from 1 to 50.'],
    ['too many cups', { drinks_total: '51' }, 'Cups in the pass must be a whole number from 1 to 50.'],
    ['cups paid above cups given', { drinks_total: '5', drinks_paid: '6' }, 'Cups paid for cannot be more than the cups in the pass.'],
    ['a fractional validity', { validity_days: '7.5' }, 'Validity must be a whole number of days from 1 to 365.'],
    ['a year and a day', { validity_days: '366' }, 'Validity must be a whole number of days from 1 to 365.'],
    ['a daily limit of words', { max_per_day: 'one' }, 'Daily limit must be empty or a whole number of cups from 1 up.'],
    ['a daily limit above the cups', { max_per_day: '8' }, 'Daily limit cannot be more than the cups in the pass.'],
    ['a description over 500', { description: 'y'.repeat(501) }, 'Description must be 500 characters or fewer.'],
  ])('refuses %s', (_label, patch, message) => {
    expect(create(patch)).toEqual({ ok: false, error: message });
  });

  it('edits: only the fields that changed, never the sort order', () => {
    const form = { ...planToForm(WEEKLY), name: 'Weekly Ritual+', validity_days: '10' };
    expect(buildPlanPayload(form, WEEKLY, 99)).toEqual({ ok: true, changed: true, body: { name: 'Weekly Ritual+', validity_days: 10 } });
  });

  it('edits: no change means no request', () => {
    expect(buildPlanPayload(planToForm(WEEKLY), WEEKLY, 99)).toEqual({ ok: true, changed: false, body: {} });
    // trimmed whitespace is not a change
    expect(buildPlanPayload({ ...planToForm(WEEKLY), name: ' Weekly Ritual ' }, WEEKLY)).toMatchObject({ changed: false });
  });

  it('edits a legacy plan that still has a price: still no price in the body', () => {
    const legacy = { ...WEEKLY, price_inr: 750, drink_value_inr: 150 };
    expect(buildPlanPayload(planToForm(legacy), legacy)).toEqual({ ok: true, changed: false, body: {} });
  });

  it('edits: clearing the daily limit sends null; setting one sends the number', () => {
    const capped = { ...WEEKLY, max_per_day: 1 };
    expect(buildPlanPayload({ ...planToForm(capped), max_per_day: '' }, capped)).toMatchObject({ body: { max_per_day: null } });
    expect(buildPlanPayload({ ...planToForm(WEEKLY), max_per_day: '1' }, WEEKLY)).toMatchObject({ body: { max_per_day: 1 } });
  });

  it('edits: changing the cups paid for sends just that, since the price follows the drink', () => {
    expect(buildPlanPayload({ ...planToForm(WEEKLY), drinks_paid: '6' }, WEEKLY)).toEqual({ ok: true, changed: true, body: { drinks_paid: 6 } });
  });

  it('sorts new plans after the existing ones, in steps of 10', () => {
    expect(nextSortOrder([])).toBe(10);
    expect(nextSortOrder([WEEKLY, MONTHLY])).toBe(30);
    expect(nextSortOrder([{ sort_order: 0 }])).toBe(10);
  });

  it('lists plans the way the server does: sort order, then name', () => {
    const first = { ...WEEKLY, id: 'a', name: 'A', sort_order: 10 };
    const second = { ...WEEKLY, id: 'b', name: 'B', sort_order: 10 };
    const later = { ...WEEKLY, id: 'c', name: 'A', sort_order: 20 };
    expect(sortPlans([later, second, first]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
    const cheap = first;
    const input = [later, cheap];
    sortPlans(input);
    expect(input[0]).toBe(later); // the input is not reordered
  });
});

describe('planSaveConfirmation', () => {
  const live = { ...WEEKLY, is_active: true };

  it('asks before a plan goes on sale', () => {
    // From the table's switch...
    expect(planSaveConfirmation(WEEKLY, { is_active: true })).toMatchObject({
      title: 'Make this plan available?',
      message: 'Customers will be able to buy this now.',
      danger: false,
    });
    // ...from the edit form...
    expect(planSaveConfirmation(WEEKLY, { name: 'X', is_active: true })?.message).toBe('Customers will be able to buy this now.');
    // ...and for a brand-new plan created switched on.
    expect(planSaveConfirmation(null, { is_active: true })?.message).toBe('Customers will be able to buy this now.');
  });

  it('asks before a plan goes off sale, and says the sold Rituals are safe', () => {
    const c = planSaveConfirmation(live, { is_active: false });
    expect(c).toMatchObject({ title: 'Switch this plan off?', confirmLabel: 'Switch off', danger: true });
    expect(c?.message).toContain('Rituals already sold keep working');
  });

  it('asks before the terms of a live plan change', () => {
    for (const change of [{ drinks_total: 8 }, { validity_days: 10 }, { max_per_day: 1 }, { gst_exempt: true }, { drinks_paid: 4 }]) {
      expect(planSaveConfirmation(live, change), JSON.stringify(change)).toMatchObject({ title: 'Change a live plan?', danger: false });
    }
    // The wording no longer promises a "price": there is none to change.
    expect(planSaveConfirmation(live, { drinks_paid: 4 })?.message).toBe(
      'This plan is on sale. The new terms apply to every sale from now on. Rituals already sold keep the terms they were sold with.',
    );
  });

  it('does not ask when nothing that matters to a sale changes', () => {
    expect(planSaveConfirmation(live, { name: 'Renamed', description: 'New words' })).toBeNull(); // wording only
    expect(planSaveConfirmation(WEEKLY, { validity_days: 10, drinks_total: 8 })).toBeNull(); // not on sale yet
    expect(planSaveConfirmation(null, { name: 'New', is_active: false })).toBeNull(); // a new plan left off
    expect(planSaveConfirmation(live, { validity_days: 7 })).toBeNull(); // the same validity
    expect(planSaveConfirmation(live, { is_active: true })).toBeNull(); // still on
    expect(planSaveConfirmation(WEEKLY, { is_active: false })).toBeNull(); // still off
  });

  it('activating wins over a terms change in the same save', () => {
    expect(planSaveConfirmation(WEEKLY, { validity_days: 10, is_active: true })?.title).toBe('Make this plan available?');
  });
});

describe('setupChecklist', () => {
  const byId = (r: ReturnType<typeof setupChecklist>) => Object.fromEntries(r.items.map((i) => [i.id, i]));

  it('starts with the two real steps to do, and the GST rule already settled', () => {
    const r = setupChecklist({ plans: [], eligibleCount: 0 });
    expect(r.todo).toBe(2); // the settled GST item is not an open step
    const items = byId(r);
    expect(items.live).toMatchObject({ kind: 'info', done: true });
    expect(items.plan).toMatchObject({ kind: 'todo', done: false, label: 'Create a plan and switch it on', detail: 'No plans yet.', href: '#ritual-plans' });
    expect(items.drinks).toMatchObject({
      kind: 'todo',
      done: false,
      href: '#ritual-drinks',
      label: 'Choose the drinks a Ritual can be bought for',
      detail: 'No drink is chosen yet, so customers have nothing to buy.',
    });
    expect(items.gst).toMatchObject({ kind: 'info', done: true, href: '#ritual-plans' });
    expect(items.gst.label).toBe(GST_RULE);
    expect(items.gst.label).toBe('GST: 5% when a Ritual is sold · 0% on redeemed cups');
    expect(items.gst.detail).toBe(
      'Decided by the owner on 30 Sep 2026. Cups are paid for when the Ritual is sold, so a redeemed cup carries no GST; a top-up above the cup value is taxed like any sale.',
    );
  });

  it('plans that exist but none on sale: still to do', () => {
    const r = setupChecklist({ plans: [WEEKLY, MONTHLY], eligibleCount: 0 });
    expect(byId(r).plan).toMatchObject({ done: false, label: 'Check the plans, then switch one on', detail: 'No plan is on sale yet, so customers cannot buy anything.' });
    expect(r.todo).toBe(2);
  });

  it('ticks off the plan step as soon as one is on sale', () => {
    const r = setupChecklist({ plans: [{ ...WEEKLY, is_active: true }, MONTHLY], eligibleCount: 0 });
    expect(byId(r).plan).toMatchObject({ done: true, detail: '1 of 2 plans are on sale.' });
    expect(r.todo).toBe(1);
  });

  it('ticks off the drinks step once any drink is chosen', () => {
    const r = setupChecklist({ plans: [{ ...WEEKLY, is_active: true }], eligibleCount: 1 });
    expect(byId(r).plan.detail).toBe('1 of 1 plan is on sale.');
    expect(byId(r).drinks).toMatchObject({ done: true, detail: '1 drink chosen.' });
    expect(r.todo).toBe(0);
    // Every item is ticked once the two steps are done: the GST rule was settled from the start.
    expect(r.items.every((i) => i.done)).toBe(true);
    expect(byId(r).gst.done).toBe(true);
  });

  it('never counts the settled items (feature flag, GST rule) as open steps, whatever the data', () => {
    for (const input of [
      { plans: [], eligibleCount: 0 },
      { plans: [WEEKLY], eligibleCount: 3 },
      { plans: [{ ...WEEKLY, is_active: true }], eligibleCount: 0 },
    ]) {
      const r = setupChecklist(input);
      expect(r.items.filter((i) => i.kind === 'info').every((i) => i.done)).toBe(true);
      expect(r.todo).toBe(r.items.filter((i) => i.kind === 'todo' && !i.done).length);
      expect(byId(r).gst).toMatchObject({ kind: 'info', done: true });
    }
  });

  it('counts drinks in the plural', () => {
    expect(byId(setupChecklist({ plans: [], eligibleCount: 12 })).drinks.detail).toBe('12 drinks chosen.');
  });
});

describe('the eligible-drinks picker', () => {
  const item = (id: string, category: string, is_available = true): PickerItem => ({ id, name: `Drink ${id}`, category, is_available });
  const MENU: PickerItem[] = [
    item('c1', 'Coffee'),
    item('c2', 'Coffee'),
    item('c3', 'Coffee', false),
    item('k1', 'Cold Brews'),
    item('i1', 'Iced Coffee'),
    item('i2', 'Iced Coffee'),
    item('cr1', 'Creme Coffee'),
    item('s1', 'Sandwiches'),
    item('x1', '  '),
  ];
  const groups = groupMenuByCategory(MENU);
  const group = (name: string): CategoryGroup => groups.find((g) => g.category === name) as CategoryGroup;

  it('groups by category in first-seen order, keeping item order, and names a blank category Other', () => {
    expect(groups.map((g) => g.category)).toEqual(['Coffee', 'Cold Brews', 'Iced Coffee', 'Creme Coffee', 'Sandwiches', 'Other']);
    expect(group('Coffee').items.map((i) => i.id)).toEqual(['c1', 'c2', 'c3']);
    expect(group('Other').items.map((i) => i.id)).toEqual(['x1']);
    expect(groupMenuByCategory([])).toEqual([]);
  });

  it('keeps unavailable items (they can still be ticked)', () => {
    expect(group('Coffee').items.find((i) => i.id === 'c3')?.is_available).toBe(false);
  });

  it('reports how much of a category is ticked', () => {
    const coffee = group('Coffee');
    expect(categorySelection(coffee, new Set())).toEqual({ selected: 0, total: 3, state: 'none' });
    expect(categorySelection(coffee, new Set(['c1']))).toEqual({ selected: 1, total: 3, state: 'some' });
    expect(categorySelection(coffee, new Set(['c1', 'c2', 'c3', 'zzz']))).toEqual({ selected: 3, total: 3, state: 'all' });
    expect(categorySelection({ category: 'Empty', items: [] }, new Set(['c1']))).toEqual({ selected: 0, total: 0, state: 'none' });
  });

  it('select-all ticks a whole category, unavailable items included, and leaves the rest alone', () => {
    const start = new Set(['s1']);
    const next = setCategorySelected(start, group('Coffee'), true);
    expect([...next].sort()).toEqual(['c1', 'c2', 'c3', 's1']);
    expect([...start]).toEqual(['s1']); // not mutated
    const cleared = setCategorySelected(next, group('Coffee'), false);
    expect([...cleared]).toEqual(['s1']);
  });

  it('ticks and unticks single items without mutating', () => {
    const start: ReadonlySet<string> = new Set(['c1']);
    expect([...withSelection(start, ['c2'], true)].sort()).toEqual(['c1', 'c2']);
    expect([...withSelection(start, ['c1'], false)]).toEqual([]);
    expect([...withSelection(start, ['c1'], true)]).toEqual(['c1']); // already on
    expect([...start]).toEqual(['c1']);
  });

  it('offers the quick buttons that exist on this menu, in the owner\'s order', () => {
    expect(quickCategories(groups).map((g) => g.category)).toEqual(['Coffee', 'Creme Coffee', 'Iced Coffee', 'Cold Brews']);
    expect(quickCategories(groupMenuByCategory([item('a', 'Iced Coffee'), item('b', 'Bakery')])).map((g) => g.category)).toEqual(['Iced Coffee']);
    expect(quickCategories(groupMenuByCategory([item('a', 'Bakery')]))).toEqual([]);
  });

  it('matches quick categories loosely on case and spacing', () => {
    const loose = groupMenuByCategory([item('a', ' creme   coffee '), item('b', 'COLD BREWS')]);
    expect(quickCategories(loose).map((g) => g.category)).toEqual(['creme   coffee', 'COLD BREWS']);
  });

  it('compares selections regardless of order, and counts only ids on the menu', () => {
    expect(sameSelection(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameSelection(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameSelection(new Set(['a', 'c']), new Set(['a', 'b']))).toBe(false);
    expect(sameSelection(new Set(), new Set())).toBe(true);
    expect(countSelected(MENU, new Set(['c1', 'k1', 'gone']))).toBe(2);
  });

  it('warns about saving nothing only while a plan is on sale', () => {
    expect(eligibleSaveWarning({ selectedCount: 0, hasActivePlan: true })).toBe(
      'No drink is chosen, so nobody could buy a Ritual while a plan is on sale.',
    );
    expect(eligibleSaveWarning({ selectedCount: 0, hasActivePlan: false })).toBeNull();
    expect(eligibleSaveWarning({ selectedCount: 3, hasActivePlan: true })).toBeNull();
  });
});

describe('summary date range', () => {
  it.each([
    ['today', '2026-10-15', { from: '2026-10-15', to: '2026-10-15' }],
    ['7d', '2026-10-15', { from: '2026-10-09', to: '2026-10-15' }],
    ['30d', '2026-10-15', { from: '2026-09-16', to: '2026-10-15' }],
    ['7d', '2026-01-03', { from: '2025-12-28', to: '2026-01-03' }],
    ['30d', '2028-03-10', { from: '2028-02-10', to: '2028-03-10' }], // 2028 is a leap year
  ] as const)('preset %s ending %s', (preset, today, expected) => {
    expect(presetRange(preset, today)).toEqual(expected);
  });

  it('builds the query string', () => {
    expect(summaryQuery({ from: '2026-09-16', to: '2026-10-15' })).toBe('from=2026-09-16&to=2026-10-15');
  });

  it('accepts a good custom range', () => {
    expect(checkCustomRange('2026-10-01', '2026-10-14', '2026-10-15')).toEqual({ ok: true, range: { from: '2026-10-01', to: '2026-10-14' } });
    expect(checkCustomRange('2026-10-15', '2026-10-15', '2026-10-15')).toMatchObject({ ok: true }); // today is allowed
  });

  it.each([
    ['a blank start', '', '2026-10-14', 'Pick both dates.'],
    ['a blank end', '2026-10-01', '', 'Pick both dates.'],
    ['a start after the end', '2026-10-14', '2026-10-01', 'The start date is after the end date.'],
    ['an end in the future', '2026-10-01', '2026-10-16', 'The range can’t end in the future.'],
    ['a date that is not real', '2026-02-30', '2026-10-01', 'Dates must be real dates (YYYY-MM-DD).'],
    ['more than a year', '2025-01-01', '2026-10-15', 'Pick at most 366 days at a time.'],
  ])('refuses %s, in the server\'s words', (_label, from, to, message) => {
    expect(checkCustomRange(from, to, '2026-10-15')).toEqual({ ok: false, message });
  });
});

describe('summaryCards', () => {
  const SUMMARY: PassProgramSummary = {
    range: { from: '2026-10-01', to: '2026-10-14' },
    sold: { count: 12, inr: 9600 },
    sold_by_plan: [{ plan_name: 'Weekly Ritual', count: 12, inr: 9600 }],
    refunded: { count: 1, inr: 750 },
    active: { passes: 8, cups_outstanding: 41, liability_inr: 4392 },
    redeemed: { cups: 30, covered_inr: 3900 },
    expired_unused: { cups: 1, inr: 107 },
    recent: [],
  };

  it('words the seven cards, live ones flagged, liability first among equals', () => {
    const cards = summaryCards(SUMMARY);
    expect(cards.map((c) => c.id)).toEqual(['sold', 'refunded', 'active', 'cups', 'liability', 'redeemed', 'expired']);
    expect(cards.map((c) => [c.label, c.value, c.sub])).toEqual([
      ['Rituals sold', '12', '₹9,600'],
      ['Refunded', '1', '₹750'],
      ['Active Rituals', '8', 'in date, with cups left'],
      ['Cups outstanding', '41', 'left on active Rituals'],
      ['Liability', '₹4,392', 'Cups still owed × what customers paid per cup.'],
      ['Cups redeemed', '30', '₹3,900 covered'],
      ['Expired unused', '1 cup', '₹107'],
    ]);
    expect(cards.filter((c) => c.live).map((c) => c.id)).toEqual(['active', 'cups', 'liability']);
    expect(cards.filter((c) => c.emphasis).map((c) => c.id)).toEqual(['liability']);
  });

  it('is all zeros, not blanks, for a cafe with no sales yet', () => {
    const empty: PassProgramSummary = {
      ...SUMMARY,
      sold: { count: 0, inr: 0 },
      sold_by_plan: [],
      refunded: { count: 0, inr: 0 },
      active: { passes: 0, cups_outstanding: 0, liability_inr: 0 },
      redeemed: { cups: 0, covered_inr: 0 },
      expired_unused: { cups: 0, inr: 0 },
    };
    expect(summaryCards(empty).map((c) => c.value)).toEqual(['0', '0', '0', '0', '₹0', '0', '0 cups']);
  });
});

describe('reportPassRows', () => {
  const totals = { passSales: { count: 3, inr: 2250 }, passRedemptions: { drinks: 5, inr: 640 } };

  it('adds the two informational rows when there is something to show', () => {
    expect(reportPassRows(totals, true)).toEqual({
      sales: { label: 'of which HIOC Ritual sales', value: '3 · ₹2,250' },
      cups: { label: 'Cups served on HIOC Ritual', value: '5 cups · ₹640 covered' },
    });
  });

  it('says "1 cup" in the singular', () => {
    expect(reportPassRows({ passSales: { count: 0, inr: 0 }, passRedemptions: { drinks: 1, inr: 120 } }, true).cups?.value).toBe('1 cup · ₹120 covered');
  });

  it('adds nothing while the flag is off, whatever the numbers', () => {
    expect(reportPassRows(totals, false)).toEqual({ sales: null, cups: null });
  });

  it('adds nothing for zeros, or for totals that predate the feature', () => {
    expect(reportPassRows({ passSales: { count: 0, inr: 0 }, passRedemptions: { drinks: 0, inr: 0 } }, true)).toEqual({ sales: null, cups: null });
    expect(reportPassRows({}, true)).toEqual({ sales: null, cups: null });
    expect(reportPassRows({ passSales: null, passRedemptions: null }, true)).toEqual({ sales: null, cups: null });
  });

  it('shows each row on its own', () => {
    const onlySales = reportPassRows({ passSales: { count: 2, inr: 1500 }, passRedemptions: { drinks: 0, inr: 0 } }, true);
    expect(onlySales.sales).not.toBeNull();
    expect(onlySales.cups).toBeNull();
    const onlyCups = reportPassRows({ passSales: { count: 0, inr: 0 }, passRedemptions: { drinks: 2, inr: 200 } }, true);
    expect(onlyCups.sales).toBeNull();
    expect(onlyCups.cups).not.toBeNull();
  });
});
