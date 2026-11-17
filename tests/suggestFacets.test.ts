import { describe, expect, it } from 'vitest';

// Menu facets (lib/suggest/facets.ts): a compact record per item, and the exact
// JOINT "which options lead nowhere" check the wizard uses. The check rebuilds
// items from the facets and calls the engine's own functions, so here it is
// compared with a brute-force check done directly on the real items.

import {
  CANONICAL_NOTE,
  FACET_OPTIONS,
  inputsForOptions,
  menuFacets,
  unavailableOptions,
  type FacetOption,
  type MenuFacet,
} from '@/lib/suggest/facets';
import { flavourFamiliesOf } from '@/lib/suggest/families';
import { passesHardConstraints } from '@/lib/suggest/filter';
import { HONOURED_CHOICES, FLAVOUR_FAMILIES, type MenuItemTraits, type TraitKind } from '@/lib/suggest/types';
import { choiceApplies, isChoiceSet, keepsChoice, madeToOrder, type ChoiceSubject } from '@/lib/suggest/promises';
import { isSugarAdjustable } from '@/lib/suggest/sugar';
import type { MenuItem } from '@/lib/types';
import { NO_TRAITS_ITEM, UNAVAILABLE_ITEM, buildFixtureMenu, buildFixtureTraitsById, makeMenuItem, makeTraitsV2 } from './fixtures/suggestMenu';
import { buildAddonMenu, shotGroupFor, syrupGroupFor } from './fixtures/suggestAddonMenu';

type Selection = { kinds: TraitKind[]; options: FacetOption[] };

/** The brute-force check, on real items. */
function bruteForce(selection: Selection, items: MenuItem[], traitsById: Map<string, MenuItemTraits>): Set<FacetOption> {
  const out = new Set<FacetOption>();
  const group = (o: FacetOption) => o.split(':')[0];
  for (const option of FACET_OPTIONS) {
    if (selection.options.includes(option)) continue;
    const others = selection.options.filter((o) => group(o) !== group(option));
    const inputs = inputsForOptions(selection.kinds, [...others, option]);
    const fits = items.some((item) => {
      const traits = traitsById.get(item.id);
      if (!traits || !selection.kinds.includes(traits.kind)) return false;
      if (!passesHardConstraints(item, traits, inputs, [])) return false;
      const subject: ChoiceSubject = {
        name: item.name,
        traits,
        sugarAdjustable: isSugarAdjustable(item),
        made: madeToOrder(item, traits, inputs),
      };
      for (const choice of HONOURED_CHOICES) {
        if (isChoiceSet(choice, inputs) && choiceApplies(choice, traits.kind) && keepsChoice(choice, subject, inputs) === false) return false;
      }
      const kept = (c: (typeof HONOURED_CHOICES)[number]) => ['own', 'made'].includes(String(keepsChoice(c, subject, inputs)));
      const g = group(option);
      if (g === 'temp') return traits.kind === 'drink';
      if (g === 'coffee') return option === 'coffee:none' ? traits.kind === 'drink' && !traits.is_coffee : kept('strength');
      if (g === 'sweet') return kept('sweetness');
      if (g === 'flavour') return kept('flavours');
      if (g === 'body') return kept('body');
      return true;
    });
    if (!fits) out.add(option);
  }
  return out;
}

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSelection(rand: () => number): Selection {
  const kindSets: TraitKind[][] = [['drink'], ['drink'], ['drink', 'dessert'], ['dessert'], ['drink', 'dessert', 'food'], ['drink', 'food']];
  const kinds = kindSets[Math.floor(rand() * kindSets.length)];
  const pickOne = (list: FacetOption[]) => (rand() < 0.45 ? [list[Math.floor(rand() * list.length)]] : []);
  const options: FacetOption[] = [
    ...pickOne(['temp:hot', 'temp:iced']),
    ...pickOne(['coffee:strong', 'coffee:mild', 'coffee:none']),
    ...(rand() < 0.15 ? (['caffeineFree'] as FacetOption[]) : []),
    ...pickOne(['sweet:none', 'sweet:light', 'sweet:sweet']),
    ...FLAVOUR_FAMILIES.filter(() => rand() < 0.12).map((f) => `flavour:${f}` as FacetOption),
    ...pickOne(['budget:under_100', 'budget:under_150', 'budget:under_200']),
    ...pickOne(['body:light', 'body:rich']),
  ];
  return { kinds, options: FACET_OPTIONS.filter((o) => options.includes(o)) };
}

const fixture = { items: buildFixtureMenu(), traitsById: buildFixtureTraitsById() };
const addonMenu = buildAddonMenu();

