import { describe, expect, it } from 'vitest';
import { runSuggest } from '@/lib/suggest/engine';
import { filterCandidates } from '@/lib/suggest/filter';
import { buildShortlist } from '@/lib/suggest/score';
import type { FilteredCandidate } from '@/lib/suggest/filter';
import { flavourCountsByKind } from '@/lib/suggest/flavor';
import { withInputDefaults } from '@/lib/suggest/inputs';
import { choiceApplies, honourChoices, isChoiceSet, satisfiesChoice, unmetChoices } from '@/lib/suggest/promises';
import { deliveredSweetness } from '@/lib/suggest/sugar';
import { matchTagsFor } from '@/lib/suggest/templates';
import { FLAVOUR_FAMILY_INFO } from '@/lib/suggest/traitVocabulary';
import { FLAVOUR_FAMILIES, HONOURED_CHOICES, KINDS, SWEETNESS_BANDS } from '@/lib/suggest/types';
import type { Candidate, Decider, DeciderResult, FlavourFamily, MenuItemTraits, SuggestInputs } from '@/lib/suggest/types';
import {
  buildFixtureMenu,
  buildFixtureTraitsById,
  buildSugarGroup,
  makeMenuItem,
  makeTraits,
  makeTraitsV2,
} from './fixtures/suggestMenu';

function ask(over: Partial<SuggestInputs> = {}): SuggestInputs {
  return withInputDefaults({ mood: 'comfort', ...over });
}

const subject = (traits: MenuItemTraits, over: { name?: string; sugarAdjustable?: boolean } = {}) => ({
  name: over.name ?? 'Item',
  traits,
  sugarAdjustable: over.sugarAdjustable ?? false,
});

/** A drink row that is a coffee by default; v2 so intensity is explicit. */
type Over = Partial<Omit<MenuItemTraits, 'sweetness_level'>> & { sweetness_level?: number };
const drink = (over: Over = {}) =>
  makeTraitsV2({ menu_item_id: 'x', sweetness_level: 5, kind: 'drink', is_coffee: true, intensity: 1, ...over });

let seq = 0;
/** A post-filter candidate of the given kind. */
function cand(kind: 'drink' | 'dessert' | 'food', over: Over = {}, name?: string): FilteredCandidate {
  seq += 1;
  const id = `${kind}-${seq}`;
  return {
    item: makeMenuItem({ id, name: name ?? `Item ${id}`, priceInr: 100 }),
    traits: makeTraitsV2({ menu_item_id: id, sweetness_level: 5, kind, is_coffee: kind === 'drink', ...over }),
  };
}
const ids = (list: FilteredCandidate[]) => list.map((c) => c.item.id);

// ---------------------------------------------------------------------------
describe('deliveredSweetness', () => {
  it('is the base when not adjustable or when there is no target', () => {
    expect(deliveredSweetness(4, false, 10)).toBe(4);
    expect(deliveredSweetness(4, true, null)).toBe(4);
    expect(deliveredSweetness(4, false, null)).toBe(4);
  });

  it('adjustable: the nearer of base and base + 3 (capped at 10)', () => {
    expect(deliveredSweetness(0, true, 3)).toBe(3);
    expect(deliveredSweetness(0, true, 0)).toBe(0);
    expect(deliveredSweetness(2, true, 5)).toBe(5);
    expect(deliveredSweetness(9, true, 10)).toBe(10); // capped at max, and 10 is closer
    expect(deliveredSweetness(8, true, 0)).toBe(8); // sugar never lowers it
    expect(deliveredSweetness(1, true, 3)).toBe(4); // |4-3| = 1 < |1-3| = 2
  });

  it('a tie goes to the base (No Sugar)', () => {
    expect(deliveredSweetness(0, true, 1.5)).toBe(0); // 0 and 3 are both 1.5 away
    expect(deliveredSweetness(2, true, 3.5)).toBe(2); // 2 and 5 are both 1.5 away
    expect(deliveredSweetness(4, true, 5.5)).toBe(4); // 4 and 7 are both 1.5 away
  });
});

