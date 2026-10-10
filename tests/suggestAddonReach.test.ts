import { describe, expect, it } from 'vitest';
import { flavourAddonFor, reachableAddonFamilies } from '@/lib/suggest/addonTraits';
import { describeCandidate } from '@/lib/suggest/brief';
import { runSuggest } from '@/lib/suggest/engine';
import { filterCandidates } from '@/lib/suggest/filter';
import { withInputDefaults } from '@/lib/suggest/inputs';
import { preferenceFits, scoreCandidates } from '@/lib/suggest/score';
import { matchTagsFor, templateReason } from '@/lib/suggest/templates';
import { lintReason } from '@/lib/suggest/tone';
import { ADDON_SUGGEST_LIMITS, SUGGEST_LIMITS } from '@/lib/suggest/types';
import type {
  AddonTraits,
  Decider,
  FlavourAddonSuggestion,
  FlavourFamily,
  MenuItemTraits,
  SuggestInputs,
  TasteProfile,
} from '@/lib/suggest/types';
import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';
import { buildSugarGroup, makeMenuItem, makeTraits, makeTraitsV2 } from './fixtures/suggestMenu';

// COFFEY-ADDONS-PAIRINGS-SPEC §2.4, §3 and §6 — reaching a requested flavour
// through an add-on. The running example is the live menu's: a Cappucino with
// the "Add a Syrup" group (Salted Caramel / Vanilla / Hazelnut / Caramel, ₹35),
// asked for something nutty, which carries a "Hazelnut syrup" tip. The add-on is
// a tip, not a ranking boost: ADDON_SUGGEST_LIMITS.flavourFit is 0 (measured on
// the live menu, see its comment in lib/suggest/types.ts).

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type OptionSpec = Omit<AddonOption, 'addon_group_id'>;

function opt(id: string, name: string, priceInr: number, sortOrder = 0, over: Partial<AddonOption> = {}): OptionSpec {
  return { id, name, price_inr: priceInr, sort_order: sortOrder, ...over };
}

function group(id: string, name: string, displayName: string, options: OptionSpec[], over: Partial<AddonGroup> = {}): AddonGroup {
  return {
    id,
    name,
    display_name: displayName,
    selection_type: 'multi',
    min_select: 0,
    max_select: options.length,
    sort_order: 0,
    options: options.map((o) => ({ ...o, addon_group_id: id })),
    ...over,
  };
}

/** The live "Add a Syrup" group, in menu order (2026-10 snapshot). */
function syrupGroup(priceInr = 35, over: Partial<AddonGroup> = {}): AddonGroup {
  return group(
    'syrup-group',
    'Add On Syrup',
    'Add a Syrup',
    [
      opt('syrup-salted-caramel', 'Salted Caramel (newly Launched)', priceInr, 0),
      opt('syrup-vanilla', 'Vanilla', priceInr, 1),
      opt('syrup-hazelnut', 'Hazelnut', priceInr, 2),
      opt('syrup-caramel', 'Caramel', priceInr, 3),
    ],
    over,
  );
}

/** The live "Base- Add On" topping group: Hazelnut ₹25 is a topping (1 sweeter), not a syrup (2). */
function toppingGroup(over: Partial<AddonGroup> = {}): AddonGroup {
  return group(
    'topping-group',
    'Base- Add On',
    'Add Toppings',
    [opt('topping-red-velvet', 'Red Velvet', 10, 0), opt('topping-hazelnut', 'Hazelnut', 25, 1), opt('topping-almond', 'Almond', 15, 2)],
    over,
  );
}

function cappucino(groups: AddonGroup[] = [syrupGroup()]): MenuItem {
  return makeMenuItem({ id: 'cappucino', name: 'Cappucino', priceInr: 130, addon_groups: groups });
}

/** A hot milky coffee, v2-tagged, inherent sweetness 1 unless `sweetness_level` says otherwise. */
function latteTraits(menuItemId: string, over: Partial<MenuItemTraits> = {}): MenuItemTraits {
  return makeTraitsV2({
    intensity: 1,
    textures: ['silky'],
    flavor_notes: ['creamy'],
    moods: ['cosy', 'focus'],
    ...over,
    menu_item_id: menuItemId,
    sweetness_level: over.sweetness_level ?? 1,
  });
}

const CAPPUCINO_TRAITS = latteTraits('cappucino');

/** The customer asked for these flavours; everything else is neutral. */
function ask(flavours: FlavourFamily[], over: Partial<SuggestInputs> = {}): SuggestInputs {
  return withInputDefaults({ mood: 'cosy', flavours, ...over });
}

