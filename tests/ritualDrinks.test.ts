import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER,
  NO_CHOICE,
  PICKER_SEARCH_MIN_DRINKS,
  PRICE_FOLLOWS_DRINK,
  categoryLabel,
  choiceLabel,
  choiceLineName,
  chooseDrink,
  chooseSize,
  completeChoice,
  drinkSelectable,
  filterDrinks,
  passCoverLine,
  passTitle,
  pickerNeedsSearch,
  pickerView,
  priceRangeLabel,
  resolveChoice,
  ritualCoverLine,
  ritualPerCupLine,
  ritualPriceLine,
  ritualPriceQuote,
  sizesOnSale,
} from '@/lib/passes/ritualDrinks';
import type { RitualDrink } from '@/lib/passes/types';

// The drink picker's pure half (docs/COFFEE-PASS-SPEC.md §13, CP-D22..D25): what is
// listed and searched, which size is chosen, the price line, and the words a pass
// uses for its drink. Shared by /ritual, the counter and the owner screen, so the
// edges are pinned here once.

function drink(over: Partial<RitualDrink> & Pick<RitualDrink, 'id' | 'name'>): RitualDrink {
  return {
    category: 'Coffee',
    is_available: true,
    sizes: [
      { variant_id: `${over.id}-s`, label: 'Small', price_inr: 90 },
      { variant_id: `${over.id}-l`, label: 'Large', price_inr: 120 },
    ],
    ...over,
  };
}

const CAPPUCCINO = drink({ id: 'cap', name: 'Cappuccino' });
const LATTE = drink({ id: 'lat', name: 'Latte' });
const CREME = drink({ id: 'cre', name: 'Crème Brûlée Latte', category: 'Creme Coffee' });
const ICED = drink({ id: 'ice', name: 'Iced Americano', category: 'Iced Coffee', sizes: [{ variant_id: 'ice-r', label: '', price_inr: 100 }] });
const COLD = drink({ id: 'cold', name: 'Cold Brew', category: 'Cold Brews', is_available: false });
const ALL = [CAPPUCCINO, LATTE, CREME, ICED, COLD];

describe('sizes', () => {
  it('lists only sizes on sale (₹1 or more), cheapest first, keeping the API order among equals', () => {
    const d = drink({
      id: 'x',
      name: 'X',
      sizes: [
        { variant_id: 'b', label: 'Large', price_inr: 140 },
        { variant_id: 'free', label: 'Free', price_inr: 0 },
        { variant_id: 'a', label: 'Small', price_inr: 90 },
        { variant_id: 'c', label: 'Also large', price_inr: 140 },
      ],
    });
    expect(sizesOnSale(d).map((s) => s.variant_id)).toEqual(['a', 'b', 'c']);
  });

  it('labels a price range, or one price when every size costs the same', () => {
    expect(priceRangeLabel(CAPPUCCINO)).toBe('₹90–₹120');
    expect(priceRangeLabel(ICED)).toBe('₹100');
    expect(priceRangeLabel(drink({ id: 'n', name: 'N', sizes: [] }))).toBe('');
  });

  it('a drink can be picked while it is on the menu and has a size on sale', () => {
    expect(drinkSelectable(CAPPUCCINO)).toBe(true);
    expect(drinkSelectable(COLD)).toBe(false); // off the menu today: listed, greyed
    expect(drinkSelectable(drink({ id: 'n', name: 'N', sizes: [{ variant_id: 'z', label: 'S', price_inr: 0 }] }))).toBe(false);
  });
});

