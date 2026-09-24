import { describe, expect, it } from 'vitest';
import { filterCandidates } from '@/lib/suggest/filter';
import {
  DAYPART_WEIGHT,
  EXTRAS_WEIGHT,
  MOOD_WEIGHT,
  POPULARITY_WEIGHT,
  PROFILE_WEIGHT,
  RECENT_ITEM_PENALTY,
  buildShortlist,
  scoreCandidates,
} from '@/lib/suggest/score';
import type { SuggestInputs, TasteProfile } from '@/lib/suggest/types';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import { buildFixtureMenu, buildFixtureTraitsById } from './fixtures/suggestMenu';

const COFFEE_MENU_ITEM_IDS = [
  'espresso',
  'cappuccino',
  'cafe-latte',
  'doppio',
  'flat-white',
  'mocha',
  'cortado',
  'ristretto',
  'hot-americano',
  'macchiato',
];

function makeInputs(over: Partial<SuggestInputs>): SuggestInputs {
  return {
    temperature: 'either',
    base: 'either',
    extras: [],
    needs: [],
    budget: 'any',
    mood: 'boost',
    note: '',
    ...over,
  };
}

function fullProfile(over: Partial<TasteProfile> = {}): TasteProfile {
  return {
    topItems: [],
    categoryAffinity: {},
    traitLean: { icedShare: 0.5, meanSweetness: 1.5, caffeineShare: 0.5, foodAttachRate: 0.3 },
    ticket: { median: 200, p75: 260 },
    priceComfort: 'mid',
    orderingMood: 'routine',
    daypartHistogram: { morning: 0.25, afternoon: 0.25, evening: 0.25, late: 0.25 },
    favorites: [],
    ...over,
  };
}

describe('scoring weights (§5.3, exact numbers)', () => {
  it('sum to 1', () => {
    expect(MOOD_WEIGHT + EXTRAS_WEIGHT + DAYPART_WEIGHT + PROFILE_WEIGHT + POPULARITY_WEIGHT).toBeCloseTo(1, 10);
  });

  it('match the spec verbatim', () => {
    expect(MOOD_WEIGHT).toBe(0.35);
    expect(EXTRAS_WEIGHT).toBe(0.2);
    expect(DAYPART_WEIGHT).toBe(0.15);
    expect(PROFILE_WEIGHT).toBe(0.2);
    expect(POPULARITY_WEIGHT).toBe(0.1);
  });
});

