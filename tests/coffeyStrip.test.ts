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
    expect(s).toContain('Tap to remove or put back. Everything else is below, as usual.');
    expect(s).not.toContain('That group is full');
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
    expect(s).toContain('That group is full. Remove one of its choices below to add this back.');
  });

  it('the full-group line appears only when a chip is disabled for that reason', () => {
    const o = { 'g-syrup': ['o-hazelnut'] };
    const full = 'That group is full.';
    expect(strip(render({ ...initialSelection(item()), 'g-syrup': ['o-hazelnut'] }, o))).not.toContain(full);
    expect(strip(render({ ...initialSelection(item()), 'g-syrup': [] }, o))).not.toContain(full);
    // Sugar-only panel: nothing can be full.
    expect(strip(render(initialSelection(item()), { 'g-sugar': ['o-nosugar'] }))).not.toContain(full);
    // The chip is on although the group is at its limit: not disabled, no line.
    const atLimit = { ...initialSelection(item()), 'g-syrup': ['o-hazelnut', 'o-vanilla'] };
    const s = strip(render(atLimit, o));
    expect(s).not.toContain('disabled=""');
    expect(s).not.toContain(full);
  });

  it('footer: neutral line with a removable add-on (even when all are off), short line with only required', () => {
    const neutral = 'Tap to remove or put back. Everything else is below, as usual.';
    expect(strip(render({ ...sel(both), 'g-syrup': [] }, both.suggestedOptions))).toContain(neutral);
    expect(strip(render(sel(both), both.suggestedOptions))).toContain(neutral);
    const only = strip(render(initialSelection(item()), { 'g-sugar': ['o-nosugar'] }));
    expect(only).toContain('You can change it below.');
    expect(only).not.toContain('Tap to remove');
  });

  it('a paid preset in a required group shows its price; a free required option shows none', () => {
    const flavour: AddonGroup = {
      id: 'g-flav',
      name: 'Flavour',
      display_name: 'Choice of Flavour',
      selection_type: 'single',
      min_select: 1,
      max_select: 1,
      sort_order: 5,
      options: [option('o-plain', 'g-flav', 'Plain', 0, 0), option('o-hz', 'g-flav', 'Hazelnut', 30, 10)],
    };
    const it2 = item({ addon_groups: [flavour, sugarGroup, syrupGroup] });
    const o = { 'g-flav': ['o-hz'], 'g-sugar': ['o-nosugar'] };
    const html = renderToStaticMarkup(
      createElement(ItemCustomizer, {
        item: it2,
        variantId: 'v-reg',
        onVariantChange: () => {},
        selection: initialSelection(it2, o),
        onToggle: () => {},
        instructions: '',
        onInstructionsChange: () => {},
        coffeyOptions: o,
      }),
    );
    const s = strip(html);
    expect(s).toContain('Flavour: Hazelnut');
    expect(s).toContain('+₹30</span>');
    // Sugar "No Sugar" is free: exactly one price in the panel.
    expect(s.match(/₹/g)).toHaveLength(1);
    expect(s.slice(s.indexOf('Sugar: No Sugar'))).not.toContain('₹');
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

  it('the ordinary screen carries nothing of the panel and starts with its first group', () => {
    const base = render(initialSelection(item()));
    expect(base).not.toContain('Coffey set this up');
    expect(base).not.toContain('Coffey&#x27;s pick');
    // No panel: the only role="group" blocks are the option groups, and none comes before the first heading.
    expect(base).not.toContain('class="mb-3 rounded-lg');
    expect(base.indexOf('role="group"')).toBeGreaterThan(base.indexOf('>Required</h3>'));
    expect(base).not.toContain('Tap to remove');
    // The body opens straight on the first section's heading (no stray element).
    expect(text(base).startsWith('<div class="divide-y divide-line"><section class="py-2 first:pt-0"><h3 ')).toBe(true);
    expect(text(base)).toMatch(/^<div class="divide-y divide-line"><section class="py-2 first:pt-0"><h3 [^>]*>Required<\/h3>/);
    // With several sizes, the size picker is what comes first.
    const sized = renderToStaticMarkup(
      createElement(ItemCustomizer, {
        item: item({
          variants: [
            { id: 'v-reg', menu_item_id: 'm-capp', label: 'Regular', price_inr: 160, sort_order: 0 },
            { id: 'v-lg', menu_item_id: 'm-capp', label: 'Large', price_inr: 200, sort_order: 1 },
          ],
        }),
        variantId: 'v-reg',
        onVariantChange: () => {},
        selection: initialSelection(item()),
        onToggle: () => {},
        instructions: '',
        onInstructionsChange: () => {},
      }),
    );
    expect(text(sized)).toMatch(/^<div class="divide-y divide-line"><section class="py-2 first:pt-0"><h3 [^>]*>Required<\/h3>/);
    expect(sized).not.toContain('class="mb-3 rounded-lg');
  });

  it('chip prefix: only a leading "Choice of " is stripped; an empty name has no prefix', () => {
    const grp = (id: string, display: string, label: string): AddonGroup => ({
      id,
      name: 'x',
      display_name: display,
      selection_type: 'single',
      min_select: 1,
      max_select: 1,
      sort_order: 1,
      options: [option(id + '-o', id, label, 0, 0)],
    });
    const groups = [
      grp('a', 'Choice of Sugar', 'No Sugar'),
      grp('b', 'Choose any 2 toppings', 'Cream'),
      grp('c', '', 'Plain'),
      grp('d', 'choice of Milk', 'Oat'),
    ];
    const it2 = item({ addon_groups: groups });
    const o = { a: ['a-o'], b: ['b-o'], c: ['c-o'], d: ['d-o'] };
    const s = strip(
      renderToStaticMarkup(
        createElement(ItemCustomizer, {
          item: it2,
          variantId: 'v-reg',
          onVariantChange: () => {},
          selection: initialSelection(it2, o),
          onToggle: () => {},
          instructions: '',
          onInstructionsChange: () => {},
          coffeyOptions: o,
        }),
      ),
    );
    expect(s).toContain('<span>Sugar: No Sugar</span>');
    expect(s).toContain('<span>Choose any 2 toppings: Cream</span>');
    expect(s).toContain('<span>Plain</span>');
    expect(s).not.toContain('Sugar: Plain');
    expect(s).toContain('<span>Milk: Oat</span>');
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
