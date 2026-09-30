import { describe, expect, it } from 'vitest';
import {
  buildPlanPayload,
  canUseSuggestedPrice,
  categorySelection,
  checkCustomRange,
  countSelected,
  cupsLeftLabel,
  cupsWorthInr,
  dailyCapLabel,
  effectiveDiscountPercent,
  eligibleSaveWarning,
  emptyPlanForm,
  formatCount,
  formatIstDay,
  formatRupees,
  formatValidTill,
  formPriceInr,
  formPriceText,
  formSuggestedPrice,
  groupMenuByCategory,
  GST_RULE,
  nextSortOrder,
  parseWholeNumber,
  passStateLabel,
  passStateTone,
  passValidTillIso,
  perCupPriceInr,
  planPreview,
  planRow,
  planSaveConfirmation,
  planToForm,
  presetRange,
  priceWarning,
  quickCategories,
  reportPassRows,
  sameSelection,
  setCategorySelected,
  setupChecklist,
  sortPlans,
  suggestedPriceInr,
  summaryCards,
  summaryQuery,
  validityLabel,
  withSelection,
  withSuggestedPrice,
  withTypedPrice,
  type CategoryGroup,
  type PickerItem,
  type PlanForm,
} from '@/lib/passes/ownerUi';
import { validatePlanInput } from '@/lib/passes/rules';
import type { PassProgramSummary } from '@/lib/passes/summary';
import type { CoffeePassPlan, PassState } from '@/lib/passes/types';

// lib/passes/ownerUi.ts: the rules behind Owner → HIOC Ritual, as pure functions. The
// screens (components/owner/passes) only hold state and draw, so what the owner is
// TOLD (a price, a discount, a warning, what to confirm, what is left to do) is pinned
// here. The seeded plans (spec §5.6) are the running example.

