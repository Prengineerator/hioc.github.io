import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addonLabel, deriveAddonTraits, resolveAddonTraits } from '@/lib/suggest/addonTraits';
import { FLAVOUR_FAMILY_INFO } from '@/lib/suggest/traitVocabulary';
import { ADDON_ROLES, FLAVOUR_FAMILIES } from '@/lib/suggest/types';
import type { AddonRole, AddonTraits, FlavourFamily, Texture } from '@/lib/suggest/types';

// COFFEY-ADDONS-PAIRINGS-SPEC §2.2 — the traits derived for an add-on option
// from its group and option names, and §2.4's label rule. The pin below covers
// EVERY option on the live menu (data/inventory/menu-snapshot.json), so a new
// option fails here until someone has looked at what it was given.

interface SnapshotAddonOption {
  id: string;
  group: string; // addon_groups.name
  group_label: string; // addon_groups.display_name
  option: string; // addon_options.name
  price_inr: number;
}

const snapshot: { addon_options: SnapshotAddonOption[] } = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data/inventory/menu-snapshot.json'), 'utf8'),
);

function traitsOf(group: string, groupLabel: string, option: string): AddonTraits {
  return deriveAddonTraits({ name: group, display_name: groupLabel }, { name: option });
}

// ---------------------------------------------------------------------------
// The pin: [role, flavour families, sweetness, intensity, indulgence, textures]
// per "<group name> | <option name>" in the snapshot.
// ---------------------------------------------------------------------------

type Expected = readonly [AddonRole, readonly FlavourFamily[], number, number, number, readonly Texture[]];

const SERVE_PLAIN: Expected = ['serve', [], 0, 0, 0, []];
const SERVE_FIZZY: Expected = ['serve', [], 0, 0, 0, ['fizzy']];
const SWEETENER: Expected = ['sweetener', [], 0, 0, 0, []];
const MILK: Expected = ['milk', [], 0, 0, 0, []];
const ICE: Expected = ['ice', [], 0, 0, 0, []];
const SIDE: Expected = ['side', [], 0, 0, 0, []];
const OTHER: Expected = ['other', [], 0, 0, 0, []];
const DIP: Expected = ['topping', [], 0, 0, 0, []];