describe('isChoiceSet / choiceApplies', () => {
  it('reads each choice from the inputs', () => {
    const none = ask();
    for (const c of HONOURED_CHOICES) expect(isChoiceSet(c, none), c).toBe(false);
    expect(isChoiceSet('flavours', ask({ flavours: ['nutty'] }))).toBe(true);
    expect(isChoiceSet('strength', ask({ strength: 'mild' }))).toBe(true);
    expect(isChoiceSet('sweetness', ask({ sweetness: 'light' }))).toBe(true);
    expect(isChoiceSet('body', ask({ body: 'rich' }))).toBe(true);
  });

  it('strength is for drinks, flavours and sweetness skip food, body is for all', () => {
    expect(KINDS.map((k) => choiceApplies('strength', k))).toEqual([true, false, false]);
    expect(KINDS.map((k) => choiceApplies('flavours', k))).toEqual([true, true, false]);
    expect(KINDS.map((k) => choiceApplies('sweetness', k))).toEqual([true, true, false]);
    expect(KINDS.map((k) => choiceApplies('body', k))).toEqual([true, true, true]);
  });
});

// ---------------------------------------------------------------------------
describe('satisfiesChoice', () => {
  it('is null when the choice is not set or does not apply to the kind', () => {
    expect(satisfiesChoice('flavours', subject(drink()), ask())).toBeNull();
    expect(satisfiesChoice('strength', subject(drink()), ask())).toBeNull();
    expect(satisfiesChoice('strength', subject(drink({ kind: 'dessert' })), ask({ strength: 'strong' }))).toBeNull();
    expect(satisfiesChoice('flavours', subject(drink({ kind: 'food' })), ask({ flavours: ['nutty'] }))).toBeNull();
    expect(satisfiesChoice('sweetness', subject(drink({ kind: 'food' })), ask({ sweetness: 'none' }))).toBeNull();
    expect(satisfiesChoice('body', subject(drink({ kind: 'food', body: 'rich' })), ask({ body: 'rich' }))).toBe(true);
  });

  describe('flavours', () => {
    it('needs a requested family the item carries itself (name or notes)', () => {
      const inputs = ask({ flavours: ['nutty', 'floral'] });
      expect(satisfiesChoice('flavours', subject(drink({ flavor_notes: ['hazelnut'] })), inputs)).toBe(true);
      expect(satisfiesChoice('flavours', subject(drink(), { name: 'Rose Latte' }), inputs)).toBe(true);
      expect(satisfiesChoice('flavours', subject(drink({ flavor_notes: ['caramel'] })), inputs)).toBe(false);
    });

    it('a flavour reachable only through an add-on does not count', () => {
      const t = drink({ flavor_notes: ['creamy'] });
      expect(satisfiesChoice('flavours', { ...subject(t), addonFlavourFamilies: ['nutty'] } as never, ask({ flavours: ['nutty'] }))).toBe(false);
    });
  });

  describe('strength', () => {
    const at = (intensity: number | null, over: Over = {}) => subject(drink({ intensity, ...over }));
    it('strong is intensity 3 only', () => {
      const i = ask({ strength: 'strong' });
      expect([0, 1, 2, 3].map((n) => satisfiesChoice('strength', at(n), i))).toEqual([false, false, false, true]);
    });
    it('mild is intensity 2 or less', () => {
      const i = ask({ strength: 'mild' });
      expect([0, 1, 2, 3].map((n) => satisfiesChoice('strength', at(n), i))).toEqual([true, true, true, false]);
    });
    it('balanced is intensity 1 or 2', () => {
      const i = ask({ strength: 'balanced' });
      expect([0, 1, 2, 3].map((n) => satisfiesChoice('strength', at(n), i))).toEqual([false, true, true, false]);
    });
    it('falls back to caffeine when intensity is null (score.ts table)', () => {
      const strong = ask({ strength: 'strong' });
      expect(satisfiesChoice('strength', at(null, { caffeine: 'high' }), strong)).toBe(true);
      expect(satisfiesChoice('strength', at(null, { caffeine: 'medium' }), strong)).toBe(false);
      expect(satisfiesChoice('strength', at(null, { caffeine: 'low' }), ask({ strength: 'balanced' }))).toBe(true);
    });
    it('a non-coffee drink is false; a dessert is null', () => {
      expect(satisfiesChoice('strength', at(3, { is_coffee: false }), ask({ strength: 'strong' }))).toBe(false);
      expect(satisfiesChoice('strength', at(3, { kind: 'dessert' }), ask({ strength: 'strong' }))).toBeNull();
    });
  });

  describe('sweetness (delivered level inside SWEETNESS_BANDS, inclusive)', () => {
    const level = (n: number, sugarAdjustable = false) => subject(drink({ sweetness_level: n }), { sugarAdjustable });
    it('each band edge, as made', () => {
      for (const pref of ['none', 'light', 'medium', 'sweet', 'very'] as const) {
        const { min, max } = SWEETNESS_BANDS[pref];
        const inputs = ask({ sweetness: pref });
        expect(satisfiesChoice('sweetness', level(min), inputs), `${pref} @${min}`).toBe(true);
        expect(satisfiesChoice('sweetness', level(max), inputs), `${pref} @${max}`).toBe(true);
        if (min > 0) expect(satisfiesChoice('sweetness', level(min - 1), inputs), `${pref} @${min - 1}`).toBe(false);
        if (max < 10) expect(satisfiesChoice('sweetness', level(max + 1), inputs), `${pref} @${max + 1}`).toBe(false);
      }
    });
    it('a sugar-adjustable coffee at 0 satisfies "light" through added sugar, and "none" with no sugar', () => {
      expect(satisfiesChoice('sweetness', level(0, false), ask({ sweetness: 'light' }))).toBe(false);
      expect(satisfiesChoice('sweetness', level(0, true), ask({ sweetness: 'light' }))).toBe(true);
      expect(satisfiesChoice('sweetness', level(0, true), ask({ sweetness: 'none' }))).toBe(true);
    });
    it('sugar cannot lower a sweet item', () => {
      expect(satisfiesChoice('sweetness', level(6, true), ask({ sweetness: 'light' }))).toBe(false);
    });
  });

  it('body is an exact match', () => {
    const inputs = ask({ body: 'light' });
    expect(satisfiesChoice('body', subject(drink({ body: 'light' })), inputs)).toBe(true);
    expect(satisfiesChoice('body', subject(drink({ body: 'medium' })), inputs)).toBe(false);
    expect(satisfiesChoice('body', subject(drink({ body: 'rich' })), inputs)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('honourChoices (lexicographic tiers with pinned picks)', () => {
  const rich = { body: 'rich' as const };
  const light = { body: 'light' as const };
  const drinks = (richCount: number, lightCount = 4) => [
    ...Array.from({ length: richCount }, () => cand('drink', rich)),
    ...Array.from({ length: lightCount }, () => cand('drink', light)),
  ];
  const inputsRich = (over: Partial<SuggestInputs> = {}) => ask({ body: 'rich', ...over });
  const nutty = (extra: Over = {}) => cand('drink', { flavor_notes: ['hazelnut'], ...extra });
  const plainDrink = (extra: Over = {}) => cand('drink', { flavor_notes: [], ...extra });

  it('returns the very same elements and no pins when no choice is set', () => {
    const pool = drinks(2);
    const out = honourChoices(pool, ask());
    expect(out.pool).toBe(pool);
    expect(out.pinnedIds).toEqual([]);
  });

  it('single kind, >= 3 keep every active choice: the pool is exactly those, nothing pinned', () => {
    for (const n of [3, 5]) {
      const pool = drinks(n);
      const out = honourChoices(pool, inputsRich());
      expect(out.pool).toHaveLength(n);
      expect(out.pool.every((c) => c.traits.body === 'rich')).toBe(true);
      expect(out.pinnedIds).toEqual([]);
    }
  });

  it('1 or 2 keep it: they are pinned and the pool is them plus the whole next tier', () => {
    for (const n of [1, 2]) {
      const pool = drinks(n, 4);
      const out = honourChoices(pool, inputsRich());
      expect(out.pool).toHaveLength(n + 4); // the complete next tier
      expect(out.pinnedIds).toEqual(ids(pool.slice(0, n)));
    }
  });

  it('with nothing keeping the choice, everything stays and nothing is pinned', () => {
    const pool = drinks(0, 4);
    const out = honourChoices(pool, inputsRich());
    expect(out.pool).toEqual(pool);
    expect(out.pinnedIds).toEqual([]);
  });

  it('flavours outranks strength outranks sweetness outranks body in the tier order', () => {
    const inputs = ask({ flavours: ['nutty'], strength: 'strong', sweetness: 'none', body: 'rich' });
    const flavourOnly = nutty({ intensity: 1, sweetness_level: 9, body: 'light' });
    const strengthOnly = plainDrink({ intensity: 3, sweetness_level: 9, body: 'light' });
    const sweetnessOnly = plainDrink({ intensity: 1, sweetness_level: 0, body: 'light' });
    const bodyOnly = plainDrink({ intensity: 1, sweetness_level: 9, body: 'rich' });
    const nothing = plainDrink({ intensity: 1, sweetness_level: 9, body: 'light' });
    // Shuffled input; need is 3: the first two tiers are pinned, the third completes the pool.
    const pool = [nothing, bodyOnly, sweetnessOnly, strengthOnly, flavourOnly];
    const out = honourChoices(pool, inputs);
    expect(out.pinnedIds).toEqual(ids([flavourOnly, strengthOnly]));
    expect(ids(out.pool)).toEqual(ids([sweetnessOnly, strengthOnly, flavourOnly]));
  });

  it('a tier is taken whole once it reaches the need, and only tiers before it are pinned', () => {
    const best = nutty({ intensity: 3 });
    const next = [1, 2, 3].map(() => nutty({ intensity: 1 }));
    const rest = [plainDrink({ intensity: 3 }), plainDrink({ intensity: 1 })];
    const pool = [rest[0], next[0], best, next[1], rest[1], next[2]];
    const out = honourChoices(pool, ask({ flavours: ['nutty'], strength: 'strong' }));
    expect(out.pinnedIds).toEqual(ids([best]));
    expect(ids(out.pool)).toEqual(ids([next[0], best, next[1], next[2]])); // original order, rest dropped
  });

  it('a two-kind request where one kind has no candidates uses need = 3 for the other', () => {
    const inputs = ask({ kinds: ['drink', 'dessert'], body: 'rich' });
    const pool = drinks(2, 4); // no desserts at all
    const out = honourChoices(pool, inputs);
    expect(out.pool).toHaveLength(6); // 2 rich < 3, so the next tier is added too
    expect(out.pinnedIds).toHaveLength(2);
  });

  it('a two-kind request with candidates in both uses need = 2 per kind and leaves kinds without an active choice alone', () => {
    const inputs = ask({ kinds: ['drink', 'dessert', 'food'], strength: 'strong' });
    const drinksList = [cand('drink', { intensity: 3 }), cand('drink', { intensity: 3 }), cand('drink', { intensity: 1 })];
    const desserts = [cand('dessert'), cand('dessert')];
    const foods = [cand('food'), cand('food')];
    const out = honourChoices([...drinksList, ...desserts, ...foods], inputs);
    expect(ids(out.pool)).toEqual(ids([drinksList[0], drinksList[1], ...desserts, ...foods]));
    expect(out.pinnedIds).toEqual([]);
  });

  it('preserves relative order and never adds items', () => {
    const a = cand('drink', light);
    const b = cand('drink', rich);
    const c = cand('drink', light);
    const d = cand('drink', rich);
    const e = cand('drink', rich);
    const pool = [a, b, c, d, e];
    const out = honourChoices(pool, inputsRich());
    expect(ids(out.pool)).toEqual(ids([b, d, e]));
    for (const x of out.pool) expect(pool).toContain(x);
  });

  it('properties over generated pools: pinned < need per kind, pins are in the pool, narrowing never leaves fewer than min(3, size) for a single kind', () => {
    for (let n = 0; n <= 6; n++) {
      for (let m = 0; m <= 6; m++) {
        const pool = [...Array.from({ length: n }, () => nutty({ intensity: 3 })), ...Array.from({ length: m }, () => plainDrink({ intensity: 1 }))];
        const out = honourChoices(pool, ask({ flavours: ['nutty'], strength: 'strong' }));
        expect(out.pinnedIds.length).toBeLessThan(3);
        for (const id of out.pinnedIds) expect(ids(out.pool)).toContain(id);
        expect(out.pool.length).toBeGreaterThanOrEqual(Math.min(3, pool.length));
        for (const x of out.pool) expect(pool).toContain(x);
      }
    }
  });

  it('priority: flavours is kept ahead of strength when both cannot be', () => {
    const flav = [nutty({ intensity: 1 }), nutty({ intensity: 1 }), nutty({ intensity: 2 })];
    const strongPlain = [plainDrink({ intensity: 3 }), plainDrink({ intensity: 3 }), plainDrink({ intensity: 3 })];
    const out = honourChoices([...flav, ...strongPlain], ask({ flavours: ['nutty'], strength: 'strong' }));
    expect(ids(out.pool)).toEqual(ids(flav));
    expect(out.pinnedIds).toEqual([]);
  });

  it('a refine (items already excluded) leaving too few: the survivors are pinned and the next tier fills the rest', () => {
    const full = drinks(3);
    expect(honourChoices(full, inputsRich()).pinnedIds).toEqual([]);
    const refined = full.filter((c) => c.item.id !== full[0].item.id);
    const out = honourChoices(refined, inputsRich());
    expect(out.pinnedIds).toEqual(ids(refined.slice(0, 2)));
    expect(out.pool).toHaveLength(refined.length);
  });

  it('sweetness and flavours never narrow, mark or pin food', () => {
    const food = [cand('food', { flavor_notes: [] }), cand('food', { flavor_notes: [] }), cand('food', { flavor_notes: ['hazelnut'] }), cand('food')];
    const inputs = ask({ kinds: ['food'], sweetness: 'none', flavours: ['nutty'] });
    const out = honourChoices(food, inputs);
    expect(out.pool).toEqual(food);
    expect(out.pinnedIds).toEqual([]);
    for (const f of food) {
      expect(satisfiesChoice('sweetness', subject(f.traits, { name: f.item.name }), inputs)).toBeNull();
      expect(satisfiesChoice('flavours', subject(f.traits, { name: f.item.name }), inputs)).toBeNull();
    }
    expect(unmetChoices(food.map((f) => subject(f.traits, { name: f.item.name })), inputs)).toEqual([]);
  });

  it('uses isSugarAdjustable from the menu row for sweetness', () => {
    const adjustable = () => {
      const c = cand('drink', { sweetness_level: 0 });
      c.item.addon_groups = [buildSugarGroup(c.item.id)];
      return c;
    };
    const pool = [adjustable(), adjustable(), adjustable(), cand('drink', { sweetness_level: 8 })];
    const out = honourChoices(pool, ask({ sweetness: 'light' }));
    expect(ids(out.pool)).toEqual(ids(pool.slice(0, 3)));
    expect(out.pinnedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('unmetChoices', () => {
  it('lists exactly the set choices a pick breaks, in priority order', () => {
    const inputs = ask({ flavours: ['nutty'], strength: 'strong', sweetness: 'none', body: 'rich' });
    const good = subject(drink({ flavor_notes: ['hazelnut'], intensity: 3, sweetness_level: 0, body: 'rich' }));
    const weak = subject(drink({ flavor_notes: [], intensity: 1, sweetness_level: 0, body: 'rich' }));
    const sweet = subject(drink({ flavor_notes: ['hazelnut'], intensity: 3, sweetness_level: 9, body: 'light' }));
    expect(unmetChoices([good], inputs)).toEqual([]);
    expect(unmetChoices([good, weak], inputs)).toEqual(['flavours', 'strength']);
    expect(unmetChoices([good, sweet], inputs)).toEqual(['sweetness', 'body']);
    expect(unmetChoices([weak, sweet], inputs)).toEqual(['flavours', 'strength', 'sweetness', 'body']);
  });

  it('is empty with no picks, with no choices set, and ignores null (not applicable)', () => {
    expect(unmetChoices([], ask({ flavours: ['nutty'] }))).toEqual([]);
    expect(unmetChoices([subject(drink())], ask())).toEqual([]);
    expect(unmetChoices([subject(drink({ kind: 'dessert' }))], ask({ strength: 'strong' }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('flavourCountsByKind', () => {
  it('counts native carriers per kind, skipping unavailable and untagged items', () => {
    const mk = (id: string, name: string) => makeMenuItem({ id, name, priceInr: 100 });
    const items = [
      mk('a', 'Hazelnut Latte'),
      mk('b', 'Plain Latte'),
      mk('c', 'Hazelnut Brownie'),
      mk('d', 'Hazelnut Shake'),
      mk('e', 'Untagged Hazelnut'),
      { ...mk('f', 'Hazelnut Off'), is_available: false },
    ];
    const traitsById = new Map<string, MenuItemTraits>([
      ['a', makeTraits({ menu_item_id: 'a', kind: 'drink', flavor_notes: ['hazelnut'] })],
      ['b', makeTraits({ menu_item_id: 'b', kind: 'drink', flavor_notes: ['creamy'] })],
      ['c', makeTraits({ menu_item_id: 'c', kind: 'dessert', flavor_notes: ['chocolate'] })],
      ['d', makeTraits({ menu_item_id: 'd', kind: 'drink', flavor_notes: ['chocolate'] })],
      ['f', makeTraits({ menu_item_id: 'f', kind: 'drink', flavor_notes: ['hazelnut'] })],
    ]);
    const counts = flavourCountsByKind(items, traitsById);
    expect(counts.drink.nutty).toBe(2); // a (note) + d (name); not f (unavailable), not e (untagged)
    expect(counts.drink.chocolatey).toBe(1);
    expect(counts.dessert.nutty).toBe(1); // name "Hazelnut Brownie"
    expect(counts.dessert.chocolatey).toBe(1);
    expect(counts.food).toEqual({});
  });
});

// ---------------------------------------------------------------------------
describe('matchTagsFor never claims a choice the pick does not keep', () => {
  const FLAVOUR_TAGS = new Set(FLAVOUR_FAMILIES.map((f) => FLAVOUR_FAMILY_INFO[f].tag));
  const SWEET_TAGS = new Set(['Not sweet', 'Lightly sweet', 'Medium sweet', 'Sweet', 'Very sweet']);
  const menu = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();

  const combos: SuggestInputs[] = [];
  const flavourSets: FlavourFamily[][] = [[], ['nutty'], ['chocolatey', 'fruity'], ['floral'], ['caramel', 'biscuit']];
  for (const flavours of flavourSets) {
    for (const sweetness of ['any', 'none', 'light', 'medium', 'sweet', 'very'] as const) {
      for (const strength of ['any', 'strong', 'mild', 'balanced'] as const) {
        combos.push(
          ask({
            mood: 'boost',
            kinds: ['drink', 'dessert', 'food'],
            flavours,
            sweetness,
            strength,
            body: combos.length % 3 === 0 ? 'any' : combos.length % 3 === 1 ? 'light' : 'rich',
            temperature: combos.length % 2 ? 'iced' : 'hot',
            budget: combos.length % 4 === 0 ? 'under_100' : 'any',
          }),
        );
      }
    }
  }

  it('flavour, sweetness, strength and body tags appear only when satisfiesChoice is true; no add-on or budget tags', () => {
    let tagged = 0;
    expect(combos.length).toBeGreaterThan(30);
    for (const inputs of combos) {
      for (const item of menu) {
        const traits = traitsById.get(item.id);
        if (!traits) continue;
        const sugarAdjustable = item.addon_groups.length > 0;
        const s = { name: item.name, traits, sugarAdjustable, addonFlavourFamilies: ['nutty', 'caramel'] as FlavourFamily[] };
        const tags = matchTagsFor(s, inputs);
        const label = `${item.id} ${JSON.stringify(inputs.flavours)}/${inputs.sweetness}/${inputs.strength}/${inputs.body}`;
        for (const tag of tags) {
          expect(tag, label).not.toMatch(/add-on|₹/);
          if (FLAVOUR_TAGS.has(tag)) expect(satisfiesChoice('flavours', s, inputs), `${label} ${tag}`).toBe(true);
          if (SWEET_TAGS.has(tag)) expect(satisfiesChoice('sweetness', s, inputs), `${label} ${tag}`).toBe(true);
          if (tag === 'Strong' || tag === 'Smooth & milky') expect(satisfiesChoice('strength', s, inputs), `${label} ${tag}`).toBe(true);
          if (tag === 'Light & refreshing' || tag === 'Rich & filling') expect(satisfiesChoice('body', s, inputs), `${label} ${tag}`).toBe(true);
          if (tag === 'Iced' || tag === 'Hot') expect(traits.temperature).toBe(inputs.temperature);
          tagged++;
        }
      }
    }
    expect(tagged).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
describe('runSuggest keeps the choices it can and says so when it cannot (decider: null)', () => {
  const run = (inputs: SuggestInputs) =>
    runSuggest({
      request: { inputs },
      menu: buildFixtureMenu(),
      traitsById: buildFixtureTraitsById(),
      profile: null,
      popularity: new Map(),
      recentItemIds: [],
      now: new Date('2026-06-01T10:00:00Z'),
      decider: null as Decider | null,
      fallbackReason: 'disabled',
    });
  const menu = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();
  const counts = flavourCountsByKind(menu, traitsById);

  it('a flavour the fixture holds at least 3 drinks of: all three picks carry it, unmet is empty', async () => {
    expect(counts.drink.nutty).toBeGreaterThanOrEqual(3);
    const inputs = ask({ kinds: ['drink'], flavours: ['nutty'] });
    const result = await run(inputs);
    expect(result.picks).toHaveLength(3);
    for (const p of result.picks) {
      const item = menu.find((m) => m.id === p.menuItemId)!;
      expect(satisfiesChoice('flavours', subject(traitsById.get(p.menuItemId)!, { name: item.name }), inputs), item.name).toBe(true);
    }
    expect(result.unmet).toEqual([]);
  });

  it('a flavour it holds fewer than 3 drinks of: picks still come back and unmet includes flavours', async () => {
    expect(counts.drink.caramel ?? 0).toBeLessThan(3);
    const result = await run(ask({ kinds: ['drink'], flavours: ['caramel'] }));
    expect(result.picks.length).toBeGreaterThan(0);
    expect(result.unmet).toContain('flavours');
  });

  it('with no choice set, unmet is empty', async () => {
    expect((await run(ask({ kinds: ['drink'] }))).unmet).toEqual([]);
  });

  // Each card says what its own pick does not keep, from the same predicate.
  it('every pick carries its own misses: none when it keeps the choices, the broken choice when it does not', async () => {
    const kept = await run(ask({ kinds: ['drink'], flavours: ['nutty'] }));
    for (const p of kept.picks) expect(p.misses).toEqual([]);

    const inputs = ask({ kinds: ['drink'], flavours: ['caramel'] });
    const short = await run(inputs);
    for (const p of short.picks) {
      const item = menu.find((m) => m.id === p.menuItemId)!;
      const keeps = satisfiesChoice('flavours', subject(traitsById.get(p.menuItemId)!, { name: item.name }), inputs);
      expect(p.misses, item.name).toEqual(keeps ? [] : ['flavours']);
    }
    // `unmet` is exactly the union of the picks' misses.
    expect(short.unmet).toEqual(['flavours']);
    expect(new Set(short.picks.flatMap((p) => p.misses ?? []))).toEqual(new Set(short.unmet));

    // No choice set: nothing can be missed.
    for (const p of (await run(ask({ kinds: ['drink'] }))).picks) expect(p.misses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('pinned picks through runSuggest (fixture menu, revised rule)', () => {
  const menu = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();
  const run = (inputs: SuggestInputs, over: { decider?: Decider | null; excludeItemIds?: string[] } = {}) =>
    runSuggest({
      request: { inputs, excludeItemIds: over.excludeItemIds },
      menu,
      traitsById,
      profile: null,
      popularity: new Map(),
      recentItemIds: [],
      now: new Date('2026-06-01T10:00:00Z'),
      decider: over.decider ?? null,
      fallbackReason: 'disabled',
    });
  const nameOf = (id: string) => menu.find((m) => m.id === id)!.name;

  /** The only drink of the fixture that carries caramel, after the hard filter. */
  const caramelInputs = ask({ kinds: ['drink'], flavours: ['caramel'] });
  const caramelIds = () =>
    filterCandidates(menu, traitsById, caramelInputs, [])
      .filter((c) => satisfiesChoice('flavours', subject(c.traits, { name: c.item.name }), caramelInputs) === true)
      .map((c) => c.item.id);

  it('1: exactly one item keeps the flavour: it is among the picks, unmet says flavours, and 3 picks come back', async () => {
    const keepers = caramelIds();
    expect(keepers).toHaveLength(1);
    const result = await run(caramelInputs);
    expect(result.picks).toHaveLength(3);
    expect(result.pickIds).toContain(keepers[0]);
    expect(result.pickIds[0]).toBe(keepers[0]); // pinned picks come first
    expect(result.unmet).toContain('flavours');
    expect(result.items.map((i) => i.id)).toEqual(result.pickIds);
  });

  it('2: a two-kind request with one kind emptied by a hard filter still returns 3 picks', async () => {
    const inputs = ask({ kinds: ['drink', 'dessert'], sweetness: 'none', flavours: ['chocolatey'] });
    const desserts = filterCandidates(menu, traitsById, inputs, []).filter((c) => c.traits.kind === 'dessert');
    const excludeItemIds = desserts.map((c) => c.item.id);
    const drinksLeft = filterCandidates(menu, traitsById, inputs, excludeItemIds);
    expect(drinksLeft.filter((c) => c.traits.kind === 'dessert')).toHaveLength(0);
    expect(drinksLeft.filter((c) => c.traits.kind === 'drink').length).toBeGreaterThanOrEqual(3);
    const result = await run(inputs, { excludeItemIds });
    expect(result.picks).toHaveLength(3);
    expect(new Set(result.pickIds).size).toBe(3);
  });

  it('3: a decider that leaves the pinned item out cannot drop it: it replaces a pick of the same kind', async () => {
    const [pinned] = caramelIds();
    const decider: Decider = async ({ shortlist }) => {
      const others = shortlist.filter((c) => c.menuItemId !== pinned && c.traits.kind === 'drink').slice(0, 3);
      expect(others).toHaveLength(3);
      return {
        picks: others.map((c) => ({ menuItemId: c.menuItemId, reason: 'A lovely pick for you.', reasonCode: 'trait' as const })),
        header: null,
        model: 'fake',
        inputTokens: 1,
        cacheReadTokens: 0,
        outputTokens: 1,
        costUsdMicros: 1,
      } satisfies DeciderResult;
    };
    const result = await run(caramelInputs, { decider });
    expect(result.source).toBe('llm');
    expect(result.picks).toHaveLength(3);
    expect(result.pickIds[0]).toBe(pinned);
    expect(new Set(result.pickIds).size).toBe(3);
    expect(result.picks[0].reason.length).toBeGreaterThan(0);
    expect(nameOf(pinned)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('buildShortlist with pinned ids', () => {
  const mk = (i: number, score: number, category: string): Candidate => ({
    menuItemId: `c${String(i).padStart(2, '0')}`,
    name: `Item ${i}`,
    category,
    minPriceInr: 100,
    maxPriceInr: 100,
    description: '',
    sugarAdjustable: false,
    score,
    traits: makeTraitsV2({ menu_item_id: `c${i}`, sweetness_level: 5 }),
  });
  // 30 candidates over 4 categories, best first; the last one is the worst of all.
  const scored = Array.from({ length: 30 }, (_, i) => mk(i, 1 - i * 0.03, `cat${i % 4}`));
  const inputs = ask({ kinds: ['drink'] });
  const worst = scored[scored.length - 1];

  it('keeps a low-scoring pinned candidate in the list, within the limits, best first', () => {
    const without = buildShortlist(scored, inputs);
    expect(without.some((c) => c.menuItemId === worst.menuItemId)).toBe(false);
    const withPin = buildShortlist(scored, inputs, new Set([worst.menuItemId]));
    expect(withPin.some((c) => c.menuItemId === worst.menuItemId)).toBe(true);
    expect(withPin).toHaveLength(without.length);
    const perCat = new Map<string, number>();
    for (const c of withPin) perCat.set(c.category, (perCat.get(c.category) ?? 0) + 1);
    for (const n of perCat.values()) expect(n).toBeLessThanOrEqual(8);
    expect(withPin.map((c) => c.score)).toEqual([...withPin.map((c) => c.score)].sort((a, b) => b - a));
    expect(new Set(withPin.map((c) => c.menuItemId)).size).toBe(withPin.length);
  });

  it('is identical to the two-argument call when nothing is pinned', () => {
    expect(buildShortlist(scored, inputs, new Set())).toEqual(buildShortlist(scored, inputs));
    expect(buildShortlist(scored, inputs, undefined)).toEqual(buildShortlist(scored, inputs));
  });
});
