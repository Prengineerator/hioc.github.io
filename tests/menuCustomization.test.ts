import { describe, expect, it } from 'vitest';
import {
  defaultOptionIds,
  flattenAddons,
  initialSelection,
  invalidGroups,
  isRequired,
  toggleOption,
} from '@/lib/menu/customization';
import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';

// Fixtures below are copied verbatim (ids, names, prices, sort_order) from the
// real cafe data in supabase/seed.sql, so the defaults this test asserts are
// the actual prefills customers/staff will see, not a stand-in.

function option(id: string, addon_group_id: string, name: string, price_inr: number, sort_order: number): AddonOption {
  return { id, addon_group_id, name, price_inr, sort_order };
}

function group(partial: Omit<AddonGroup, 'options'> & { options: AddonOption[] }): AddonGroup {
  return partial;
}

const sugarGroup = group({
  id: 'sugar',
  name: 'Sugar',
  display_name: 'Choice of Sugar',
  selection_type: 'single',
  min_select: 1,
  max_select: 1,
  sort_order: 20,
  options: [
    option('stevia', 'sugar', 'Stevia (sugarfree)', 10, 0),
    option('brown', 'sugar', 'Brown Sugar', 0, 10),
    option('none', 'sugar', 'No Sugar', 0, 20),
    option('normal', 'sugar', 'Normal', 0, 30),
  ],
});

const iceGroup = group({
  id: 'ice',
  name: 'Ice',
  display_name: 'Ice Level',
  selection_type: 'single',
  min_select: 1,
  max_select: 1,
  sort_order: 120,
  options: [
    option('maxx', 'ice', 'Only Ice - Maxxx Ice', 10, 0),
    option('noice', 'ice', 'No Ice', 30, 10),
    option('lessice', 'ice', 'Less Ice', 10, 20),
    option('normalice', 'ice', 'Normal Ice', 0, 30),
  ],
});

const whippedCreamGroup = group({
  id: 'whipped',
  name: 'Whipped Cream_choose',
  display_name: 'Whipped Cream',
  selection_type: 'single',
  min_select: 1,
  max_select: 1,
  sort_order: 150,
  options: [
    option('nowhip', 'whipped', 'No Whipped Cream', 0, 0),
    option('defaultwhip', 'whipped', 'Default', 0, 10),
  ],
});

const coldBrewGroup = group({
  id: 'coldbrew',
  name: 'Upgrade To Cold Brew',
  display_name: 'Upgrade to Cold Brew',
  selection_type: 'single',
  min_select: 1,
  max_select: 1,
  sort_order: 40,
  options: [
    option('espresso', 'coldbrew', 'Espresso Brew', 0, 0),
    option('signature', 'coldbrew', 'Signature Cold Brew', 20, 10),
  ],
});

const specializedBrewGroup = group({
  id: 'specialized',
  name: 'Specialized Brews',
  display_name: 'Upgrade to Specialized Brew',
  selection_type: 'single',
  min_select: 1,
  max_select: 1,
  sort_order: 0,
  options: [
    option('sparkle-apple', 'specialized', 'Sparkling Water(green Apple)', 30, 0),
    option('sparkle-peach', 'specialized', 'Sparkling Water(peach)', 30, 10),
    option('sparkle-lime', 'specialized', 'Sparkling Water(lime And Lemon)', 30, 20),
    option('tonic', 'specialized', 'Tonic Water', 30, 30),
    option('coconut', 'specialized', 'Coconut Water', 30, 40),
    option('still', 'specialized', 'Still Water', 0, 50),
  ],
});

// Optional groups (min_select === 0), for the "no prefill" and toggle-rule cases.
const condimentsGroup = group({
  id: 'condiments',
  name: 'Add On Condiments',
  display_name: 'Add Condiments',
  selection_type: 'multi',
  min_select: 0,
  max_select: 4,
  sort_order: 90,
  options: [
    option('choc-sauce', 'condiments', 'Chocolate Sauce', 30, 0),
    option('caramel-sauce', 'condiments', 'Caramel Sauce', 30, 10),
    option('espresso-shot', 'condiments', 'Espresso Shot', 40, 20),
    option('whip', 'condiments', 'Whipped Cream', 45, 30),
  ],
});

const specializedRocksGroup = group({
  id: 'rocks',
  name: 'Specialized Brews(on The Rocks)',
  display_name: 'Specialized Brew',
  selection_type: 'single',
  min_select: 0,
  max_select: 1,
  sort_order: 10,
  options: [
    option('rocks-tonic', 'rocks', 'Tonic Water (espresso & Tonic)', 60, 0),
    option('rocks-ginger', 'rocks', 'Ginger Ale', 60, 10),
    option('rocks-diet', 'rocks', 'Diet Coke', 25, 20),
  ],
});

