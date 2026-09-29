import { describe, expect, it } from 'vitest';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { runSuggest } from '@/lib/suggest/engine';
import { filterCandidates, minPriceInr, passesHardConstraints, relaxHintFor } from '@/lib/suggest/filter';
import { withInputDefaults } from '@/lib/suggest/inputs';
import { buildShortlist, scoreCandidates } from '@/lib/suggest/score';
import { deterministicPicks } from '@/lib/suggest/templates';
import { validateDeciderPicks } from '@/lib/suggest/validate';
import type { MenuItem } from '@/lib/types';
import type {
  BasePref,
  Budget,
  Decider,
  DeciderResult,
  MenuItemTraits,
  Mood,
  Need,
  SuggestInputs,
  SweetnessPref,
  TasteProfile,
  TemperaturePref,
  TraitKind,
} from '@/lib/suggest/types';
import { BUDGETS, KINDS, MOODS, SWEETNESS_PREFS } from '@/lib/suggest/types';
import {
  buildFixtureMenu,
  buildFixtureTraitsById,
  makeMenuItem,
  makeTraits,
  NO_TRAITS_ITEM,
  SNOOZED_ITEM,
  UNAVAILABLE_ITEM,
} from './fixtures/suggestMenu';

// ---------------------------------------------------------------------------
// COFFEY-SPEC §4.1 / PHASE-7 §6.1: "a property-style unit test runs the filter
// plus the full pipeline (with the LLM mocked to return adversarial ids …)
// across every combination of chips × a fixture menu, and asserts no violating
// item is ever returned." This is that test. `spec4_1Violation` is an
// INDEPENDENT re-statement of §4.1's six rules — it calls nothing in the code
// under test (not even sweetnessLevel or the budget table) — so a bug in
// filter.ts can't also hide from its own check.
//
// Invariants beyond the six, carried over from the Phase-7 quality pass:
//  (a) temperature only ever gates DRINKS — a hot/iced food or dessert item is
//      never excluded just because the customer's temperature chip doesn't
//      match it.
//  (b) composition is the customer's own `kinds` (COFFEY-SPEC §4.1.2): an item
//      is a candidate only when its kind is one they asked for. Neither a
//      feeling ('celebrate' used to admit dessert) nor a flavour steer admits
//      a kind on its own any more.
// ---------------------------------------------------------------------------

/** The legacy 0–3 column on the 0–10 scale (COFFEY-SPEC §3.1) — restated, not imported. */
const LEGACY_LEVEL = [0, 3, 6, 9];
/** What each sweetness choice means on the item scale (§4.1.5) — restated. */
const SWEETNESS_TARGET: Record<Exclude<SweetnessPref, 'any'>, number> = { none: 0, light: 3, medium: 5, sweet: 7, very: 10 };
const SWEETNESS_TOLERANCE = 3;
/** Budget ceilings on the cheapest size (§4.1.6) — restated. */
const CAP: Record<Budget, number | null> = { under_100: 100, under_150: 150, under_200: 200, any: null };

function cheapest(item: MenuItem): number {
  return item.variants.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...item.variants.map((v) => v.price_inr));
}

function itemLevel(t: MenuItemTraits): number {
  return typeof t.sweetness_level === 'number' ? t.sweetness_level : LEGACY_LEVEL[t.sweetness];
}

function spec4_1Violation(
  item: MenuItem,
  t: MenuItemTraits | undefined,
  inputs: SuggestInputs,
  excludeIds: string[],
): string | null {
  if (!t) return 'no traits row (§4.1.1)';
  if (!isMenuItemAvailable(item)) return 'unavailable (§4.1.1)';
  if (excludeIds.includes(item.id)) return 'in excludeItemIds';
  if (!inputs.kinds.includes(t.kind)) return `kind ${t.kind} not among the kinds asked for [${inputs.kinds.join(',')}] (§4.1.2)`;
  // (a) drinks-only temperature.
  if (t.kind === 'drink' && inputs.temperature === 'hot' && t.temperature === 'iced') return 'Hot chip returned an iced drink (§4.1.3)';
  if (t.kind === 'drink' && inputs.temperature === 'iced' && t.temperature === 'hot') return 'Iced chip returned a hot drink (§4.1.3)';
  if (inputs.base === 'no_coffee' && t.is_coffee) return 'No-coffee returned a coffee item (§4.1.4)';
  if (inputs.base === 'coffee' && t.kind === 'drink' && !t.is_coffee) return 'Coffee returned a non-coffee drink (§4.1.4)';
  if (inputs.needs.includes('no_caffeine') && t.caffeine !== 'none') return 'No-caffeine returned a caffeinated item (§4.1.4)';
  if (inputs.sweetness !== 'any') {
    const ceiling = SWEETNESS_TARGET[inputs.sweetness] + SWEETNESS_TOLERANCE;
    if (itemLevel(t) > ceiling) return `sweetness ${itemLevel(t)} over the ${inputs.sweetness} ceiling ${ceiling} (§4.1.5)`;
  }
  const cap = CAP[inputs.budget];
  if (cap !== null && cheapest(item) > cap) return `₹${cheapest(item)} over the ₹${cap} ceiling (§4.1.6)`;
  return null;
}

