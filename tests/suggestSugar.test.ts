import { describe, expect, it } from 'vitest';
import {
  achievableSweetness,
  findSugarGroup,
  isSugarAdjustable,
  sugarPresetFor,
} from '@/lib/suggest/sugar';
import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';
import { SWEETNESS_PREFS, SWEETNESS_SCALE, type SweetnessPref } from '@/lib/suggest/types';
import { buildSugarGroup, makeMenuItem } from './fixtures/suggestMenu';

// COFFEY-SPEC §4.7 — sugar presets. "Live data" below is the real production
// group (2026-09-29): 'Sugar' / 'Choice of Sugar', single, required, with
// Stevia (sugarfree) ₹10, Brown Sugar, No Sugar and Normal — see buildSugarGroup.

function itemWith(...groups: AddonGroup[]): MenuItem {
  return makeMenuItem({ id: 'latte', name: 'Latte', priceInr: 140, addon_groups: groups });
}

function group(over: Partial<AddonGroup> & { options: AddonOption[] }): AddonGroup {
  return {
    id: 'g1',
    name: 'Sugar',
    display_name: 'Choice of Sugar',
    selection_type: 'single',
    min_select: 1,
    max_select: 1,
    sort_order: 0,
    ...over,
  };
}

function option(id: string, name: string, over: Partial<AddonOption> = {}): AddonOption {
  return { id, addon_group_id: 'g1', name, price_inr: 0, sort_order: 0, ...over };
}

describe('findSugarGroup', () => {
  it('finds the live "Choice of Sugar" group and returns its No Sugar and Normal options', () => {
    const live = buildSugarGroup('live');
    const match = findSugarGroup(itemWith(live));
    expect(match).not.toBeNull();
    expect(match!.group.id).toBe('live-group');
    expect(match!.noSugar.name).toBe('No Sugar');
    expect(match!.normal.name).toBe('Normal');
  });

  it("matches on the group `name` 'Sugar' alone, case-insensitively, whatever the display name says", () => {
    for (const name of ['Sugar', 'sugar', 'SUGAR', ' Sugar ']) {
      const g = group({
        name,
        display_name: 'Sweetness',
        options: [option('a', 'No Sugar'), option('b', 'Normal')],
      });
      expect(findSugarGroup(itemWith(g)), name).not.toBeNull();
    }
  });

  it('matches on a display_name that mentions sugar, whatever the internal name is', () => {
    const g = group({
      name: 'sweetener-choice',
      display_name: 'How much sugar?',
      options: [option('a', 'No Sugar'), option('b', 'Normal')],
    });
    expect(findSugarGroup(itemWith(g))?.group.id).toBe('g1');
  });

  it('ignores option-name case and stray whitespace', () => {
    const g = group({ options: [option('a', '  no   SUGAR '), option('b', 'NORMAL')] });
    const match = findSugarGroup(itemWith(g));
    expect(match?.noSugar.id).toBe('a');
    expect(match?.normal.id).toBe('b');
  });

  it('needs BOTH a No Sugar and a Normal option — a group with only one is not a choice we can steer', () => {
    expect(findSugarGroup(itemWith(group({ options: [option('a', 'No Sugar'), option('s', 'Stevia (sugarfree)')] })))).toBeNull();
    expect(findSugarGroup(itemWith(group({ options: [option('b', 'Normal'), option('s', 'Brown Sugar')] })))).toBeNull();
    expect(findSugarGroup(itemWith(group({ options: [] })))).toBeNull();
  });

  it('ignores a group that is not about sugar, even if it has options with those names', () => {
    const g = group({
      name: 'Milk',
      display_name: 'Choice of Milk',
      options: [option('a', 'No Sugar'), option('b', 'Normal')],
    });
    expect(findSugarGroup(itemWith(g))).toBeNull();
  });

  it('does not count an option that is switched off (is_available === false)', () => {
    const noSugarOff = group({ options: [option('a', 'No Sugar', { is_available: false }), option('b', 'Normal')] });
    const normalOff = group({ options: [option('a', 'No Sugar'), option('b', 'Normal', { is_available: false })] });
    expect(findSugarGroup(itemWith(noSugarOff))).toBeNull();
    expect(findSugarGroup(itemWith(normalOff))).toBeNull();
    // An option that says nothing about availability is on; an explicit true is on too.
    const on = group({ options: [option('a', 'No Sugar', { is_available: true }), option('b', 'Normal')] });
    expect(findSugarGroup(itemWith(on))).not.toBeNull();
  });

  it('returns null when the item has no add-on groups at all', () => {
    expect(findSugarGroup(itemWith())).toBeNull();
    expect(findSugarGroup({ addon_groups: undefined as unknown as AddonGroup[] })).toBeNull();
  });

  it('takes the first qualifying group when there are several', () => {
    const first = group({ id: 'first', options: [option('a1', 'No Sugar'), option('b1', 'Normal')] });
    const second = group({ id: 'second', options: [option('a2', 'No Sugar'), option('b2', 'Normal')] });
    expect(findSugarGroup(itemWith(first, second))?.group.id).toBe('first');
  });

  it('skips a non-qualifying sugar-looking group and finds the qualifying one after it', () => {
    const syrup = group({ id: 'syrup', name: 'Syrup', display_name: 'Sugar syrup', options: [option('x', 'Vanilla')] });
    const real = buildSugarGroup('real');
    expect(findSugarGroup(itemWith(syrup, real))?.group.id).toBe('real-group');
  });
});