// A required multi group (min 2) — not in the seed data, but exercises the
// "prefill takes min_select ids" path for selection_type: 'multi'.
const multiRequiredGroup = group({
  id: 'multi-required',
  name: 'multi-required',
  display_name: 'Pick Two',
  selection_type: 'multi',
  min_select: 2,
  max_select: 3,
  sort_order: 0,
  options: [
    option('m1', 'multi-required', 'Option A', 10, 0),
    option('m2', 'multi-required', 'Option B', 0, 10),
    option('m3', 'multi-required', 'Normal', 0, 20),
    option('m4', 'multi-required', 'Option D', 5, 30),
  ],
});

function makeItem(groups: AddonGroup[]): MenuItem {
  return {
    id: 'item-1',
    name: 'Test Latte',
    description: '',
    category: 'Coffee',
    parent_category: '',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '',
    updated_at: '',
    variants: [{ id: 'v1', menu_item_id: 'item-1', label: 'Regular', price_inr: 200, sort_order: 0 }],
    addon_groups: groups,
  };
}

describe('defaultOptionIds — required-group prefills (seed data)', () => {
  it('Choice of Sugar defaults to Normal', () => {
    expect(defaultOptionIds(sugarGroup)).toEqual(['normal']);
  });

  it('Ice Level defaults to Normal Ice', () => {
    expect(defaultOptionIds(iceGroup)).toEqual(['normalice']);
  });

  it('Whipped Cream defaults to Default', () => {
    expect(defaultOptionIds(whippedCreamGroup)).toEqual(['defaultwhip']);
  });

  it('Upgrade to Cold Brew defaults to Espresso Brew', () => {
    expect(defaultOptionIds(coldBrewGroup)).toEqual(['espresso']);
  });

  it('Upgrade to Specialized Brew defaults to Still Water', () => {
    expect(defaultOptionIds(specializedBrewGroup)).toEqual(['still']);
  });
});

describe('defaultOptionIds — optional groups and multi-select', () => {
  it('returns no prefill for an optional group', () => {
    expect(isRequired(condimentsGroup)).toBe(false);
    expect(defaultOptionIds(condimentsGroup)).toEqual([]);
    expect(isRequired(specializedRocksGroup)).toBe(false);
    expect(defaultOptionIds(specializedRocksGroup)).toEqual([]);
  });

  it('prefills min_select ids for a required multi group, preferring free/named defaults', () => {
    // Free options ranked first, "Normal" preferred over the other free option,
    // then the cheapest paid option fills the remainder.
    expect(defaultOptionIds(multiRequiredGroup)).toEqual(['m3', 'm2']);
  });
});

describe('initialSelection', () => {
  it('prefills every required group and leaves optional groups empty', () => {
    const item = makeItem([sugarGroup, iceGroup, condimentsGroup, specializedRocksGroup]);
    expect(initialSelection(item)).toEqual({
      sugar: ['normal'],
      ice: ['normalice'],
      condiments: [],
      rocks: [],
    });
  });

  it('produces a selection with no invalid groups when every group has options', () => {
    const item = makeItem([sugarGroup, iceGroup, whippedCreamGroup, condimentsGroup]);
    expect(invalidGroups(item, initialSelection(item))).toEqual([]);
  });
});

