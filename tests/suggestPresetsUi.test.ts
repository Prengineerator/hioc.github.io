import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// Coffey "Made your way" presets (add-on + sugar toggles on the card, preselected
// in the customise modal). No DOM: server render of the card plus the pure
// helpers in components/suggest/addonHint.ts.

import { SuggestionCard } from '@/components/suggest/SuggestionCard';
import {
  customizeModalProps,
  needsCustomizeModal,
  presetReasonLine,
  tickedPick,
} from '@/components/suggest/addonHint';
import { initialSelection } from '@/lib/menu/customization';
import type {
  AddonPreset,
  FlavourAddonSuggestion,
  SugarPreset,
  SuggestionPick,
} from '@/lib/suggest/types';
import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';

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
  matchTags: ['Cosy'],
  ...over,
});


const hazelPreset: AddonPreset = {
  groupId: 'g-syrup',
  optionId: 'o-hazelnut',
  label: 'Hazelnut syrup',
  priceInr: 35,
  purpose: 'flavour',
  family: 'nutty',
};
const shotPreset: AddonPreset = {
  groupId: 'g-syrup',
  optionId: 'o-vanilla',
  label: 'Espresso Shot',
  priceInr: 40,
  purpose: 'strength',
};

const render = (p: SuggestionPick, unticked: string[] = [], isUsual = false) =>
  renderToStaticMarkup(
    createElement(SuggestionCard, {
      item: item(),
      pick: p,
      isUsual,
      untickedOptionIds: new Set(unticked),
      onTogglePreset: () => {},
      onAddToCart: () => {},
      onFeedback: () => {},
    }),
  );
// React separates adjacent text nodes with comments in static markup.
const text = (html: string) => html.replace(/<!-- -->/g, '');