/** All 7 non-empty subsets of what the customer can want (drink / dessert / food). */
const KIND_SUBSETS: TraitKind[][] = KINDS.reduce<TraitKind[][]>((acc, k) => [...acc, ...acc.map((s) => [...s, k])], [[]]).filter(
  (s) => s.length > 0,
);
const TEMPERATURES: TemperaturePref[] = ['hot', 'iced', 'either'];
const BASES: BasePref[] = ['coffee', 'no_coffee', 'either'];
const NEEDS_SUBSETS: Need[][] = [[], ['no_caffeine']];
const SWEETNESSES: SweetnessPref[] = [...SWEETNESS_PREFS];
const BUDGETS_TO_TEST: Budget[] = [...BUDGETS];

function makeInputs(over: Partial<SuggestInputs> = {}): SuggestInputs {
  return withInputDefaults({ mood: 'boost', ...over });
}

function label(inputs: SuggestInputs, excludeCount = 0): string {
  return [
    `K=${inputs.kinds.join('+')}`,
    `T=${inputs.temperature}`,
    `B=${inputs.base}`,
    `N=${inputs.needs.join('+') || 'none'}`,
    `S=${inputs.sweetness}`,
    `$=${inputs.budget}`,
    `X=${excludeCount}`,
  ].join(' ');
}

describe('the fixture really exercises the rules', () => {
  const items = buildFixtureMenu();
  const traitsById = buildFixtureTraitsById();

  it('has every kind, both eras of trait rows, a sugar group, and a spread of prices and sweetness', () => {
    const traits = [...traitsById.values()];
    for (const kind of KINDS) expect(traits.some((t) => t.kind === kind), kind).toBe(true);
    expect(traits.some((t) => (t.traits_version ?? 1) >= 2)).toBe(true);
    expect(traits.some((t) => (t.traits_version ?? 1) < 2)).toBe(true);
    expect(items.some((i) => i.addon_groups.length > 0)).toBe(true);
    const levels = new Set(traits.map(itemLevel));
    expect(Math.min(...levels)).toBe(0);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(9);
    // Both sides of every budget ceiling.
    for (const cap of [100, 150, 200]) {
      expect(items.some((i) => cheapest(i) <= cap)).toBe(true);
      expect(items.some((i) => cheapest(i) > cap)).toBe(true);
    }
  });
});