describe('isSugarAdjustable', () => {
  it('is true exactly when there is a sugar group to steer', () => {
    expect(isSugarAdjustable(itemWith(buildSugarGroup()))).toBe(true);
    expect(isSugarAdjustable(itemWith())).toBe(false);
  });
});

describe('achievableSweetness', () => {
  it('is the item\'s own level when sugar cannot be adjusted, whatever the target', () => {
    for (const target of [0, 3, 5, 7, 10]) {
      expect(achievableSweetness(4, false, target)).toBe(4);
    }
  });

  it('clamps the target into [base, min(10, base + sugarAdds)] when sugar can be adjusted', () => {
    // A cold brew at 1: "Normal" sugar takes it as far as 1 + 3 = 4.
    expect(achievableSweetness(1, true, 0)).toBe(1); // sugar can't be taken out
    expect(achievableSweetness(1, true, 3)).toBe(3); // reachable
    expect(achievableSweetness(1, true, 5)).toBe(4); // capped at base + sugarAdds
    expect(achievableSweetness(1, true, 10)).toBe(4);
    // Near the top of the scale the ceiling is the scale itself.
    expect(achievableSweetness(9, true, 10)).toBe(10);
    expect(achievableSweetness(10, true, 5)).toBe(10);
  });

  it('never goes below the base level, and never above the scale', () => {
    for (let base = 0; base <= 10; base++) {
      for (const target of [0, 3, 5, 7, 10]) {
        const a = achievableSweetness(base, true, target);
        expect(a).toBeGreaterThanOrEqual(base);
        expect(a).toBeLessThanOrEqual(Math.min(SWEETNESS_SCALE.max, base + SWEETNESS_SCALE.sugarAdds));
      }
    }
  });
});