const WEEKLY: CoffeePassPlan = {
  id: 'plan-weekly',
  name: 'Weekly Ritual',
  description: '7 cups for the price of 5',
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
const MONTHLY: CoffeePassPlan = {
  ...WEEKLY,
  id: 'plan-monthly',
  name: 'Monthly Ritual',
  description: 'Pay for 6, get 7',
  drinks_paid: 6,
  validity_days: 30,
  price_inr: 900,
  sort_order: 20,
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
    [5, 150, 750],
    [6, 150, 900],
    [1, 1, 1],
    [0, 150, null],
    [5, 0, null],
    [-1, 150, null],
    [2.5, 150, null],
  ])('suggested price for %s cups paid at ₹%s is %s', (paid, value, expected) => {
    expect(suggestedPriceInr(paid, value)).toBe(expected);
  });

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

  it('works out what the cups are worth', () => {
    expect(cupsWorthInr(7, 150)).toBe(1050);
    expect(cupsWorthInr(0, 150)).toBeNull();
    expect(cupsWorthInr(7, 0)).toBeNull();
  });

  it.each([
    // The seeded plans: 29% and 14%.
    [750, 7, 150, 29],
    [900, 7, 150, 14],
    // An overridden price follows the price, not the cups paid for.
    [800, 7, 150, 24],
    [1050, 7, 150, 0],
    [1000, 7, 150, 5],
    // Above the cups' value: negative, and priceWarning speaks.
    [1200, 7, 150, -14],
    [1051, 7, 150, 0], // -0.09% rounds to 0, never -0
    [0, 7, 150, null],
    [750, 0, 150, null],
    [750, 7, 0, null],
  ])('₹%s for %s cups of ₹%s is %s%% off', (price, total, value, expected) => {
    const got = effectiveDiscountPercent(price, total, value);
    expect(got).toBe(expected);
    if (got === 0) expect(Object.is(got, -0)).toBe(false);
  });

  it('warns when the price is above what the cups are worth, and only then', () => {
    expect(priceWarning(750, 7, 150)).toBeNull();
    expect(priceWarning(1050, 7, 150)).toBeNull(); // equal is not a warning
    expect(priceWarning(1051, 7, 150)).toBe(
      'The price (₹1,051) is more than the cups are worth (7 × ₹150 = ₹1,050). Customers would pay more than menu price.',
    );
    expect(priceWarning(Number.NaN, 7, 150)).toBeNull();
    expect(priceWarning(750, 0, 150)).toBeNull();
  });

  it('describes a plan row without further arithmetic', () => {
    expect(planRow(WEEKLY)).toEqual({ perCup: 107.14, discountPercent: 29, overpriced: false, validity: '7 days', cap: 'No limit' });
    expect(planRow({ ...MONTHLY, max_per_day: 1 })).toMatchObject({ perCup: 128.57, discountPercent: 14, validity: '30 days', cap: '1 a day' });
    expect(planRow({ ...WEEKLY, price_inr: 2000 })).toMatchObject({ overpriced: true, discountPercent: -90 });
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
  it('starts a new plan Weekly-shaped, with the suggested price, switched off', () => {
    const form = emptyPlanForm();
    expect(form).toMatchObject({ name: '', drinks_total: '7', drinks_paid: '5', validity_days: '7', drink_value_inr: '150', is_active: false, price_custom: false });
    expect(formSuggestedPrice(form)).toBe(750);
    expect(formPriceInr(form)).toBe(750);
    expect(formPriceText(form)).toBe('750');
  });

  it('follows the suggested price until the owner types their own', () => {
    let form: PlanForm = emptyPlanForm();
    form = { ...form, drinks_paid: '6' };
    expect(formPriceInr(form)).toBe(900); // the price moved with the cups paid for
    expect(canUseSuggestedPrice(form)).toBe(false);

    form = withTypedPrice(form, '850');
    expect(form.price_custom).toBe(true);
    expect(formPriceInr(form)).toBe(850);
    expect(formPriceText(form)).toBe('850');
    expect(canUseSuggestedPrice(form)).toBe(true);
    // ...and no longer follows the cups
    expect(formPriceInr({ ...form, drinks_paid: '5' })).toBe(850);

    form = withSuggestedPrice(form);
    expect(form.price_custom).toBe(false);
    expect(formPriceInr(form)).toBe(900);
    expect(canUseSuggestedPrice(form)).toBe(false);
  });

  it('treats a typed price that equals the suggestion as still the owner\'s own, but offers no button', () => {
    const form = withTypedPrice(emptyPlanForm(), '750');
    expect(canUseSuggestedPrice(form)).toBe(false);
  });

  it('cannot suggest while the boxes are unreadable', () => {
    const form: PlanForm = { ...emptyPlanForm(), drinks_paid: '' };
    expect(formSuggestedPrice(form)).toBeNull();
    expect(formPriceInr(form)).toBeNull();
    expect(formPriceText(form)).toBe('');
    expect(canUseSuggestedPrice(form)).toBe(false);
    expect(planPreview(form)).toMatchObject({ price: null, suggested: null, perCup: null, discountPercent: null, warning: null });
  });

  it('edits a stored plan: its own price counts as custom only when it differs from the suggestion', () => {
    expect(planToForm(WEEKLY)).toMatchObject({ name: 'Weekly Ritual', drinks_total: '7', price_inr: '750', price_custom: false, max_per_day: '', is_active: false });
    expect(planToForm({ ...WEEKLY, price_inr: 700, max_per_day: 1, is_active: true })).toMatchObject({ price_inr: '700', price_custom: true, max_per_day: '1', is_active: true });
  });

  it('shows the live preview: per cup, discount, warning', () => {
    expect(planPreview(emptyPlanForm())).toEqual({
      price: 750,
      suggested: 750,
      perCup: 107.14,
      discountPercent: 29,
      worth: 1050,
      warning: null,
    });
    const over = planPreview(withTypedPrice(emptyPlanForm(), '1200'));
    expect(over.discountPercent).toBe(-14);
    expect(over.warning).toContain('more than the cups are worth');
  });
});

