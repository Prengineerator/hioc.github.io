import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// "Coffey set this up for you" strip on the customise screen: the pure
// derivation, what customizeModalProps hands over, the server-rendered panel,
// and the toggle through toggleOption (the handler the option chips use).

import { ItemCustomizer } from '@/components/menu/ItemCustomizer';
import { customizeModalProps } from '@/components/suggest/addonHint';
import {
  coffeyStripEntries,
  initialSelection,
  preselectedSuggestions,
  suggestedOptionIds,
  toggleOption,
  visibleHints,
} from '@/lib/menu/customization';
import type { AddonPreset, SugarPreset } from '@/lib/suggest/types';
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
  description: '',
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

const hazel: AddonPreset = { groupId: 'g-syrup', optionId: 'o-hazelnut', label: 'Hazelnut syrup', priceInr: 35, purpose: 'flavour', family: 'nutty' };
const vanilla: AddonPreset = { groupId: 'g-syrup', optionId: 'o-vanilla', label: 'Espresso Shot', priceInr: 40, purpose: 'strength' };
const sugarNone: SugarPreset = { groupId: 'g-sugar', optionId: 'o-nosugar', label: 'No Sugar' };

const sel = (props: ReturnType<typeof customizeModalProps>) => initialSelection(item(), props.initialSelection);

describe('coffeyStripEntries', () => {
  it('one add-on', () => {
    const e = coffeyStripEntries(item(), { 'g-syrup': ['o-hazelnut'] }, { 'g-syrup': ['o-hazelnut'] });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ label: 'Hazelnut syrup', priceInr: 35, required: false, on: true });
    expect(e[0].option.id).toBe('o-hazelnut');
  });

  it('two add-ons, in the item\'s option order', () => {
    const e = coffeyStripEntries(item(), { 'g-syrup': ['o-hazelnut', 'o-vanilla'] }, {});
    expect(e.map((x) => x.label)).toEqual(['Vanilla syrup', 'Hazelnut syrup']);
    expect(e.every((x) => !x.on)).toBe(true);
  });

  it('add-on plus sugar: add-ons first, sugar required', () => {
    const e = coffeyStripEntries(item(), { 'g-sugar': ['o-nosugar'], 'g-syrup': ['o-hazelnut'] }, {
      'g-sugar': ['o-nosugar'],
      'g-syrup': [],
    });
    expect(e.map((x) => [x.label, x.required, x.on])).toEqual([
      ['Hazelnut syrup', false, false],
      ['No Sugar', true, true],
    ]);
  });

  it('sugar only; `on` goes false when another sugar is chosen', () => {
    const e = coffeyStripEntries(item(), { 'g-sugar': ['o-nosugar'] }, { 'g-sugar': ['o-normal'] });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ required: true, on: false, priceInr: 0 });
  });

  it('skips options not on the item, switched off, or in a group it lacks', () => {
    expect(
      coffeyStripEntries(item(), { 'g-syrup': ['o-ghost', 'o-caramel'], 'g-nope': ['o-hazelnut'], 'g-sugar': ['o-hazelnut'] }, {}),
    ).toEqual([]);
    expect(coffeyStripEntries(item(), undefined, {})).toEqual([]);
    expect(coffeyStripEntries(item({ addon_groups: [] }), { 'g-syrup': ['o-hazelnut'] }, {})).toEqual([]);
  });

  it('preselectedSuggestions keeps only what was chosen on open', () => {
    expect(preselectedSuggestions({ 'g-syrup': ['o-hazelnut'] }, { 'g-syrup': [] })).toBeUndefined();
    expect(preselectedSuggestions({ 'g-syrup': ['o-hazelnut', 'o-vanilla'] }, { 'g-syrup': ['o-vanilla'] })).toEqual({
      'g-syrup': ['o-vanilla'],
    });
    expect(preselectedSuggestions(undefined, {})).toBeUndefined();
  });

  it('visibleHints drops the hint only when the strip is drawn', () => {
    expect(visibleHints(['x'], true)).toEqual([]);
    expect(visibleHints(['x'], false)).toEqual(['x']);
  });
});

describe('customizeModalProps puts every preselected option in suggestedOptions', () => {
  it('add-on + sugar', () => {
    const props = customizeModalProps(item(), { addonPresets: [hazel], sugarPreset: sugarNone });
    expect(props.suggestedOptions).toEqual({ 'g-sugar': ['o-nosugar'], 'g-syrup': ['o-hazelnut'] });
    expect(props.initialSelection).toEqual({ 'g-syrup': ['o-hazelnut'], 'g-sugar': ['o-nosugar'] });
  });
  it('sugar whose add-ons were all dropped by vetting', () => {
    const ghost = { ...hazel, optionId: 'o-ghost' };
    const props = customizeModalProps(item(), { addonPresets: [ghost], sugarPreset: sugarNone });
    expect(props.suggestedOptions).toEqual({ 'g-sugar': ['o-nosugar'] });
  });
  it('an unvetted sugar preset is not suggested', () => {
    const props = customizeModalProps(item(), { addonPresets: [hazel], sugarPreset: { ...sugarNone, optionId: 'o-ghost' } });
    expect(props.suggestedOptions).toEqual({ 'g-syrup': ['o-hazelnut'] });
  });
});