describe('SuggestionCard "Made your way"', () => {
  it('shows one pressed chip per preset with its label and mono price', () => {
    const html = text(render(pick({ addonPresets: [hazelPreset], sugarPreset: sugarNone })));
    expect(html).toContain('Made your way');
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(2);
    expect(html).toContain('Hazelnut syrup');
    expect(html).toContain('<span class="font-mono tabular-nums">+₹35</span>');
    expect(html).toContain('No Sugar');
    expect(html).toContain('✓');
  });

  it('puts the ticked add-on in the name, and drops it when un-ticked', () => {
    const on = text(render(pick({ addonPresets: [hazelPreset] })));
    expect(on).toContain('Cappucino<span class="font-normal text-muted"> + Hazelnut syrup</span>');
    const off = text(render(pick({ addonPresets: [hazelPreset] }), ['o-hazelnut']));
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain(' + Hazelnut syrup');
    expect(off).not.toContain('Added for the');
  });

  it('un-ticks the sugar chip too', () => {
    const html = render(pick({ sugarPreset: sugarNone }), ['o-nosugar']);
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('gives the reason for flavour, strength and both', () => {
    expect(text(render(pick({ addonPresets: [hazelPreset] })))).toContain('Added for the nutty flavour.');
    expect(text(render(pick({ addonPresets: [shotPreset] })))).toContain('An extra shot makes it strong.');
    expect(text(render(pick({ addonPresets: [hazelPreset, shotPreset] })))).toContain(
      'Added for the nutty flavour. An extra shot makes it strong.',
    );
    expect(presetReasonLine([])).toBe('');
  });

  it('shows no row for a pick without presets, and no tip when presets exist', () => {
    expect(render(pick())).not.toContain('Made your way');
    expect(render(pick({ addonPresets: [], sugarPreset: null }))).not.toContain('Made your way');
    expect(render(pick({ addonPresets: [hazelPreset], flavourAddon: hazelnutOld }))).not.toContain('Coffey tip');
  });

  it('keeps the fallback tip for an old-style flavourAddon without presets', () => {
    expect(render(pick({ flavourAddon: hazelnutOld }))).toContain('Coffey tip: try it with Hazelnut syrup');
  });

  it('shows the row on "Your usual"', () => {
    const html = render(pick({ addonPresets: [hazelPreset] }), [], true);
    expect(html).toContain('Your usual');
    expect(html).toContain('Made your way');
  });

  it('shows no combined total', () => {
    expect(render(pick({ addonPresets: [hazelPreset] }))).toContain('₹160');
    expect(render(pick({ addonPresets: [hazelPreset] }))).not.toContain('₹195');
  });
});

const hazelnutOld: FlavourAddonSuggestion = {
  groupId: 'g-syrup',
  optionId: 'o-hazelnut',
  label: 'Hazelnut syrup',
  priceInr: 35,
  family: 'nutty',
};

describe('needsCustomizeModal with presets', () => {
  it('opens the modal for a ticked preset or sugar preset on a simple item', () => {
    expect(needsCustomizeModal(simpleItem, pick({ addonPresets: [hazelPreset] }))).toBe(true);
    expect(needsCustomizeModal(simpleItem, pick({ sugarPreset: sugarNone }))).toBe(true);
  });
  it('follows today\'s rule once everything is un-ticked', () => {
    const t = tickedPick(pick({ addonPresets: [hazelPreset], sugarPreset: sugarNone }), new Set(['o-hazelnut', 'o-nosugar']));
    expect(t.addonPresets).toEqual([]);
    expect(t.sugarPreset).toBeNull();
    expect(needsCustomizeModal(simpleItem, t)).toBe(false);
  });
  it('tickedPick drops the old flavourAddon only when presets exist', () => {
    expect(tickedPick(pick({ addonPresets: [hazelPreset], flavourAddon: hazelnutOld }), new Set()).flavourAddon).toBeNull();
    expect(tickedPick(pick({ flavourAddon: hazelnutOld }), new Set()).flavourAddon).toEqual(hazelnutOld);
  });
});

describe('customizeModalProps with addon presets', () => {
  it('preselects ticked add-ons through initialSelection, and marks them as Coffey\'s pick', () => {
    const props = customizeModalProps(item(), { addonPresets: [hazelPreset] });
    expect(props.initialSelection).toEqual({ 'g-syrup': ['o-hazelnut'] });
    expect(props.suggestedOptions).toEqual({ 'g-syrup': ['o-hazelnut'] });
    expect(initialSelection(item(), props.initialSelection)['g-syrup']).toEqual(['o-hazelnut']);
    expect(initialSelection(item(), props.initialSelection)['g-sugar']).toEqual(initialSelection(item())['g-sugar']);
  });

  it('does not preselect un-ticked ones (the caller leaves them out)', () => {
    const t = tickedPick(pick({ addonPresets: [hazelPreset, shotPreset] }), new Set(['o-hazelnut']));
    const props = customizeModalProps(item(), { addonPresets: t.addonPresets });
    expect(props.initialSelection).toEqual({ 'g-syrup': ['o-vanilla'] });
  });

  it('drops options missing from the item, switched off, or over max_select', () => {
    const missing = { ...hazelPreset, optionId: 'o-ghost' };
    const off = { ...hazelPreset, optionId: 'o-caramel' };
    expect(customizeModalProps(item(), { addonPresets: [missing, off] })).toEqual({});
    const third: AddonPreset = { ...hazelPreset, optionId: 'o-extra', label: 'Extra' };
    const wide = item({
      addon_groups: [
        sugarGroup,
        { ...syrupGroup, options: [...syrupGroup.options, option('o-extra', 'g-syrup', 'Extra', 10, 30)] },
      ],
    });
    const props = customizeModalProps(wide, { addonPresets: [hazelPreset, shotPreset, third] });
    expect(props.initialSelection).toEqual({ 'g-syrup': ['o-hazelnut', 'o-vanilla'] });
    expect(props.hint?.[0]).not.toContain('Extra');
  });

  it('writes the hint for each combination', () => {
    const hint = (e: Parameters<typeof customizeModalProps>[1]) => customizeModalProps(item(), e).hint;
    expect(hint({ addonPresets: [hazelPreset] })).toEqual([
      "Coffey added Hazelnut syrup (+₹35). Untick it if you'd rather not.",
    ]);
    expect(hint({ addonPresets: [hazelPreset, shotPreset] })).toEqual([
      "Coffey added Hazelnut syrup (+₹35) and Espresso Shot (+₹40). Untick anything you don't want.",
    ]);
    expect(hint({ addonPresets: [hazelPreset], sugarPreset: sugarNone })).toEqual([
      "Coffey added Hazelnut syrup (+₹35) and set sugar to No Sugar. Untick anything you don't want.",
    ]);
    expect(hint({ sugarPreset: sugarNone })).toEqual(['Coffey set sugar to “No Sugar” for you — change it anytime.']);
    expect(hint({})).toBeUndefined();
    expect(hint({ addonPresets: [{ ...hazelPreset, priceInr: 0 }] })?.[0]).toBe(
      "Coffey added Hazelnut syrup. Untick it if you'd rather not.",
    );
  });

  it('also preselects sugar next to an add-on, and with no presets equals today', () => {
    const props = customizeModalProps(item(), { addonPresets: [hazelPreset], sugarPreset: sugarNone });
    expect(props.initialSelection).toEqual({ 'g-syrup': ['o-hazelnut'], 'g-sugar': ['o-nosugar'] });
    expect(customizeModalProps(item(), { addonPresets: [] })).toEqual({});
    expect(customizeModalProps(item(), { sugarPreset: sugarNone, addonPresets: [] })).toEqual(
      customizeModalProps(item(), { sugarPreset: sugarNone }),
    );
  });
});
