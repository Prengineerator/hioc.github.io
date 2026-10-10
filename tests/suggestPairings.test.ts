import { describe, expect, it } from 'vitest';
import type { MenuItem } from '@/lib/types';
import {
  PAIRING_WEIGHTS,
  buildCoOrderStats,
  coOrderFit,
  complementFit,
  daypartFit,
  harmonyFit,
  pairKey,
  pairingReason,
  pairingsFor,
  type PairingsArgs,
} from '@/lib/suggest/pairings';
import { lintReason } from '@/lib/suggest/tone';
import { FLAVOUR_FAMILY_INFO } from '@/lib/suggest/traitVocabulary';
import type { CoOrderStats, MenuItemTraits, PairingPick, TraitKind } from '@/lib/suggest/types';
import { FLAVOUR_FAMILIES, PAIRING_LIMITS } from '@/lib/suggest/types';
import { makeMenuItem, makeTraitsV2 } from './fixtures/suggestMenu';

// COFFEY-ADDONS-PAIRINGS-SPEC §4.1 / §6 — the pure checkout "pairs well with"
// ranker: co-order statistics, the five scoring terms, the greedy selection and
// the reason templates.

// ---------------------------------------------------------------------------
// Fixtures: a small café. Prices are chosen around the ₹150 cap.
// ---------------------------------------------------------------------------

interface Entry {
  item: MenuItem;
  traits: MenuItemTraits;
}

function entry(spec: {
  id: string;
  name: string;
  category: string;
  price: number;
  traits: Partial<MenuItemTraits> & { sweetness_level: number };
  item?: Partial<MenuItem>;
}): Entry {
  return {
    item: makeMenuItem({ id: spec.id, name: spec.name, category: spec.category, priceInr: spec.price, ...spec.item }),
    traits: makeTraitsV2({ menu_item_id: spec.id, ...spec.traits }),
  };
}

const COFFEE = { kind: 'drink', is_coffee: true, caffeine: 'high' } as const;

const AMERICANO = entry({
  id: 'americano',
  name: 'Americano',
  category: 'Coffee',
  price: 100,
  traits: { ...COFFEE, sweetness_level: 0, flavor_notes: ['bold'] },
});
const COLD_BREW = entry({
  id: 'cold-brew',
  name: 'Classic Cold Brew',
  category: 'Cold Brew',
  price: 140,
  traits: { ...COFFEE, temperature: 'iced', sweetness_level: 1, flavor_notes: ['bold'] },
});
const CHAI = entry({
  id: 'chai',
  name: 'Masala Chai',
  category: 'Hot Non-Coffee',
  price: 110,
  traits: { kind: 'drink', is_coffee: false, caffeine: 'low', sweetness_level: 5, flavor_notes: ['chai spice'] },
});
const BROWNIE = entry({
  id: 'brownie',
  name: 'Fudgy Brownie',
  category: 'Desserts',
  price: 120,
  traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 8, flavor_notes: ['chocolate'] },
});
const CHEESECAKE = entry({
  id: 'cheesecake',
  name: 'Blueberry Cheesecake',
  category: 'Cheesecakes',
  price: 140,
  traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 7, flavor_notes: [] },
});
const WAFFLE = entry({
  id: 'waffle',
  name: 'Belgian Waffle',
  category: 'Waffles',
  price: 180,
  traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 7, flavor_notes: [] },
});
const SANDWICH = entry({
  id: 'sandwich',
  name: 'Grilled Sandwich',
  category: 'Savoury',
  price: 130,
  traits: { kind: 'food', is_coffee: false, caffeine: 'none', sweetness_level: 1, flavor_notes: [] },
});
const WRAP = entry({
  id: 'wrap',
  name: 'Paneer Wrap',
  category: 'Savoury',
  price: 120,
  traits: { kind: 'food', is_coffee: false, caffeine: 'none', sweetness_level: 1, flavor_notes: [] },
});
const FRIES = entry({
  id: 'fries',
  name: 'Peri Peri Fries',
  category: 'Sides',
  price: 90,
  traits: { kind: 'food', is_coffee: false, caffeine: 'none', sweetness_level: 0, flavor_notes: [] },
});

const ALL = [AMERICANO, COLD_BREW, CHAI, BROWNIE, CHEESECAKE, WAFFLE, SANDWICH, WRAP, FRIES];

// A spread of 30-day units across the menu (americano the bestseller, waffle the
// slowest), so the popularity term has something to say.
const POPULARITY = new Map<string, number>([
  ['americano', 80],
  ['cold-brew', 20],
  ['chai', 15],
  ['brownie', 50],
  ['cheesecake', 30],
  ['waffle', 5],
  ['sandwich', 40],
  ['wrap', 10],
  ['fries', 25],
]);

const NO_ORDERS: CoOrderStats = { orders: 0, itemOrders: new Map(), pairs: new Map() };

// Explicit instants, read in IST by daypartFor, so the tests pass in any server
// timezone. They are also chosen so that reading them as UTC would give a
// different daypart (04:30Z is "late" in UTC, 16:30Z is "afternoon"), which means
// a pairing that read the wrong zone would fail the daypart tests below.
const MORNING = new Date('2026-10-10T04:30:00Z'); // 10:00 IST
const EVENING = new Date('2026-10-10T13:30:00Z'); // 19:00 IST
const LATE = new Date('2026-10-10T16:30:00Z'); // 22:00 IST