describe('ItemCustomizer strip', () => {
  const render = (selection: Record<string, string[]>, coffeyOptions?: Record<string, string[]>, suggested?: ReadonlySet<string>) =>
    renderToStaticMarkup(
      createElement(ItemCustomizer, {
        item: item(),
        variantId: 'v-reg',
        onVariantChange: () => {},
        selection,
        onToggle: () => {},
        instructions: '',
        onInstructionsChange: () => {},
        suggestedOptionIds: suggested,
        coffeyOptions,
      }),
    );
  const text = (html: string) => html.replace(/<!-- -->/g, '');
  /** The strip's own markup (its group div up to the muted line). */
  const strip = (html: string) => text(html).match(/<div role="group" aria-labelledby="[^"]*" class="mb-3[\s\S]*?<\/p><\/div>/)?.[0] ?? '';

  const both = customizeModalProps(item(), { addonPresets: [hazel], sugarPreset: sugarNone });

  it('draws the panel with chips, pressed states and prices', () => {
    const html = render(sel(both), both.suggestedOptions, suggestedOptionIds(item(), both.suggestedOptions));
    const s = strip(html);
    expect(s).toContain('Coffey set this up for you');
    expect(s).toContain('Hazelnut syrup');
    expect(s).toContain('+₹35</span>');
    expect(s).toContain('Sugar: No Sugar');
    expect(s).not.toContain('Choice of Sugar: No Sugar'); // the chip drops "Choice of"
    expect(s.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(s).toContain('min-h-[44px]');
    expect(s).toContain('Tap to remove. Everything else is below, as usual.');
    // Pills below stay.
    expect(text(html).split("Coffey&#x27;s pick").length - 1).toBe(2);
    // Panel comes before the first option group.
    expect(html.indexOf('Coffey set this up for you')).toBeLessThan(html.indexOf('>Required<'));
  });

  it('sugar only reads "You can change it below." and has no price', () => {
    const o = { 'g-sugar': ['o-nosugar'] };
    const s = strip(render(initialSelection(item(), o), o));
    expect(s).toContain('You can change it below.');
    expect(s).not.toContain('Tap to remove');
    expect(s).not.toContain('₹');
  });

  it('an add-on that has been deselected renders aria-pressed="false"', () => {
    const selection = { ...sel(both), 'g-syrup': [] };
    const s = strip(render(selection, both.suggestedOptions));
    expect(s).toContain('border-dashed');
    expect(s.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(s.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('a different sugar chosen below un-presses the sugar chip', () => {
    const s = strip(render({ ...sel(both), 'g-sugar': ['o-normal'] }, both.suggestedOptions));
    expect(s.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(s).toContain('Sugar: No Sugar');
    expect(s).not.toContain('Choice of Sugar: No Sugar'); // the chip drops "Choice of"
  });

  it('a full group disables the add-on chip like its own chip below', () => {
    const o = { 'g-syrup': ['o-hazelnut'] };
    const selection = { ...initialSelection(item()), 'g-syrup': ['o-vanilla', 'o-caramel'] };
    const s = strip(render(selection, o));
    expect(s).toContain('disabled=""');
  });

  it('is exactly the same markup with no Coffey props (menu page, QR menu, staff)', () => {
    const base = render(initialSelection(item()));
    expect(base).not.toContain('Coffey set this up');
    expect(render(initialSelection(item()), undefined)).toBe(base);
    expect(render(initialSelection(item()), {})).toBe(base);
    // Nothing on the item: no panel either.
    expect(render(initialSelection(item()), { 'g-syrup': ['o-ghost'] })).toBe(base);
    // With the props, the rest of the screen is the base plus the panel.
    const withProps = render(sel(both), both.suggestedOptions);
    expect(withProps).toContain('Coffey set this up for you');
  });
});

describe('strip toggles go through toggleOption', () => {
  const g = syrupGroup;
  it('off, on again, and on when the group is full', () => {
    const on = { 'g-syrup': ['o-hazelnut'] };
    const off = toggleOption(on, g, 'o-hazelnut');
    expect(off['g-syrup']).toEqual([]);
    expect(toggleOption(off, g, 'o-hazelnut')['g-syrup']).toEqual(['o-hazelnut']);
    const full = { 'g-syrup': ['o-vanilla', 'o-caramel'] };
    expect(toggleOption(full, g, 'o-hazelnut')).toBe(full);
  });
  it('sugar re-selects and never goes off', () => {
    const chosen = { 'g-sugar': ['o-normal'] };
    expect(toggleOption(chosen, sugarGroup, 'o-nosugar')['g-sugar']).toEqual(['o-nosugar']);
    expect(toggleOption({ 'g-sugar': ['o-nosugar'] }, sugarGroup, 'o-nosugar')['g-sugar']).toEqual(['o-nosugar']);
  });
});
