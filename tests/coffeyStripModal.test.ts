import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The modal's own derivation (what Coffey "set up", which hints stay), rendered
// for real with the cart and the portal-based Modal stubbed out.
vi.mock('@/lib/cart/CartContext', () => ({ useCart: () => ({ addItem: () => {} }) }));
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children }: { children: unknown }) => createElement('div', null, children as never),
}));

import { MenuItemCustomizeModal } from '@/components/menu/MenuItemCustomizeModal';
import { customizeModalProps } from '@/components/suggest/addonHint';
import { preselectedSuggestions, vetPresets } from '@/lib/menu/customization';
import type { AddonPreset, FlavourAddonSuggestion, SugarPreset } from '@/lib/suggest/types';
import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';

const option = (id: string, groupId: string, name: string, price: number, sort: number): AddonOption => ({
  id,
  addon_group_id: groupId,
  name,
  price_inr: price,
  sort_order: sort,
});
const flavourGroup: AddonGroup = {
  id: 'g-flav',
  name: 'Flavour',
  display_name: 'Choice of Flavour',
  selection_type: 'single',
  min_select: 1,
  max_select: 1,
  sort_order: 5,
  options: [option('o-plain', 'g-flav', 'Normal', 0, 0), option('o-hz', 'g-flav', 'Hazelnut', 30, 10)],
};
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
  options: [option('o-vanilla', 'g-syrup', 'Vanilla', 35, 0)],
};
const item: MenuItem = {
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
  addon_groups: [flavourGroup, sugarGroup, syrupGroup],
};

const sugarNone: SugarPreset = { groupId: 'g-sugar', optionId: 'o-nosugar', label: 'No Sugar' };
const SUGAR_HINT = 'Coffey set sugar to “No Sugar” for you — change it anytime.';

const render = (props: ReturnType<typeof customizeModalProps>) =>
  renderToStaticMarkup(createElement(MenuItemCustomizeModal, { item, onClose: () => {}, ...props })).replace(/<!-- -->/g, '');

describe('modal: what Coffey set up, and which hints stay', () => {
  it('a highlighted-only option that is a required default gets no chip, and the sugar note stays', () => {
    const flavourAddon = { groupId: 'g-flav', optionId: 'o-plain', label: 'Normal', family: 'nutty' } as unknown as FlavourAddonSuggestion;
    const props = customizeModalProps(item, { sugarPreset: sugarNone, flavourAddon });
    // The reviewer's shape: the highlighted option is selected on open (a default).
    expect(props.suggestedOptions).toEqual({ 'g-flav': ['o-plain'] });
    expect(props.initialSelection).toEqual({ 'g-sugar': ['o-nosugar'] });
    const html = render(props);
    expect(html).not.toContain('Coffey set this up for you');
    expect(html).toContain(SUGAR_HINT);
    expect(html).toContain('Coffey suggests Normal');
  });

  it('preselectedSuggestions counts only vetted presets, not opening defaults', () => {
    expect(preselectedSuggestions({ 'g-flav': ['o-plain'] }, vetPresets(item, { 'g-sugar': ['o-nosugar'] }))).toBeUndefined();
  });

  it('the normal presets path: panel shown, no duplicate hint line', () => {
    const hz: AddonPreset = { groupId: 'g-syrup', optionId: 'o-vanilla', label: 'Vanilla syrup', priceInr: 35, purpose: 'flavour', family: 'nutty' };
    const props = customizeModalProps(item, { addonPresets: [hz], sugarPreset: sugarNone });
    const html = render(props);
    expect(html).toContain('Coffey set this up for you');
    expect(html).toContain('Vanilla syrup');
    expect(html).toContain('Sugar: No Sugar');
    expect(html).not.toContain('Untick');
    expect(html).not.toContain('role="status"');
  });

  it('a paid preset in a required group: panel shown with its price, hint hidden', () => {
    const hz: AddonPreset = { groupId: 'g-flav', optionId: 'o-hz', label: 'Hazelnut', priceInr: 30, purpose: 'flavour', family: 'nutty' };
    const html = render(customizeModalProps(item, { addonPresets: [hz] }));
    expect(html).toContain('Flavour: Hazelnut');
    expect(html).toContain('+₹30');
    expect(html).not.toContain('role="status"');
  });
});