describe('menuFacets', () => {
  it('one compact facet per orderable, tagged item, with exactly the fields the rules read and nothing identifying', () => {
    const facets = menuFacets(fixture.items, fixture.traitsById);
    expect(facets.length).toBeGreaterThan(20);
    for (const f of facets) {
      expect(Object.keys(f).sort()).toEqual(
        ['addons', 'body', 'caffeine', 'families', 'intensity', 'isCoffee', 'kind', 'minPriceInr', 'sugarAdjustable', 'sweetness', 'temperature'],
      );
    }
    const json = JSON.stringify(facets);
    for (const item of fixture.items) expect(json).not.toContain(item.id);
    expect(menuFacets([UNAVAILABLE_ITEM, NO_TRAITS_ITEM], fixture.traitsById)).toEqual([]);
  });

  it('keeps only the add-ons that can become a preset: flavour sources and espresso shots, switched on and within the price limit', () => {
    const facets = menuFacets(addonMenu.items, addonMenu.traitsById);
    const byKey = (name: string) => facets[addonMenu.items.findIndex((i) => i.name === name)];
    const cappuccino = byKey('Cappuccino');
    // Vanilla has no family, so it is not there; hazelnut (nutty) and caramel are, and the shot.
    expect(cappuccino.addons.map((a) => [a.role, a.families, a.sweetness, a.intensity, a.priceInr])).toEqual([
      ['flavour', ['nutty'], 2, 0, 35],
      ['flavour', ['caramel'], 2, 0, 35],
      ['shot', [], 0, 1, 40],
    ]);
    expect(new Set(cappuccino.addons.map((a) => a.group)).size).toBe(2);
    expect(cappuccino.addons.every((a) => a.max === 1)).toBe(true);
    expect(cappuccino.sugarAdjustable).toBe(true);
    expect(byKey('Flat White').addons).toEqual([]);
  });

  it('a switched-off or dear option is left out', () => {
    const item = makeMenuItem({
      id: 'x',
      name: 'Latte',
      priceInr: 100,
      addon_groups: [{ ...syrupGroupFor('x', 70) }, { ...shotGroupFor('y'), options: [{ ...shotGroupFor('y').options[0], is_available: false }] }],
    });
    const facets = menuFacets([item], new Map([['x', makeTraitsV2({ menu_item_id: 'x', sweetness_level: 1 })]]));
    expect(facets[0].addons).toEqual([]);
  });

  it('has a canonical flavour note per family that flavourFamiliesOf reads back as exactly that family', () => {
    for (const family of FLAVOUR_FAMILIES) expect(flavourFamiliesOf('', [CANONICAL_NOTE[family]]), family).toEqual([family]);
  });

  it('is small: the JSON of the fixture menu, for the record', () => {
    const size = JSON.stringify(menuFacets(fixture.items, fixture.traitsById)).length;
    expect(size).toBeLessThan(20_000);
  });
});

describe('unavailableOptions agrees with a brute-force check on the real items', () => {
  for (const [label, menu] of [
    ['fixture menu', fixture],
    ['add-on menu', addonMenu],
  ] as const) {
    it(`${label}: ${300} random selections, single-kind and multi-kind`, () => {
      const facets = menuFacets(menu.items, menu.traitsById);
      const rand = rng(label === 'fixture menu' ? 1 : 2);
      let multi = 0;
      let someOff = 0;
      for (let n = 0; n < 300; n++) {
        const selection = randomSelection(rand);
        if (selection.kinds.length > 1) multi++;
        const got = unavailableOptions(selection, facets);
        const want = bruteForce(selection, menu.items, menu.traitsById);
        expect([...got].sort(), JSON.stringify(selection)).toEqual([...want].sort());
        for (const o of selection.options) expect(got.has(o)).toBe(false);
        if (got.size > 0) someOff++;
      }
      expect(multi).toBeGreaterThan(50);
      expect(someOff).toBeGreaterThan(50);
    });
  }
});

