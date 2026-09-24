import { describe, expect, it } from 'vitest';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { filterCandidates, minPriceInr, passesHardConstraints, relaxHintFor } from '@/lib/suggest/filter';
import { scoreCandidates, buildShortlist } from '@/lib/suggest/score';
import { deterministicPicks } from '@/lib/suggest/templates';
import { validateDeciderPicks } from '@/lib/suggest/validate';
import type { MenuItem } from '@/lib/types';
import type {
  Extra,
  MenuItemTraits,
  Mood,
  SuggestInputs,
  TemperaturePref,
  BasePref,
  Budget,
  Need,
} from '@/lib/suggest/types';
import { MOODS } from '@/lib/suggest/types';
import {
  buildFixtureMenu,
  buildFixtureTraitsById,
  NO_TRAITS_ITEM,
  SNOOZED_ITEM,
  UNAVAILABLE_ITEM,
} from './fixtures/suggestMenu';

// ---------------------------------------------------------------------------
// §6.1: "a property-style unit test runs the filter plus the full pipeline
// ... across every combination of chips × a fixture menu, and asserts no
// violating item is ever returned." This is that test. `spec5_2Violation`
// is an INDEPENDENT re-statement of §5.2's rules (not a call into the code
// under test) so a bug in filter.ts can't also hide from its own check.
//
// Two invariants added alongside the original six (root causes #1 of the
// Phase-7 "help me choose" quality pass):
//  (a) temperature only ever gates DRINKS — a hot/iced food or dessert item
//      is never excluded just because the customer's temperature chip
//      doesn't match it.
//  (b) composition — food is a candidate only when 'eat' or 'filling' was
//      chosen; dessert only when 'eat'/'sweet'/'filling' was chosen or the
//      mood is 'celebrate'. Neither 'chocolatey' nor 'fruity' admits either.
// ---------------------------------------------------------------------------

function compositionAllows(t: MenuItemTraits, inputs: SuggestInputs): boolean {
  if (t.kind === 'food') return inputs.extras.includes('eat') || inputs.extras.includes('filling');
  if (t.kind === 'dessert') {
    return (
      inputs.extras.includes('eat') ||
      inputs.extras.includes('sweet') ||
      inputs.extras.includes('filling') ||
      inputs.mood === 'celebrate'
    );
  }
  return true; // drinks are never gated by composition.
}

function spec5_2Violation(
  item: MenuItem,
  t: MenuItemTraits | undefined,
  inputs: SuggestInputs,
  excludeIds: string[],
): string | null {
  if (!t) return 'no traits row (§5.2.1)';
  if (!isMenuItemAvailable(item)) return 'unavailable (§5.2.1)';
  if (excludeIds.includes(item.id)) return 'in excludeItemIds (§5.2.6)';
  if (!compositionAllows(t, inputs)) return 'food/dessert admitted without the customer asking to eat (§5.2.2b)';
  // (a) drinks-only temperature.
  if (t.kind === 'drink' && inputs.temperature === 'hot' && t.temperature === 'iced') {
    return 'Hot chip returned an iced drink (§5.2.2)';
  }
  if (t.kind === 'drink' && inputs.temperature === 'iced' && t.temperature === 'hot') {
    return 'Iced chip returned a hot drink (§5.2.2)';
  }
  if (inputs.base === 'no_coffee' && t.is_coffee) return 'No-coffee chip returned a coffee item (§5.2.3)';
  if (inputs.base === 'coffee' && t.kind === 'drink' && !t.is_coffee) {
    return 'Coffee chip returned a non-coffee drink (§5.2.3)';
  }
  if (inputs.needs.includes('no_caffeine') && t.caffeine !== 'none') {
    return 'No-caffeine need returned a caffeinated item (§5.2.3)';
  }
  if (inputs.needs.includes('less_sugar') && t.sweetness === 3) {
    return 'Less-sugar need returned a sweetness-3 item (§5.2.5)';
  }
  const price = minPriceInr(item);
  if (inputs.budget === 'under_150' && price > 150) return 'Over ₹150 under the under_150 budget (§5.2.4)';
  if (inputs.budget === '150_300' && (price < 150 || price > 300)) {
    return 'Outside ₹150–300 under the 150_300 budget (§5.2.4)';
  }
  return null;
}

const TEMPERATURES: TemperaturePref[] = ['hot', 'iced', 'either'];
const BASES: BasePref[] = ['coffee', 'no_coffee', 'either'];
const NEEDS_SUBSETS: Need[][] = [[], ['no_caffeine'], ['less_sugar'], ['no_caffeine', 'less_sugar']];
const BUDGETS_TO_TEST: Budget[] = ['under_150', '150_300', 'treat', 'any'];

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