function worldOf(entries: Entry[]): Pick<PairingsArgs, 'menu' | 'traitsById'> {
  return {
    menu: entries.map((e) => e.item),
    traitsById: new Map(entries.map((e) => [e.traits.menu_item_id, e.traits])),
  };
}

function ask(cartItemIds: string[], over: Partial<PairingsArgs> = {}, entries: Entry[] = ALL): PairingPick[] {
  return pairingsFor({
    cartItemIds,
    ...worldOf(entries),
    coOrders: NO_ORDERS,
    popularity: POPULARITY,
    now: MORNING,
    ...over,
  });
}

function categoryOf(id: string, entries: Entry[] = ALL): string {
  return entries.find((e) => e.item.id === id)!.item.category;
}

function kindOf(id: string, entries: Entry[] = ALL): TraitKind {
  return entries.find((e) => e.item.id === id)!.traits.kind;
}

function expectValidReasons(picks: PairingPick[]) {
  for (const p of picks) {
    expect(p.reason.length).toBeLessThanOrEqual(PAIRING_LIMITS.reasonMaxChars);
    expect(lintReason(p.reason)).toEqual({ ok: true });
    expect(p.score).toBeGreaterThanOrEqual(PAIRING_LIMITS.minScore);
    expect(p.score).toBeLessThanOrEqual(1);
  }
}

/** n orders, each holding exactly `itemIds`. */
function repeat(n: number, itemIds: string[]): { itemIds: string[] }[] {
  return Array.from({ length: n }, () => ({ itemIds }));
}

// ---------------------------------------------------------------------------
// pairKey / buildCoOrderStats
// ---------------------------------------------------------------------------

describe('pairKey', () => {
  it('sorts the two ids and joins them with a pipe', () => {
    expect(pairKey('b', 'a')).toBe('a|b');
    expect(pairKey('a', 'b')).toBe('a|b');
  });
});