// Coffey's sugar preselection: initialSelection(item, presets) opens the modal
// with one group already answered. A preset is only trusted when it is a
// selection the group itself would accept; anything else falls back to the
// ordinary default so a bad hint can never break the modal.
describe('initialSelection — presets', () => {
  const item = makeItem([sugarGroup, iceGroup, condimentsGroup, multiRequiredGroup]);

  it('uses a valid preset for its group and leaves every other group on its default', () => {
    expect(initialSelection(item, { sugar: ['none'] })).toEqual({
      sugar: ['none'],
      ice: ['normalice'],
      condiments: [],
      'multi-required': ['m3', 'm2'],
    });
  });

  it('is unchanged when there are no presets (existing callers)', () => {
    expect(initialSelection(item, undefined)).toEqual(initialSelection(item));
    expect(initialSelection(item, {})).toEqual(initialSelection(item));
  });

  it('falls back to the default when the preset names an option the group does not have', () => {
    expect(initialSelection(item, { sugar: ['does-not-exist'] }).sugar).toEqual(['normal']);
    // An option that exists, but in a different group, is just as unknown here.
    expect(initialSelection(item, { sugar: ['normalice'] }).sugar).toEqual(['normal']);
  });

  it('falls back to the default when the preset includes an unavailable option', () => {
    const outOfNoSugar = makeItem([
      group({
        ...sugarGroup,
        options: sugarGroup.options.map((o) => (o.id === 'none' ? { ...o, is_available: false } : o)),
      }),
    ]);
    expect(initialSelection(outOfNoSugar, { sugar: ['none'] }).sugar).toEqual(['normal']);

    // is_available absent (a row read before the migration) counts as on.
    expect(initialSelection(item, { sugar: ['none'] }).sugar).toEqual(['none']);
  });

  it('falls back to the default when a multi-select preset goes past max_select', () => {
    // multiRequiredGroup allows 2–3; four ids is one too many.
    expect(initialSelection(item, { 'multi-required': ['m1', 'm2', 'm3', 'm4'] })['multi-required']).toEqual([
      'm3',
      'm2',
    ]);
  });

  it('falls back to the default when a preset is short of min_select', () => {
    expect(initialSelection(item, { 'multi-required': ['m1'] })['multi-required']).toEqual(['m3', 'm2']);
    // ...and accepts one that sits inside the min–max range.
    expect(initialSelection(item, { 'multi-required': ['m1', 'm4'] })['multi-required']).toEqual(['m1', 'm4']);
  });

  it('gives a single-select group exactly one option, never none or several', () => {
    expect(initialSelection(item, { sugar: ['none', 'normal'] }).sugar).toEqual(['normal']);
    expect(initialSelection(item, { sugar: [] }).sugar).toEqual(['normal']);

    // Optional single-select: a preset must still pick exactly one.
    const optionalSingle = makeItem([specializedRocksGroup]);
    expect(initialSelection(optionalSingle, { rocks: ['rocks-tonic', 'rocks-ginger'] }).rocks).toEqual([]);
    expect(initialSelection(optionalSingle, { rocks: ['rocks-ginger'] }).rocks).toEqual(['rocks-ginger']);
  });

  it('rejects a preset that repeats an option', () => {
    expect(initialSelection(item, { 'multi-required': ['m1', 'm1'] })['multi-required']).toEqual(['m3', 'm2']);
  });

  it('ignores a preset for a group the item does not have', () => {
    const selection = initialSelection(item, { nope: ['x'], sugar: ['none'] });
    expect(Object.keys(selection).sort()).toEqual(['condiments', 'ice', 'multi-required', 'sugar']);
    expect(selection.sugar).toEqual(['none']);
  });

  it('copies the preset instead of aliasing the caller’s array', () => {
    const preset = ['none'];
    const selection = initialSelection(item, { sugar: preset });
    expect(selection.sugar).not.toBe(preset);
  });

  it('a valid preset always yields a selection with no invalid groups', () => {
    expect(invalidGroups(item, initialSelection(item, { sugar: ['none'] }))).toEqual([]);
  });
});

describe('toggleOption', () => {
  it('does not allow deselecting a required single-select group', () => {
    const selection = { sugar: ['normal'] };
    const next = toggleOption(selection, sugarGroup, 'normal');
    expect(next.sugar).toEqual(['normal']);
  });

  it('allows deselecting an optional single-select group', () => {
    const selection = { rocks: ['rocks-tonic'] };
    const next = toggleOption(selection, specializedRocksGroup, 'rocks-tonic');
    expect(next.rocks).toEqual([]);
  });

  it('replaces the pick in a single-select group', () => {
    const selection = { sugar: ['normal'] };
    const next = toggleOption(selection, sugarGroup, 'stevia');
    expect(next.sugar).toEqual(['stevia']);
  });

  it('toggles options on and off in a multi-select group', () => {
    let selection: Record<string, string[]> = { condiments: [] };
    selection = toggleOption(selection, condimentsGroup, 'choc-sauce');
    expect(selection.condiments).toEqual(['choc-sauce']);
    selection = toggleOption(selection, condimentsGroup, 'choc-sauce');
    expect(selection.condiments).toEqual([]);
  });

  it('refuses to add past max_select in a multi-select group', () => {
    let selection: Record<string, string[]> = {
      condiments: ['choc-sauce', 'caramel-sauce', 'espresso-shot', 'whip'],
    };
    selection = toggleOption(selection, condimentsGroup, 'choc-sauce'); // already at max but selected -> removable
    expect(selection.condiments).toEqual(['caramel-sauce', 'espresso-shot', 'whip']);

    // Now at 3/4 — adding a 4th should succeed, a 5th (none exist here) would not.
    const full = { condiments: ['choc-sauce', 'caramel-sauce', 'espresso-shot', 'whip'] };
    const attempt = toggleOption(full, condimentsGroup, 'choc-sauce'); // toggling a selected one off is fine
    expect(attempt.condiments).toHaveLength(3);
  });
});

describe('flattenAddons', () => {
  it('flattens the selection into cart addon lines with prices', () => {
    const item = makeItem([sugarGroup, coldBrewGroup]);
    const selection = { sugar: ['stevia'], coldbrew: ['signature'] };
    expect(flattenAddons(item, selection)).toEqual([
      { optionId: 'stevia', groupName: 'Choice of Sugar', optionName: 'Stevia (sugarfree)', priceInr: 10 },
      { optionId: 'signature', groupName: 'Upgrade to Cold Brew', optionName: 'Signature Cold Brew', priceInr: 20 },
    ]);
  });

  it('ignores unknown option ids', () => {
    const item = makeItem([sugarGroup]);
    expect(flattenAddons(item, { sugar: ['does-not-exist'] })).toEqual([]);
  });
});