describe('buildPlanPayload', () => {
  const create = (patch: Partial<PlanForm> = {}) => buildPlanPayload({ ...emptyPlanForm(), name: 'Weekly Ritual', ...patch }, null, 30);

  it('creates: the whole plan, the suggested price, and a sort order after the others', () => {
    expect(create()).toEqual({
      ok: true,
      changed: true,
      body: {
        name: 'Weekly Ritual',
        description: '',
        drinks_total: 7,
        drinks_paid: 5,
        validity_days: 7,
        drink_value_inr: 150,
        price_inr: 750,
        max_per_day: null,
        gst_exempt: false,
        is_active: false,
        sort_order: 30,
      },
    });
  });

  it('what it builds for a create passes the server\'s own validator', () => {
    const built = create({ description: '  7 for 5  ', max_per_day: '1', gst_exempt: true, is_active: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validatePlanInput(built.body as Record<string, unknown>, { partial: false }).ok).toBe(true);
    expect(built.body).toMatchObject({ description: '7 for 5', max_per_day: 1, gst_exempt: true, is_active: true });
  });

  it('sends an overridden price and a trimmed name', () => {
    const built = create({ name: '  Sunday Ritual ' });
    expect(built.ok && built.body.name).toBe('Sunday Ritual');
    const custom = buildPlanPayload(withTypedPrice({ ...emptyPlanForm(), name: 'X' }, '₹1,000'), null);
    expect(custom.ok && custom.body.price_inr).toBe(1000);
    // no sort order given: none sent (the server defaults it)
    expect(custom.ok && 'sort_order' in custom.body).toBe(false);
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
    ['a zero cup value', { drink_value_inr: '0' }, 'Cup value must be a whole number of rupees from 1 to 5000.'],
    ['a typed price of words', { price_custom: true, price_inr: 'cheap' }, 'Price must be a whole number of rupees from 1 to 100000.'],
    ['an emptied price', { price_custom: true, price_inr: '' }, 'Price must be a whole number of rupees from 1 to 100000.'],
    ['a daily limit of words', { max_per_day: 'one' }, 'Daily limit must be empty or a whole number of cups from 1 up.'],
    ['a daily limit above the cups', { max_per_day: '8' }, 'Daily limit cannot be more than the cups in the pass.'],
    ['a description over 500', { description: 'y'.repeat(501) }, 'Description must be 500 characters or fewer.'],
  ])('refuses %s', (_label, patch, message) => {
    expect(create(patch)).toEqual({ ok: false, error: message });
  });

  it('edits: only the fields that changed, never the sort order', () => {
    const form = { ...planToForm(WEEKLY), name: 'Weekly Ritual+', price_custom: true, price_inr: '700' };
    expect(buildPlanPayload(form, WEEKLY, 99)).toEqual({ ok: true, changed: true, body: { name: 'Weekly Ritual+', price_inr: 700 } });
  });

  it('edits: no change means no request', () => {
    expect(buildPlanPayload(planToForm(WEEKLY), WEEKLY, 99)).toEqual({ ok: true, changed: false, body: {} });
    // trimmed whitespace is not a change
    expect(buildPlanPayload({ ...planToForm(WEEKLY), name: ' Weekly Ritual ' }, WEEKLY)).toMatchObject({ changed: false });
  });

  it('edits: clearing the daily limit sends null; setting one sends the number', () => {
    const capped = { ...WEEKLY, max_per_day: 1 };
    expect(buildPlanPayload({ ...planToForm(capped), max_per_day: '' }, capped)).toMatchObject({ body: { max_per_day: null } });
    expect(buildPlanPayload({ ...planToForm(WEEKLY), max_per_day: '1' }, WEEKLY)).toMatchObject({ body: { max_per_day: 1 } });
  });

  it('edits: changing the cups paid for moves a suggested price with it, unless the owner overrode it', () => {
    expect(buildPlanPayload({ ...planToForm(WEEKLY), drinks_paid: '6' }, WEEKLY)).toMatchObject({ body: { drinks_paid: 6, price_inr: 900 } });
    const overridden = { ...WEEKLY, price_inr: 700 };
    expect(buildPlanPayload({ ...planToForm(overridden), drinks_paid: '6' }, overridden)).toMatchObject({ body: { drinks_paid: 6 } });
    expect(buildPlanPayload({ ...planToForm(overridden), drinks_paid: '6' }, overridden)).not.toMatchObject({ body: { price_inr: expect.anything() } });
  });

  it('sorts new plans after the existing ones, in steps of 10', () => {
    expect(nextSortOrder([])).toBe(10);
    expect(nextSortOrder([WEEKLY, MONTHLY])).toBe(30);
    expect(nextSortOrder([{ sort_order: 0 }])).toBe(10);
  });

  it('lists plans the way the server does', () => {
    const cheap = { ...WEEKLY, id: 'a', name: 'A', sort_order: 10, price_inr: 500 };
    const dear = { ...WEEKLY, id: 'b', name: 'B', sort_order: 10, price_inr: 900 };
    const later = { ...WEEKLY, id: 'c', name: 'C', sort_order: 20, price_inr: 100 };
    expect(sortPlans([later, dear, cheap]).map((p) => p.id)).toEqual(['a', 'b', 'c']);
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

  it('asks before the price or terms of a live plan change', () => {
    for (const change of [{ price_inr: 800 }, { drinks_total: 8 }, { drink_value_inr: 140 }, { validity_days: 10 }, { max_per_day: 1 }, { gst_exempt: true }, { drinks_paid: 4 }]) {
      expect(planSaveConfirmation(live, change), JSON.stringify(change)).toMatchObject({ title: 'Change a live plan?', danger: false });
    }
  });

  it('does not ask when nothing that matters to a sale changes', () => {
    expect(planSaveConfirmation(live, { name: 'Renamed', description: 'New words' })).toBeNull(); // wording only
    expect(planSaveConfirmation(WEEKLY, { price_inr: 800, drinks_total: 8 })).toBeNull(); // not on sale yet
    expect(planSaveConfirmation(null, { name: 'New', is_active: false })).toBeNull(); // a new plan left off
    expect(planSaveConfirmation(live, { price_inr: 750 })).toBeNull(); // the same price
    expect(planSaveConfirmation(live, { is_active: true })).toBeNull(); // still on
    expect(planSaveConfirmation(WEEKLY, { is_active: false })).toBeNull(); // still off
  });

  it('activating wins over a terms change in the same save', () => {
    expect(planSaveConfirmation(WEEKLY, { price_inr: 800, is_active: true })?.title).toBe('Make this plan available?');
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
    expect(items.drinks).toMatchObject({ kind: 'todo', done: false, href: '#ritual-drinks' });
    expect(items.gst).toMatchObject({ kind: 'info', done: true, href: '#ritual-plans' });
    expect(items.gst.label).toBe(GST_RULE);
    expect(items.gst.label).toBe('GST: 5% when a Ritual is sold · 0% on redeemed cups');
    expect(items.gst.detail).toBe(
      'Decided by the owner on 30 Sep 2026. Cups are paid for when the Ritual is sold, so a redeemed cup carries no GST; a top-up above the cup value is taxed like any sale.',
    );
  });

  it('plans that exist but none on sale: still to do', () => {
    const r = setupChecklist({ plans: [WEEKLY, MONTHLY], eligibleCount: 0 });
    expect(byId(r).plan).toMatchObject({ done: false, label: 'Check the prices, then switch a plan on', detail: 'No plan is on sale yet, so customers cannot buy anything.' });
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
      'No drink is chosen, so a Ritual cup would cover nothing while a plan is on sale.',
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