describe('the choice', () => {
  it('a drink with several sizes waits for one; a drink with a single size is complete at once', () => {
    expect(chooseDrink(CAPPUCCINO)).toEqual({ drinkId: 'cap', variantId: null });
    expect(chooseDrink(ICED)).toEqual({ drinkId: 'ice', variantId: 'ice-r' });
  });

  it('tapping the drink already chosen keeps its size; another drink starts over', () => {
    const large = chooseSize(chooseDrink(CAPPUCCINO), 'cap-l');
    expect(large).toEqual({ drinkId: 'cap', variantId: 'cap-l' });
    expect(chooseDrink(CAPPUCCINO, large)).toEqual(large);
    expect(chooseDrink(LATTE, large)).toEqual({ drinkId: 'lat', variantId: null });
  });

  it('choosing a size with no drink chosen changes nothing', () => {
    expect(chooseSize(NO_CHOICE, 'cap-l')).toEqual(NO_CHOICE);
  });

  it('resolves against the list as it is now: a drink or size that has gone resolves to nothing', () => {
    expect(resolveChoice(ALL, NO_CHOICE)).toBeNull();
    expect(resolveChoice(ALL, { drinkId: 'cap', variantId: null })).toEqual({ drink: CAPPUCCINO, size: null });
    expect(resolveChoice(ALL, { drinkId: 'cap', variantId: 'cap-l' })?.size?.price_inr).toBe(120);
    // The owner unticked it, or the page re-read the offer: a stale choice can never be bought.
    expect(resolveChoice([LATTE], { drinkId: 'cap', variantId: 'cap-l' })).toBeNull();
    // The size went off sale: the drink stays chosen, the size does not.
    const repriced = drink({ id: 'cap', name: 'Cappuccino', sizes: [{ variant_id: 'cap-s', label: 'Small', price_inr: 90 }] });
    expect(resolveChoice([repriced], { drinkId: 'cap', variantId: 'cap-l' })).toEqual({ drink: repriced, size: null });
    // A drink that went off the menu cannot be bought either.
    expect(resolveChoice(ALL, { drinkId: 'cold', variantId: 'cold-l' })).toBeNull();
  });

  it('is complete only with a size', () => {
    expect(completeChoice(ALL, { drinkId: 'cap', variantId: null })).toBeNull();
    const done = completeChoice(ALL, { drinkId: 'cap', variantId: 'cap-l' });
    expect(done?.drink.id).toBe('cap');
    expect(done?.size.variant_id).toBe('cap-l');
  });

  it('words the drink as a pass remembers it, and the sale line as the bill reads it', () => {
    const done = completeChoice(ALL, { drinkId: 'cap', variantId: 'cap-l' });
    expect(done && choiceLabel(done)).toBe('Cappuccino · Large');
    expect(done && choiceLineName({ name: 'Weekly Ritual' }, done)).toBe('Weekly Ritual — Cappuccino (Large)');
    // A size with no name reads as just the drink.
    const plain = completeChoice(ALL, { drinkId: 'ice', variantId: 'ice-r' });
    expect(plain && choiceLabel(plain)).toBe('Iced Americano');
    expect(plain && choiceLineName({ name: 'Monthly Ritual' }, plain)).toBe('Monthly Ritual — Iced Americano');
  });
});

describe('searching', () => {
  it('matches every word typed, in any order, against the name and the category', () => {
    expect(filterDrinks(ALL, 'latte').map((d) => d.id)).toEqual(['lat', 'cre']);
    expect(filterDrinks(ALL, 'americano iced').map((d) => d.id)).toEqual(['ice']);
    expect(filterDrinks(ALL, 'cold brews').map((d) => d.id)).toEqual(['cold']); // the category's name
  });

  it('ignores case, spaces and accents ("creme" finds "Crème")', () => {
    expect(filterDrinks(ALL, '  CAPPU   ').map((d) => d.id)).toEqual(['cap']);
    expect(filterDrinks(ALL, 'creme brulee').map((d) => d.id)).toEqual(['cre']);
  });

  it('matches the category by its label, not only its stored name', () => {
    expect(categoryLabel('Creme Coffee')).toBe('Crème Coffee');
    expect(filterDrinks(ALL, 'crème coffee', categoryLabel).map((d) => d.id)).toEqual(['cre']);
  });

  it('keeps everything for an empty search, and finds nothing for a miss', () => {
    expect(filterDrinks(ALL, '').length).toBe(ALL.length);
    expect(filterDrinks(ALL, '   ').length).toBe(ALL.length);
    expect(filterDrinks(ALL, 'waffle')).toEqual([]);
  });

  it('does not change or reorder its input', () => {
    const copy = [...ALL];
    filterDrinks(ALL, 'latte');
    expect(ALL).toEqual(copy);
  });

  it('offers a search box once the list is long enough to need one', () => {
    expect(pickerNeedsSearch(PICKER_SEARCH_MIN_DRINKS)).toBe(false);
    expect(pickerNeedsSearch(PICKER_SEARCH_MIN_DRINKS + 1)).toBe(true);
    expect(pickerNeedsSearch(59)).toBe(true);
  });
});

