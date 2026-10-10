import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// Coffey add-on flavours (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §1.1) — the UI
// side. There is no DOM in this suite, so this covers the pure rules the UI is
// built on (components/suggest/addonHint.ts, lib/menu/customization.ts), plus a
// server render of the card, which has no portal. The rules that matter:
//   - the card shows "Coffey tip: try it with {label}" and never a price;
//   - a pick with a flavour add-on never takes the one-tap Add;
//   - the suggested option is highlighted, never preselected (§4.7: a preset
//     must never quietly add to the bill);
//   - the hints read right for every family, and stack with sugar first.

import { ItemCustomizer } from '@/components/menu/ItemCustomizer';
import { SuggestionCard } from '@/components/suggest/SuggestionCard';
import {
  coffeyTip,
  customizeModalProps,
  flavourAddonHint,
  needsCustomizeModal,
  sugarPresetHint,
} from '@/components/suggest/addonHint';
import { initialSelection, suggestedOptionIds } from '@/lib/menu/customization';
import { FLAVOUR_FAMILY_INFO } from '@/lib/suggest/traitVocabulary';
import {
  FLAVOUR_FAMILIES,
  type FlavourAddonSuggestion,
  type FlavourFamily,
  type SugarPreset,
  type SuggestionPick,
} from '@/lib/suggest/types';
import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';

// ---------------------------------------------------------------------------
// Fixtures: a Cappucino shaped like the live menu (required sugar, an optional
// "Add a Syrup" group).
// ---------------------------------------------------------------------------

const option = (id: string, groupId: string, name: string, price: number, sort: number, extra: Partial<AddonOption> = {}): AddonOption => ({
  id,
  addon_group_id: groupId,
  name,
  price_inr: price,
  sort_order: sort,
  ...extra,
});

const sugarGroup: AddonGroup = {
  id: 'g-sugar',
  name: 'Sugar',
  display_name: 'Choice of Sugar',
  selection_type: 'single',
  min_select: 1,
  max_select: 1,
  sort_order: 10,
  options: [option('o-nosugar', 'g-sugar', 'No Sugar', 0, 0), option('o-normal', 'g-sugar', 'Normal', 0, 10)],
};

const syrupGroup: AddonGroup = {
  id: 'g-syrup',
  name: 'Add a Syrup',
  display_name: 'Add a Syrup',
  selection_type: 'multi',
  min_select: 0,
  max_select: 2,
  sort_order: 20,
  options: [
    option('o-vanilla', 'g-syrup', 'Vanilla', 35, 0),
    option('o-hazelnut', 'g-syrup', 'Hazelnut', 35, 10),
    option('o-caramel', 'g-syrup', 'Caramel', 35, 20, { is_available: false }),
  ],
};

const item = (over: Partial<MenuItem> = {}): MenuItem => ({
  id: 'm-capp',
  name: 'Cappucino',
  description: 'Espresso with steamed milk',
  category: 'Hot Coffee',
  parent_category: 'Coffee',
  is_veg: true,
  is_available: true,
  sort_order: 1,
  image_url: '',
  unavailable_until: null,
  short_code: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  variants: [{ id: 'v-reg', menu_item_id: 'm-capp', label: 'Regular', price_inr: 160, sort_order: 0 }],
  addon_groups: [sugarGroup, syrupGroup],
  ...over,
});

/** A one-size item with no add-ons at all: the one-tap case. */
const simpleItem = item({ addon_groups: [] });

const hazelnut: FlavourAddonSuggestion = {
  groupId: 'g-syrup',
  optionId: 'o-hazelnut',
  label: 'Hazelnut syrup',
  priceInr: 35,
  family: 'nutty',
};

const sugarNone: SugarPreset = { groupId: 'g-sugar', optionId: 'o-nosugar', label: 'No Sugar' };

const pick = (over: Partial<SuggestionPick> = {}): SuggestionPick => ({
  menuItemId: 'm-capp',
  reason: 'Mellow and silky, with toasty nutty notes from Hazelnut syrup — easy to sip while you focus.',
  reasonCode: 'trait',
  matchTags: ['Nutty add-on'],
  ...over,
});

// ---------------------------------------------------------------------------
// Card: the tip line
// ---------------------------------------------------------------------------