describe('§6.1 exhaustive hard-constraint suite', () => {
  const items = buildFixtureMenu();
  const excludeListsToTest: string[][] = [
    [],
    ['cappuccino'],
    ['espresso', 'cold-brew', 'blueberry-cheesecake'],
  ];

  for (const temperature of TEMPERATURES) {
    for (const base of BASES) {
      for (const needs of NEEDS_SUBSETS) {
        for (const budget of BUDGETS_TO_TEST) {
          for (const excludeItemIds of excludeListsToTest) {
            const inputs = makeInputs({ temperature, base, needs, budget });
            const label = `T=${temperature} B=${base} N=${needs.join('+') || 'none'} $=${budget} X=${excludeItemIds.length}`;

            it(`filterCandidates never violates §5.2 [${label}]`, () => {
              const traitsById = buildFixtureTraitsById();
              const candidates = filterCandidates(items, traitsById, inputs, excludeItemIds);
              for (const c of candidates) {
                const violation = spec5_2Violation(c.item, traitsById.get(c.item.id), inputs, excludeItemIds);
                expect(violation, `${c.item.id}: ${violation}`).toBeNull();
              }
              // Every candidate has a traits row (F1/§5.1).
              for (const c of candidates) {
                expect(c.traits).toBeDefined();
              }
            });

            it(`the full pipeline (filter → score → shortlist → deterministic picks → validate) never violates §5.2 [${label}]`, () => {
              const traitsById = buildFixtureTraitsById();
              const filtered = filterCandidates(items, traitsById, inputs, excludeItemIds);
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
                const item = items.find((i) => i.id === c.menuItemId)!;
                const violation = spec5_2Violation(item, traitsById.get(item.id), inputs, excludeItemIds);
                expect(violation, `shortlist ${c.menuItemId}: ${violation}`).toBeNull();
              }

              const picks = deterministicPicks(shortlist, inputs);
              for (const pick of picks) {
                expect(shortlistIds.has(pick.menuItemId), `deterministic pick ${pick.menuItemId} not in shortlist`).toBe(
                  true,
                );
              }

              // Adversarial decider output (§6.1: "the LLM mocked to return
              // adversarial ids: off-shortlist, unavailable, over budget"),
              // plus duplicates and a banned-phrase reason, exercised on
              // every single combination.
              const adversarialPicks = [
                { menuItemId: 'not-on-any-shortlist', reason: 'A lovely pick for you.', reasonCode: 'trait' as const },
                { menuItemId: UNAVAILABLE_ITEM.id, reason: 'A lovely pick for you.', reasonCode: 'trait' as const },
                { menuItemId: NO_TRAITS_ITEM.id, reason: 'A lovely pick for you.', reasonCode: 'trait' as const },
                { menuItemId: SNOOZED_ITEM.id, reason: 'A lovely pick for you.', reasonCode: 'trait' as const },
                // An over-budget item for whichever budget chip is active:
                // 'biscoff-cheesecake' (₹260) is over under_150 and not in
                // 150_300 either way it's a real menu item, never in a
                // budget-restricted shortlist, so it's a valid off-shortlist probe.
                { menuItemId: 'biscoff-cheesecake', reason: 'A lovely pick for you.', reasonCode: 'trait' as const },
                ...(shortlist[0]
                  ? [
                      // Duplicate of a real shortlist id.
                      { menuItemId: shortlist[0].menuItemId, reason: 'A lovely pick for you.', reasonCode: 'trait' as const },
                      { menuItemId: shortlist[0].menuItemId, reason: 'A lovely pick for you.', reasonCode: 'trait' as const },
                      // A real shortlist id with a banned-phrase reason.
                      {
                        menuItemId: shortlist[0].menuItemId,
                        reason: 'Since you spend a lot, hurry and grab this best deal.',
                        reasonCode: 'trait' as const,
                      },
                    ]
                  : []),
              ];

              const validated = validateDeciderPicks(adversarialPicks, shortlist, inputs);

              // ids ⊆ shortlist, always.
              for (const v of validated) {
                expect(shortlistIds.has(v.menuItemId), `validated pick ${v.menuItemId} not in shortlist`).toBe(true);
              }
              // No duplicates.
              expect(new Set(validated.map((v) => v.menuItemId)).size).toBe(validated.length);
              // Every reason lints clean (a banned-phrase reason must have
              // been replaced with a template).
              for (const v of validated) {
                expect(v.reason).not.toMatch(/spend|hurry|best deal/i);
              }
              // Every validated item still passes today's hard constraints.
              for (const v of validated) {
                const item = items.find((i) => i.id === v.menuItemId)!;
                const violation = spec5_2Violation(item, traitsById.get(item.id), inputs, excludeItemIds);
                expect(violation, `validated ${v.menuItemId}: ${violation}`).toBeNull();
              }
            });
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Dedicated composition-rule matrix: extras subsets × every mood × every
// temperature chip (§6.1's own wording for this ticket: "add both as
// asserted invariants across every combination — extras subsets and moods
// included"). Kept as its own smaller matrix (not folded into the ×432-combo
// suite above, which already re-checks these same two invariants on every
// one of its combinations at extras=[]/mood='boost') so varying extras and
// mood doesn't multiply the whole existing suite out to an unworkable size.
// ---------------------------------------------------------------------------

const EXTRAS_SUBSETS_FOR_COMPOSITION: Extra[][] = [
  [],
  ['eat'],
  ['sweet'],
  ['filling'],
  ['light'],
  ['chocolatey'],
  ['fruity'],
  ['eat', 'chocolatey'],
  ['sweet', 'fruity'],
];

describe('§5.2 composition rule (food/dessert) × drinks-only temperature — extras × mood × temperature', () => {
  const items = buildFixtureMenu();

  for (const mood of MOODS as readonly Mood[]) {
    for (const extras of EXTRAS_SUBSETS_FOR_COMPOSITION) {
      for (const temperature of TEMPERATURES) {
        const inputs = makeInputs({ mood, extras, temperature });
        const label = `mood=${mood} extras=${extras.join('+') || 'none'} T=${temperature}`;

        it(`filterCandidates never violates the composition/temperature invariants [${label}]`, () => {
          const traitsById = buildFixtureTraitsById();
          const candidates = filterCandidates(items, traitsById, inputs, []);
          for (const c of candidates) {
            const violation = spec5_2Violation(c.item, traitsById.get(c.item.id), inputs, []);
            expect(violation, `${c.item.id}: ${violation}`).toBeNull();
          }
        });

        it(`(a) a hot/iced food or dessert composition allows is never excluded by the temperature chip [${label}]`, () => {
          const traitsById = buildFixtureTraitsById();
          const candidates = filterCandidates(items, traitsById, inputs, []);
          const candidateIds = new Set(candidates.map((c) => c.item.id));
          for (const item of items) {
            const t = traitsById.get(item.id);
            if (!t || (t.kind !== 'food' && t.kind !== 'dessert')) continue;
            if (t.temperature !== 'hot' && t.temperature !== 'iced') continue; // ambient — nothing to prove here
            if (!isMenuItemAvailable(item)) continue;
            if (!compositionAllows(t, inputs)) continue; // correctly excluded by composition, not temperature
            expect(
              candidateIds.has(item.id),
              `${item.id} (kind=${t.kind}, temp=${t.temperature}) wrongly excluded by the ${temperature} chip`,
            ).toBe(true);
          }
        });

        it(`(b) no food/dessert candidate unless the composition rule allows it [${label}]`, () => {
          const traitsById = buildFixtureTraitsById();
          const candidates = filterCandidates(items, traitsById, inputs, []);
          for (const c of candidates) {
            if (c.traits.kind !== 'food' && c.traits.kind !== 'dessert') continue;
            expect(
              compositionAllows(c.traits, inputs),
              `${c.item.id} (kind=${c.traits.kind}) admitted without eat/sweet/filling/celebrate`,
            ).toBe(true);
          }
        });
      }
    }
  }
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
    expect(
      passesHardConstraints(unavailable, traitsById.get(unavailable.id), makeInputs({}), []),
    ).toBe(false);
  });

  it('accepts a fully-available item that clears every open chip', () => {
    expect(passesHardConstraints(espresso, traitsById.get('espresso'), makeInputs({}), [])).toBe(true);
  });

  it('respects excludeItemIds', () => {
    expect(passesHardConstraints(espresso, traitsById.get('espresso'), makeInputs({}), ['espresso'])).toBe(false);
  });
});

describe('relaxHintFor', () => {
  it('is null when there are already ≥3 candidates', () => {
    const traitsById = buildFixtureTraitsById();
    const hint = relaxHintFor(buildFixtureMenu(), traitsById, makeInputs({}), []);
    expect(hint).toBeNull();
  });

  it('names budget when tightening the budget is what starved the results', () => {
    const traitsById = buildFixtureTraitsById();
    // Iced + under_150, with no extras chosen, leaves only on-the-rocks
    // (₹140) — every other iced drink is either over ₹150 or excluded below,
    // and the composition rule (§5.2) keeps every food/dessert out entirely
    // since no extras/celebrate mood admit them. Excluding the other cheap
    // iced drinks AND the cheap hot coffees pins the baseline at 1 and makes
    // the trade-off unambiguous: relaxing budget re-admits 6 pricier iced
    // drinks, while relaxing temperature alone (still under the ₹150 cap,
    // with the cheap hot coffees excluded) only re-admits the 4 remaining
    // hot drinks priced ≤ ₹150 (espresso, cappuccino, cafe-latte,
    // chai-latte) — so budget must win the "most candidates" comparison.
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
    // The message must itself read as house tone, not just be non-empty.
    expect(hint!.message.length).toBeGreaterThan(0);
    expect(hint!.message).not.toMatch(/spend|hurry|budget level/i);
  });

  it('never names "extras" — extras are a soft/scoring chip, not a hard constraint (§5.2/§5.3)', () => {
    const traitsById = buildFixtureTraitsById();
    const inputs = makeInputs({ temperature: 'hot', base: 'no_coffee', budget: 'under_150', needs: ['no_caffeine'] });
    const hint = relaxHintFor(buildFixtureMenu(), traitsById, inputs, []);
    if (hint) expect(hint.constraint).not.toBe('extras' as never);
  });
});