describe('grouping and the category chips', () => {
  const view = (opts: { query?: string; category?: string | null } = {}) =>
    pickerView(ALL, { ...opts, categoryOrder: CATEGORY_ORDER, labelFor: categoryLabel });

  it('groups in the menu order, with the store label, and keeps the drinks in the order received', () => {
    const v = view();
    expect(v.groups.map((g) => g.category)).toEqual(['Coffee', 'Creme Coffee', 'Iced Coffee', 'Cold Brews']);
    expect(v.groups[1].label).toBe('Crème Coffee');
    expect(v.groups[0].drinks.map((d) => d.id)).toEqual(['cap', 'lat']);
    expect(v.shown).toBe(5);
    expect(v.chips).toEqual([
      { category: 'Coffee', label: 'Coffee', count: 2 },
      { category: 'Creme Coffee', label: 'Crème Coffee', count: 1 },
      { category: 'Iced Coffee', label: 'Iced Coffee', count: 1 },
      { category: 'Cold Brews', label: 'Cold Brews', count: 1 },
    ]);
  });

  it('a chosen category lists only that group, while every chip stays', () => {
    const v = view({ category: 'Iced Coffee' });
    expect(v.groups.map((g) => g.category)).toEqual(['Iced Coffee']);
    expect(v.shown).toBe(1);
    expect(v.chips).toHaveLength(4);
  });

  it('the chips follow the search, so none would be empty', () => {
    const v = view({ query: 'latte' });
    expect(v.chips.map((c) => [c.category, c.count])).toEqual([
      ['Coffee', 1],
      ['Creme Coffee', 1],
    ]);
    expect(v.shown).toBe(2);
  });

  it('a chosen category with no match leaves the list empty instead of showing everything', () => {
    const v = view({ query: 'latte', category: 'Cold Brews' });
    expect(v.groups).toEqual([]);
    expect(v.shown).toBe(0);
  });

  it('puts a category the menu does not know after the ones it does, alphabetically', () => {
    const odd = [drink({ id: 'z', name: 'Z', category: 'Zebra' }), drink({ id: 'a', name: 'A', category: 'Alpha' }), CAPPUCCINO];
    const v = pickerView(odd, { categoryOrder: CATEGORY_ORDER });
    expect(v.groups.map((g) => g.category)).toEqual(['Coffee', 'Alpha', 'Zebra']);
    expect(v.groups[1].label).toBe('Alpha'); // no labelFor: as stored
  });

  it('is empty for no drinks', () => {
    expect(pickerView([], { categoryOrder: CATEGORY_ORDER })).toEqual({ chips: [], groups: [], shown: 0 });
  });
});