describe('SuggestionCard tip line', () => {
  const render = (p: SuggestionPick, i: MenuItem = item()) =>
    renderToStaticMarkup(createElement(SuggestionCard, { item: i, pick: p, onAddToCart: () => {}, onFeedback: () => {} }));

  it('says "Coffey tip: try it with {label}" under the match tags when the pick carries a flavour add-on', () => {
    const html = render(pick({ flavourAddon: hazelnut }));
    expect(html).toContain('Coffey tip: try it with Hazelnut syrup');
    expect(coffeyTip(hazelnut)).toBe('Coffey tip: try it with Hazelnut syrup');
    // After the tags, so it reads as a quiet footnote to them.
    expect(html.indexOf('Nutty add-on')).toBeGreaterThan(-1);
    expect(html.indexOf('Coffey tip:')).toBeGreaterThan(html.indexOf('Nutty add-on'));
  });

  it('shows it even when the pick has no match tags', () => {
    expect(render(pick({ matchTags: undefined, flavourAddon: hazelnut }))).toContain('Coffey tip: try it with Hazelnut syrup');
  });

  it('never shows the add-on price on the card (Coffey does not talk about spending)', () => {
    const html = render(pick({ flavourAddon: hazelnut }));
    expect(html).not.toContain('₹35');
    expect(html).not.toContain('+35');
    expect(coffeyTip(hazelnut)).not.toMatch(/₹|\d/);
    // The item's own price is still there.
    expect(html).toContain('₹160');
  });

  it('is absent when there is no flavour add-on (null, undefined)', () => {
    expect(render(pick())).not.toContain('Coffey tip');
    expect(render(pick({ flavourAddon: null }))).not.toContain('Coffey tip');
  });

  it('uses muted, small brand tokens only', () => {
    const html = render(pick({ flavourAddon: hazelnut }));
    const tip = html.match(/<p class="([^"]*)">Coffey tip/);
    expect(tip?.[1]).toBe('mt-2 text-xs text-muted');
  });
});

// ---------------------------------------------------------------------------
// Add: never the one-tap path
// ---------------------------------------------------------------------------

describe('needsCustomizeModal (Add never one-taps a pick with a flavour add-on)', () => {
  it('lets a plain one-size, no-add-on item take the one-tap path (today\'s behaviour)', () => {
    expect(needsCustomizeModal(simpleItem, pick())).toBe(false);
    expect(needsCustomizeModal(simpleItem, pick({ flavourAddon: null }))).toBe(false);
  });

  it('opens the modal for a simple-looking item once the pick carries a flavour add-on', () => {
    expect(needsCustomizeModal(simpleItem, pick({ flavourAddon: hazelnut }))).toBe(true);
  });

  it('still opens the modal for several sizes or any add-on group, as before', () => {
    expect(needsCustomizeModal(item(), pick())).toBe(true);
    const twoSizes = item({
      addon_groups: [],
      variants: [
        { id: 'v1', menu_item_id: 'm-capp', label: 'Small', price_inr: 120, sort_order: 0 },
        { id: 'v2', menu_item_id: 'm-capp', label: 'Large', price_inr: 160, sort_order: 1 },
      ],
    });
    expect(needsCustomizeModal(twoSizes, pick())).toBe(true);
  });

  it('is what the wizard actually asks, and the wizard carries the add-on to the modal as suggestedOptions', () => {
    const wizard = readFileSync('components/suggest/SuggestWizard.tsx', 'utf8');
    expect(wizard).toContain('needsCustomizeModal(item, pick)');
    expect(wizard).toContain('flavourAddon: pick.flavourAddon ?? null');
    expect(wizard).toContain('suggestedOptions={suggestedOptions}');
    // The flavour add-on is never fed into initialSelection (nothing preselected).
    expect(wizard).not.toMatch(/initialSelection=\{[^}]*flavourAddon/);
  });
});

// ---------------------------------------------------------------------------
// Modal: which suggestions are real, and nothing is preselected
// ---------------------------------------------------------------------------