describe('unavailableOptions — made your way', () => {
  const kinds: TraitKind[] = ['drink'];
  const facets = menuFacets(addonMenu.items, addonMenu.traitsById);
  const stripped = facets.map((f) => ({ ...f, addons: [] }));

  it('a combination only reachable through a syrup is available (hot + coffee + caramel / nutty)', () => {
    const selection = { kinds, options: ['temp:hot', 'coffee:strong'] as FacetOption[] };
    // No hot coffee carries caramel itself; 16-style syrups make it so. Nutty also has an own carrier.
    expect(unavailableOptions({ kinds, options: ['temp:hot'] }, stripped).has('flavour:caramel')).toBe(true);
    expect(unavailableOptions({ kinds, options: ['temp:hot'] }, facets).has('flavour:caramel')).toBe(false);
    expect(unavailableOptions({ kinds, options: ['temp:hot', 'flavour:caramel'] }, facets).has('coffee:strong')).toBe(false);
    expect(unavailableOptions(selection, facets).has('flavour:caramel')).toBe(false);
  });

  it('a strong coffee through a shot: only intensity-2 coffees with a shot, so no shot facets means only the intensity-3 ones', () => {
    const noShots = facets.map((f) => ({ ...f, addons: f.addons.filter((a) => a.role !== 'shot') }));
    // Hot + strong + caramel: intensity-3 hot coffee (americano) has no syrup; the intensity-2 ones need the shot.
    const sel = { kinds, options: ['temp:hot', 'coffee:strong'] as FacetOption[] };
    expect(unavailableOptions(sel, facets).has('flavour:caramel')).toBe(false);
    expect(unavailableOptions(sel, noShots).has('flavour:caramel')).toBe(true);
  });

  it('"Not sweet" + a flavour only a syrup can supply is not available on an item already at sweetness 2+ (the ceiling guard)', () => {
    const coffee = (sweetness: number): MenuFacet => ({
      kind: 'drink', temperature: 'hot', isCoffee: true, caffeine: 'medium', sweetness, intensity: 2, body: 'medium',
      sugarAdjustable: false, minPriceInr: 100, families: [],
      addons: [{ role: 'flavour', families: ['caramel'], sweetness: 2, intensity: 0, priceInr: 35, group: 0, max: 1 }],
    });
    const sel = { kinds, options: ['sweet:none'] as FacetOption[] };
    for (const level of [2, 3, 5]) expect(unavailableOptions(sel, [coffee(level)]).has('flavour:caramel'), `level ${level}`).toBe(true);
    // The guard itself, on the real function: level 2 + 2 > 0 + 3, so no preset at all.
    const inputs = inputsForOptions(kinds, ['sweet:none', 'flavour:caramel']);
    const item = makeMenuItem({ id: 'g', name: 'Latte', priceInr: 100, addon_groups: [syrupGroupFor('g')] });
    const at = (level: number) => makeTraitsV2({ menu_item_id: 'g', sweetness_level: level, is_coffee: true });
    expect(madeToOrder(item, at(2), inputs).presets).toEqual([]);
    expect(madeToOrder(item, at(1), inputs).presets).toHaveLength(1); // 1 + 2 is within the ceiling,
    expect(unavailableOptions(sel, [coffee(1)]).has('flavour:caramel')).toBe(false); // 3 is still inside the "not sweet" band
  });

  it('a budget cap the base price fits but base + add-on does not makes the flavour unavailable', () => {
    const coffee = (price: number): MenuFacet => ({
      kind: 'drink', temperature: 'hot', isCoffee: true, caffeine: 'medium', sweetness: 1, intensity: 2, body: 'medium',
      sugarAdjustable: false, minPriceInr: price, families: [],
      addons: [{ role: 'flavour', families: ['nutty'], sweetness: 2, intensity: 0, priceInr: 35, group: 0, max: 1 }],
    });
    const sel = { kinds, options: ['budget:under_150'] as FacetOption[] };
    expect(unavailableOptions(sel, [coffee(140)]).has('flavour:nutty')).toBe(true); // 140 fits, 175 does not
    expect(unavailableOptions(sel, [coffee(110)]).has('flavour:nutty')).toBe(false); // 145 fits
    expect(unavailableOptions({ kinds, options: ['budget:under_200'] }, [coffee(140)]).has('flavour:nutty')).toBe(false);
  });

  it('a selected option is never returned, and nothing is available on empty facets', () => {
    const options: FacetOption[] = ['temp:iced', 'flavour:floral', 'budget:under_100'];
    const got = unavailableOptions({ kinds, options }, facets);
    for (const o of options) expect(got.has(o)).toBe(false);
    const none = unavailableOptions({ kinds, options }, []);
    expect([...none].sort()).toEqual(FACET_OPTIONS.filter((o) => !options.includes(o)).sort());
    expect(unavailableOptions({ kinds, options: [] }, []).size).toBe(FACET_OPTIONS.length);
  });

  it('reuses the rebuilt items for the same facets array (cached) and gives the same answer twice', () => {
    const sel = { kinds, options: ['temp:hot'] as FacetOption[] };
    expect([...unavailableOptions(sel, facets)]).toEqual([...unavailableOptions(sel, facets)]);
  });
});