describe('§6.1 exhaustive hard-constraint suite (kinds × temperature × base × needs × sweetness × budget)', () => {
  const items = buildFixtureMenu();
  const byId = new Map(items.map((i) => [i.id, i]));
  const excludeListsToTest: string[][] = [[], ['cappuccino', 'espresso', 'cold-brew', 'blueberry-cheesecake', 'nutella-shake']];

  // A signed-in customer whose history covers every kind — so the "usual" is
  // exercised under every combination too (pickUsual reuses the hard filter).
  const everyKindProfile: TasteProfile = {
    topItems: [
      'nutella-shake',
      'baked-cheese-nachos',
      'fudge-brownie',
      'hot-chocolate',
      'cheesy-garlic-bread',
      'espresso',
      'signature-iced-brew',
      'blueberry-cheesecake',
      'matcha-latte',
      'iced-latte',
    ].map((menu_item_id, i) => ({ menu_item_id, count: 20 - i, lastOrderedAt: '2026-09-01T00:00:00Z' })),
    categoryAffinity: { Coffee: 0.5, Waffles: 0.5 },
    traitLean: { icedShare: 0.5, meanSweetness: 1.5, caffeineShare: 0.6, foodAttachRate: 0.4 },
    ticket: { median: 200, p75: 260 },
    priceComfort: 'mid',
    orderingMood: 'routine',
    daypartHistogram: { morning: 0.25, afternoon: 0.25, evening: 0.25, late: 0.25 },
    favorites: [],
  };

  // Every id below is a way to break a rule under SOME combination; whichever it
  // breaks under the combination at hand, it must never come back.
  const ADVERSARIAL_IDS = [
    'not-on-any-shortlist', // invented
    UNAVAILABLE_ITEM.id, // 86'd
    SNOOZED_ITEM.id, // snoozed
    NO_TRAITS_ITEM.id, // no traits row
    'biscoff-cheesecake', // ₹260: over every ceiling
    'nutella-waffle', // ₹240
    'nutella-shake', // sweetness 9: over "no sugar", "lightly sweet" and "medium"
    'fudge-brownie', // sweetness 9 dessert
    'hazelnut-creme', // legacy sweetness 3 → 9
    'espresso', // hot, caffeinated coffee
    'iced-latte', // iced coffee
    'berry-lemonade', // caffeine-free non-coffee
    'baked-cheese-nachos', // food
    'red-velvet-cupcake', // dessert
    'cold-brew', // a drink, for a kinds set without drinks
  ];

  const adversarialDecider: Decider = async ({ shortlist }) => {
    const real = shortlist.slice(0, 2).map((c) => c.menuItemId);
    const result: DeciderResult = {
      picks: [
        ...ADVERSARIAL_IDS.map((menuItemId) => ({ menuItemId, reason: 'A lovely pick for you.', reasonCode: 'trait' as const })),
        // A real shortlist id, listed twice, once with a banned-phrase reason.
        ...real.map((menuItemId) => ({ menuItemId, reason: 'Since you spend a lot, hurry and grab this best deal.', reasonCode: 'boost' as const })),
        ...real.map((menuItemId) => ({ menuItemId, reason: 'A lovely pick for you.', reasonCode: 'trait' as const })),
      ],
      header: 'You should buy this — best deal today!',
      model: 'jev:test',
      inputTokens: 1,
      cacheReadTokens: 0,
      outputTokens: 0,
      costUsdMicros: 0,
    };
    return result;
  };

  for (const kinds of KIND_SUBSETS) {
    for (const temperature of TEMPERATURES) {
      for (const base of BASES) {
        const group = `K=${kinds.join('+')} T=${temperature} B=${base}`;

        it(`filterCandidates never violates §4.1 [${group}: needs × sweetness × budget × exclude]`, () => {
          const traitsById = buildFixtureTraitsById();
          for (const needs of NEEDS_SUBSETS) {
            for (const sweetness of SWEETNESSES) {
              for (const budget of BUDGETS_TO_TEST) {
                for (const excludeItemIds of excludeListsToTest) {
                  const inputs = makeInputs({ kinds, temperature, base, needs, sweetness, budget });
                  const candidates = filterCandidates(items, traitsById, inputs, excludeItemIds);
                  for (const c of candidates) {
                    const violation = spec4_1Violation(c.item, traitsById.get(c.item.id), inputs, excludeItemIds);
                    expect(violation, `${label(inputs, excludeItemIds.length)} — ${c.item.id}: ${violation}`).toBeNull();
                    expect(c.traits).toBeDefined(); // every candidate has a traits row (F1)
                  }
                  // …and the filter drops nothing it should have kept (no over-filtering).
                  const kept = new Set(candidates.map((c) => c.item.id));
                  for (const item of items) {
                    if (spec4_1Violation(item, traitsById.get(item.id), inputs, excludeItemIds) === null) {
                      expect(kept.has(item.id), `${label(inputs, excludeItemIds.length)} — ${item.id} wrongly excluded`).toBe(true);
                    }
                  }
                }
              }
            }
          }
        });

        it(`the pipeline (filter → score → shortlist → deterministic picks → validate) never violates §4.1 [${group}]`, () => {
          const traitsById = buildFixtureTraitsById();
          for (const needs of NEEDS_SUBSETS) {
            for (const sweetness of SWEETNESSES) {
              for (const budget of BUDGETS_TO_TEST) {
                const inputs = makeInputs({ kinds, temperature, base, needs, sweetness, budget });
                const tag = label(inputs);
                const filtered = filterCandidates(items, traitsById, inputs, []);
                const scored = scoreCandidates({
                  candidates: filtered,
                  inputs,
                  profile: null,
                  daypart: 'afternoon',
                  popularity: new Map(),
                  recentItemIds: [],
                });
                const shortlist = buildShortlist(scored, inputs);
                const shortlistIds = new Set(shortlist.map((c) => c.menuItemId));

                for (const c of shortlist) {
                  const violation = spec4_1Violation(byId.get(c.menuItemId)!, traitsById.get(c.menuItemId), inputs, []);
                  expect(violation, `${tag} — shortlist ${c.menuItemId}: ${violation}`).toBeNull();
                }

                const picks = deterministicPicks(shortlist, inputs);
                for (const pick of picks) {
                  expect(shortlistIds.has(pick.menuItemId), `${tag} — deterministic pick ${pick.menuItemId} not in shortlist`).toBe(true);
                }
                expect(new Set(picks.map((p) => p.menuItemId)).size).toBe(picks.length);

                const adversarial = ADVERSARIAL_IDS.map((menuItemId) => ({
                  menuItemId,
                  reason: 'A lovely pick for you.',
                  reasonCode: 'trait' as const,
                }));
                const validated = validateDeciderPicks(adversarial, shortlist, inputs);
                expect(validated.length).toBeLessThanOrEqual(3);
                expect(new Set(validated.map((v) => v.menuItemId)).size).toBe(validated.length);
                for (const v of validated) {
                  expect(shortlistIds.has(v.menuItemId), `${tag} — validated pick ${v.menuItemId} not in shortlist`).toBe(true);
                  const violation = spec4_1Violation(byId.get(v.menuItemId)!, traitsById.get(v.menuItemId), inputs, []);
                  expect(violation, `${tag} — validated ${v.menuItemId}: ${violation}`).toBeNull();
                }
              }
            }
          }
        });

        it(`the full engine with an adversarial decider never returns a violating pick or usual [${group}]`, async () => {
          const traitsById = buildFixtureTraitsById();
          for (const needs of NEEDS_SUBSETS) {
            for (const sweetness of SWEETNESSES) {
              for (const budget of BUDGETS_TO_TEST) {
                const inputs = makeInputs({ kinds, temperature, base, needs, sweetness, budget, note: 'studying late' });
                const tag = label(inputs);
                const result = await runSuggest({
                  request: { inputs },
                  menu: items,
                  traitsById,
                  profile: everyKindProfile,
                  popularity: new Map(),
                  recentItemIds: [],
                  now: new Date('2026-06-01T10:00:00Z'), // an IST afternoon
                  decider: adversarialDecider,
                });

                const candidateIds = new Set(result.candidateIds);
                expect(result.pickIds.length, tag).toBeLessThanOrEqual(3);
                expect(new Set(result.pickIds).size, tag).toBe(result.pickIds.length);
                for (const pick of result.picks) {
                  expect(candidateIds.has(pick.menuItemId), `${tag} — pick ${pick.menuItemId} not a candidate`).toBe(true);
                  const violation = spec4_1Violation(byId.get(pick.menuItemId)!, traitsById.get(pick.menuItemId), inputs, []);
                  expect(violation, `${tag} — pick ${pick.menuItemId}: ${violation}`).toBeNull();
                  expect(pick.reason, tag).not.toMatch(/spend|hurry|best deal/i);
                  expect(pick.matchTags?.length ?? 0, tag).toBeLessThanOrEqual(3);
                }
                if (result.usual) {
                  const violation = spec4_1Violation(byId.get(result.usual.menuItemId)!, traitsById.get(result.usual.menuItemId), inputs, []);
                  expect(violation, `${tag} — usual ${result.usual.menuItemId}: ${violation}`).toBeNull();
                  expect(result.pickIds, `${tag} — the usual is never also a pick`).not.toContain(result.usual.menuItemId);
                }
                // The header is model text: it must have been replaced, never shown raw.
                expect(result.header, tag).not.toMatch(/best deal|you should/i);
                // Every item shipped to the page is one of the above, and only those.
                for (const item of result.items) {
                  const violation = spec4_1Violation(item, traitsById.get(item.id), inputs, []);
                  expect(violation, `${tag} — item ${item.id}: ${violation}`).toBeNull();
                }
              }
            }
          }
        }, 30_000);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Dedicated composition matrix: kinds subsets × every mood × every temperature
// chip. Kept as its own smaller matrix (the suite above already re-checks these
// invariants on every one of ITS combinations at mood 'boost') so varying the
// mood doesn't multiply the whole suite out to an unworkable size.
// ---------------------------------------------------------------------------

describe('§4.1.2 composition (kinds) × drinks-only temperature — kinds × mood × temperature', () => {
  const items = buildFixtureMenu();

  for (const mood of MOODS as readonly Mood[]) {
    for (const kinds of KIND_SUBSETS) {
      for (const temperature of TEMPERATURES) {
        const inputs = makeInputs({ mood, kinds, temperature });
        const tag = `mood=${mood} kinds=${kinds.join('+')} T=${temperature}`;

        it(`filterCandidates never violates the composition/temperature invariants [${tag}]`, () => {
          const traitsById = buildFixtureTraitsById();
          for (const c of filterCandidates(items, traitsById, inputs, [])) {
            const violation = spec4_1Violation(c.item, traitsById.get(c.item.id), inputs, []);
            expect(violation, `${c.item.id}: ${violation}`).toBeNull();
          }
        });

        it(`(a) a hot/iced food or dessert the kinds allow is never excluded by the temperature chip [${tag}]`, () => {
          const traitsById = buildFixtureTraitsById();
          const candidateIds = new Set(filterCandidates(items, traitsById, inputs, []).map((c) => c.item.id));
          for (const item of items) {
            const t = traitsById.get(item.id);
            if (!t || (t.kind !== 'food' && t.kind !== 'dessert')) continue;
            if (t.temperature !== 'hot' && t.temperature !== 'iced') continue; // ambient — nothing to prove here
            if (!isMenuItemAvailable(item)) continue;
            if (!kinds.includes(t.kind)) continue; // correctly excluded by composition, not temperature
            expect(
              candidateIds.has(item.id),
              `${item.id} (kind=${t.kind}, temp=${t.temperature}) wrongly excluded by the ${temperature} chip`,
            ).toBe(true);
          }
        });

        it(`(b) no candidate of a kind the customer did not ask for [${tag}]`, () => {
          const traitsById = buildFixtureTraitsById();
          for (const c of filterCandidates(items, traitsById, inputs, [])) {
            expect(kinds, `${c.item.id} (kind=${c.traits.kind}) admitted without being asked for`).toContain(c.traits.kind);
          }
        });
      }
    }
  }

  it("the mood alone never admits a kind: a celebrating customer who asked for a drink is shown drinks only (v1 admitted dessert)", () => {
    const traitsById = buildFixtureTraitsById();
    const kindsSeen = new Set(
      filterCandidates(items, traitsById, makeInputs({ mood: 'celebrate', kinds: ['drink'] }), []).map((c) => c.traits.kind),
    );
    expect([...kindsSeen]).toEqual(['drink']);
  });

  it('a kind is admitted when — and only when — it is asked for, each on its own', () => {
    const traitsById = buildFixtureTraitsById();
    for (const kind of KINDS) {
      const seen = new Set(filterCandidates(items, traitsById, makeInputs({ kinds: [kind] }), []).map((c) => c.traits.kind));
      expect([...seen], kind).toEqual([kind]);
    }
    const all = new Set(filterCandidates(items, traitsById, makeInputs({ kinds: [...KINDS] }), []).map((c) => c.traits.kind));
    expect(all).toEqual(new Set(KINDS));
  });
});

// ---------------------------------------------------------------------------
// Unit-level coverage of the individual exports.
// ---------------------------------------------------------------------------

describe('minPriceInr', () => {
  it('is the cheapest variant price', () => {
    const item: MenuItem = buildFixtureMenu()[0];
    item.variants = [
      { id: 'a', menu_item_id: item.id, label: 'S', price_inr: 200, sort_order: 0 },
      { id: 'b', menu_item_id: item.id, label: 'L', price_inr: 150, sort_order: 1 },
    ];
    expect(minPriceInr(item)).toBe(150);
  });

  it('is +Infinity (fails every budget check) when there are no variants', () => {
    const item: MenuItem = { ...buildFixtureMenu()[0], variants: [] };
    expect(minPriceInr(item)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('passesHardConstraints', () => {
  const traitsById = buildFixtureTraitsById();
  const items = buildFixtureMenu();
  const espresso = items.find((i) => i.id === 'espresso')!;

  it('rejects an item with no traits row', () => {
    const noTraits = items.find((i) => i.id === NO_TRAITS_ITEM.id)!;
    expect(passesHardConstraints(noTraits, undefined, makeInputs({}), [])).toBe(false);
  });

  it('rejects an unavailable item even with traits', () => {
    const unavailable = items.find((i) => i.id === UNAVAILABLE_ITEM.id)!;
    expect(passesHardConstraints(unavailable, traitsById.get(unavailable.id), makeInputs({}), [])).toBe(false);
  });

  it('accepts a fully-available item that clears every open chip', () => {
    expect(passesHardConstraints(espresso, traitsById.get('espresso'), makeInputs({}), [])).toBe(true);
  });

  it('respects excludeItemIds', () => {
    expect(passesHardConstraints(espresso, traitsById.get('espresso'), makeInputs({}), ['espresso'])).toBe(false);
  });

  it('kinds is the composition rule: only the kinds asked for pass', () => {
    const cake = items.find((i) => i.id === 'blueberry-cheesecake')!;
    const nachos = items.find((i) => i.id === 'baked-cheese-nachos')!;
    const pass = (item: MenuItem, kinds: TraitKind[]) => passesHardConstraints(item, traitsById.get(item.id), makeInputs({ kinds }), []);
    expect(pass(espresso, ['drink'])).toBe(true);
    expect(pass(espresso, ['dessert', 'food'])).toBe(false);
    expect(pass(cake, ['drink'])).toBe(false);
    expect(pass(cake, ['drink', 'dessert'])).toBe(true);
    expect(pass(cake, ['food'])).toBe(false);
    expect(pass(nachos, ['drink', 'dessert'])).toBe(false);
    expect(pass(nachos, ['food'])).toBe(true);
  });

  describe('the sweetness ceiling (§4.1.5): excluded when the item\'s inherent level > target + 3', () => {
    const withLevel = (level: number): MenuItemTraits => ({ ...traitsById.get('espresso')!, sweetness_level: level });
    const passes = (level: number, sweetness: SweetnessPref) =>
      passesHardConstraints(espresso, withLevel(level), makeInputs({ sweetness }), []);

    it('"any" never excludes on sweetness', () => {
      for (let level = 0; level <= 10; level++) expect(passes(level, 'any'), `${level}`).toBe(true);
    });

    it('the ceilings are none 3, light 6, medium 8, sweet 10, very 13 — the level AT the ceiling passes, one above fails', () => {
      const ceiling: Record<Exclude<SweetnessPref, 'any'>, number> = { none: 3, light: 6, medium: 8, sweet: 10, very: 13 };
      for (const [pref, top] of Object.entries(ceiling)) {
        const p = pref as Exclude<SweetnessPref, 'any'>;
        for (let level = 0; level <= 10; level++) {
          expect(passes(level, p), `${pref} @ level ${level}`).toBe(level <= top);
        }
      }
    });

    it('"sweet" and "very" can never exclude anything — the ceiling is at or above the top of the scale', () => {
      for (let level = 0; level <= 10; level++) {
        expect(passes(level, 'sweet')).toBe(true);
        expect(passes(level, 'very')).toBe(true);
      }
    });

    it('reads a legacy row through 0→0, 1→3, 2→6, 3→9 — which reproduces v1\'s "less sugar" (excludes sweetness 3)', () => {
      const legacy = (sweetness: 0 | 1 | 2 | 3): MenuItemTraits => ({ ...traitsById.get('espresso')!, sweetness, sweetness_level: undefined });
      const lightPasses = (s: 0 | 1 | 2 | 3) => passesHardConstraints(espresso, legacy(s), makeInputs({ sweetness: 'light' }), []);
      expect([0, 1, 2, 3].map((s) => lightPasses(s as 0 | 1 | 2 | 3))).toEqual([true, true, true, false]);
    });

    it('a v2 row\'s 0–10 level outranks its derived legacy column', () => {
      const conflicting: MenuItemTraits = { ...traitsById.get('espresso')!, sweetness: 3, sweetness_level: 2 };
      expect(passesHardConstraints(espresso, conflicting, makeInputs({ sweetness: 'none' }), [])).toBe(true);
      const other: MenuItemTraits = { ...traitsById.get('espresso')!, sweetness: 0, sweetness_level: 9 };
      expect(passesHardConstraints(espresso, other, makeInputs({ sweetness: 'none' }), [])).toBe(false);
    });

    it('optional sugar does not soften the ceiling: sugar can be added, never taken out', () => {
      const brew = items.find((i) => i.id === 'signature-iced-brew')!; // has the live Sugar group
      expect(brew.addon_groups.length).toBeGreaterThan(0);
      const sweet: MenuItemTraits = { ...traitsById.get('signature-iced-brew')!, sweetness_level: 7 };
      expect(passesHardConstraints(brew, sweet, makeInputs({ sweetness: 'none', kinds: ['drink'] }), [])).toBe(false);
    });

    it('a sugar-adjustable coffee at a low level is NOT excluded by "not too sweet" — sweetness is inherent plus optional sugar', () => {
      const brew = items.find((i) => i.id === 'signature-iced-brew')!;
      expect(passesHardConstraints(brew, traitsById.get(brew.id), makeInputs({ sweetness: 'none' }), [])).toBe(true);
    });

    it('applies to desserts and food as much as to drinks', () => {
      const brownie = items.find((i) => i.id === 'fudge-brownie')!;
      const biscotti = items.find((i) => i.id === 'almond-biscotti')!;
      const asked = makeInputs({ kinds: ['dessert'], sweetness: 'none' });
      expect(passesHardConstraints(brownie, traitsById.get(brownie.id), asked, [])).toBe(false); // level 9
      expect(passesHardConstraints(biscotti, traitsById.get(biscotti.id), asked, [])).toBe(true); // level 3
    });
  });

  describe('the budget (§4.1.6): a CEILING on the cheapest size', () => {
    const priced = (...prices: number[]): MenuItem => ({
      ...espresso,
      variants: prices.map((price_inr, i) => ({ id: `v${i}`, menu_item_id: espresso.id, label: `S${i}`, price_inr, sort_order: i })),
    });
    const traits = traitsById.get('espresso')!;
    const passes = (item: MenuItem, budget: Budget) => passesHardConstraints(item, traits, makeInputs({ budget }), []);

    it('under_100 / under_150 / under_200 pass an item at the ceiling and fail one rupee over', () => {
      for (const [budget, cap] of [['under_100', 100], ['under_150', 150], ['under_200', 200]] as const) {
        expect(passes(priced(cap), budget), `${budget} @ ₹${cap}`).toBe(true);
        expect(passes(priced(cap + 1), budget), `${budget} @ ₹${cap + 1}`).toBe(false);
      }
    });

    it('it is a ceiling, not a band: cheap items pass every ceiling above them (v1\'s ₹150–300 hid everything under ₹150)', () => {
      expect(passes(priced(70), 'under_100')).toBe(true);
      expect(passes(priced(70), 'under_150')).toBe(true);
      expect(passes(priced(70), 'under_200')).toBe(true);
      expect(passes(priced(130), 'under_100')).toBe(false);
      expect(passes(priced(130), 'under_200')).toBe(true);
    });

    it('is judged on the CHEAPEST size', () => {
      expect(passes(priced(90, 250), 'under_100')).toBe(true);
      expect(passes(priced(120, 90), 'under_100')).toBe(true);
      expect(passes(priced(140, 250), 'under_100')).toBe(false);
    });

    it('"any" has no ceiling at all', () => {
      expect(passes(priced(5000), 'any')).toBe(true);
    });

    it('an item with no priced size fails every ceiling (it cannot be confirmed affordable) but passes "any"', () => {
      const unpriced: MenuItem = { ...espresso, variants: [] };
      expect(passes(unpriced, 'under_100')).toBe(false);
      expect(passes(unpriced, 'under_150')).toBe(false);
      expect(passes(unpriced, 'under_200')).toBe(false);
      expect(passes(unpriced, 'any')).toBe(true);
    });
  });
});

describe('relaxHintFor', () => {
  it('is null when there are already ≥3 candidates', () => {
    const traitsById = buildFixtureTraitsById();
    expect(relaxHintFor(buildFixtureMenu(), traitsById, makeInputs({}), [])).toBeNull();
  });

  it('names budget when tightening the budget is what starved the results', () => {
    const traitsById = buildFixtureTraitsById();
    // Iced + up to ₹150, drinks only, with the other cheap iced drinks and the
    // cheap hot coffees excluded, pins the baseline at 1 (on-the-rocks, ₹140) and
    // makes the trade-off unambiguous: relaxing the budget re-admits every pricier
    // iced drink, while relaxing temperature (still under the cap) only re-admits the
    // handful of hot drinks priced ≤ ₹150 — so budget must win the "most candidates" comparison.
    const excludeItemIds = [
      'iced-latte',
      'iced-americano',
      'cold-brew',
      'red-velvet-cupcake',
      'doppio',
      'flat-white',
      'cortado',
      'ristretto',
      'hot-americano',
      'macchiato',
    ];
    const inputs = makeInputs({ temperature: 'iced', budget: 'under_150' });
    const before = filterCandidates(buildFixtureMenu(), traitsById, inputs, excludeItemIds);
    expect(before.length).toBeLessThan(3);
    const hint = relaxHintFor(buildFixtureMenu(), traitsById, inputs, excludeItemIds);
    expect(hint).not.toBeNull();
    expect(hint!.constraint).toBe('budget');
    // The message reads as house tone, and speaks in the customer's own ceiling.
    expect(hint!.message).toBe('Nothing iced up to ₹150 right now — shall we look a little wider?');
    expect(hint!.message).not.toMatch(/spend|hurry|budget level/i);
  });

  it('the budget message names each ceiling in its own words', () => {
    const traitsById = buildFixtureTraitsById();
    const items = buildFixtureMenu();
    // Only the budget is restrictive (desserts only, no other chip), and the
    // exclusions starve each ceiling down to two dessert candidates.
    const say = (budget: Budget, excludeItemIds: string[]) =>
      relaxHintFor(items, traitsById, makeInputs({ kinds: ['dessert'], budget }), excludeItemIds);
    expect(say('under_100', [])).toEqual({
      constraint: 'budget',
      message: 'Nothing quite fits up to ₹100 right now — shall we look a little wider?',
    });
    expect(say('under_150', ['fudge-brownie'])?.message).toBe('Nothing quite fits up to ₹150 right now — shall we look a little wider?');
    expect(say('under_200', ['fudge-brownie'])?.message).toBe('Nothing quite fits up to ₹200 right now — shall we look a little wider?');
  });

  it('names sweetness when a low-sugar ask is what starved the results', () => {
    const traitsById = buildFixtureTraitsById();
    // Desserts only, "not sweet" (ceiling 3): only the biscotti (level 3) qualifies.
    const inputs = makeInputs({ kinds: ['dessert'], sweetness: 'none' });
    expect(filterCandidates(buildFixtureMenu(), traitsById, inputs, []).length).toBeLessThan(3);
    const hint = relaxHintFor(buildFixtureMenu(), traitsById, inputs, []);
    expect(hint).toEqual({
      constraint: 'sweetness',
      message: 'Nothing quite that light on sugar fits right now — want to see a little sweeter options?',
    });
  });

  it('relaxing sweetness sets it to "any" and adds the sweeter items back', () => {
    const traitsById = buildFixtureTraitsById();
    const items = buildFixtureMenu();
    const asked = makeInputs({ kinds: ['dessert'], sweetness: 'none' });
    const relaxed = makeInputs({ kinds: ['dessert'], sweetness: 'any' });
    expect(filterCandidates(items, traitsById, relaxed, []).length).toBeGreaterThan(filterCandidates(items, traitsById, asked, []).length);
    expect(relaxHintFor(items, traitsById, relaxed, [])).toBeNull(); // the relaxed ask has plenty
  });

  describe('which constraint it names: the most candidates gained, ties in the order budget, temperature, sweetness, base, needs', () => {
    // Five drinks, each excluded by EXACTLY ONE of the five relaxable choices under
    // the inputs below — so relaxing that choice gains exactly that item.
    const drink = (id: string, over: Partial<MenuItemTraits>, priceInr = 100): { item: MenuItem; traits: MenuItemTraits } => ({
      item: makeMenuItem({ id, name: id, priceInr, category: `cat-${id}`, parent_category: '' }),
      traits: makeTraits({
        menu_item_id: id,
        temperature: 'iced',
        is_coffee: true,
        caffeine: 'none',
        sweetness: 0,
        kind: 'drink',
        ...over,
      }),
    });
    const byBudget = (id: string) => drink(id, {}, 300); // over the ₹150 ceiling
    const bySweetness = (id: string) => drink(id, { sweetness: 3 }); // level 9, over the "not sweet" ceiling
    const byTemperature = (id: string) => drink(id, { temperature: 'hot' });
    const byBase = (id: string) => drink(id, { is_coffee: false });
    const byNeeds = (id: string) => drink(id, { caffeine: 'high' });

    const allFive = makeInputs({ temperature: 'iced', base: 'coffee', needs: ['no_caffeine'], sweetness: 'none', budget: 'under_150' });

    const hintFor = (rows: { item: MenuItem; traits: MenuItemTraits }[]) =>
      relaxHintFor(
        rows.map((r) => r.item),
        new Map(rows.map((r) => [r.item.id, r.traits])),
        allFive,
        [],
      )?.constraint;

    it('premise: each of the five items is excluded by exactly the one choice it is named for', () => {
      const rows = { budget: byBudget('a'), sweetness: bySweetness('b'), temperature: byTemperature('c'), base: byBase('d'), needs: byNeeds('e') };
      for (const [choice, row] of Object.entries(rows)) {
        expect(spec4_1Violation(row.item, row.traits, allFive, []), choice).toMatch(
          { budget: /₹/, sweetness: /sweetness/, temperature: /Iced chip/, base: /Coffee returned/, needs: /caffeinated/ }[choice as keyof typeof rows],
        );
      }
    });

    it('a tie goes to the earlier one: budget, then temperature, then sweetness, then base, then needs', () => {
      const a = byBudget('a');
      const b = bySweetness('b');
      const c = byTemperature('c');
      const d = byBase('d');
      const e = byNeeds('e');
      expect(hintFor([a, b, c, d, e])).toBe('budget');
      expect(hintFor([b, c, d, e])).toBe('temperature');
      expect(hintFor([b, d, e])).toBe('sweetness');
      expect(hintFor([d, e])).toBe('base');
      expect(hintFor([e])).toBe('needs');
    });

    it('but the most candidates gained beats the order: a later choice that frees more wins', () => {
      // sweetness would free 1; base would free 2.
      expect(hintFor([bySweetness('b'), byBase('d1'), byBase('d2')])).toBe('base');
      // budget would free 1; needs would free 3.
      expect(hintFor([byBudget('a'), byNeeds('e1'), byNeeds('e2'), byNeeds('e3')])).toBe('needs');
      // …and an earlier one that frees more wins, of course.
      expect(hintFor([byTemperature('c1'), byTemperature('c2'), bySweetness('b'), byBase('d')])).toBe('temperature');
    });

    it('sweetness sits between temperature and base', () => {
      expect(hintFor([bySweetness('b'), byBase('d')])).toBe('sweetness');
      expect(hintFor([byTemperature('c'), bySweetness('b')])).toBe('temperature');
    });
  });

  it('never offers "kinds" — silently adding food is the v1 bug', () => {
    const traitsById = buildFixtureTraitsById();
    const items = buildFixtureMenu();
    for (const kinds of KIND_SUBSETS) {
      for (const sweetness of SWEETNESSES) {
        const hint = relaxHintFor(items, traitsById, makeInputs({ kinds, sweetness, temperature: 'hot', base: 'no_coffee', budget: 'under_100', needs: ['no_caffeine'] }), []);
        if (hint) expect(['budget', 'temperature', 'sweetness', 'base', 'needs']).toContain(hint.constraint);
      }
    }
    // …and neither the old name for it.
    const hint = relaxHintFor(items, traitsById, makeInputs({ temperature: 'hot', base: 'no_coffee', budget: 'under_100', needs: ['no_caffeine'] }), []);
    if (hint) expect(hint.constraint).not.toBe('extras' as never);
  });

  it('does not blame a sweetness that cannot be excluding anything ("sweet" and "very" never hide an item)', () => {
    const traitsById = buildFixtureTraitsById();
    const items = buildFixtureMenu();
    // Short of candidates only because of the temperature + base + caffeine asks.
    for (const sweetness of ['sweet', 'very'] as const) {
      const inputs = makeInputs({ temperature: 'hot', base: 'no_coffee', needs: ['no_caffeine'], budget: 'under_100', sweetness });
      const hint = relaxHintFor(items, traitsById, inputs, []);
      if (hint) expect(hint.constraint, sweetness).not.toBe('sweetness');
    }
  });

  it('is null when nothing is restrictive — the shortage is the menu\'s, not the customer\'s', () => {
    const traitsById = buildFixtureTraitsById();
    const everyItemExcluded = buildFixtureMenu().map((i) => i.id);
    expect(relaxHintFor(buildFixtureMenu(), traitsById, makeInputs({}), everyItemExcluded)).toBeNull();
  });
});