/** A hand-made override. */
function traits(over: Partial<AddonTraits> = {}): AddonTraits {
  return {
    role: 'flavour',
    flavour_families: [],
    sweetness_delta: 2,
    intensity_delta: 0,
    indulgence_delta: 0,
    textures: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// reachableAddonFamilies / flavourAddonFor (§2.4)
// ---------------------------------------------------------------------------

describe('reachableAddonFamilies', () => {
  it('a Cappucino with the syrup group reaches nutty, caramel and nothing else', () => {
    const item = cappucino();
    expect(reachableAddonFamilies(item, CAPPUCINO_TRAITS, ask(['nutty']))).toEqual(['nutty']);
    expect(reachableAddonFamilies(item, CAPPUCINO_TRAITS, ask(['caramel']))).toEqual(['caramel']);
    // Vanilla is not a family, so the syrup group cannot make this chocolatey, fruity, …
    expect(reachableAddonFamilies(item, CAPPUCINO_TRAITS, ask(['chocolatey', 'fruity', 'spiced', 'floral', 'biscuit']))).toEqual([]);
  });

  it('is in the order the customer asked, and lists only what they asked for', () => {
    const item = cappucino();
    expect(reachableAddonFamilies(item, CAPPUCINO_TRAITS, ask(['caramel', 'nutty']))).toEqual(['caramel', 'nutty']);
    expect(reachableAddonFamilies(item, CAPPUCINO_TRAITS, ask(['nutty', 'fruity', 'caramel']))).toEqual(['nutty', 'caramel']);
  });

  it('is [] when no flavours are asked for, however many add-ons the item has', () => {
    expect(reachableAddonFamilies(cappucino(), CAPPUCINO_TRAITS, ask([]))).toEqual([]);
    expect(flavourAddonFor(cappucino(), CAPPUCINO_TRAITS, ask([]))).toBeNull();
  });

  it('never lists a family the item already has natively (by name or by flavour note)', () => {
    const byName = makeMenuItem({ id: 'hl', name: 'Hazelnut Latte', priceInr: 150, addon_groups: [syrupGroup()] });
    expect(reachableAddonFamilies(byName, latteTraits('hl'), ask(['nutty']))).toEqual([]);
    expect(flavourAddonFor(byName, latteTraits('hl'), ask(['nutty']))).toBeNull();

    const byNote = latteTraits('cappucino', { flavor_notes: ['hazelnut', 'creamy'] });
    expect(reachableAddonFamilies(cappucino(), byNote, ask(['nutty']))).toEqual([]);
    expect(flavourAddonFor(cappucino(), byNote, ask(['nutty']))).toBeNull();
  });

  it('with one family native and another not, lists only the one it lacks', () => {
    const caramelNative = latteTraits('cappucino', { flavor_notes: ['caramel'] });
    expect(reachableAddonFamilies(cappucino(), caramelNative, ask(['caramel', 'nutty']))).toEqual(['nutty']);
  });

  it('is [] for an item with no add-on groups, or none at all', () => {
    expect(reachableAddonFamilies(cappucino([]), CAPPUCINO_TRAITS, ask(['nutty']))).toEqual([]);
    const noGroups = { ...cappucino(), addon_groups: undefined as unknown as AddonGroup[] };
    expect(reachableAddonFamilies(noGroups, CAPPUCINO_TRAITS, ask(['nutty']))).toEqual([]);
    expect(flavourAddonFor(noGroups, CAPPUCINO_TRAITS, ask(['nutty']))).toBeNull();
  });

  it('counts a required group as well as an optional one', () => {
    const required = syrupGroup(35, { min_select: 1, max_select: 1, selection_type: 'single' });
    expect(reachableAddonFamilies(cappucino([required]), CAPPUCINO_TRAITS, ask(['nutty']))).toEqual(['nutty']);
  });

  it('reaches through a topping (Nutella, Hazelnut) and a serve upgrade (Sparkling Water(peach)) too', () => {
    expect(reachableAddonFamilies(cappucino([toppingGroup()]), CAPPUCINO_TRAITS, ask(['nutty']))).toEqual(['nutty']);
    expect(reachableAddonFamilies(cappucino([toppingGroup()]), CAPPUCINO_TRAITS, ask(['chocolatey']))).toEqual(['chocolatey']); // Red Velvet
    const brews = group('brews', 'Specialized Brews', 'Upgrade to Specialized Brew', [opt('peach', 'Sparkling Water(peach)', 30)]);
    expect(reachableAddonFamilies(cappucino([brews]), CAPPUCINO_TRAITS, ask(['fruity']))).toEqual(['fruity']);
  });

  it('does not reach through a milk, sugar, ice, side or shot, whatever the option is called', () => {
    const milk = group('milk', 'ADD On Milk', 'Choose Milk', [opt('m', 'Hazelnut Milk', 40)]);
    const sugar = group('sugar', 'Sugar', 'Choice of Sugar', [opt('s', 'Caramel Sugar', 0)]);
    const ice = group('ice', 'Ice', 'Ice Level', [opt('i', 'Chocolate Ice', 0)]);
    const side = group('side', 'Add A Slider', 'Add a Side', [opt('c', 'Nutella Almond Croissant (large)', 55)]); // chocolatey + nutty, ₹55
    const shot = group('shot', 'Add On Condiments', 'Add Condiments', [opt('e', 'Hazelnut Espresso Shot', 40)]);
    for (const g of [milk, sugar, ice, side, shot]) {
      expect(reachableAddonFamilies(cappucino([g]), CAPPUCINO_TRAITS, ask(['nutty', 'chocolatey'])), g.name).toEqual([]);
      expect(flavourAddonFor(cappucino([g]), CAPPUCINO_TRAITS, ask(['nutty', 'chocolatey'])), g.name).toBeNull();
    }
  });

  describe('options that are never pointed to', () => {
    it('an option that is switched off (is_available === false)', () => {
      const off = syrupGroup(35);
      off.options = off.options.map((o) => (o.name === 'Hazelnut' ? { ...o, is_available: false } : o));
      expect(reachableAddonFamilies(cappucino([off]), CAPPUCINO_TRAITS, ask(['nutty']))).toEqual([]);
      expect(flavourAddonFor(cappucino([off]), CAPPUCINO_TRAITS, ask(['nutty']))).toBeNull();
      // …but the others still work, and an explicit true is on.
      expect(flavourAddonFor(cappucino([off]), CAPPUCINO_TRAITS, ask(['caramel']))?.optionId).toBe('syrup-salted-caramel');
      const on = syrupGroup(35);
      on.options = on.options.map((o) => ({ ...o, is_available: true }));
      expect(flavourAddonFor(cappucino([on]), CAPPUCINO_TRAITS, ask(['nutty']))?.optionId).toBe('syrup-hazelnut');
    });

    it(`one dearer than ₹${ADDON_SUGGEST_LIMITS.maxPriceInr} (₹${ADDON_SUGGEST_LIMITS.maxPriceInr} itself is fine)`, () => {
      const max = ADDON_SUGGEST_LIMITS.maxPriceInr;
      expect(flavourAddonFor(cappucino([syrupGroup(max + 1)]), CAPPUCINO_TRAITS, ask(['nutty']))).toBeNull();
      expect(reachableAddonFamilies(cappucino([syrupGroup(max + 1)]), CAPPUCINO_TRAITS, ask(['nutty']))).toEqual([]);
      expect(flavourAddonFor(cappucino([syrupGroup(max)]), CAPPUCINO_TRAITS, ask(['nutty']))?.priceInr).toBe(max);
      expect(flavourAddonFor(cappucino([syrupGroup(0)]), CAPPUCINO_TRAITS, ask(['nutty']))?.priceInr).toBe(0);
    });

    it('an option with no flavour family (Vanilla for a nutty customer)', () => {
      const vanillaOnly = group('g', 'Add On Syrup', 'Add a Syrup', [opt('v', 'Vanilla', 35)]);
      expect(flavourAddonFor(cappucino([vanillaOnly]), CAPPUCINO_TRAITS, ask(['nutty', 'caramel']))).toBeNull();
    });

    it('an over-limit option is skipped in favour of one within the limit', () => {
      const mixed = group('g', 'Add On Syrup', 'Add a Syrup', [opt('dear', 'Hazelnut', 80, 0), opt('fair', 'Toasted Hazelnut', 45, 1)]);
      expect(flavourAddonFor(cappucino([mixed]), CAPPUCINO_TRAITS, ask(['nutty']))?.optionId).toBe('fair');
    });
  });

  describe('the sweetness guard (§2.4)', () => {
    const syrups = () => cappucino([syrupGroup()]); // a syrup lifts sweetness by 2
    const at = (level: number) => latteTraits('cappucino', { sweetness_level: level });

    it('"Not sweet" (target 0, ceiling 3): Hazelnut syrup counts only when baseLevel + 2 ≤ 3', () => {
      const none = ask(['nutty'], { sweetness: 'none' });
      expect(reachableAddonFamilies(syrups(), at(0), none)).toEqual(['nutty']);
      expect(reachableAddonFamilies(syrups(), at(1), none)).toEqual(['nutty']); // 1 + 2 = 3
      expect(reachableAddonFamilies(syrups(), at(2), none)).toEqual([]); // 2 + 2 = 4
      expect(flavourAddonFor(syrups(), at(2), none)).toBeNull();
      expect(flavourAddonFor(syrups(), at(1), none)?.label).toBe('Hazelnut syrup');
    });

    it('the ceiling moves with the choice: Lightly sweet 3 → 6, Medium 5 → 8, Sweet 7 → 10', () => {
      expect(reachableAddonFamilies(syrups(), at(4), ask(['nutty'], { sweetness: 'light' }))).toEqual(['nutty']); // 6
      expect(reachableAddonFamilies(syrups(), at(5), ask(['nutty'], { sweetness: 'light' }))).toEqual([]); // 7
      expect(reachableAddonFamilies(syrups(), at(6), ask(['nutty'], { sweetness: 'medium' }))).toEqual(['nutty']); // 8
      expect(reachableAddonFamilies(syrups(), at(7), ask(['nutty'], { sweetness: 'medium' }))).toEqual([]); // 9
      expect(reachableAddonFamilies(syrups(), at(8), ask(['nutty'], { sweetness: 'sweet' }))).toEqual(['nutty']); // 10
    });

    it('"Any" has no guard at all', () => {
      expect(reachableAddonFamilies(syrups(), at(9), ask(['nutty'], { sweetness: 'any' }))).toEqual(['nutty']);
    });

    it('reads the legacy 0–3 column for a row tagged before v2 (1 → level 3)', () => {
      const legacy = makeTraits({ menu_item_id: 'cappucino', sweetness: 1, flavor_notes: ['creamy'] });
      expect(reachableAddonFamilies(syrups(), legacy, ask(['nutty'], { sweetness: 'none' }))).toEqual([]); // 3 + 2
      expect(reachableAddonFamilies(syrups(), legacy, ask(['nutty'], { sweetness: 'light' }))).toEqual(['nutty']); // 3 + 2 ≤ 6
    });

    it('falls through to an option that fits: the topping (+1) when the syrup (+2) would blow the ceiling', () => {
      const item = cappucino([syrupGroup(), toppingGroup()]);
      const none = ask(['nutty'], { sweetness: 'none' });
      expect(flavourAddonFor(item, at(1), none)?.optionId).toBe('syrup-hazelnut'); // both fit; the syrup is the flavour role
      const tight = flavourAddonFor(item, at(2), none); // 2 + 2 = 4 > 3 but 2 + 1 = 3
      // Hazelnut ₹25 and Almond ₹15 are both nutty toppings (+1); the cheaper one is named.
      expect(tight).toEqual({ groupId: 'topping-group', optionId: 'topping-almond', label: 'Almond', priceInr: 15, family: 'nutty' });
      expect(flavourAddonFor(item, at(3), none)).toBeNull(); // 3 + 1 = 4
    });

    it('the guard applies to the other requested families independently', () => {
      const item = cappucino([syrupGroup(), toppingGroup()]);
      // At level 2, "not sweet": nutty survives via the topping, caramel (syrup only) does not.
      expect(reachableAddonFamilies(item, at(2), ask(['caramel', 'nutty'], { sweetness: 'none' }))).toEqual(['nutty']);
    });
  });

  describe('owner overrides (§2.3)', () => {
    const hazelnut = 'syrup-hazelnut';

    it('an override that takes the role out of reach removes the option', () => {
      const overrides = new Map([[hazelnut, traits({ role: 'other', flavour_families: ['nutty'] })]]);
      expect(reachableAddonFamilies(cappucino(), CAPPUCINO_TRAITS, ask(['nutty']), overrides)).toEqual([]);
      for (const role of ['milk', 'sweetener', 'ice', 'shot', 'side'] as const) {
        const o = new Map([[hazelnut, traits({ role, flavour_families: ['nutty'] })]]);
        expect(flavourAddonFor(cappucino(), CAPPUCINO_TRAITS, ask(['nutty']), o), role).toBeNull();
      }
    });

    it('an override can give an option a family it was not derived with', () => {
      const overrides = new Map([['syrup-vanilla', traits({ flavour_families: ['nutty'] })]]);
      // Vanilla and Hazelnut now both give nutty at the same sweetness and price; the lower sort_order (Vanilla, 1 < 2) wins.
      expect(flavourAddonFor(cappucino(), CAPPUCINO_TRAITS, ask(['nutty']), overrides)?.optionId).toBe('syrup-vanilla');
      expect(flavourAddonFor(cappucino(), CAPPUCINO_TRAITS, ask(['nutty']), overrides)?.label).toBe('Vanilla syrup');
    });

    it('an override can take a family away', () => {
      const overrides = new Map([[hazelnut, traits({ flavour_families: [] })]]);
      expect(reachableAddonFamilies(cappucino(), CAPPUCINO_TRAITS, ask(['nutty']), overrides)).toEqual([]);
    });

    it('an override can bring a milk option into reach by re-roling it', () => {
      const milk = group('milk', 'ADD On Milk', 'Choose Milk', [opt('hazel-milk', 'Hazelnut Milk', 40)]);
      expect(reachableAddonFamilies(cappucino([milk]), CAPPUCINO_TRAITS, ask(['nutty']))).toEqual([]);
      const overrides = new Map([['hazel-milk', traits({ role: 'flavour', flavour_families: ['nutty'], sweetness_delta: 1 })]]);
      expect(flavourAddonFor(cappucino([milk]), CAPPUCINO_TRAITS, ask(['nutty']), overrides)).toMatchObject({
        optionId: 'hazel-milk',
        label: 'Hazelnut Milk',
        family: 'nutty',
      });
    });

    it('an override sweetness_delta feeds both the guard and the ordering', () => {
      const heavy = new Map([[hazelnut, traits({ flavour_families: ['nutty'], sweetness_delta: 5 })]]);
      expect(reachableAddonFamilies(cappucino(), CAPPUCINO_TRAITS, ask(['nutty'], { sweetness: 'light' }), heavy)).toEqual(['nutty']); // 1 + 5 = 6 ≤ 6
      expect(reachableAddonFamilies(cappucino(), CAPPUCINO_TRAITS, ask(['nutty'], { sweetness: 'none' }), heavy)).toEqual([]); // 6 > 3

      const item = cappucino([syrupGroup(), toppingGroup()]);
      const light = new Map([['topping-hazelnut', traits({ role: 'flavour', flavour_families: ['nutty'], sweetness_delta: 0 })]]);
      // Same role now; the topping option's smaller sweetness_delta (0 < 2) wins over the syrup.
      expect(flavourAddonFor(item, CAPPUCINO_TRAITS, ask(['nutty']), light)?.optionId).toBe('topping-hazelnut');
    });

    it('an override never bypasses availability or the price limit', () => {
      const group35 = syrupGroup(ADDON_SUGGEST_LIMITS.maxPriceInr + 1);
      const overrides = new Map([[hazelnut, traits({ flavour_families: ['nutty'], sweetness_delta: 0 })]]);
      expect(flavourAddonFor(cappucino([group35]), CAPPUCINO_TRAITS, ask(['nutty']), overrides)).toBeNull();

      const off = syrupGroup(35);
      off.options = off.options.map((o) => (o.id === hazelnut ? { ...o, is_available: false } : o));
      expect(flavourAddonFor(cappucino([off]), CAPPUCINO_TRAITS, ask(['nutty']), overrides)).toBeNull();
    });

    it('an override for another option changes nothing', () => {
      const overrides = new Map([['some-other-option', traits({ role: 'other' })]]);
      expect(flavourAddonFor(cappucino(), CAPPUCINO_TRAITS, ask(['nutty']), overrides)?.label).toBe('Hazelnut syrup');
    });
  });
});

describe('flavourAddonFor', () => {
  it('the acceptance case: a Cappucino for "nutty" is pointed to the Hazelnut syrup', () => {
    expect(flavourAddonFor(cappucino(), CAPPUCINO_TRAITS, ask(['nutty']))).toEqual({
      groupId: 'syrup-group',
      optionId: 'syrup-hazelnut',
      label: 'Hazelnut syrup',
      priceInr: 35,
      family: 'nutty',
    } satisfies FlavourAddonSuggestion);
  });

  it('the label is cleaned: "Salted Caramel (newly Launched)" becomes "Salted Caramel syrup"', () => {
    const only = group('g', 'Add On Syrup', 'Add a Syrup', [opt('sc', 'Salted Caramel (newly Launched)', 35)]);
    expect(flavourAddonFor(cappucino([only]), CAPPUCINO_TRAITS, ask(['caramel']))?.label).toBe('Salted Caramel syrup');
  });

  describe('ordering (§2.4)', () => {
    const nutty = (...groups: AddonGroup[]) => flavourAddonFor(cappucino(groups), CAPPUCINO_TRAITS, ask(['nutty']))?.optionId;

    it('1 · the requested family earlier in the list wins, whatever the options', () => {
      const item = cappucino([syrupGroup()]);
      expect(flavourAddonFor(item, CAPPUCINO_TRAITS, ask(['nutty', 'caramel']))).toMatchObject({ optionId: 'syrup-hazelnut', family: 'nutty' });
      // Both families are reachable; asked the other way round, caramel comes first. Of the two caramel
      // syrups (equal in every respect but sort_order) the first on the menu wins.
      expect(flavourAddonFor(item, CAPPUCINO_TRAITS, ask(['caramel', 'nutty']))).toMatchObject({
        optionId: 'syrup-salted-caramel',
        label: 'Salted Caramel syrup',
        family: 'caramel',
      });
    });

    it('an option that gives two requested families is reported under the earlier one', () => {
      const nutella = group('g', 'Treat Yourself', 'Treat Yourself', [opt('nutella', 'Nutella', 45)]); // chocolatey + nutty
      expect(flavourAddonFor(cappucino([nutella]), CAPPUCINO_TRAITS, ask(['nutty', 'chocolatey']))?.family).toBe('nutty');
      expect(flavourAddonFor(cappucino([nutella]), CAPPUCINO_TRAITS, ask(['chocolatey', 'nutty']))?.family).toBe('chocolatey');
    });

    it('2 · role: flavour before topping before serve, even when a later role is cheaper', () => {
      const syrup = group('syrup', 'Add On Syrup', 'Add a Syrup', [opt('syrup-h', 'Hazelnut', 40)]);
      const topping = group('top', 'Base- Add On', 'Add Toppings', [opt('top-h', 'Hazelnut', 10)]);
      const serve = group('serve', 'Specialized Brews', 'Upgrade to Specialized Brew', [opt('serve-h', 'Hazelnut Cold Foam Brew', 5)]);
      expect(nutty(serve, topping, syrup)).toBe('syrup-h');
      expect(nutty(serve, topping)).toBe('top-h');
      expect(nutty(serve)).toBe('serve-h');
    });

    it('3 · lower sweetness_delta next', () => {
      const lighter = new Map([['b', traits({ flavour_families: ['nutty'], sweetness_delta: 1 })]]);
      const g = group('g', 'Add On Syrup', 'Add a Syrup', [opt('a', 'Hazelnut', 30, 0), opt('b', 'Toasted Hazelnut', 30, 1)]);
      expect(flavourAddonFor(cappucino([g]), CAPPUCINO_TRAITS, ask(['nutty']))?.optionId).toBe('a'); // equal → sort_order
      expect(flavourAddonFor(cappucino([g]), CAPPUCINO_TRAITS, ask(['nutty']), lighter)?.optionId).toBe('b');
    });

    it('4 · lower price next', () => {
      const g = group('g', 'Add On Syrup', 'Add a Syrup', [opt('dear', 'Hazelnut', 40, 0), opt('cheap', 'Toasted Hazelnut', 30, 1)]);
      expect(nutty(g)).toBe('cheap');
    });

    it('5 · group sort_order next', () => {
      const late = group('late', 'Add On Syrup', 'Add a Syrup', [opt('late-h', 'Hazelnut', 35, 0)], { sort_order: 20 });
      const early = group('early', 'Add On Syrup', 'Add a Syrup', [opt('early-h', 'Hazelnut', 35, 9)], { sort_order: 5 });
      expect(nutty(late, early)).toBe('early-h');
      expect(nutty(early, late)).toBe('early-h');
    });

    it('6 · option sort_order next', () => {
      const g = group('g', 'Add On Syrup', 'Add a Syrup', [opt('second', 'Hazelnut', 35, 7), opt('first', 'Toasted Hazelnut', 35, 3)]);
      expect(nutty(g)).toBe('first');
    });

    it('7 · option id last, so the result never depends on the order the groups arrive in', () => {
      const g1 = group('g1', 'Add On Syrup', 'Add a Syrup', [opt('b-id', 'Hazelnut', 35, 0)]);
      const g2 = group('g2', 'Add On Syrup', 'Add a Syrup', [opt('a-id', 'Toasted Hazelnut', 35, 0)]);
      expect(nutty(g1, g2)).toBe('a-id');
      expect(nutty(g2, g1)).toBe('a-id');
    });

    it('is deterministic and does not mutate the item', () => {
      const item = cappucino([syrupGroup(), toppingGroup()]);
      const before = JSON.stringify(item);
      const first = flavourAddonFor(item, CAPPUCINO_TRAITS, ask(['nutty', 'caramel']));
      expect(flavourAddonFor(item, CAPPUCINO_TRAITS, ask(['nutty', 'caramel']))).toEqual(first);
      expect(JSON.stringify(item)).toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// The scorer (§3.1)
// ---------------------------------------------------------------------------

describe('scoreCandidates and preferenceFits — flavours via an add-on', () => {
  const inputs = ask(['nutty']);
  const now = { daypart: 'morning' as const, popularity: new Map<string, number>(), recentItemIds: [] as string[], profile: null };

  function scoreMenu(menu: MenuItem[], traitsList: MenuItemTraits[], forInputs: SuggestInputs, addonTraitsById?: Map<string, AddonTraits>) {
    const byId = new Map(traitsList.map((t) => [t.menu_item_id, t]));
    const filtered = filterCandidates(menu, byId, forInputs, []);
    return scoreCandidates({ candidates: filtered, inputs: forInputs, addonTraitsById, ...now });
  }

  it('the flavours sub-fit is flavourFit (0) through an add-on, 1 natively, 0 otherwise', () => {
    const [candidate] = scoreMenu([cappucino()], [CAPPUCINO_TRAITS], inputs);
    expect(candidate.addonFlavourFamilies).toEqual(['nutty']);
    expect(ADDON_SUGGEST_LIMITS.flavourFit).toBe(0);
    expect(preferenceFits(inputs, candidate).flavours).toBe(ADDON_SUGGEST_LIMITS.flavourFit);

    // The same item with no add-on route, as it scored before: 0.
    expect(preferenceFits(inputs, { ...candidate, addonFlavourFamilies: [] }).flavours).toBe(0);
    expect(preferenceFits(inputs, { name: candidate.name, traits: candidate.traits, sugarAdjustable: false }).flavours).toBe(0);

    // Natively nutty: a full match, and nothing left to reach for.
    const native = latteTraits('cappucino', { flavor_notes: ['hazelnut'] });
    const [nativeCandidate] = scoreMenu([cappucino()], [native], inputs);
    expect(nativeCandidate.addonFlavourFamilies).toEqual([]);
    expect(preferenceFits(inputs, nativeCandidate).flavours).toBe(1);
    // …even if a subject claims an add-on route as well: native is full marks.
    expect(preferenceFits(inputs, { ...nativeCandidate, addonFlavourFamilies: ['nutty'] }).flavours).toBe(1);
  });

  it('only a family that was asked for counts: a caramel route does not help a nutty customer', () => {
    const [candidate] = scoreMenu([cappucino()], [CAPPUCINO_TRAITS], inputs);
    expect(preferenceFits(inputs, { ...candidate, addonFlavourFamilies: ['caramel'] }).flavours).toBe(0);
  });

  it('OR semantics: one native family among several asked is a full match, an add-on one scores flavourFit', () => {
    const both = ask(['caramel', 'nutty']);
    const caramelNative = latteTraits('cappucino', { flavor_notes: ['caramel'] });
    const [native] = scoreMenu([cappucino()], [caramelNative], both);
    expect(native.addonFlavourFamilies).toEqual(['nutty']);
    expect(preferenceFits(both, native).flavours).toBe(1);
    const [viaAddon] = scoreMenu([cappucino()], [CAPPUCINO_TRAITS], both);
    expect(viaAddon.addonFlavourFamilies).toEqual(['caramel', 'nutty']);
    expect(preferenceFits(both, viaAddon).flavours).toBe(ADDON_SUGGEST_LIMITS.flavourFit);
  });

  it('the score moves by exactly the preference weight × flavourFit, i.e. not at all', () => {
    const [withSyrup] = scoreMenu([cappucino()], [CAPPUCINO_TRAITS], inputs);
    const [without] = scoreMenu([cappucino([])], [CAPPUCINO_TRAITS], inputs);
    expect(withSyrup.score - without.score).toBeCloseTo(0.25 * ADDON_SUGGEST_LIMITS.flavourFit, 10);
    expect(withSyrup.score).toBe(without.score);
  });

  it('the sweetness guard keeps the score where it was: no add-on route, no credit', () => {
    const tooSweet = latteTraits('cappucino', { sweetness_level: 2 });
    const none = ask(['nutty'], { sweetness: 'none' });
    const [withSyrup] = scoreMenu([cappucino()], [tooSweet], none);
    const [without] = scoreMenu([cappucino([])], [tooSweet], none);
    expect(withSyrup.addonFlavourFamilies).toEqual([]);
    expect(withSyrup.score).toBe(without.score);
  });

  it('no flavours requested: no add-on families anywhere, and every score is what it was without the syrups', () => {
    const menu = [
      cappucino(),
      makeMenuItem({ id: 'plain', name: 'Plain Latte', priceInr: 140, addon_groups: [buildSugarGroup('plain')] }),
      makeMenuItem({ id: 'toppy', name: 'Toppy Mocha', priceInr: 160, addon_groups: [syrupGroup(), toppingGroup()] }),
    ];
    const bare = menu.map((m) => ({ ...m, addon_groups: m.addon_groups.filter((g) => !/syrup|add on/i.test(`${g.name} ${g.display_name}`)) }));
    const traitsList = menu.map((m) => latteTraits(m.id));
    for (const forInputs of [ask([]), ask([], { sweetness: 'none' }), ask([], { sweetness: 'sweet', strength: 'strong' })]) {
      const a = scoreMenu(menu, traitsList, forInputs);
      const b = scoreMenu(bare, traitsList, forInputs);
      expect(a.map((c) => [c.menuItemId, c.score])).toEqual(b.map((c) => [c.menuItemId, c.score]));
      for (const c of a) expect(c.addonFlavourFamilies ?? []).toEqual([]);
    }
  });

  it('owner overrides reach the scorer (addonTraitsById)', () => {
    const overrides = new Map([['syrup-hazelnut', traits({ role: 'other', flavour_families: ['nutty'] })]]);
    const [candidate] = scoreMenu([cappucino()], [CAPPUCINO_TRAITS], inputs, overrides);
    expect(candidate.addonFlavourFamilies).toEqual([]);
    expect(preferenceFits(inputs, candidate).flavours).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tags, reasons and Jev's brief (§3.3)
// ---------------------------------------------------------------------------

describe('matchTagsFor — "<Family> add-on"', () => {
  const subject = (over: Record<string, unknown> = {}) => ({
    name: 'Cappucino',
    traits: makeTraitsV2({ menu_item_id: 'cappucino', sweetness_level: 1, moods: [] }),
    sugarAdjustable: false,
    ...over,
  });

  it('the family only reached through an add-on gets the add-on tag', () => {
    expect(matchTagsFor(subject({ addonFlavourFamilies: ['nutty'] }), ask(['nutty'], { mood: 'surprise' }))).toEqual(['Nutty add-on']);
    expect(matchTagsFor(subject({ addonFlavourFamilies: ['caramel'] }), ask(['caramel'], { mood: 'surprise' }))).toEqual(['Caramel add-on']);
    expect(matchTagsFor(subject({ addonFlavourFamilies: ['biscuit'] }), ask(['biscuit'], { mood: 'surprise' }))).toEqual(['Cookies & biscuit add-on']);
  });

  it('takes slot 2: after the feeling, before sweetness, iced and the budget', () => {
    const traitsCosy = makeTraitsV2({ menu_item_id: 'cappucino', sweetness_level: 3, moods: ['cosy'], mood_fit: { cosy: 3 } });
    const tags = matchTagsFor(
      subject({ traits: traitsCosy, addonFlavourFamilies: ['nutty'] }),
      ask(['nutty'], { sweetness: 'light', temperature: 'hot', budget: 'under_150' }),
    );
    expect(tags).toEqual(['Cosy', 'Nutty add-on', 'Lightly sweet']); // capped at three
  });

  it('a native family takes the tag, with no "add-on"', () => {
    expect(matchTagsFor(subject({ name: 'Hazelnut Latte', addonFlavourFamilies: ['nutty'] }), ask(['nutty'], { mood: 'surprise' }))).toEqual(['Nutty']);
  });

  it('with two asked, a native one beats an add-on one, and the first asked add-on family is used otherwise', () => {
    const caramelNative = makeTraitsV2({ menu_item_id: 'cappucino', sweetness_level: 1, moods: [], flavor_notes: ['caramel'] });
    expect(matchTagsFor(subject({ traits: caramelNative, addonFlavourFamilies: ['nutty'] }), ask(['nutty', 'caramel'], { mood: 'surprise' }))).toEqual(['Caramel']);
    expect(matchTagsFor(subject({ addonFlavourFamilies: ['caramel', 'nutty'] }), ask(['nutty', 'caramel'], { mood: 'surprise' }))).toEqual(['Nutty add-on']);
  });

  it('nothing when the add-on family was not asked for, or when the field is absent or empty', () => {
    expect(matchTagsFor(subject({ addonFlavourFamilies: ['caramel'] }), ask(['nutty'], { mood: 'surprise' }))).toEqual([]);
    expect(matchTagsFor(subject(), ask(['nutty'], { mood: 'surprise' }))).toEqual([]);
    expect(matchTagsFor(subject({ addonFlavourFamilies: [] }), ask(['nutty'], { mood: 'surprise' }))).toEqual([]);
    expect(matchTagsFor(subject({ addonFlavourFamilies: ['nutty'] }), ask([], { mood: 'surprise' }))).toEqual([]);
  });
});

describe('templateReason — "<family phrase> from <label>"', () => {
  const addon = (label = 'Hazelnut syrup', family: FlavourFamily = 'nutty'): FlavourAddonSuggestion => ({
    groupId: 'syrup-group',
    optionId: 'syrup-hazelnut',
    label,
    priceInr: 35,
    family,
  });
  const v2 = makeTraitsV2({
    menu_item_id: 'cappucino',
    sweetness_level: 3,
    intensity: 1,
    textures: ['silky'],
    flavor_notes: ['creamy'],
    moods: ['focus'],
  });
  const v1 = makeTraits({ menu_item_id: 'cappucino', flavor_notes: ['creamy'], moods: ['cosy'] });

  it('the spec example', () => {
    const reason = templateReason(v2, ask(['nutty'], { mood: 'focus' }), 'focus', 'Cappucino', false, addon());
    expect(reason).toBe('Mellow and silky, with toasty nutty notes from Hazelnut syrup — easy to sip while you focus.');
    expect(lintReason(reason).ok).toBe(true);
  });

  it('without an add-on the reason is exactly what it was', () => {
    const inputs = ask(['nutty'], { mood: 'focus' });
    const plain = templateReason(v2, inputs, 'focus', 'Cappucino');
    expect(plain).toBe('Mellow and silky, with creamy notes — easy to sip while you focus.');
    expect(templateReason(v2, inputs, 'focus', 'Cappucino', false, null)).toBe(plain);
  });

  it('also reads right in the v1 shapes, the usual and the popular framing', () => {
    const cosy = ask(['nutty']);
    expect(templateReason(v1, cosy, 'cosy', 'Cappucino', false, addon())).toBe(
      'A lovely pick — toasty nutty notes from Hazelnut syrup, warm and unhurried, a cosy choice.',
    );
    expect(templateReason(v2, cosy, 'usual', 'Cappucino', false, addon())).toBe(
      'Your usual — toasty nutty notes from Hazelnut syrup, always a good choice.',
    );
    expect(templateReason(v2, cosy, 'popular', 'Cappucino', false, addon())).toBe(
      'Our regulars love this one, with toasty nutty notes from Hazelnut syrup.',
    );
  });

  it('over 120 characters: drops " from <label>" (before dropping any descriptor)', () => {
    const label = 'Roasted Hazelnut Praline Crunch Syrup With Sea Salt And Toasted Almond Flakes';
    const reason = templateReason(v2, ask(['nutty'], { mood: 'focus' }), 'focus', 'Cappucino', false, addon(label));
    expect(reason).toBe('Mellow and silky, with toasty nutty notes — easy to sip while you focus.');
    expect(reason.length).toBeLessThanOrEqual(SUGGEST_LIMITS.reasonMaxChars);
  });

  it('a label that fails the tone lint is left out, not shown', () => {
    for (const label of ['Budget Syrup', 'Hazel<b>nut', 'Syrup — see https://example.com', "Don't miss syrup"]) {
      const reason = templateReason(v2, ask(['nutty'], { mood: 'focus' }), 'focus', 'Cappucino', false, addon(label));
      expect(reason, label).toBe('Mellow and silky, with toasty nutty notes — easy to sip while you focus.');
      expect(lintReason(reason).ok, label).toBe(true);
    }
  });

  it('every reason it can write is ≤120 characters and passes lintReason', () => {
    const labels = ['Hazelnut syrup', 'Salted Caramel syrup', 'x'.repeat(200), '', 'Budget syrup', 'A'.repeat(90)];
    for (const label of labels) {
      for (const reasonCode of ['boost', 'focus', 'unwind', 'cosy', 'comfort', 'celebrate', 'cool', 'surprise', 'trait', 'usual', 'popular'] as const) {
        for (const t of [v1, v2]) {
          const reason = templateReason(t, ask(['nutty']), reasonCode, 'Cappucino', true, addon(label));
          expect(reason.length, `${reasonCode} ${label.slice(0, 12)}`).toBeLessThanOrEqual(SUGGEST_LIMITS.reasonMaxChars);
          expect(lintReason(reason).ok, `${reasonCode} ${label.slice(0, 12)}`).toBe(true);
        }
      }
    }
  });

  it('a native requested family keeps its own phrase; the add-on is ignored', () => {
    const reason = templateReason(v2, ask(['nutty']), 'cosy', 'Hazelnut Latte', false, addon());
    expect(reason).toContain('toasty nutty notes');
    expect(reason).not.toContain(' from ');
  });

  it('an add-on for a family that was not asked for is ignored', () => {
    const reason = templateReason(v2, ask(['caramel']), 'cosy', 'Cappucino', false, addon('Hazelnut syrup', 'nutty'));
    expect(reason).not.toContain('Hazelnut syrup');
    expect(templateReason(v2, ask([]), 'cosy', 'Cappucino', false, addon())).toBe(templateReason(v2, ask([]), 'cosy', 'Cappucino'));
  });
});

describe('describeCandidate — addOnFlavours', () => {
  const inputs = ask(['nutty', 'caramel']);
  const byId = new Map([['cappucino', CAPPUCINO_TRAITS]]);
  const [candidate] = scoreCandidates({
    candidates: filterCandidates([cappucino()], byId, inputs, []),
    inputs,
    profile: null,
    daypart: 'morning',
    popularity: new Map(),
    recentItemIds: [],
  });

  it('lists the labels of the flavours it gets only from an add-on, last', () => {
    const described = describeCandidate(candidate);
    expect(described.addOnFlavours).toEqual(['Nutty', 'Caramel & toffee']); // in the order they were asked for
    expect(Object.keys(described).at(-1)).toBe('addOnFlavours');
  });

  it('is left out when there are none (empty, or the field is absent)', () => {
    expect(describeCandidate({ ...candidate, addonFlavourFamilies: [] })).not.toHaveProperty('addOnFlavours');
    const { addonFlavourFamilies: _omitted, ...bare } = candidate;
    void _omitted;
    expect(describeCandidate(bare)).not.toHaveProperty('addOnFlavours');
  });

  it('is valid JSON as it stands', () => {
    const described = describeCandidate(candidate);
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });
});

// ---------------------------------------------------------------------------
// Through the engine (§3.2, §6)
// ---------------------------------------------------------------------------

describe('runSuggest — flavour add-ons, end to end (decider: null)', () => {
  const NOW = new Date('2026-06-01T10:00:00Z'); // an IST afternoon

  /** Three hot milky coffees, identical but for their flavour: one natively
   * nutty, one that can be made nutty with a syrup, one that cannot. */
  function menu(opts: { syrups?: boolean; cappucinoLevel?: number } = {}): { items: MenuItem[]; traitsById: Map<string, MenuItemTraits> } {
    const syrups = opts.syrups === false ? [] : [syrupGroup()];
    const items = [
      makeMenuItem({ id: 'cappucino', name: 'Cappucino', priceInr: 130, addon_groups: syrups }),
      makeMenuItem({
        id: 'hazelnut-latte',
        name: 'Hazelnut Latte',
        priceInr: 150,
        addon_groups: syrups.map((g) => ({ ...g, id: 'syrup-group-hl', options: g.options.map((o) => ({ ...o, id: `${o.id}-hl`, addon_group_id: 'syrup-group-hl' })) })),
      }),
      makeMenuItem({ id: 'plain-latte', name: 'Plain Latte', priceInr: 140 }),
    ];
    const traitsById = new Map<string, MenuItemTraits>([
      ['cappucino', latteTraits('cappucino', { sweetness_level: opts.cappucinoLevel ?? 1 })],
      ['hazelnut-latte', latteTraits('hazelnut-latte')],
      ['plain-latte', latteTraits('plain-latte')],
    ]);
    return { items, traitsById };
  }

  function run(
    inputs: SuggestInputs,
    over: { menu?: ReturnType<typeof menu>; profile?: TasteProfile | null; decider?: Decider | null; addonTraitsById?: Map<string, AddonTraits> } = {},
  ) {
    const m = over.menu ?? menu();
    return runSuggest({
      request: { inputs },
      menu: m.items,
      traitsById: m.traitsById,
      profile: over.profile ?? null,
      popularity: new Map(),
      recentItemIds: [],
      addonTraitsById: over.addonTraitsById,
      now: NOW,
      decider: over.decider ?? null,
      fallbackReason: 'disabled',
    });
  }

  const pick = (result: Awaited<ReturnType<typeof run>>, id: string) => {
    const found = result.picks.find((p) => p.menuItemId === id);
    expect(found, id).toBeDefined();
    return found!;
  };

  it('asked for nutty: the Cappucino carries the Hazelnut syrup tip, a tag and a reason that name it', async () => {
    const result = await run(ask(['nutty']));
    expect(result.picks.map((p) => p.menuItemId).sort()).toEqual(['cappucino', 'hazelnut-latte', 'plain-latte']);

    const cap = pick(result, 'cappucino');
    expect(cap.flavourAddon).toEqual({
      groupId: 'syrup-group',
      optionId: 'syrup-hazelnut',
      label: 'Hazelnut syrup',
      priceInr: 35,
      family: 'nutty',
    });
    expect(cap.flavourAddon!.label).toBe('Hazelnut syrup');
    expect(cap.matchTags).toEqual(['Cosy', 'Nutty add-on']);
    expect(cap.reason).toContain('from Hazelnut syrup');
    // No sweetness word: the syrup sweetens the drink, so "unsweetened … from
    // Hazelnut syrup" would contradict itself. The next descriptor (texture) leads.
    expect(cap.reason).toBe(
      'Mellow and silky, with toasty nutty notes from Hazelnut syrup — warm and unhurried, a cosy choice.',
    );
    expect(lintReason(cap.reason).ok).toBe(true);
    expect(cap.reason.length).toBeLessThanOrEqual(SUGGEST_LIMITS.reasonMaxChars);
    expect(cap.reasonCode).toBe('cosy');
    // The preselected sugar option is the sugar job's alone: nothing else is preselected.
    expect(cap.sugarPreset).toBeNull();
  });

  it('a reason that names an add-on never states a sweetness, even when the customer chose one', async () => {
    for (const sweetness of ['none', 'light', 'medium', 'any'] as const) {
      const result = await run(ask(['nutty'], { sweetness }));
      for (const p of result.picks) {
        if (!p.reason.includes(' from ')) continue;
        expect(p.reason, `${sweetness}: ${p.reason}`).not.toMatch(/unsweetened|lightly sweet|medium-sweet|dessert-sweet|\bsweet\b/);
      }
    }
  });

  it('a natively nutty pick has no add-on; one with nothing nutty to offer has none either', async () => {
    const result = await run(ask(['nutty']));

    const native = pick(result, 'hazelnut-latte');
    expect(native.flavourAddon ?? null).toBeNull();
    expect(native.matchTags).toEqual(['Cosy', 'Nutty']);
    expect(native.reason).not.toContain(' from ');

    const plain = pick(result, 'plain-latte');
    expect(plain.flavourAddon ?? null).toBeNull();
    expect(plain.matchTags).toEqual(['Cosy']);
  });

  it('ranks native first; an add-on route alone does not lift an item (ties fall to id)', async () => {
    const inputs = ask(['nutty']);
    const m = menu();
    const scored = scoreCandidates({
      candidates: filterCandidates(m.items, m.traitsById, inputs, []),
      inputs,
      profile: null,
      daypart: 'morning',
      popularity: new Map(),
      recentItemIds: [],
    });
    expect(scored.map((c) => c.menuItemId)).toEqual(['hazelnut-latte', 'cappucino', 'plain-latte']);
    const [native, viaAddon, neither] = scored;
    expect(native.score - viaAddon.score).toBeCloseTo(0.25 * (1 - ADDON_SUGGEST_LIMITS.flavourFit), 10);
    expect(viaAddon.score - neither.score).toBeCloseTo(0.25 * ADDON_SUGGEST_LIMITS.flavourFit, 10);
  });

  it('no flavours asked for: no flavourAddon anywhere, and the response is what it is without the syrups', async () => {
    const inputs = ask([]);
    const withSyrups = await run(inputs);
    const without = await run(inputs, { menu: menu({ syrups: false }) });
    for (const p of withSyrups.picks) expect(p.flavourAddon ?? null, p.menuItemId).toBeNull();
    expect(withSyrups.candidateIds).toEqual(without.candidateIds);
    expect(withSyrups.picks.map((p) => [p.menuItemId, p.reason, p.reasonCode, p.matchTags, p.sugarPreset])).toEqual(
      without.picks.map((p) => [p.menuItemId, p.reason, p.reasonCode, p.matchTags, p.sugarPreset]),
    );
  });

  it('"Not sweet": the syrup only counts while baseLevel + 2 ≤ 3', async () => {
    const none = ask(['nutty'], { sweetness: 'none' });
    const ok = await run(none, { menu: menu({ cappucinoLevel: 1 }) });
    expect(pick(ok, 'cappucino').flavourAddon?.label).toBe('Hazelnut syrup');
    expect(pick(ok, 'cappucino').matchTags).toContain('Nutty add-on');

    const tooSweet = await run(none, { menu: menu({ cappucinoLevel: 2 }) });
    expect(pick(tooSweet, 'cappucino').flavourAddon ?? null).toBeNull();
    expect(pick(tooSweet, 'cappucino').matchTags).not.toContain('Nutty add-on');
    expect(pick(tooSweet, 'cappucino').reason).not.toContain('Hazelnut');
  });

  it('an unavailable, over-limit or re-roled option is never named', async () => {
    const m = menu();
    const cap = m.items.find((i) => i.id === 'cappucino')!;
    cap.addon_groups[0].options = cap.addon_groups[0].options.map((o) => (o.id === 'syrup-hazelnut' ? { ...o, is_available: false } : o));
    expect(pick(await run(ask(['nutty']), { menu: m }), 'cappucino').flavourAddon ?? null).toBeNull();

    const dear = menu();
    dear.items.find((i) => i.id === 'cappucino')!.addon_groups[0].options.forEach((o) => {
      o.price_inr = ADDON_SUGGEST_LIMITS.maxPriceInr + 1;
    });
    expect(pick(await run(ask(['nutty']), { menu: dear }), 'cappucino').flavourAddon ?? null).toBeNull();

    const overrides = new Map([['syrup-hazelnut', traits({ role: 'other', flavour_families: ['nutty'] })]]);
    const result = await run(ask(['nutty']), { addonTraitsById: overrides });
    expect(pick(result, 'cappucino').flavourAddon ?? null).toBeNull();
  });

  it('owner overrides steer the choice: a re-tagged Vanilla syrup is the nutty one', async () => {
    const overrides = new Map([['syrup-vanilla', traits({ flavour_families: ['nutty'], sweetness_delta: 1 })]]);
    const result = await run(ask(['nutty']), { addonTraitsById: overrides });
    const cap = pick(result, 'cappucino');
    expect(cap.flavourAddon).toMatchObject({ optionId: 'syrup-vanilla', label: 'Vanilla syrup', family: 'nutty' });
    expect(cap.reason).toContain('from Vanilla syrup');
  });

  it('the usual is decorated the same way, and keeps its "usual" voice', async () => {
    const profile: TasteProfile = {
      topItems: [{ menu_item_id: 'cappucino', count: 9, lastOrderedAt: '2026-05-01T00:00:00Z' }],
      categoryAffinity: { Coffee: 1 },
      traitLean: { icedShare: 0.2, meanSweetness: 0.5, caffeineShare: 0.9, foodAttachRate: 0.1 },
      ticket: { median: 150, p75: 180 },
      priceComfort: 'budget',
      orderingMood: 'routine',
      daypartHistogram: { morning: 0.5, afternoon: 0.5, evening: 0, late: 0 },
      favorites: [],
    };
    const result = await run(ask(['nutty']), { profile });
    expect(result.usualItemId).toBe('cappucino');
    expect(result.usual?.reasonCode).toBe('usual');
    expect(result.usual?.flavourAddon?.label).toBe('Hazelnut syrup');
    expect(result.usual?.reason).toBe('Your usual — toasty nutty notes from Hazelnut syrup, always a good choice.');
    expect(result.usual?.matchTags).toEqual(['Cosy', 'Nutty add-on']);
    expect(result.picks.some((p) => p.menuItemId === 'cappucino')).toBe(false);

    const noFlavours = await run(ask([]), { profile });
    expect(noFlavours.usual?.flavourAddon ?? null).toBeNull();
  });

  it('whatever a decider returns, flavourAddon comes from the menu row and the reason from the template', async () => {
    const decider: Decider = async ({ shortlist }) => ({
      picks: shortlist.map((c) => ({
        menuItemId: c.menuItemId,
        reason: 'A lovely pick for you.',
        reasonCode: 'cosy' as const,
        // Not part of DeciderResult: anything extra a model sneaks in must go nowhere.
        flavourAddon: { groupId: 'x', optionId: 'x', label: 'Free money', priceInr: 0, family: 'nutty' },
      })),
      header: null,
      model: 'fake',
      inputTokens: 1,
      cacheReadTokens: 0,
      outputTokens: 1,
      costUsdMicros: 1,
    });
    const result = await run(ask(['nutty']), { decider });
    expect(result.source).toBe('llm');
    expect(pick(result, 'plain-latte').flavourAddon ?? null).toBeNull();
    expect(pick(result, 'plain-latte').reason).toBe('A lovely pick for you.'); // no add-on, so the decider's reason stands
    const cap = pick(result, 'cappucino');
    expect(cap.flavourAddon?.label).toBe('Hazelnut syrup');
    expect(cap.reason).toContain('from Hazelnut syrup');
    expect(JSON.stringify(result.picks)).not.toContain('Free money');
  });

  it('every pick still passes the tone lint and the length cap, add-on or not', async () => {
    for (const flavours of [[], ['nutty'], ['caramel'], ['nutty', 'caramel', 'chocolatey']] as FlavourFamily[][]) {
      const result = await run(ask(flavours));
      for (const p of [...result.picks, ...(result.usual ? [result.usual] : [])]) {
        expect(lintReason(p.reason).ok, `${flavours} ${p.menuItemId}`).toBe(true);
        expect(p.reason.length).toBeLessThanOrEqual(SUGGEST_LIMITS.reasonMaxChars);
        expect(p.matchTags!.length).toBeLessThanOrEqual(3);
      }
    }
  });
});