describe('buildCoOrderStats', () => {
  it('de-duplicates ids within an order', () => {
    const stats = buildCoOrderStats([{ itemIds: ['a', 'a', 'b', 'b', 'b'] }]);
    expect(stats.orders).toBe(1);
    expect(stats.itemOrders.get('a')).toBe(1);
    expect(stats.itemOrders.get('b')).toBe(1);
    expect(stats.pairs.get(pairKey('a', 'b'))).toBe(1);
    expect(stats.pairs.size).toBe(1);
  });

  it('counts orders, items and pairs, and a pair is the same pair either way round', () => {
    const stats = buildCoOrderStats([
      { itemIds: ['a', 'b', 'c'] },
      { itemIds: ['c', 'b'] },
      { itemIds: ['b', 'a'] },
      { itemIds: ['a'] },
    ]);
    expect(stats.orders).toBe(4);
    expect(stats.itemOrders.get('a')).toBe(3);
    expect(stats.itemOrders.get('b')).toBe(3);
    expect(stats.itemOrders.get('c')).toBe(2);
    expect(stats.pairs.get(pairKey('a', 'b'))).toBe(2);
    expect(stats.pairs.get(pairKey('b', 'a'))).toBe(2);
    expect(stats.pairs.get(pairKey('b', 'c'))).toBe(2);
    expect(stats.pairs.get(pairKey('a', 'c'))).toBe(1);
    expect(stats.pairs.size).toBe(3);
  });

  it('skips orders with no ids entirely, but counts a single-item order', () => {
    const stats = buildCoOrderStats([{ itemIds: [] }, { itemIds: ['', ''] }, { itemIds: ['a'] }]);
    expect(stats.orders).toBe(1);
    expect(stats.itemOrders.get('a')).toBe(1);
    expect(stats.pairs.size).toBe(0);
  });

  it('is empty for no orders', () => {
    const stats = buildCoOrderStats([]);
    expect(stats.orders).toBe(0);
    expect(stats.itemOrders.size).toBe(0);
    expect(stats.pairs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The weights
// ---------------------------------------------------------------------------

describe('PAIRING_WEIGHTS', () => {
  it('are the spec values and sum to 1', () => {
    // popularity 0.05 / daypart 0.10: retuned on the live menu (see the constant's comment).
    expect(PAIRING_WEIGHTS).toEqual({ complement: 0.4, coOrder: 0.25, harmony: 0.2, popularity: 0.05, daypart: 0.1 });
    const sum = Object.values(PAIRING_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

// ---------------------------------------------------------------------------
// §6 acceptance
// ---------------------------------------------------------------------------

describe('pairingsFor: acceptance (§6)', () => {
  it('a cart of one Americano gets up to 3 picks: at most one drink, distinct categories, none in the cart', () => {
    const picks = ask(['americano'], { limit: 10 });
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.length).toBeLessThanOrEqual(10);
    expect(ask(['americano']).length).toBeLessThanOrEqual(PAIRING_LIMITS.picks);

    const ids = picks.map((p) => p.menuItemId);
    expect(ids).not.toContain('americano');
    expect(ids.filter((id) => kindOf(id) === 'drink').length).toBeLessThanOrEqual(1);
    const categories = ids.map((id) => categoryOf(id));
    expect(new Set(categories).size).toBe(categories.length);
    for (const p of picks) expect(p.anchorItemId).toBe('americano');
    expectValidReasons(picks);
  });

  it('defaults to PAIRING_LIMITS.picks and honours an explicit limit', () => {
    expect(ask(['americano']).length).toBe(PAIRING_LIMITS.picks);
    expect(ask(['americano'], { limit: 1 })).toHaveLength(1);
    expect(ask(['americano'], { limit: 0 })).toEqual([]);
  });

  it('an empty cart, unknown ids, or ids without traits give []', () => {
    expect(ask([])).toEqual([]);
    expect(ask(['nope', 'also-nope'])).toEqual([]);

    const noTraits = worldOf(ALL);
    noTraits.traitsById.delete('americano');
    expect(ask(['americano'], { traitsById: noTraits.traitsById })).toEqual([]);

    const noRow = ALL.filter((e) => e.item.id !== 'americano');
    expect(ask(['americano'], {}, noRow)).toEqual([]);
  });

  it('ignores unknown cart ids when other cart ids are good', () => {
    expect(ask(['nope', 'americano'])).toEqual(ask(['americano']));
  });

  it('is deterministic for fixed inputs, and does not depend on menu or cart order', () => {
    const first = ask(['americano', 'brownie']);
    expect(ask(['americano', 'brownie'])).toEqual(first);
    expect(ask(['brownie', 'americano'])).toEqual(first);

    const reversed = [...ALL].reverse();
    expect(ask(['americano'], {}, reversed)).toEqual(ask(['americano']));
  });

  it('every reason is within 90 characters and passes the tone lint, even for a 60-character anchor name', () => {
    const longName = 'Hazelnut Caramel Swirl Iced Cold Brew with Salted Foam Latte';
    expect(longName).toHaveLength(60);
    const long = entry({
      id: 'long',
      name: longName,
      category: 'Coffee',
      price: 100,
      traits: { ...COFFEE, sweetness_level: 2, flavor_notes: ['hazelnut'] },
    });
    // A dessert that shares the anchor's caramel family, a plain dessert, a food and a drink.
    const caramelCake = entry({
      id: 'caramel-cake',
      name: 'Caramel Cake',
      category: 'Cakes',
      price: 120,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 7, flavor_notes: ['caramel'] },
    });
    const entries = [long, caramelCake, CHEESECAKE, SANDWICH, FRIES];

    for (const cart of [['long'], ['long', 'sandwich']]) {
      const picks = ask(cart, { limit: 10 }, entries);
      expect(picks.length).toBeGreaterThan(0);
      expectValidReasons(picks);
    }
    const picks = ask(['long'], { limit: 10 }, entries);
    expect(picks.some((p) => p.reason.includes('…'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// complement
// ---------------------------------------------------------------------------

describe('complementFit', () => {
  const kinds = (...k: TraitKind[]) => new Set<TraitKind>(k);

  it.each([
    // [candidate kind, cart kinds, expected]
    ['drink', [], 1],
    ['drink', ['food'], 1],
    ['drink', ['dessert'], 1],
    ['drink', ['drink'], 0.2],
    ['drink', ['drink', 'dessert', 'food'], 0.2],
    ['dessert', ['dessert'], 0.15],
    ['dessert', ['drink', 'dessert'], 0.15],
    ['dessert', ['drink'], 1],
    ['dessert', ['drink', 'food'], 1],
    ['dessert', ['food'], 0.6],
    ['dessert', [], 0.6],
    ['food', ['food'], 0.15],
    ['food', ['drink', 'food'], 0.15],
    ['food', ['drink'], 0.8],
    ['food', ['drink', 'dessert'], 0.8],
    ['food', ['dessert'], 0.6],
    ['food', [], 0.6],
  ] as [TraitKind, TraitKind[], number][])('%s candidate, cart %j gives %s', (kind, cart, expected) => {
    expect(complementFit(kind, kinds(...cart))).toBe(expected);
  });

  it('a drink-only cart favours the dessert, then the food, over another drink', () => {
    const picks = ask(['americano'], { limit: 10 });
    const order = picks.map((p) => kindOf(p.menuItemId));
    expect(order[0]).toBe('dessert');
    expect(order.indexOf('food')).toBeGreaterThan(order.indexOf('dessert'));
    expect(order).not.toContain('drink');
  });

  it('kind coverage: a drink-only cart gets something savoury even when sweet things outscore it', () => {
    // Three desserts in three categories, each a better match than any food —
    // filling by score alone would return three desserts.
    const tart = entry({
      id: 'tart',
      name: 'Lemon Tart',
      category: 'Tarts',
      price: 110,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 7, flavor_notes: [] },
    });
    const entries = [AMERICANO, BROWNIE, CHEESECAKE, tart, FRIES];
    const picks = ask(['americano'], {}, entries);
    const kinds = picks.map((p) => kindOf(p.menuItemId, entries));
    expect(kinds).toContain('food');
    expect(kinds.filter((k) => k === 'dessert')).toHaveLength(2);
    // ...and the picks still come back best first.
    expect(picks.map((p) => p.score)).toEqual([...picks.map((p) => p.score)].sort((a, b) => b - a));
  });

  it('kind coverage never takes a missing kind that falls below the cut-off', () => {
    // A dessert cart: the drink is missing and clears the cut-off; a food is
    // missing too, but a dessert-only cart scores food low.
    const picks = ask(['brownie'], {}, [BROWNIE, CHAI, FRIES]);
    for (const p of picks) expect(p.score).toBeGreaterThanOrEqual(PAIRING_LIMITS.minScore);
    expect(picks.map((p) => kindOf(p.menuItemId, [BROWNIE, CHAI, FRIES]))).toContain('drink');
  });

  it('late at night a caffeine-free drink beats an equally good caffeinated one beside a dessert', () => {
    const hotChoc = entry({
      id: 'hot-choc',
      name: 'Hot Chocolate',
      category: 'Hot Non-Coffee',
      price: 130,
      traits: { kind: 'drink', is_coffee: false, caffeine: 'none', sweetness_level: 7, flavor_notes: ['chocolate'] },
    });
    const mocha = entry({
      id: 'mocha',
      name: 'Mocha',
      category: 'Coffee',
      price: 130,
      traits: { kind: 'drink', is_coffee: true, caffeine: 'medium', sweetness_level: 7, flavor_notes: ['chocolate'] },
    });
    const entries = [BROWNIE, hotChoc, mocha];
    const popularity = new Map([['mocha', 100], ['hot-choc', 0]]); // the mocha sells far better
    expect(ask(['brownie'], { popularity, now: MORNING }, entries)[0].menuItemId).toBe('mocha');
    expect(ask(['brownie'], { popularity, now: LATE }, entries)[0].menuItemId).toBe('hot-choc');
  });

  it('a food-only cart favours a drink', () => {
    const picks = ask(['sandwich']);
    expect(picks.length).toBeGreaterThan(0);
    expect(kindOf(picks[0].menuItemId)).toBe('drink');
    expect(picks.filter((p) => kindOf(p.menuItemId) === 'drink').length).toBe(1);
  });

  it('a dessert-only cart takes at most one of the several drinks that qualify', () => {
    const drinksOnly = [BROWNIE, AMERICANO, COLD_BREW, CHAI];
    // Each drink clears the cut-off on its own...
    for (const drink of [AMERICANO, COLD_BREW, CHAI]) {
      const alone = ask(['brownie'], {}, [BROWNIE, drink]);
      expect(alone).toHaveLength(1);
      expect(alone[0].score).toBeGreaterThanOrEqual(PAIRING_LIMITS.minScore);
    }
    // ...but only one of them is offered.
    const picks = ask(['brownie'], { limit: 10 }, drinksOnly);
    expect(picks).toHaveLength(1);
  });

  it('a cart with a drink, a dessert and a food scores everything low and returns nothing', () => {
    expect(ask(['americano', 'brownie', 'sandwich'])).toEqual([]);
  });

  it('...unless a strong co-order lifts one candidate over the cut-off, so fewer than 3 come back', () => {
    // wrap goes with the sandwich in 10 of 100 orders, and is in no others.
    const coOrders = buildCoOrderStats([...repeat(10, ['sandwich', 'wrap']), ...repeat(90, ['fries'])]);
    const picks = ask(['americano', 'brownie', 'sandwich'], { coOrders });
    expect(picks.map((p) => p.menuItemId)).toEqual(['wrap']);
    expect(picks[0].anchorItemId).toBe('sandwich');
    expect(picks[0].reason).toBe('Often ordered with your Grilled Sandwich.');
    expectValidReasons(picks);
  });
});

// ---------------------------------------------------------------------------
// coOrder
// ---------------------------------------------------------------------------

describe('coOrderFit', () => {
  function stats(orders: number, a: number, c: number, pairs: number): CoOrderStats {
    return {
      orders,
      itemOrders: new Map([
        ['a', a],
        ['c', c],
      ]),
      pairs: new Map([[pairKey('a', 'c'), pairs]]),
    };
  }

  it('is 0 below PAIRING_LIMITS.minCoOrders joint orders, however lifted', () => {
    const below = PAIRING_LIMITS.minCoOrders - 1;
    expect(coOrderFit('a', 'c', stats(1000, below, below, below))).toBe(0);
    expect(coOrderFit('a', 'c', NO_ORDERS)).toBe(0);
    expect(coOrderFit('a', 'c', stats(1000, 3, 3, PAIRING_LIMITS.minCoOrders))).toBeGreaterThan(0);
  });

  it('is symmetric in the pair but reads confidence from the anchor', () => {
    const s = stats(20, 8, 6, 5);
    expect(coOrderFit('a', 'c', s)).toBeGreaterThan(0);
    // confidence 5/8 (full marks at 0.25) and lift 100/48:
    expect(coOrderFit('a', 'c', s)).toBeCloseTo(0.5 + 0.5 * ((100 / 48 - 1) / 3), 6);
  });

  it('combines confidence and lift: weak on both is low', () => {
    // confidence 3/40 = 0.075 → 0.3 of full; lift 3·100/(40·10) = 0.75 → 0.
    expect(coOrderFit('a', 'c', stats(100, 40, 10, 3))).toBeCloseTo(0.5 * 0.3, 6);
  });

  it('is 1 for a pair that always travels together and is rare otherwise', () => {
    expect(coOrderFit('a', 'c', stats(100, 10, 10, 10))).toBe(1);
  });

  it('is 0 when the stats are inconsistent (a zero denominator)', () => {
    expect(coOrderFit('a', 'c', stats(0, 10, 10, 10))).toBe(0);
    expect(coOrderFit('a', 'c', stats(100, 0, 10, 10))).toBe(0);
    expect(coOrderFit('a', 'c', stats(100, 10, 0, 10))).toBe(0);
  });
});

describe('pairingsFor: co-orders', () => {
  it('a strong co-order lifts a candidate to the top with the "Often ordered with" reason', () => {
    // the sandwich is in 10 of 100 orders, always with an Americano.
    const coOrders = buildCoOrderStats([...repeat(10, ['americano', 'sandwich']), ...repeat(90, ['fries'])]);
    const picks = ask(['americano'], { coOrders });
    expect(picks[0].menuItemId).toBe('sandwich');
    expect(picks[0].reason).toBe('Often ordered with your Americano.');
    expect(picks[0].score).toBeGreaterThan(ask(['americano'])[0].score - 0.1);
    // the others keep their ordinary reasons
    expect(picks.slice(1).every((p) => !p.reason.startsWith('Often ordered'))).toBe(true);
  });

  it('below minCoOrders joint orders it counts for nothing', () => {
    const coOrders = buildCoOrderStats([
      ...repeat(PAIRING_LIMITS.minCoOrders - 1, ['americano', 'sandwich']),
      ...repeat(90, ['fries']),
    ]);
    expect(ask(['americano'], { coOrders })).toEqual(ask(['americano']));
  });

  it('reads the pair in either direction (the cart item can be the second id)', () => {
    const coOrders = buildCoOrderStats([...repeat(10, ['sandwich', 'americano']), ...repeat(90, ['fries'])]);
    expect(ask(['americano'], { coOrders })[0].reason).toBe('Often ordered with your Americano.');
  });
});

// ---------------------------------------------------------------------------
// harmony
// ---------------------------------------------------------------------------

describe('harmonyFit', () => {
  const subject = (name: string, traits: Partial<MenuItemTraits> & { sweetness_level: number }) => ({
    name,
    traits: makeTraitsV2({ menu_item_id: name, ...traits }),
  });
  const coffee = (level: number, notes: string[] = [], name = 'Coffee') =>
    subject(name, { ...COFFEE, sweetness_level: level, flavor_notes: notes });
  const dessert = (level: number, notes: string[] = [], name = 'Dessert') =>
    subject(name, { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: level, flavor_notes: notes });

  it('is 0.6 for a shared flavour family (name or notes)', () => {
    expect(harmonyFit(coffee(5, ['hazelnut'], 'Latte'), dessert(5, [], 'Nutella Waffle'))).toBeCloseTo(0.6, 10);
    expect(harmonyFit(coffee(5, ['caramel']), dessert(5, ['caramel']))).toBeCloseTo(0.6, 10);
  });

  it('is 0.4 for a sweet dessert with a bold coffee, in both directions', () => {
    expect(harmonyFit(coffee(0), dessert(8))).toBeCloseTo(0.4, 10);
    expect(harmonyFit(dessert(8), coffee(0))).toBeCloseTo(0.4, 10);
    // the thresholds are inclusive: coffee ≤ 4, dessert ≥ 6
    expect(harmonyFit(coffee(4), dessert(6))).toBeCloseTo(0.4, 10);
    expect(harmonyFit(dessert(6), coffee(4))).toBeCloseTo(0.4, 10);
  });

  it('has no contrast when the coffee is sweet, the dessert is mild, or the drink is not coffee', () => {
    expect(harmonyFit(coffee(5), dessert(8))).toBe(0);
    expect(harmonyFit(coffee(0), dessert(5))).toBe(0);
    const chai = subject('Chai', { kind: 'drink', is_coffee: false, caffeine: 'low', sweetness_level: 0 });
    expect(harmonyFit(chai, dessert(8))).toBe(0);
    // two coffees, or two desserts, are never a contrast
    expect(harmonyFit(coffee(0), coffee(0))).toBe(0);
    expect(harmonyFit(dessert(8), dessert(8))).toBe(0);
  });

  it('adds the two and caps at 1', () => {
    expect(harmonyFit(coffee(2, ['chocolate'], 'Mocha'), dessert(8, ['chocolate'], 'Brownie'))).toBe(1);
  });

  it('is 0 with neither', () => {
    expect(harmonyFit(coffee(5), dessert(5))).toBe(0);
  });

  it('shows in the ranking: the chocolate dessert beats an equally sweet plain one next to a mocha', () => {
    const mocha = entry({
      id: 'mocha',
      name: 'Mocha',
      category: 'Coffee',
      price: 100,
      traits: { ...COFFEE, sweetness_level: 6, flavor_notes: ['chocolate'] },
    });
    const plain = entry({
      id: 'plain-cake',
      name: 'Vanilla Slice',
      category: 'Cakes',
      price: 120,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 7, flavor_notes: [] },
    });
    const choc = entry({
      id: 'choc-cake',
      name: 'Chocolate Slice',
      category: 'Cakes 2',
      price: 120,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 7, flavor_notes: ['chocolate'] },
    });
    const picks = ask(['mocha'], { popularity: new Map() }, [mocha, plain, choc]);
    expect(picks[0].menuItemId).toBe('choc-cake');
    expect(picks[0].reason).toBe(`Pairs well with your Mocha — ${FLAVOUR_FAMILY_INFO.chocolatey.phrase}.`);
    expect(picks[1].menuItemId).toBe('plain-cake');
    expect(picks[1].reason).toBe('Pairs well with your Mocha — a sweet finish.');
  });

  it('shows in the ranking: a sweet dessert is lifted by a bold coffee, a cold-sweet drink is not', () => {
    // brownie next to the bold Americano gets the contrast bonus (0.2 × 0.4)...
    const withContrast = ask(['americano'], { popularity: new Map() }, [AMERICANO, BROWNIE]);
    // ...and the same brownie next to a sweet Chai drink does not.
    const without = ask(['chai'], { popularity: new Map() }, [CHAI, BROWNIE]);
    expect(withContrast[0].score - without[0].score).toBeCloseTo(PAIRING_WEIGHTS.harmony * 0.4, 10);
  });

  it('shows in the ranking: contrast works with the dessert as the anchor', () => {
    const picks = ask(['brownie'], { popularity: new Map() }, [BROWNIE, AMERICANO, CHAI]);
    // Americano: complement 1, contrast 0.4. Chai: complement 1, none.
    expect(picks).toHaveLength(1);
    expect(picks[0].menuItemId).toBe('americano');
    const americanoOnly = ask(['brownie'], { popularity: new Map() }, [BROWNIE, AMERICANO]);
    const chaiOnly = ask(['brownie'], { popularity: new Map() }, [BROWNIE, CHAI]);
    expect(americanoOnly[0].score - chaiOnly[0].score).toBeCloseTo(PAIRING_WEIGHTS.harmony * 0.4, 10);
  });
});

// ---------------------------------------------------------------------------
// popularity
// ---------------------------------------------------------------------------

describe('pairingsFor: popularity', () => {
  it('ranks the more popular of two otherwise identical candidates first', () => {
    const a = entry({
      id: 'cake-a',
      name: 'Cake A',
      category: 'Cakes A',
      price: 100,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 3, flavor_notes: [] },
    });
    const b = entry({
      id: 'cake-b',
      name: 'Cake B',
      category: 'Cakes B',
      price: 100,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 3, flavor_notes: [] },
    });
    const popularity = new Map([
      ['cake-a', 10],
      ['cake-b', 90],
      ['americano', 50],
    ]);
    const picks = ask(['americano'], { popularity }, [AMERICANO, a, b]);
    expect(picks.map((p) => p.menuItemId)).toEqual(['cake-b', 'cake-a']);
  });

  it('breaks exact ties by menuItemId ascending, whatever the menu order', () => {
    const mk = (id: string) =>
      entry({
        id,
        name: `Cake ${id}`,
        category: `Cat ${id}`,
        price: 100,
        traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 3, flavor_notes: [] },
      });
    const forward = [AMERICANO, mk('b-cake'), mk('a-cake'), mk('c-cake')];
    const picks = ask(['americano'], { popularity: new Map() }, forward);
    expect(picks.map((p) => p.menuItemId)).toEqual(['a-cake', 'b-cake', 'c-cake']);
    expect(ask(['americano'], { popularity: new Map() }, [...forward].reverse())).toEqual(picks);
  });

  it('no popularity data (an empty map, or no spread) is no signal rather than a failure', () => {
    expect(ask(['americano'], { popularity: new Map() }).length).toBeGreaterThan(0);
    const flat = new Map(ALL.map((e) => [e.item.id, 7]));
    expect(ask(['americano'], { popularity: flat }).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// daypart
// ---------------------------------------------------------------------------

describe('daypartFit', () => {
  it('marks a medium or high caffeine drink down as the day goes on', () => {
    for (const caffeine of ['medium', 'high'] as const) {
      const t = { kind: 'drink', caffeine } as const;
      expect(daypartFit(t, 'morning')).toBe(1);
      expect(daypartFit(t, 'afternoon')).toBe(1);
      expect(daypartFit(t, 'evening')).toBe(0.5);
      expect(daypartFit(t, 'late')).toBe(0);
    }
  });

  it('leaves low and no-caffeine drinks, and anything that is not a drink, alone', () => {
    for (const daypart of ['morning', 'afternoon', 'evening', 'late'] as const) {
      expect(daypartFit({ kind: 'drink', caffeine: 'low' }, daypart)).toBe(1);
      expect(daypartFit({ kind: 'drink', caffeine: 'none' }, daypart)).toBe(1);
      expect(daypartFit({ kind: 'dessert', caffeine: 'high' }, daypart)).toBe(1);
      expect(daypartFit({ kind: 'food', caffeine: 'medium' }, daypart)).toBe(1);
    }
  });
});

describe('pairingsFor: daypart', () => {
  const world = [BROWNIE, COLD_BREW]; // a dessert-only cart wants a drink; cold brew is high caffeine

  it('a high-caffeine drink at 22:00 IST scores lower than at 10:00 IST', () => {
    const morning = ask(['brownie'], { now: MORNING }, world);
    const late = ask(['brownie'], { now: LATE }, world);
    expect(morning).toHaveLength(1);
    expect(late).toHaveLength(1);
    expect(late[0].score).toBeLessThan(morning[0].score);
    expect(morning[0].score - late[0].score).toBeCloseTo(PAIRING_WEIGHTS.daypart, 10);
  });

  it('is half-way down in the evening', () => {
    const morning = ask(['brownie'], { now: MORNING }, world)[0].score;
    const evening = ask(['brownie'], { now: EVENING }, world)[0].score;
    expect(morning - evening).toBeCloseTo(PAIRING_WEIGHTS.daypart * 0.5, 10);
  });

  it('does not change a caffeine-free drink', () => {
    const decaf = entry({
      id: 'decaf',
      name: 'Hot Chocolate',
      category: 'Hot Non-Coffee',
      price: 120,
      traits: { kind: 'drink', is_coffee: false, caffeine: 'none', sweetness_level: 6, flavor_notes: [] },
    });
    const morning = ask(['brownie'], { now: MORNING }, [BROWNIE, decaf])[0].score;
    const late = ask(['brownie'], { now: LATE }, [BROWNIE, decaf])[0].score;
    expect(late).toBe(morning);
  });
});

// ---------------------------------------------------------------------------
// price cap and availability
// ---------------------------------------------------------------------------

describe('pairingsFor: price cap', () => {
  const dessertAt = (id: string, price: number) =>
    entry({
      id,
      name: `Cake ${id}`,
      category: `Cat ${id}`,
      price,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 3, flavor_notes: [] },
    });

  it('excludes an item dearer than ₹150 when the cart is cheaper', () => {
    const entries = [AMERICANO, dessertAt('at-150', 150), dessertAt('at-151', 151), dessertAt('at-300', 300)];
    const ids = ask(['americano'], { limit: 10 }, entries).map((p) => p.menuItemId);
    expect(ids).toContain('at-150');
    expect(ids).not.toContain('at-151');
    expect(ids).not.toContain('at-300');
  });

  it('lets the cap rise to the dearest cart item', () => {
    const pricey = entry({
      id: 'pricey',
      name: 'Reserve Pour-over',
      category: 'Coffee',
      price: 300,
      traits: { ...COFFEE, sweetness_level: 0, flavor_notes: [] },
    });
    const entries = [pricey, AMERICANO, dessertAt('at-250', 250), dessertAt('at-301', 301)];
    const withPricey = ask(['pricey'], { limit: 10 }, entries).map((p) => p.menuItemId);
    expect(withPricey).toContain('at-250');
    expect(withPricey).not.toContain('at-301');
    const withoutPricey = ask(['americano'], { limit: 10 }, entries).map((p) => p.menuItemId);
    expect(withoutPricey).not.toContain('at-250');
  });

  it('prices an item by its cheapest size', () => {
    const sized = entry({
      id: 'sized',
      name: 'Sized Cake',
      category: 'Sized',
      price: 400,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 3, flavor_notes: [] },
      item: {
        variants: [
          { id: 'v-big', menu_item_id: 'sized', label: 'Large', price_inr: 400, sort_order: 1 },
          { id: 'v-small', menu_item_id: 'sized', label: 'Small', price_inr: 140, sort_order: 0 },
        ],
      },
    });
    expect(ask(['americano'], { limit: 10 }, [AMERICANO, sized]).map((p) => p.menuItemId)).toEqual(['sized']);
  });

  it('never offers an item with no priced size', () => {
    const none = entry({
      id: 'none',
      name: 'Unpriced',
      category: 'Nothing',
      price: 100,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 3, flavor_notes: [] },
      item: { variants: [] },
    });
    expect(ask(['americano'], { limit: 10 }, [AMERICANO, none])).toEqual([]);
  });
});

describe('pairingsFor: availability and traits', () => {
  it('excludes an item that is switched off', () => {
    const off = entry({
      id: 'off',
      name: 'Off Cake',
      category: 'Cakes',
      price: 100,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 3, flavor_notes: [] },
      item: { is_available: false },
    });
    expect(ask(['americano'], {}, [AMERICANO, off])).toEqual([]);
  });

  it('excludes an item snoozed past `now`, and offers it again once the snooze is over', () => {
    const snoozed = entry({
      id: 'snoozed',
      name: 'Snoozed Cake',
      category: 'Cakes',
      price: 100,
      traits: { kind: 'dessert', is_coffee: false, caffeine: 'none', sweetness_level: 3, flavor_notes: [] },
      item: { unavailable_until: '2026-10-10T08:00:00Z' },
    });
    // snoozed until 13:30 IST: still snoozed at 10:00 IST, back by 19:00 IST.
    expect(ask(['americano'], { now: MORNING }, [AMERICANO, snoozed])).toEqual([]);
    expect(ask(['americano'], { now: EVENING }, [AMERICANO, snoozed]).map((p) => p.menuItemId)).toEqual(['snoozed']);
  });

  it('excludes an item with no traits row', () => {
    const entries = ALL.filter((e) => e.item.id !== 'brownie');
    const world = worldOf(ALL); // brownie's menu row stays, its traits do not
    world.traitsById.delete('brownie');
    const picks = pairingsFor({
      cartItemIds: ['americano'],
      menu: world.menu,
      traitsById: world.traitsById,
      coOrders: NO_ORDERS,
      popularity: POPULARITY,
      now: MORNING,
      limit: 10,
    });
    expect(picks.map((p) => p.menuItemId)).not.toContain('brownie');
    expect(picks.map((p) => p.menuItemId)).toEqual(ask(['americano'], { limit: 10 }, entries).map((p) => p.menuItemId));
  });

  it('never offers an item that is already in the cart, however well it would score', () => {
    const picks = ask(['americano', 'brownie'], { limit: 10 });
    expect(picks.map((p) => p.menuItemId)).not.toContain('brownie');
    expect(picks.map((p) => p.menuItemId)).not.toContain('americano');
  });

  it('names the best-scoring cart item as the anchor', () => {
    // sandwich is co-ordered with the brownie, not the americano.
    const coOrders = buildCoOrderStats([...repeat(10, ['brownie', 'sandwich']), ...repeat(90, ['fries'])]);
    const picks = ask(['americano', 'brownie'], { coOrders, limit: 10 });
    const sandwich = picks.find((p) => p.menuItemId === 'sandwich');
    expect(sandwich?.anchorItemId).toBe('brownie');
    expect(sandwich?.reason).toBe('Often ordered with your Fudgy Brownie.');
  });
});

// ---------------------------------------------------------------------------
// reasons
// ---------------------------------------------------------------------------

describe('pairingReason', () => {
  const base = { anchorName: 'Americano', coOrder: 0, sharedFamily: null, kind: 'dessert' } as const;

  it('uses the five templates in priority order', () => {
    expect(pairingReason({ ...base, coOrder: 0.6, sharedFamily: 'nutty' })).toBe('Often ordered with your Americano.');
    expect(pairingReason({ ...base, coOrder: 0.59, sharedFamily: 'nutty' })).toBe(
      'Pairs well with your Americano — toasty nutty notes.',
    );
    expect(pairingReason({ ...base })).toBe('Pairs well with your Americano — a sweet finish.');
    expect(pairingReason({ ...base, kind: 'food' })).toBe('Pairs well with your Americano — a savoury bite on the side.');
    expect(pairingReason({ ...base, kind: 'drink' })).toBe(
      'Pairs well with your Americano — something to sip alongside.',
    );
  });

  it.each(FLAVOUR_FAMILIES)('the %s family phrase fits and passes the lint', (family) => {
    const reason = pairingReason({ ...base, sharedFamily: family });
    expect(reason).toBe(`Pairs well with your Americano — ${FLAVOUR_FAMILY_INFO[family].phrase}.`);
    expect(lintReason(reason).ok).toBe(true);
  });

  it('shortens a long anchor name with an ellipsis so the line is within 90 characters', () => {
    const sixty = 'Hazelnut Caramel Swirl Iced Cold Brew with Salted Foam Latte';
    expect(sixty).toHaveLength(60);
    for (const anchorName of [sixty, 'x'.repeat(100), `${'Word '.repeat(30)}`]) {
      for (const kind of ['drink', 'dessert', 'food'] as const) {
        for (const [coOrder, sharedFamily] of [
          [0.9, null],
          [0, 'fruity'],
          [0, null],
        ] as const) {
          const reason = pairingReason({ anchorName, coOrder, sharedFamily, kind });
          expect(reason.length).toBeLessThanOrEqual(PAIRING_LIMITS.reasonMaxChars);
          expect(lintReason(reason).ok).toBe(true);
          expect(reason).toMatch(/^(Often ordered|Pairs well) with your /);
          // The name is cut (and marked) exactly when the whole line would not fit.
          const whole = anchorName.replace(/\s+/g, ' ').trim();
          expect(reason.includes('…')).toBe(!reason.includes(whole));
          if (whole.length > 60) expect(reason).toContain('…');
        }
      }
    }
  });

  it('keeps the whole name when it fits, and fills the line right up to the cap when it does not', () => {
    const fits = pairingReason({ ...base, anchorName: 'A'.repeat(30) });
    expect(fits).toContain('A'.repeat(30));
    expect(fits).not.toContain('…');

    const cut = pairingReason({ ...base, anchorName: 'A'.repeat(100) });
    expect(cut).toHaveLength(PAIRING_LIMITS.reasonMaxChars);
    expect(cut).toContain(`${'A'.repeat(PAIRING_LIMITS.reasonMaxChars - 'Pairs well with your … — a sweet finish.'.length)}…`);
  });

  it('collapses stray whitespace in the name', () => {
    expect(pairingReason({ ...base, anchorName: '  Iced   Latte ' })).toBe(
      'Pairs well with your Iced Latte — a sweet finish.',
    );
  });

  it('never leaves half an emoji at the cut', () => {
    const reason = pairingReason({ ...base, anchorName: `${'a'.repeat(40)}${'😀'.repeat(40)}` });
    expect(reason.length).toBeLessThanOrEqual(PAIRING_LIMITS.reasonMaxChars);
    expect(reason).not.toMatch(/[\uD800-\uDBFF]…/);
    expect(lintReason(reason).ok).toBe(true);
  });

  it('falls back to a line that names nothing when the anchor name cannot pass the lint', () => {
    for (const anchorName of ['Healthy Bowl', 'Spend Less Combo', '<b>Bold</b>']) {
      const reason = pairingReason({ ...base, anchorName });
      expect(reason).toBe('Pairs well with your order.');
      expect(lintReason(reason).ok).toBe(true);
    }
  });

  it('through the ranker: a cart item with an unlintable name still gets a clean reason', () => {
    const odd = entry({
      id: 'odd',
      name: 'Healthy Bowl',
      category: 'Bowls',
      price: 100,
      traits: { kind: 'food', is_coffee: false, caffeine: 'none', sweetness_level: 1, flavor_notes: [] },
    });
    const picks = ask(['odd'], { limit: 10 }, [odd, AMERICANO, BROWNIE]);
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      expect(p.reason).toBe('Pairs well with your order.');
      expect(lintReason(p.reason).ok).toBe(true);
    }
  });
});