describe('sugarPresetFor', () => {
  const live = () => itemWith(buildSugarGroup('live'));

  it("is null for 'any' — the customer expressed no view, so nothing is preselected", () => {
    expect(sugarPresetFor(live(), 'any', 1)).toBeNull();
  });

  it('is null when the item has no sugar group', () => {
    for (const pref of SWEETNESS_PREFS) {
      expect(sugarPresetFor(itemWith(), pref, 1), pref).toBeNull();
    }
  });

  it('is null when the sugar group cannot be steered (a switched-off option)', () => {
    const g = buildSugarGroup('live');
    g.options = g.options.map((o) => (o.name === 'Normal' ? { ...o, is_available: false } : o));
    expect(sugarPresetFor(itemWith(g), 'medium', 1)).toBeNull();
  });

  it('returns { groupId, optionId, label } for the chosen option', () => {
    expect(sugarPresetFor(live(), 'none', 1)).toEqual({
      groupId: 'live-group',
      optionId: 'live-none',
      label: 'No Sugar',
    });
    expect(sugarPresetFor(live(), 'medium', 1)).toEqual({
      groupId: 'live-group',
      optionId: 'live-normal',
      label: 'Normal',
    });
  });

  it('picks whichever of No Sugar (achieves base) and Normal (achieves base + 3) lands nearer the target', () => {
    // base 1: No Sugar → 1, Normal → 4.
    const expected: Record<Exclude<SweetnessPref, 'any'>, 'No Sugar' | 'Normal'> = {
      none: 'No Sugar', // |1-0| = 1 vs |4-0| = 4
      light: 'Normal', // |1-3| = 2 vs |4-3| = 1
      medium: 'Normal', // 4 vs 1
      sweet: 'Normal', // 6 vs 3
      very: 'Normal', // 9 vs 6
    };
    for (const [pref, label] of Object.entries(expected)) {
      expect(sugarPresetFor(live(), pref as SweetnessPref, 1)?.label, pref).toBe(label);
    }
    // base 0 (an espresso): "lightly sweet" is exactly what Normal delivers.
    expect(sugarPresetFor(live(), 'light', 0)?.label).toBe('Normal');
    // An item already sweeter than the ask: sugar can only add, so No Sugar.
    expect(sugarPresetFor(live(), 'light', 6)?.label).toBe('No Sugar');
    expect(sugarPresetFor(live(), 'none', 6)?.label).toBe('No Sugar');
  });

  it('a tie goes to No Sugar', () => {
    // base 1.5: No Sugar → 1.5, Normal → 4.5, and 3 is exactly between them.
    expect(sugarPresetFor(live(), 'light', 1.5)?.label).toBe('No Sugar');
    // At the top of the scale both options land on 10: nothing to choose between.
    for (const pref of ['none', 'light', 'medium', 'sweet', 'very'] as const) {
      expect(sugarPresetFor(live(), pref, 10)?.label, pref).toBe('No Sugar');
    }
  });

  it('never picks Stevia (paid) or Brown Sugar (a flavour choice), for any preference at any base level', () => {
    for (const pref of SWEETNESS_PREFS) {
      for (let base = 0; base <= 10; base++) {
        const preset = sugarPresetFor(live(), pref, base);
        if (preset) {
          expect(['No Sugar', 'Normal'], `${pref}/${base}`).toContain(preset.label);
          expect(preset.optionId).not.toMatch(/stevia|brown/);
        }
      }
    }
  });

  it('never picks an option that costs extra, even if it is No Sugar or Normal', () => {
    // A kitchen that charged for Normal: it is not auto-selected — a preset must
    // never quietly add to the bill — so the free No Sugar is all that is left.
    const g = buildSugarGroup('paid');
    g.options = g.options.map((o) => (o.name === 'Normal' ? { ...o, price_inr: 5 } : o));
    expect(sugarPresetFor(itemWith(g), 'very', 1)?.label).toBe('No Sugar');
    // Both paid: nothing can be preselected.
    g.options = g.options.map((o) => (o.name === 'No Sugar' ? { ...o, price_inr: 5 } : o));
    expect(sugarPresetFor(itemWith(g), 'very', 1)).toBeNull();
  });

  it('uses the option name as the customer-facing label', () => {
    const g = group({ options: [option('a', 'No Sugar'), option('b', 'Normal')] });
    expect(sugarPresetFor(itemWith(g), 'none', 3)?.label).toBe('No Sugar');
  });
});