const EXPECTED: Record<string, Expected> = {
  // Rule 11 — serve (fizzy for sparkling / tonic / ginger ale / coke)
  'Specialized Brews | Sparkling Water(green Apple)': ['serve', ['fruity'], 0, 0, 0, ['fizzy']],
  'Specialized Brews | Sparkling Water(peach)': ['serve', ['fruity'], 0, 0, 0, ['fizzy']],
  'Specialized Brews | Sparkling Water(lime And Lemon)': ['serve', ['fruity'], 0, 0, 0, ['fizzy']],
  'Specialized Brews | Tonic Water': SERVE_FIZZY,
  'Specialized Brews | Coconut Water': SERVE_PLAIN,
  'Specialized Brews | Still Water': SERVE_PLAIN,
  'Specialized Brews(on The Rocks) | Tonic Water (espresso & Tonic)': SERVE_FIZZY,
  'Specialized Brews(on The Rocks) | Ginger Ale': ['serve', ['spiced'], 0, 0, 0, ['fizzy']],
  'Specialized Brews(on The Rocks) | Diet Coke': SERVE_FIZZY,
  'Upgrade To Cold Brew | Espresso Brew': SERVE_PLAIN,
  'Upgrade To Cold Brew | Signature Cold Brew': SERVE_PLAIN,

  // Rule 1 — sugar
  'Sugar | Stevia (sugarfree)': SWEETENER,
  'Sugar | Brown Sugar': SWEETENER,
  'Sugar | No Sugar': SWEETENER,
  'Sugar | Normal': SWEETENER,

  // Rule 2 — milk (no family, even for "Almond")
  'ADD ON Milk | Almond': MILK,
  'ADD ON Milk | Oat': MILK,
  'ADD ON Milk | Soy Milk': MILK,
  'ADD ON Milk | Lactose Free': MILK,
  'ADD ON Milk | Coconut Milk (new)': MILK,

  // Rule 7 — syrup (vanilla has no family)
  'Add On Syrup | Salted Caramel (newly Launched)': ['flavour', ['caramel'], 2, 0, 0, []],
  'Add On Syrup | Vanilla': ['flavour', [], 2, 0, 0, []],
  'Add On Syrup | Hazelnut': ['flavour', ['nutty'], 2, 0, 0, []],
  'Add On Syrup | Caramel': ['flavour', ['caramel'], 2, 0, 0, []],

  // Rule 9 — extras / toppings / treat yourself (marshmallow soft; nuts and chips crunchy)
  'Hot Chocolate | Nuts: Hazelnuts': ['topping', ['nutty'], 1, 0, 1, ['crunchy']],
  'Hot Chocolate | Nuts: Almonds': ['topping', ['nutty'], 1, 0, 1, ['crunchy']],
  'Hot Chocolate | Marshmallow (5pcs)': ['topping', [], 1, 0, 1, ['soft']],
  'Yes, For Me | Nutella': ['topping', ['chocolatey', 'nutty'], 1, 0, 1, []],
  'Add On Waffles | Caramel Syrup': ['topping', ['caramel'], 1, 0, 1, []], // a waffle topping, not rule 7: the GROUP is not a syrup group
  'Add On Waffles | Nutella': ['topping', ['chocolatey', 'nutty'], 1, 0, 1, []],
  'Add On Waffles | Chocochips(white)': ['topping', ['chocolatey'], 1, 0, 1, ['crunchy']],
  'Add On Waffles | Chocochips(dark)': ['topping', ['chocolatey'], 1, 0, 1, ['crunchy']],
  'Base- Add On | Red Velvet': ['topping', ['chocolatey'], 1, 0, 1, []],
  'Base- Add On | Hazelnut': ['topping', ['nutty'], 1, 0, 1, ['crunchy']],
  'Base- Add On | Almond': ['topping', ['nutty'], 1, 0, 1, ['crunchy']],

  // Rule 6 — ice cream (beats the topping group)
  'Yes, For Me | Ice Cream - Chocolate': ['topping', ['chocolatey'], 2, 0, 2, ['creamy']],
  'Yes, For Me | Ice Cream - Vanilla': ['topping', [], 2, 0, 2, ['creamy']],
  'Add On Waffles | Icecream(chocolate)': ['topping', ['chocolatey'], 2, 0, 2, ['creamy']],
  'Add On Waffles | Icecream(vanilla)': ['topping', [], 2, 0, 2, ['creamy']],

  // Rules 4, 5, 8 — condiments
  'Add On Condiments | Chocolate Sauce': ['flavour', ['chocolatey'], 2, 0, 1, []],
  'Add On Condiments | Caramel Sauce': ['flavour', ['caramel'], 2, 0, 1, []],
  'Add On Condiments | Espresso Shot': ['shot', [], 0, 1, 0, []],
  'Add On Condiments | Whipped Cream': ['topping', [], 1, 0, 1, ['creamy']],
  'Whipped Cream_add | Add On Whipped Cream': ['topping', [], 1, 0, 1, ['creamy']],

  // Rule 12 — dips
  'Dips | Cheese Dip': DIP,
  'Dips | Peri Peri Dip': DIP,
  'Dips | Tandoori Dip': DIP,

  // Rule 3 — ice level
  'Ice | Only Ice - Maxxx Ice': ICE,
  'Ice | No Ice': ICE,
  'Ice | Less Ice': ICE,
  'Ice | Normal Ice': ICE,

  // Rule 10 — sides (a side keeps its families: the croissant is chocolatey + nutty)
  'Add A Slider | Nutella Almond Croissant (large)': ['side', ['chocolatey', 'nutty'], 0, 0, 0, []],
  'Add A Slider | Cheesy Garlic Toast': SIDE,
  'Add A Slider | Butter Croissant (large)': SIDE,
  'Croissant | Croissant': SIDE,

  // Rule 13 — packaging, "No Whipped Cream", "Default"
  'Ice Cream Packaging | Assemble It By You': OTHER,
  'Ice Cream Packaging | Assemble It Myself': OTHER,
  'Whipped Cream_choose | No Whipped Cream': OTHER,
  'Whipped Cream_choose | Default': OTHER,
  'Whipped Cream_add | No Whipped Cream': OTHER,
};