describe('scoreCandidates', () => {
  const items = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();

  it('every score is clamped to [0,1]', () => {
    const inputs = makeInputs({ mood: 'boost' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const scored = scoreCandidates({
      candidates: filtered,
      inputs,
      profile: fullProfile(),
      daypart: 'morning',
      popularity: new Map(items.map((i) => [i.id, Math.random() * 100])),
      recentItemIds: [items[0].id],
    });
    for (const c of scored) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
  });

  it('sorts descending by score', () => {
    const inputs = makeInputs({ mood: 'boost' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const scored = scoreCandidates({
      candidates: filtered,
      inputs,
      profile: null,
      daypart: 'morning',
      popularity: new Map(),
      recentItemIds: [],
    });
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
    }
  });

  it('breaks ties deterministically by menuItemId ascending', () => {
    const inputs = makeInputs({});
    // Force a tie: no profile, no popularity, everything scores purely on
    // mood/extras/daypart which are identical for two items with identical
    // traits (aside from id) — cheat by scoring the same candidate set twice
    // and confirming the ORDER is stable across runs instead (determinism).
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const runA = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'late', popularity: new Map(), recentItemIds: [] });
    const runB = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'late', popularity: new Map(), recentItemIds: [] });
    expect(runA.map((c) => c.menuItemId)).toEqual(runB.map((c) => c.menuItemId));

    // Any two consecutive items with an equal score are ordered by id ascending.
    for (let i = 1; i < runA.length; i++) {
      if (runA[i - 1].score === runA[i].score) {
        expect(runA[i - 1].menuItemId < runA[i].menuItemId).toBe(true);
      }
    }
  });

  it('scores a mood-tagged item higher than an otherwise-identical item without the mood', () => {
    // cappuccino is tagged 'cosy'; iced-latte is tagged 'cool', not 'cosy'.
    const inputs = makeInputs({ mood: 'cosy', temperature: 'either' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'late', popularity: new Map(), recentItemIds: [] });
    const cappuccino = scored.find((c) => c.menuItemId === 'cappuccino')!;
    const icedLatte = scored.find((c) => c.menuItemId === 'iced-latte')!;
    expect(cappuccino.score).toBeGreaterThan(icedLatte.score);
  });

  it('extras: an item satisfying a chosen extra scores its extras share; none chosen scores it neutrally (full credit)', () => {
    // mood: 'cool' gives neither espresso nor the waffle a mood-term bonus
    // (espresso isn't iced; the waffle isn't tagged 'cool') — isolates the
    // extras term instead of being swamped by the heavier 0.35 mood weight.
    //
    // The "no extras chosen" half deliberately builds its candidates by hand
    // (not via filterCandidates) rather than through 'eat' — the composition
    // rule (§5.2) means the waffle isn't even a CANDIDATE with extras: [], so
    // this exercises scoreCandidates' own extras maths directly, same as
    // buildShortlist's "guaranteed food/dessert" logic can hand it an item
    // that already cleared composition upstream.
    const waffleItem = items.find((i) => i.id === 'belgian-waffle')!;
    const espressoItem = items.find((i) => i.id === 'espresso')!;
    const waffleTraits = traitsById.get('belgian-waffle')!;
    const espressoTraits = traitsById.get('espresso')!;

    const withEat = makeInputs({ extras: ['eat'], mood: 'cool' });
    const withoutExtras = makeInputs({ extras: [], mood: 'cool' });
    const filteredWith = filterCandidates(items, traitsById, withEat, []);
    const handBuilt = [
      { item: waffleItem, traits: waffleTraits },
      { item: espressoItem, traits: espressoTraits },
    ];
    const scoredWith = scoreCandidates({ candidates: filteredWith, inputs: withEat, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    const scoredWithout = scoreCandidates({ candidates: handBuilt, inputs: withoutExtras, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    const waffleWith = scoredWith.find((c) => c.menuItemId === 'belgian-waffle')!;
    const espressoWith = scoredWith.find((c) => c.menuItemId === 'espresso')!;
    // 'eat' is satisfied by the waffle (food) but not espresso (drink).
    expect(waffleWith.score).toBeGreaterThan(espressoWith.score);
    // With no extras chosen, both get full extras credit (1) — the gap
    // should shrink relative to the 'eat' run's extras-driven boost.
    const gapWith = waffleWith.score - espressoWith.score;
    const waffleWithout = scoredWithout.find((c) => c.menuItemId === 'belgian-waffle')!;
    const espressoWithout = scoredWithout.find((c) => c.menuItemId === 'espresso')!;
    const gapWithout = waffleWithout.score - espressoWithout.score;
    expect(gapWith).toBeGreaterThan(gapWithout);
  });

  it('extras: "chocolatey" scores a chocolatey drink higher than a non-chocolatey one (soft preference, never a hard filter)', () => {
    const inputs = makeInputs({ extras: ['chocolatey'], mood: 'cool', temperature: 'either' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    // hot-chocolate's name AND flavor_notes both read chocolatey; espresso
    // reads neither — isolates the extras term rather than the mood term
    // (neither is tagged 'cool').
    const hotChocolate = scored.find((c) => c.menuItemId === 'hot-chocolate')!;
    const espresso = scored.find((c) => c.menuItemId === 'espresso')!;
    expect(hotChocolate.score).toBeGreaterThan(espresso.score);
  });

  it('extras: "fruity" scores a fruity drink higher than a non-fruity one', () => {
    const inputs = makeInputs({ extras: ['fruity'], mood: 'cool', temperature: 'either' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    // berry-lemonade is both 'cool'-tagged and fruity (name + flavor_notes);
    // espresso is neither — a real request this extra should win on.
    const berryLemonade = scored.find((c) => c.menuItemId === 'berry-lemonade')!;
    const espresso = scored.find((c) => c.menuItemId === 'espresso')!;
    expect(berryLemonade.score).toBeGreaterThan(espresso.score);
  });

  it('daypart: an item tagged for the current daypart outscores one that is not (all else equal)', () => {
    const inputs = makeInputs({ mood: 'cool', temperature: 'iced' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    // matcha-iced-latte is tagged only 'afternoon'; berry-lemonade is tagged 'afternoon'+'evening'.
    const morningScored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'morning', popularity: new Map(), recentItemIds: [] });
    const afternoonScored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    const matchaMorning = morningScored.find((c) => c.menuItemId === 'matcha-iced-latte')!;
    const matchaAfternoon = afternoonScored.find((c) => c.menuItemId === 'matcha-iced-latte')!;
    expect(matchaAfternoon.score).toBeGreaterThan(matchaMorning.score);
  });

  it('profile price-comfort: a budget customer is scored down for an item priced well above their p75', () => {
    // extras: ['sweet'] admits the dessert past the §5.2 composition rule —
    // applied identically to both profiles compared below, so it doesn't
    // affect the budget-vs-premium comparison itself.
    const inputs = makeInputs({ budget: 'any', extras: ['sweet'] });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const budgetProfile = fullProfile({ priceComfort: 'budget', ticket: { median: 120, p75: 140 } });
    const premiumProfile = fullProfile({ priceComfort: 'premium', ticket: { median: 500, p75: 600 } });
    const scoredBudget = scoreCandidates({ candidates: filtered, inputs, profile: budgetProfile, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    const scoredPremium = scoreCandidates({ candidates: filtered, inputs, profile: premiumProfile, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    // biscoff-cheesecake (₹260) is well above the budget customer's p75 (₹140).
    const cakeBudget = scoredBudget.find((c) => c.menuItemId === 'biscoff-cheesecake')!;
    const cakePremium = scoredPremium.find((c) => c.menuItemId === 'biscoff-cheesecake')!;
    // Premium gets "no penalty" (§5.5) — never scored down for price.
    expect(cakePremium.score).toBeGreaterThanOrEqual(cakeBudget.score);
  });

  it('orderingMood "treating" gives a food/dessert item a bonus over "routine"', () => {
    // extras: ['sweet'] admits the dessert past the §5.2 composition rule —
    // applied identically to both orderingMood runs compared below.
    const inputs = makeInputs({ extras: ['sweet'] });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const treating = fullProfile({ orderingMood: 'treating' });
    const routine = fullProfile({ orderingMood: 'routine' });
    const scoredTreating = scoreCandidates({ candidates: filtered, inputs, profile: treating, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    const scoredRoutine = scoreCandidates({ candidates: filtered, inputs, profile: routine, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    const dessertTreating = scoredTreating.find((c) => c.menuItemId === 'blueberry-cheesecake')!;
    const dessertRoutine = scoredRoutine.find((c) => c.menuItemId === 'blueberry-cheesecake')!;
    expect(dessertTreating.score).toBeGreaterThan(dessertRoutine.score);
  });

  it('items ordered in the last 3 visits take the flat §5.3 explore penalty', () => {
    const inputs = makeInputs({ mood: 'boost' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const withoutPenalty = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'morning', popularity: new Map(), recentItemIds: [] });
    const withPenalty = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'morning', popularity: new Map(), recentItemIds: ['espresso'] });
    const before = withoutPenalty.find((c) => c.menuItemId === 'espresso')!;
    const after = withPenalty.find((c) => c.menuItemId === 'espresso')!;
    expect(before.score - after.score).toBeCloseTo(RECENT_ITEM_PENALTY, 5);
  });

  it('popularity is min-max normalised across the whole popularity map, not just the shortlist', () => {
    const inputs = makeInputs({});
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const popularity = new Map(items.map((i) => [i.id, 0]));
    popularity.set('espresso', 100); // the menu's clear bestseller
    popularity.set('cappuccino', 50);
    const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'afternoon', popularity, recentItemIds: [] });
    const espresso = scored.find((c) => c.menuItemId === 'espresso')!;
    const cappuccino = scored.find((c) => c.menuItemId === 'cappuccino')!;
    const zeroPop = scored.find((c) => c.menuItemId === 'cafe-latte')!; // popularity 0
    expect(espresso.score).toBeGreaterThan(cappuccino.score);
    expect(cappuccino.score).toBeGreaterThan(zeroPop.score - 1e-9);
  });
});

describe('buildShortlist', () => {
  const items = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();

  it('caps the shortlist at SUGGEST_LIMITS.shortlist', () => {
    const inputs = makeInputs({});
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    const shortlist = buildShortlist(scored, inputs);
    expect(shortlist.length).toBeLessThanOrEqual(SUGGEST_LIMITS.shortlist);
  });

  it('allows at most maxPerCategoryInShortlist items per category', () => {
    const inputs = makeInputs({});
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'afternoon', popularity: new Map(), recentItemIds: [] });
    const shortlist = buildShortlist(scored, inputs);
    const perCategory = new Map<string, number>();
    for (const c of shortlist) perCategory.set(c.category, (perCategory.get(c.category) ?? 0) + 1);
    for (const [, count] of perCategory) {
      expect(count).toBeLessThanOrEqual(SUGGEST_LIMITS.maxPerCategoryInShortlist);
    }
  });

  it('guarantees a food/dessert item in the shortlist when "eat" was chosen', () => {
    // A wide-open drink pool (13+ drink-category slots across 7 categories,
    // each strongly boost-scored) is enough to fill all 12 shortlist slots
    // without ever needing a dessert — so this is a real test of the forced
    // swap, not a case where food would have shown up anyway.
    const inputs = makeInputs({ temperature: 'either', base: 'either', extras: ['eat'], mood: 'boost' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'morning', popularity: new Map(), recentItemIds: [] });
    const shortlist = buildShortlist(scored, inputs);
    expect(shortlist.length).toBeLessThanOrEqual(SUGGEST_LIMITS.shortlist);
    expect(shortlist.some((c) => c.traits.kind === 'food' || c.traits.kind === 'dessert')).toBe(true);
  });

  it('root cause #2: no longer starves a same-category request to 2 — 10 hot coffees + "hot coffee" yields ≥8 coffees in the shortlist', () => {
    const inputs = makeInputs({ temperature: 'hot', base: 'coffee', mood: 'boost' });
    const filtered = filterCandidates(items, traitsById, inputs, []);
    const filteredCoffeeIds = filtered.filter((c) => COFFEE_MENU_ITEM_IDS.includes(c.item.id)).map((c) => c.item.id);
    // The fixture menu really does have 10 hot coffees that clear this filter.
    expect(filteredCoffeeIds.length).toBe(10);

    const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'morning', popularity: new Map(), recentItemIds: [] });
    const shortlist = buildShortlist(scored, inputs);
    const coffeesInShortlist = shortlist.filter((c) => COFFEE_MENU_ITEM_IDS.includes(c.menuItemId));
    expect(coffeesInShortlist.length).toBeGreaterThanOrEqual(8);
  });

  it('never returns FEWER food/dessert items than the same scenario without "eat" chosen', () => {
    const withEat = makeInputs({ temperature: 'either', base: 'either', extras: ['eat'], mood: 'boost' });
    const withoutEat = makeInputs({ temperature: 'either', base: 'either', extras: [], mood: 'boost' });
    const countFoodOrDessert = (inputs: SuggestInputs) => {
      const filtered = filterCandidates(items, traitsById, inputs, []);
      const scored = scoreCandidates({ candidates: filtered, inputs, profile: null, daypart: 'morning', popularity: new Map(), recentItemIds: [] });
      return buildShortlist(scored, inputs).filter((c) => c.traits.kind === 'food' || c.traits.kind === 'dessert').length;
    };
    expect(countFoodOrDessert(withEat)).toBeGreaterThanOrEqual(countFoodOrDessert(withoutEat));
  });
});
