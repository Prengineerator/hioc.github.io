import { describe, expect, it } from 'vitest';

// Menu facets (lib/suggest/facets.ts): each option's effect on each item, taken
// from the engine's own functions, and the pure "which options lead nowhere"
// check the wizard uses.

import { FACET_OPTIONS, menuFacets, unavailableOptions, type FacetOption, type MenuFacet } from '@/lib/suggest/facets';
import { passesHardConstraints } from '@/lib/suggest/filter';
import { satisfiesChoice } from '@/lib/suggest/promises';
import { isSugarAdjustable } from '@/lib/suggest/sugar';
import type { SuggestInputs } from '@/lib/suggest/types';
import {
  BAKED_CHEESE_NACHOS,
  BERRY_LEMONADE,
  BLUEBERRY_CHEESECAKE,
  CAPPUCCINO,
  CAPPUCCINO_TRAITS,
  BERRY_LEMONADE_TRAITS,
  BLUEBERRY_CHEESECAKE_TRAITS,
  BAKED_CHEESE_NACHOS_TRAITS,
  buildFixtureMenu,
  buildFixtureTraitsById,
  UNAVAILABLE_ITEM,
  NO_TRAITS_ITEM,
} from './fixtures/suggestMenu';
import type { MenuItem } from '@/lib/types';
import type { MenuItemTraits } from '@/lib/suggest/types';

const st = (facet: MenuFacet, option: FacetOption) => facet.states[FACET_OPTIONS.indexOf(option)];

function facetOf(item: MenuItem, traits: MenuItemTraits): MenuFacet {
  return menuFacets([item], new Map([[item.id, traits]]))[0];
}

// Independent restatement of the spec, using the engine functions directly.
function expected(item: MenuItem, traits: MenuItemTraits, option: FacetOption): string {
  const inputs: SuggestInputs = {
    mood: 'cosy', secondaryMood: null, kinds: [traits.kind], temperature: 'either', base: 'either',
    strength: 'any', sweetness: 'any', body: 'any', flavours: [], needs: [], budget: 'any', note: '',
  };
  const subject = { name: item.name, traits, sugarAdjustable: isSugarAdjustable(item) };
  const tri = (v: boolean | null) => (v === null ? 'n' : v ? 'k' : 'x');
  const [g, v] = option.split(':');
  if (g === 'temp') {
    if (traits.kind !== 'drink') return 'n';
    inputs.temperature = v as 'hot' | 'iced';
    return passesHardConstraints(item, traits, inputs, []) ? 'k' : 'x';
  }
  if (g === 'flavour') return tri(satisfiesChoice('flavours', subject, { ...inputs, flavours: [v as 'fruity'] }));
  if (g === 'body') return tri(satisfiesChoice('body', subject, { ...inputs, body: v as 'light' }));
  if (g === 'budget') return passesHardConstraints(item, traits, { ...inputs, budget: v as 'under_100' }, []) ? 'k' : 'x';
  if (g === 'caffeineFree') return passesHardConstraints(item, traits, { ...inputs, needs: ['no_caffeine'] }, []) ? 'k' : 'x';
  if (g === 'sweet') {
    const i = { ...inputs, sweetness: v as 'none' };
    return passesHardConstraints(item, traits, i, []) ? tri(satisfiesChoice('sweetness', subject, i)) : 'x';
  }
  if (v === 'none') {
    return passesHardConstraints(item, traits, { ...inputs, base: 'no_coffee' }, []) ? (traits.kind === 'drink' ? 'k' : 'n') : 'x';
  }
  const i = { ...inputs, base: 'coffee' as const, strength: v as 'strong' };
  return passesHardConstraints(item, traits, i, []) ? tri(satisfiesChoice('strength', subject, i)) : 'x';
}

describe('menuFacets', () => {
  it('has one character per option and one facet per orderable tagged item', () => {
    const facets = menuFacets(buildFixtureMenu(), buildFixtureTraitsById());
    expect(facets.length).toBeGreaterThan(20);
    for (const f of facets) expect(f.states).toHaveLength(FACET_OPTIONS.length);
    expect(menuFacets([UNAVAILABLE_ITEM, NO_TRAITS_ITEM], buildFixtureTraitsById())).toEqual([]);
  });

  it('matches the engine for a hot coffee, an iced non-coffee, a dessert and a food item', () => {
    for (const [item, traits] of [
      [CAPPUCCINO, CAPPUCCINO_TRAITS],
      [BERRY_LEMONADE, BERRY_LEMONADE_TRAITS],
      [BLUEBERRY_CHEESECAKE, BLUEBERRY_CHEESECAKE_TRAITS],
      [BAKED_CHEESE_NACHOS, BAKED_CHEESE_NACHOS_TRAITS],
    ] as const) {
      const facet = facetOf(item, traits);
      expect(facet.kind).toBe(traits.kind);
      for (const option of FACET_OPTIONS) expect(st(facet, option), `${item.name} ${option}`).toBe(expected(item, traits, option));
    }
  });

  it('reads sensibly: hot coffee keeps hot and coffee, not iced or no coffee; food is n for drink-only options', () => {
    const hot = facetOf(CAPPUCCINO, CAPPUCCINO_TRAITS);
    expect(st(hot, 'temp:hot')).toBe('k');
    expect(st(hot, 'temp:iced')).toBe('x');
    expect(st(hot, 'coffee:none')).toBe('x');
    const lemonade = facetOf(BERRY_LEMONADE, BERRY_LEMONADE_TRAITS);
    expect(st(lemonade, 'coffee:none')).toBe('k');
    expect(st(lemonade, 'coffee:strong')).toBe('x');
    const food = facetOf(BAKED_CHEESE_NACHOS, BAKED_CHEESE_NACHOS_TRAITS);
    expect(st(food, 'temp:hot')).toBe('n');
    expect(st(food, 'coffee:none')).toBe('n');
    expect(st(food, 'flavour:fruity')).toBe('n');
    expect(st(food, 'sweet:none')).not.toBe('n' + 'x');
  });
});

