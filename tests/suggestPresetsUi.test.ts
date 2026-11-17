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
  presetView,
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

// ---------------------------------------------------------------------------
// Un-ticking must not leave a false card (presetView, shared by card + modal)
// ---------------------------------------------------------------------------

const sugarPlain: SugarPreset = { groupId: 'g-sugar', optionId: 'o-normal', label: 'Normal' };
const tagged = (p: AddonPreset, tag: string): AddonPreset => ({ ...p, tag });
const hz = tagged(hazelPreset, 'Nutty');
const sh = tagged(shotPreset, 'Strong');
const full = (over: Partial<SuggestionPick> = {}) =>
  pick({
    reason: 'nutty notes from Hazelnut syrup',
    matchTags: ['Cosy', 'Nutty', 'Strong'],
    addonPresets: [hz, sh],
    sugarPreset: sugarNone,
    plain: { reason: 'Mellow and silky', sugarPreset: sugarPlain },
    ...over,
  });

describe('presetView', () => {
  const view = (p: SuggestionPick, off: string[] = []) => presetView(item(), p, new Set(off));

  it('everything ticked: pick as sent', () => {
    const v = view(full());
    expect(v.tags).toEqual(['Cosy', 'Nutty', 'Strong']);
    expect(v.reason).toBe('nutty notes from Hazelnut syrup');
    expect(v.withoutLine).toBeNull();
    expect(v.sugar).toEqual(sugarNone);
    expect(v.sugarTicked).toBe(true);
  });

  it('flavour un-ticked: tag gone, plain reason, Without line, plain sugar', () => {
    const v = view(full(), ['o-hazelnut']);
    expect(v.tags).toEqual(['Cosy', 'Strong']);
    expect(v.reason).toBe('Mellow and silky');
    expect(v.withoutLine).toBe('Without Hazelnut syrup: not nutty');
    expect(v.sugar).toEqual(sugarPlain);
    expect(v.ticked).toEqual([sh]);
    expect(v.chips).toEqual([hz, sh]);
  });

  it('strength un-ticked: sugar unchanged, plain reason, "not strong"', () => {
    const v = view(full(), ['o-vanilla']);
    expect(v.tags).toEqual(['Cosy', 'Nutty']);
    expect(v.reason).toBe('Mellow and silky');
    expect(v.withoutLine).toBe('Without Espresso Shot: not strong');
    expect(v.sugar).toEqual(sugarNone);
  });

  it('both un-ticked: one line joined with a middle dot', () => {
    const v = view(full(), ['o-hazelnut', 'o-vanilla']);
    expect(v.tags).toEqual(['Cosy']);
    expect(v.withoutLine).toBe('Without Hazelnut syrup: not nutty · Without Espresso Shot: not strong');
    expect(v.ticked).toEqual([]);
  });

  it('without plain: reason stays, sugar stays', () => {
    const v = view(full({ plain: undefined }), ['o-hazelnut']);
    expect(v.reason).toBe('nutty notes from Hazelnut syrup');
    expect(v.sugar).toEqual(sugarNone);
    expect(v.tags).toEqual(['Cosy', 'Strong']);
  });

  it('plain.sugarPreset null: no sugar chip after the flavour is un-ticked', () => {
    const v = view(full({ plain: { reason: 'Plain', sugarPreset: null } }), ['o-hazelnut']);
    expect(v.sugar).toBeNull();
    expect(tickedPick(full({ plain: { reason: 'Plain', sugarPreset: null } }), new Set(['o-hazelnut']), item()).sugarPreset).toBeNull();
    const html = render(full({ plain: { reason: 'Plain', sugarPreset: null } }), ['o-hazelnut']);
    expect(html).not.toContain('No Sugar');
  });

  it('customer sugar un-tick wins, keyed by the option shown', () => {
    expect(view(full(), ['o-nosugar']).sugarTicked).toBe(false);
    const swapped = view(full(), ['o-hazelnut', 'o-normal']);
    expect(swapped.sugar).toEqual(sugarPlain);
    expect(swapped.sugarTicked).toBe(false);
    // un-ticking the syrup's sugar does not un-tick the plain one
    expect(view(full(), ['o-hazelnut', 'o-nosugar']).sugarTicked).toBe(true);
  });

  it('tickedPick agrees with the card in every case', () => {
    const cases = [[], ['o-hazelnut'], ['o-vanilla'], ['o-hazelnut', 'o-vanilla'], ['o-nosugar'], ['o-hazelnut', 'o-normal']];
    for (const off of cases) {
      const v = view(full(), off);
      const t = tickedPick(full(), new Set(off), item());
      expect(t.addonPresets).toEqual(v.ticked);
      expect(t.sugarPreset).toEqual(v.sugarTicked ? v.sugar : null);
      expect(t.matchTags).toEqual(v.tags);
      expect(t.reason).toBe(v.reason);
      const html = text(render(full(), off));
      expect(html).toContain(v.reason);
      for (const tag of v.tags) expect(html).toContain(tag);
      if (v.withoutLine) expect(html).toContain(v.withoutLine);
      else expect(html).not.toContain('Without ');
    }
  });
});

describe('presets the customise screen would drop', () => {
  it('missing option: no chip, tag and reason revert, Without line shown', () => {
    const ghost = tagged({ ...hazelPreset, optionId: 'o-ghost' }, 'Nutty');
    const p = full({ addonPresets: [ghost] });
    const html = text(render(p));
    expect(html).not.toContain('+₹35');
    expect(html).not.toContain('Hazelnut syrup</button>');
    expect(html).toContain('Without Hazelnut syrup: not nutty');
    expect(html).toContain('Mellow and silky');
    expect(html).not.toContain('Added for the nutty');
  });

  it('switched-off option behaves the same', () => {
    const off = tagged({ ...hazelPreset, optionId: 'o-caramel', label: 'Caramel syrup' }, 'Nutty');
    const v = presetView(item(), full({ addonPresets: [off] }), new Set());
    expect(v.chips).toEqual([]);
    expect(v.ticked).toEqual([]);
    expect(v.withoutLine).toBe('Without Caramel syrup: not nutty');
    expect(v.sugar).toEqual(sugarPlain);
  });

  it('over max_select: the extra preset is not shown ticked and not passed on', () => {
    const wide = item({
      addon_groups: [
        sugarGroup,
        { ...syrupGroup, max_select: 1 },
      ],
    });
    const p = full();
    const v = presetView(wide, p, new Set());
    expect(v.ticked).toEqual([hz]);
    expect(v.chips).toEqual([hz]);
    expect(v.withoutLine).toBe('Without Espresso Shot: not strong');
    expect(tickedPick(p, new Set(), wide).addonPresets).toEqual([hz]);
    const html = renderToStaticMarkup(
      createElement(SuggestionCard, { item: wide, pick: p, onAddToCart: () => {}, onFeedback: () => {} }),
    );
    expect(html).not.toContain('Espresso Shot +');
    expect(html).toContain('Without Espresso Shot: not strong');
  });

  it('an invalid sugar preset is not drawn', () => {
    const v = presetView(item(), pick({ sugarPreset: { ...sugarNone, optionId: 'o-ghost' } }), new Set());
    expect(v.sugar).toBeNull();
  });
});

describe('"Your usual" without presets', () => {
  it('renders no Made your way row', () => {
    const html = render(pick({ addonPresets: undefined, sugarPreset: null }), [], true);
    expect(html).toContain('Your usual');
    expect(html).not.toContain('Made your way');
  });
});