describe('suggestedOptionIds (what gets the "Coffey\'s pick" pill)', () => {
  it('keeps a suggestion that names a real, available option in its own group', () => {
    expect([...suggestedOptionIds(item(), { 'g-syrup': ['o-hazelnut'] })]).toEqual(['o-hazelnut']);
  });

  it('treats an option with no is_available field as on', () => {
    expect(suggestedOptionIds(item(), { 'g-syrup': ['o-vanilla'] }).has('o-vanilla')).toBe(true);
  });

  it('drops an option that is switched off (is_available === false)', () => {
    expect(suggestedOptionIds(item(), { 'g-syrup': ['o-caramel'] }).size).toBe(0);
  });

  it('drops a group the item does not have', () => {
    expect(suggestedOptionIds(item(), { 'g-nope': ['o-hazelnut'] }).size).toBe(0);
  });

  it('drops an option that is not in the named group, even if it exists elsewhere on the item', () => {
    expect(suggestedOptionIds(item(), { 'g-sugar': ['o-hazelnut'] }).size).toBe(0);
    expect(suggestedOptionIds(item(), { 'g-syrup': ['o-nosugar'] }).size).toBe(0);
  });

  it('drops an unknown option id and keeps the good ones next to it', () => {
    expect([...suggestedOptionIds(item(), { 'g-syrup': ['o-ghost', 'o-vanilla'] })]).toEqual(['o-vanilla']);
  });

  it('is empty when nothing is suggested, which is every existing caller', () => {
    expect(suggestedOptionIds(item()).size).toBe(0);
    expect(suggestedOptionIds(item(), {}).size).toBe(0);
    expect(suggestedOptionIds(simpleItem, { 'g-syrup': ['o-hazelnut'] }).size).toBe(0);
  });
});