describe('the live price — spec §13 worked examples (the server prices it again; this is a preview)', () => {
  const weekly = { drinks_paid: 5, gst_exempt: false };
  const monthly = { drinks_paid: 6, gst_exempt: false };
  const exclusive = { percent: 5, inclusive: false };

  it('Weekly, Cappuccino Large ₹120: 5 × 120 = ₹600 + ₹30 GST = ₹630', () => {
    const q = ritualPriceQuote(weekly, 120, exclusive);
    expect(q).toEqual({ cups: 5, cupPriceInr: 120, subtotalInr: 600, gstInr: 30, gst: 'added', totalInr: 630 });
    expect(ritualPriceLine(q)).toBe('5 × ₹120 = ₹600 + ₹30 GST = ₹630');
  });

  it('Monthly, Latte Large ₹140: 6 × 140 = ₹840 + ₹42 GST = ₹882', () => {
    const q = ritualPriceQuote(monthly, 140, exclusive);
    expect(q.totalInr).toBe(882);
    expect(ritualPriceLine(q)).toBe('6 × ₹140 = ₹840 + ₹42 GST = ₹882');
  });

  it('GST already in the price: the total is the subtotal and the line says what is inside it', () => {
    const q = ritualPriceQuote(weekly, 120, { percent: 5, inclusive: true });
    expect(q).toMatchObject({ subtotalInr: 600, gstInr: 29, gst: 'included', totalInr: 600 });
    expect(ritualPriceLine(q)).toBe('5 × ₹120 = ₹600 (includes ₹29 GST)');
  });

  it('a GST-exempt plan has no GST line either way', () => {
    for (const gst of [exclusive, { percent: 5, inclusive: true }]) {
      const q = ritualPriceQuote({ drinks_paid: 5, gst_exempt: true }, 120, gst);
      expect(q).toMatchObject({ gstInr: 0, gst: 'none', totalInr: 600 });
      expect(ritualPriceLine(q)).toBe('5 × ₹120 = ₹600');
    }
  });

  it('a store that charges no GST, or one whose setting is not known, shows the plain sum', () => {
    expect(ritualPriceLine(ritualPriceQuote(weekly, 150, { percent: 0, inclusive: false }))).toBe('5 × ₹150 = ₹750');
    const unknown = ritualPriceQuote(monthly, 150, null);
    expect(unknown).toMatchObject({ gst: 'none', totalInr: 900 });
    expect(ritualPriceLine(unknown)).toBe('6 × ₹150 = ₹900');
  });

  it('rounds GST to a whole rupee like the bill does', () => {
    // 5 × ₹90 = ₹450; 5% is 22.5 → ₹23.
    expect(ritualPriceQuote(weekly, 90, exclusive)).toMatchObject({ gstInr: 23, totalInr: 473 });
  });

  it('says what each cup covers, and the price follows the drink', () => {
    expect(ritualCoverLine(120)).toBe('Each cup covers up to ₹120 on any Ritual coffee.');
    expect(PRICE_FOLLOWS_DRINK).toBe('The price follows the drink you pick.');
  });

  it('works out a cup against the drink\'s own price, only when there is a saving', () => {
    expect(ritualPerCupLine({ drinks_paid: 5, drinks_total: 7 }, 120)).toBe('About ₹86 a cup instead of ₹120'); // 600 / 7
    expect(ritualPerCupLine({ drinks_paid: 6, drinks_total: 7 }, 140)).toBe('About ₹120 a cup instead of ₹140'); // 840 / 7
    expect(ritualPerCupLine({ drinks_paid: 7, drinks_total: 7 }, 120)).toBeNull();
    expect(ritualPerCupLine({ drinks_paid: 5, drinks_total: 0 }, 120)).toBeNull();
  });
});

describe('a pass and its drink (CP-D25)', () => {
  it('titles a pass by its plan and drink, and falls back to the plan for one with no drink label', () => {
    expect(passTitle({ plan_name: 'Weekly Ritual', drink_label: 'Cappuccino · Large' })).toBe('Weekly Ritual · Cappuccino · Large');
    expect(passTitle({ plan_name: 'Weekly Ritual', drink_label: '' })).toBe('Weekly Ritual');
    expect(passTitle({ plan_name: 'Weekly Ritual', drink_label: '   ' })).toBe('Weekly Ritual');
  });

  it('says what a cup covers, or nothing when the pass has no value on record', () => {
    expect(passCoverLine({ drink_value_inr: 120 })).toBe('Each cup covers up to ₹120');
    expect(passCoverLine({ drink_value_inr: 0 })).toBe('');
  });
});