const keyOf = (row: SnapshotAddonOption) => `${row.group} | ${row.option}`;

describe('deriveAddonTraits — the live menu (data/inventory/menu-snapshot.json)', () => {
  it('has a reviewed expectation for every option on the menu', () => {
    const unreviewed = snapshot.addon_options.map(keyOf).filter((key) => !(key in EXPECTED));
    expect(
      unreviewed,
      `New add-on option(s) on the menu: review the traits they are derived and add them to EXPECTED:\n${unreviewed.join('\n')}`,
    ).toEqual([]);
  });

  it('keys are unique, so one row cannot hide another', () => {
    const keys = snapshot.addon_options.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(snapshot.addon_options.map((row) => [keyOf(row), row] as const))('%s', (key, row) => {
    const expected = EXPECTED[key];
    expect(expected, `no reviewed expectation for "${key}"`).toBeDefined();
    const [role, families, sweetness, intensity, indulgence, textures] = expected;
    expect(traitsOf(row.group, row.group_label, row.option)).toEqual({
      role,
      flavour_families: families,
      sweetness_delta: sweetness,
      intensity_delta: intensity,
      indulgence_delta: indulgence,
      textures,
    });
  });
});

// ---------------------------------------------------------------------------
// The rule table itself (§2.2) on invented groups, for what the live menu does
// not exercise: rule order, case-insensitivity, the caps, the family exclusions.
// ---------------------------------------------------------------------------

describe('deriveAddonTraits — rules', () => {
  const derive = (group: string, option: string, label = group) => traitsOf(group, label, option);

  it('the first matching role rule wins (a group rule beats an option rule, and rule 1 beats rule 7)', () => {
    expect(derive('Sugar', 'Espresso Shot').role).toBe('sweetener'); // 1 before 4
    expect(derive('Milk', 'Whipped Cream').role).toBe('milk'); // 2 before 5
    expect(derive('Ice', 'Espresso Shot').role).toBe('ice'); // 3 before 4
    expect(derive('Sugar syrup', 'Vanilla').role).toBe('sweetener'); // 1 before 7
    expect(derive('Espresso', 'Extra Shot').role).toBe('shot'); // 4 before 13
    expect(derive('Syrup', 'Chocolate Sauce').role).toBe('flavour'); // 7 before 8 (same role, rule 7's deltas)
    expect(derive('Syrup', 'Chocolate Sauce').indulgence_delta).toBe(0);
    expect(derive('Toppings', 'Chocolate Sauce').indulgence_delta).toBe(1); // 8 before 9
    expect(derive('Toppings', 'Whipped Cream').textures).toEqual(['creamy']); // 5 before 9
    expect(derive('Toppings', 'Ice Cream').sweetness_delta).toBe(2); // 6 before 9
  });

  it('is case-insensitive on both the group and the option', () => {
    expect(derive('ADD ON SYRUP', 'HAZELNUT')).toEqual(derive('add on syrup', 'hazelnut'));
    expect(derive('whipped cream_add', 'ADD ON WHIPPED CREAM').role).toBe('topping');
    expect(derive('x', 'EXTRA SHOT').role).toBe('shot');
  });

  it('matches the group on its name AND its display name', () => {
    expect(traitsOf('addons-1', 'Add a Syrup', 'Hazelnut').role).toBe('flavour');
    expect(traitsOf('Add On Syrup', 'Pick one', 'Hazelnut').role).toBe('flavour');
    expect(traitsOf('addons-2', 'How much sugar?', 'Normal').role).toBe('sweetener');
  });

  it('"ice" is a whole word, and ice cream is not ice', () => {
    expect(traitsOf('Ice', 'Ice Level', 'Less Ice').role).toBe('ice');
    expect(traitsOf('Spice', 'Spice level', 'Hot').role).toBe('other'); // "spice" is not "ice"
    expect(traitsOf('Ice Cream Packaging', 'Ice Cream Packaging', 'Assemble It Myself').role).toBe('other');
    expect(traitsOf('Ice Cream', 'Scoops', 'Vanilla').role).toBe('other');
  });

  it('"No Whipped Cream" is not a whipped cream topping, "Whipped Cream" is', () => {
    expect(derive('Whipped Cream', 'No Whipped Cream').role).toBe('other');
    expect(derive('Whipped Cream', 'no whipped cream').role).toBe('other');
    expect(derive('Whipped Cream', 'Extra Whipped Cream').role).toBe('topping');
  });

  it('role-specific deltas', () => {
    expect(derive('Condiments', 'Espresso Shot')).toMatchObject({ role: 'shot', intensity_delta: 1, sweetness_delta: 0, indulgence_delta: 0 });
    expect(derive('Syrup', 'Hazelnut')).toMatchObject({ role: 'flavour', sweetness_delta: 2, indulgence_delta: 0, intensity_delta: 0 });
    expect(derive('Condiments', 'Caramel Sauce')).toMatchObject({ role: 'flavour', sweetness_delta: 2, indulgence_delta: 1 });
    expect(derive('Condiments', 'Whipped Cream')).toMatchObject({ role: 'topping', sweetness_delta: 1, indulgence_delta: 1, textures: ['creamy'] });
    expect(derive('Treat Yourself', 'Gelato Ice Cream')).toMatchObject({ role: 'topping', sweetness_delta: 2, indulgence_delta: 2, textures: ['creamy'] });
    expect(derive('Dips', 'Mint Dip')).toMatchObject({ role: 'topping', sweetness_delta: 0, indulgence_delta: 0 });
  });

  it('flavour families come from the item patterns on the OPTION name, in FLAVOUR_FAMILIES order, at most two', () => {
    expect(derive('Syrup', 'Hazelnut').flavour_families).toEqual(['nutty']);
    expect(derive('Toppings', 'Nutella').flavour_families).toEqual(['chocolatey', 'nutty']);
    // Four families match; the first two in FLAVOUR_FAMILIES order survive, whatever order the name lists them in.
    const crowded = derive('Toppings', 'Biscoff Hazelnut Caramel Chocolate').flavour_families;
    expect(crowded).toEqual(['chocolatey', 'caramel']);
    expect(crowded.length).toBeLessThanOrEqual(2);
    const order = (fs: readonly FlavourFamily[]) => fs.map((f) => FLAVOUR_FAMILIES.indexOf(f));
    expect(order(crowded)).toEqual([...order(crowded)].sort((a, b) => a - b));
    // The GROUP name never contributes a family.
    expect(traitsOf('Hazelnut Toppings', 'Hazelnut Toppings', 'Plain').flavour_families).toEqual([]);
    // Vanilla is not a wizard family.
    expect(derive('Syrup', 'Vanilla').flavour_families).toEqual([]);
  });

  it('matches every family pattern the wizard offers', () => {
    const sample: Record<FlavourFamily, string> = {
      chocolatey: 'Chocolate Sauce',
      caramel: 'Caramel',
      nutty: 'Hazelnut',
      biscuit: 'Biscoff Crumble',
      fruity: 'Strawberry',
      spiced: 'Cinnamon',
      floral: 'Rose',
    };
    for (const family of FLAVOUR_FAMILIES) {
      expect(FLAVOUR_FAMILY_INFO[family].pattern.test(sample[family]), family).toBe(true);
      expect(derive('Toppings', sample[family]).flavour_families, family).toContain(family);
    }
  });

  it('a sweetener, milk, ice or other never carries a family, whatever the option is called', () => {
    expect(traitsOf('Sugar', 'Choice of Sugar', 'Caramel Sugar').flavour_families).toEqual([]);
    expect(traitsOf('Milk', 'Choose Milk', 'Hazelnut Milk').flavour_families).toEqual([]);
    expect(traitsOf('Ice', 'Ice Level', 'Chocolate Ice').flavour_families).toEqual([]);
    expect(traitsOf('Packaging', 'Packaging', 'Caramel Box').flavour_families).toEqual([]);
    // …while the roles that can taste of something keep them.
    expect(derive('Condiments', 'Hazelnut Espresso Shot').flavour_families).toEqual(['nutty']);
    expect(derive('Add a Side', 'Hazelnut Croissant').flavour_families).toEqual(['nutty']);
    expect(derive('Specialized Brews', 'Peach Sparkling Water').flavour_families).toEqual(['fruity']);
  });

  it('textures: marshmallow soft; chips and nuts crunchy; at most two; sparkling things fizzy', () => {
    expect(derive('Extras', 'Marshmallow').textures).toEqual(['soft']);
    expect(derive('Extras', 'Choco Chips').textures).toEqual(['crunchy']);
    expect(derive('Extras', 'Nuts: Pistachios').textures).toEqual(['crunchy']);
    expect(derive('Extras', 'Almond').textures).toEqual(['crunchy']);
    expect(derive('Extras', 'Roasted Hazelnut').textures).toEqual(['crunchy']);
    expect(derive('Extras', 'Marshmallow & Chocochips & Almond').textures).toEqual(['soft', 'crunchy']);
    expect(derive('Extras', 'Sprinkles').textures).toEqual([]);
    // The texture notes belong to rule 9 only: a syrup called "Almond" is not crunchy.
    expect(derive('Syrup', 'Almond').textures).toEqual([]);
    for (const name of ['Sparkling Water', 'Tonic Water', 'Ginger Ale', 'Diet Coke', 'COKE ZERO']) {
      expect(derive('Specialized Brews', name).textures, name).toEqual(['fizzy']);
    }
    expect(derive('Specialized Brews', 'Still Water').textures).toEqual([]);
  });

  it('only ever returns valid roles, ≤2 families and ≤2 textures, inside the spec ranges', () => {
    for (const row of snapshot.addon_options) {
      const t = traitsOf(row.group, row.group_label, row.option);
      expect(ADDON_ROLES).toContain(t.role);
      expect(t.flavour_families.length).toBeLessThanOrEqual(2);
      expect(t.textures.length).toBeLessThanOrEqual(2);
      expect(t.sweetness_delta).toBeGreaterThanOrEqual(0);
      expect(t.sweetness_delta).toBeLessThanOrEqual(5);
      expect(t.intensity_delta).toBeGreaterThanOrEqual(0);
      expect(t.intensity_delta).toBeLessThanOrEqual(2);
      expect(t.indulgence_delta).toBeGreaterThanOrEqual(0);
      expect(t.indulgence_delta).toBeLessThanOrEqual(2);
    }
  });

  it('returns fresh arrays: mutating one result never changes the next', () => {
    const first = derive('Toppings', 'Nutella');
    first.flavour_families.push('floral');
    first.textures.push('icy');
    expect(derive('Toppings', 'Nutella').flavour_families).toEqual(['chocolatey', 'nutty']);
    expect(derive('Toppings', 'Nutella').textures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2.4 — the label
// ---------------------------------------------------------------------------

describe('addonLabel', () => {
  const syrup = { name: 'Add On Syrup', display_name: 'Add a Syrup' };
  const condiments = { name: 'Add On Condiments', display_name: 'Add Condiments' };
  const milk = { name: 'ADD On Milk', display_name: 'Choose Milk' };

  it('strips "(newly Launched)" and appends "syrup" in a syrup group', () => {
    expect(addonLabel(syrup, { name: 'Salted Caramel (newly Launched)' })).toBe('Salted Caramel syrup');
  });

  it('adds "syrup" to a plain syrup option, but not twice', () => {
    expect(addonLabel(syrup, { name: 'Hazelnut' })).toBe('Hazelnut syrup');
    expect(addonLabel(syrup, { name: 'Vanilla' })).toBe('Vanilla syrup');
    expect(addonLabel(syrup, { name: 'Caramel Syrup' })).toBe('Caramel Syrup');
    expect(addonLabel(syrup, { name: 'Maple SYRUP (new)' })).toBe('Maple SYRUP');
  });

  it('strips "(new)" and leaves everything else of the name alone', () => {
    expect(addonLabel(milk, { name: 'Coconut Milk (new)' })).toBe('Coconut Milk');
    expect(addonLabel(milk, { name: 'Coconut Milk (NEW)' })).toBe('Coconut Milk');
    expect(addonLabel(condiments, { name: 'Chocolate Sauce' })).toBe('Chocolate Sauce');
    expect(addonLabel(condiments, { name: 'Marshmallow (5pcs)' })).toBe('Marshmallow (5pcs)');
  });

  it('collapses whitespace and trims', () => {
    expect(addonLabel(condiments, { name: '  Caramel   Sauce  (New)  ' })).toBe('Caramel Sauce');
    expect(addonLabel(syrup, { name: ' Salted  Caramel ( Newly  Launched ) ' })).toBe('Salted Caramel syrup');
  });

  it('only a syrup GROUP adds the word (the group name or its display name)', () => {
    expect(addonLabel(condiments, { name: 'Caramel' })).toBe('Caramel');
    expect(addonLabel({ name: 'g1', display_name: 'Add a Syrup' }, { name: 'Caramel' })).toBe('Caramel syrup');
    expect(addonLabel({ name: 'Add On Syrup', display_name: 'Flavour' }, { name: 'Caramel' })).toBe('Caramel syrup');
  });

  it('never returns an empty label', () => {
    expect(addonLabel(condiments, { name: '(new)' })).toBe('(new)');
  });
});

// ---------------------------------------------------------------------------
// §2.3 — owner overrides
// ---------------------------------------------------------------------------

describe('resolveAddonTraits', () => {
  const group = { name: 'Add On Syrup', display_name: 'Add a Syrup' };
  const hazelnut = { id: 'opt-hazelnut', name: 'Hazelnut' };
  const vanilla = { id: 'opt-vanilla', name: 'Vanilla' };
  const override: AddonTraits = {
    role: 'topping',
    flavour_families: ['nutty', 'caramel'],
    sweetness_delta: 4,
    intensity_delta: 1,
    indulgence_delta: 2,
    textures: ['crunchy'],
  };

  it('without overrides it is the derived defaults', () => {
    expect(resolveAddonTraits(group, hazelnut)).toEqual(deriveAddonTraits(group, hazelnut));
    expect(resolveAddonTraits(group, hazelnut, undefined)).toEqual(deriveAddonTraits(group, hazelnut));
    expect(resolveAddonTraits(group, hazelnut, new Map())).toEqual(deriveAddonTraits(group, hazelnut));
  });

  it('an override keyed by the option id wins over the derived defaults', () => {
    const overrides = new Map<string, AddonTraits>([[hazelnut.id, override]]);
    expect(resolveAddonTraits(group, hazelnut, overrides)).toEqual(override);
    expect(resolveAddonTraits(group, hazelnut, overrides)).not.toEqual(deriveAddonTraits(group, hazelnut));
  });

  it('an override applies to its own option only', () => {
    const overrides = new Map<string, AddonTraits>([[hazelnut.id, override]]);
    expect(resolveAddonTraits(group, vanilla, overrides)).toEqual(deriveAddonTraits(group, vanilla));
  });

  it('is keyed by id, not by name: an override for another id with the same name changes nothing', () => {
    const overrides = new Map<string, AddonTraits>([['some-other-id', override]]);
    expect(resolveAddonTraits(group, hazelnut, overrides)).toEqual(deriveAddonTraits(group, hazelnut));
  });

  it('honours an override that makes an option useless (role other, no families)', () => {
    const off: AddonTraits = { role: 'other', flavour_families: [], sweetness_delta: 0, intensity_delta: 0, indulgence_delta: 0, textures: [] };
    expect(resolveAddonTraits(group, hazelnut, new Map([[hazelnut.id, off]]))).toEqual(off);
  });
});