describe('customizeModalProps: highlight, never preselect', () => {
  it('passes the add-on as suggestedOptions and leaves initialSelection alone', () => {
    const props = customizeModalProps(item(), { sugarPreset: null, flavourAddon: hazelnut });
    expect(props.suggestedOptions).toEqual({ 'g-syrup': ['o-hazelnut'] });
    expect(props.initialSelection).toBeUndefined();
  });

  it('opens with the same selection as without the add-on: only the required defaults', () => {
    const withAddon = customizeModalProps(item(), { flavourAddon: hazelnut });
    const without = customizeModalProps(item(), {});
    const opened = initialSelection(item(), withAddon.initialSelection);
    expect(opened).toEqual(initialSelection(item(), without.initialSelection));
    expect(opened['g-syrup']).toEqual([]);
    expect(Object.values(opened).flat()).not.toContain('o-hazelnut');
  });

  it('keeps the sugar preset as the only preselection when both are present', () => {
    const props = customizeModalProps(item(), { sugarPreset: sugarNone, flavourAddon: hazelnut });
    expect(props.initialSelection).toEqual({ 'g-sugar': ['o-nosugar'] });
    expect(props.suggestedOptions).toEqual({ 'g-syrup': ['o-hazelnut'] });
    const opened = initialSelection(item(), props.initialSelection);
    expect(opened['g-sugar']).toEqual(['o-nosugar']);
    expect(opened['g-syrup']).toEqual([]);
  });

  it('is empty for a pick with neither (today\'s behaviour)', () => {
    expect(customizeModalProps(item(), {})).toEqual({});
    expect(customizeModalProps(item(), { sugarPreset: null, flavourAddon: null })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Option rows: the "Coffey's pick" pill (server-rendered; ItemCustomizer has no portal)
// ---------------------------------------------------------------------------

describe('ItemCustomizer "Coffey\'s pick" pill', () => {
  const PILL = 'Coffey&#x27;s pick';
  const render = (suggested?: ReadonlySet<string>) =>
    renderToStaticMarkup(
      createElement(ItemCustomizer, {
        item: item(),
        variantId: 'v-reg',
        onVariantChange: () => {},
        selection: initialSelection(item()),
        onToggle: () => {},
        instructions: '',
        onInstructionsChange: () => {},
        suggestedOptionIds: suggested,
      }),
    );
  /** The <button> markup of one option row. */
  const row = (html: string, name: string) => {
    const buttons = html.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    return buttons.find((b) => b.includes(name)) ?? '';
  };

  it('puts the pill on the suggested option\'s row only, as text inside the button', () => {
    const html = render(suggestedOptionIds(item(), { 'g-syrup': ['o-hazelnut'] }));
    expect(html.split(PILL).length - 1).toBe(1);
    expect(row(html, 'Hazelnut')).toContain(PILL);
    expect(row(html, 'Vanilla')).not.toContain(PILL);
    expect(row(html, 'Normal')).not.toContain(PILL);
  });

  it('does not select the suggested option', () => {
    const html = render(suggestedOptionIds(item(), { 'g-syrup': ['o-hazelnut'] }));
    expect(row(html, 'Hazelnut')).toContain('aria-pressed="false"');
  });

  it('draws no pill for a suggestion the item cannot show', () => {
    expect(render(suggestedOptionIds(item(), { 'g-syrup': ['o-caramel'] }))).not.toContain(PILL);
    expect(render(suggestedOptionIds(item(), { 'g-ghost': ['o-hazelnut'] }))).not.toContain(PILL);
  });

  it('is unchanged for callers that pass nothing (the menu page, the POS)', () => {
    expect(render()).not.toContain(PILL);
    expect(render()).toBe(render(new Set()));
  });
});

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

describe('flavourAddonHint', () => {
  const addon = (family: FlavourFamily): FlavourAddonSuggestion => ({ ...hazelnut, family });

  it('reads like the spec for nutty', () => {
    expect(flavourAddonHint(hazelnut)).toBe(
      'For the nutty notes you asked for, Coffey suggests Hazelnut syrup — tap it to add.',
    );
  });

  it.each([
    ['chocolatey', 'For the chocolatey notes you asked for, Coffey suggests Hazelnut syrup — tap it to add.'],
    ['caramel', 'For the caramel & toffee notes you asked for, Coffey suggests Hazelnut syrup — tap it to add.'],
    ['nutty', 'For the nutty notes you asked for, Coffey suggests Hazelnut syrup — tap it to add.'],
    ['biscuit', 'For the cookies & biscuit notes you asked for, Coffey suggests Hazelnut syrup — tap it to add.'],
    ['fruity', 'For the fruity notes you asked for, Coffey suggests Hazelnut syrup — tap it to add.'],
    ['spiced', 'For the warm spice notes you asked for, Coffey suggests Hazelnut syrup — tap it to add.'],
    ['floral', 'For the floral & tea notes you asked for, Coffey suggests Hazelnut syrup — tap it to add.'],
  ] as const)('names the %s family the way its chip does', (family, expected) => {
    expect(flavourAddonHint(addon(family))).toBe(expected);
  });

  it('covers every flavour family, without doubling "notes" or mentioning a price', () => {
    for (const family of FLAVOUR_FAMILIES) {
      const hint = flavourAddonHint(addon(family));
      expect(hint).toContain(`For the ${FLAVOUR_FAMILY_INFO[family].label.toLowerCase()} notes you asked for`);
      expect(hint).not.toMatch(/notes notes/i);
      expect(hint).not.toMatch(/₹|\d/);
      // The family word stays short enough not to push the sentence a line further.
      expect(FLAVOUR_FAMILY_INFO[family].label.length).toBeLessThanOrEqual(17);
    }
  });
});

describe('customizeModalProps hints', () => {
  it('has the sugar hint alone for a sugar-only pick, unchanged from before', () => {
    expect(customizeModalProps(item(), { sugarPreset: sugarNone }).hint).toEqual([
      'Coffey set sugar to “No Sugar” for you — change it anytime.',
    ]);
    expect(sugarPresetHint(sugarNone)).toBe('Coffey set sugar to “No Sugar” for you — change it anytime.');
  });

  it('has the flavour hint alone for a flavour-only pick', () => {
    expect(customizeModalProps(item(), { flavourAddon: hazelnut }).hint).toEqual([flavourAddonHint(hazelnut)]);
  });

  it('stacks both hints, sugar first', () => {
    expect(customizeModalProps(item(), { sugarPreset: sugarNone, flavourAddon: hazelnut }).hint).toEqual([
      sugarPresetHint(sugarNone),
      flavourAddonHint(hazelnut),
    ]);
  });

  it('has no hint when there is nothing to say', () => {
    expect(customizeModalProps(item(), {}).hint).toBeUndefined();
  });

  it('does not tell the customer to "tap" a suggestion the item cannot show (unknown or switched-off option)', () => {
    const gone = customizeModalProps(item(), { flavourAddon: { ...hazelnut, optionId: 'o-ghost' } });
    expect(gone.hint).toBeUndefined();
    const off = customizeModalProps(item(), { flavourAddon: { ...hazelnut, optionId: 'o-caramel', label: 'Caramel syrup' } });
    expect(off.hint).toBeUndefined();
    // The sugar hint still stands on its own.
    const sugarOnly = customizeModalProps(item(), { sugarPreset: sugarNone, flavourAddon: { ...hazelnut, optionId: 'o-ghost' } });
    expect(sugarOnly.hint).toEqual([sugarPresetHint(sugarNone)]);
  });
});