describe('unavailableOptions', () => {
  const sel = (kinds: ('drink' | 'dessert' | 'food')[], ...options: FacetOption[]) => ({ kinds, options });
  const make = (kind: 'drink' | 'dessert' | 'food', keep: FacetOption[], rule: FacetOption[] = []): MenuFacet => ({
    kind,
    states: FACET_OPTIONS.map((o) => (keep.includes(o) ? 'k' : rule.includes(o) ? 'x' : 'n')).join(''),
  });

  // Three drinks: hot strong coffee, iced strong coffee (chocolatey), iced non-coffee (fruity).
  const hotStrong = make('drink', ['temp:hot', 'coffee:strong'], ['temp:iced', 'coffee:none', 'flavour:chocolatey', 'flavour:fruity']);
  const icedStrongChoc = make('drink', ['temp:iced', 'coffee:strong', 'flavour:chocolatey'], ['temp:hot', 'coffee:none', 'flavour:fruity']);
  const icedLemon = make('drink', ['temp:iced', 'coffee:none', 'flavour:fruity'], ['temp:hot', 'coffee:strong', 'flavour:chocolatey']);
  const dessert = make('dessert', ['flavour:biscuit']);
  const facets = [hotStrong, icedLemon, dessert];

  it('with nothing selected only lists options no ticked item keeps', () => {
    const off = unavailableOptions(sel(['drink']), facets);
    expect(off.has('flavour:chocolatey')).toBe(true);
    expect(off.has('flavour:biscuit')).toBe(true); // dessert not ticked
    expect(off.has('temp:hot')).toBe(false);
    expect(off.has('coffee:strong')).toBe(false);
    expect(unavailableOptions(sel(['drink', 'dessert']), facets).has('flavour:biscuit')).toBe(false);
  });

  it('disables the conflicting option in each direction', () => {
    const f = [...facets, icedStrongChoc].filter((x) => x !== hotStrong);
    // Iced + strong + chocolatey exists only via icedStrongChoc; remove it.
    const noChoc = [hotStrong, icedLemon];
    expect(unavailableOptions(sel(['drink'], 'temp:iced', 'coffee:strong'), noChoc).has('flavour:chocolatey')).toBe(true);
    expect(unavailableOptions(sel(['drink'], 'temp:iced', 'flavour:chocolatey'), noChoc).has('coffee:strong')).toBe(true);
    expect(unavailableOptions(sel(['drink'], 'coffee:strong', 'flavour:chocolatey'), noChoc).has('temp:iced')).toBe(true);
    // With the combination present, nothing is disabled.
    const off = unavailableOptions(sel(['drink'], 'temp:iced', 'coffee:strong'), f);
    expect(off.has('flavour:chocolatey')).toBe(false);
  });

  it('never returns a selected option', () => {
    const off = unavailableOptions(sel(['drink'], 'temp:iced', 'coffee:strong'), [hotStrong, icedLemon]);
    expect(off.has('temp:iced')).toBe(false);
    expect(off.has('coffee:strong')).toBe(false);
    expect(unavailableOptions(sel(['drink'], 'flavour:chocolatey'), [hotStrong]).has('flavour:chocolatey')).toBe(false);
  });

  it('treats flavours as OR within the group', () => {
    const f = [icedLemon, icedStrongChoc];
    // Fruity or chocolatey selected: every iced drink is compatible, so both temps stay as the items allow.
    const off = unavailableOptions(sel(['drink'], 'flavour:chocolatey', 'flavour:fruity'), f);
    expect(off.has('coffee:strong')).toBe(false); // via the chocolatey item
    expect(off.has('coffee:none')).toBe(false); // via the fruity item
    // Only chocolatey selected: the lemonade is out, so coffee:none has no item.
    expect(unavailableOptions(sel(['drink'], 'flavour:chocolatey'), f).has('coffee:none')).toBe(true);
  });

  it('switching kinds changes the answer', () => {
    expect(unavailableOptions(sel(['drink']), facets).has('flavour:biscuit')).toBe(true);
    expect(unavailableOptions(sel(['dessert']), facets).has('flavour:biscuit')).toBe(false);
    expect(unavailableOptions(sel(['dessert']), facets).has('temp:hot')).toBe(true);
  });

  it('with no facets every unselected option is unavailable', () => {
    const off = unavailableOptions(sel(['drink'], 'temp:hot'), []);
    expect(off.size).toBe(FACET_OPTIONS.length - 1);
    expect(off.has('temp:hot')).toBe(false);
  });

  it('works on the fixture menu: a real facet list leaves the common options open', () => {
    const real = menuFacets(buildFixtureMenu(), buildFixtureTraitsById());
    const off = unavailableOptions(sel(['drink']), real);
    expect(off.has('temp:hot')).toBe(false);
    expect(off.has('temp:iced')).toBe(false);
    expect(off.has('coffee:none')).toBe(false);
  });
});
